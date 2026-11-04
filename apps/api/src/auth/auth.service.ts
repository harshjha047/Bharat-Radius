import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ObjectId, type Filter } from 'mongodb';
import { FieldCrypto, newTotpSecret, otpauthUrl, verifyTotp } from '@isp/shared';
import type { MongoHandle, RefreshTokenDoc, TenantDoc, UserDoc } from '@isp/db-mongo';
import { AuditService, recordSignIn } from '../audit/audit.js';
import { CONFIG, type Config } from '../config.js';
import { AppError, tooMany, unauthenticated } from '../errors.js';
import { MONGO } from '../infra/infra.module.js';
import type { AuthContext } from './context.js';
import type { IssuedSession } from './cookies.js';
import { hashPassword, needsRehash, verifyPassword } from './passwords.js';
import { RateLimiter } from './rate-limit.js';
import { SessionUsers } from './session-users.js';
import { REFRESH_TTL_SECS, Tokens } from './tokens.js';

export interface ClientMeta {
  ip: string;
  userAgent?: string | undefined;
  host: string;
}

export type LoginResult =
  | { kind: 'session'; session: IssuedSession; userId: ObjectId; mfa: 'ok' | 'enroll' }
  | { kind: 'mfa'; challenge: string };

/** Concurrent refreshes from several tabs reuse one cookie; within this window that is not treated as theft. */
const REFRESH_GRACE_MS = 10_000;

/** Reserved login "tenant" for super-admins; no tenant may use this slug. */
export const PLATFORM_SLUG = 'platform';

const invalidCredentials = () => new AppError(401, 'INVALID_CREDENTIALS', 'Wrong login or password');

const totpAad = (userId: ObjectId) => `users.totp:${userId.toHexString()}`;

export function normalizeLogin(login: string): { email: string } | { phone: string } {
  const s = login.trim();
  if (s.includes('@')) return { email: s.toLowerCase() };
  const p = s.replace(/[\s-]/g, '');
  return { phone: /^[6-9]\d{9}$/.test(p) ? `+91${p}` : p };
}

@Injectable()
export class AuthService {
  private readonly log = new Logger('auth');

  constructor(
    @Inject(MONGO) private readonly mongo: MongoHandle,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(Tokens) private readonly tokens: Tokens,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(SessionUsers) private readonly sessions: SessionUsers,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private get users() {
    return this.mongo.db.collection<UserDoc>('users');
  }

  private get refreshTokens() {
    return this.mongo.db.collection<RefreshTokenDoc>('refresh_tokens');
  }

  /** Explicit slug → that tenant; else the request host → tenant with that branding domain; else platform (super-admin). */
  private async resolveTenant(slug: string | undefined, host: string): Promise<ObjectId | null | undefined> {
    const tenants = this.mongo.db.collection<TenantDoc>('tenants');
    if (slug === PLATFORM_SLUG) return null;
    if (slug)
      return (
        await tenants.findOne({ slug: slug.toLowerCase(), status: 'active' }, { projection: { _id: 1 } })
      )?._id;
    const byHost = await tenants.findOne(
      { 'branding.domain': host.toLowerCase(), status: 'active' },
      { projection: { _id: 1 } },
    );
    return byHost ? byHost._id : null;
  }

  private note(user: UserDoc, action: 'auth.login' | 'auth.login_failed' | 'auth.locked', meta: ClientMeta) {
    return recordSignIn(this.audit, user, action, meta, (e) =>
      this.log.error(`audit write failed: ${String(e)}`),
    );
  }

  private async recordFailure(user: UserDoc | null, meta: ClientMeta): Promise<void> {
    const window = this.config.LOGIN_WINDOW_SECS;
    await this.limiter.hit(`login:ip:${meta.ip}`, window);
    if (!user) return;
    await this.note(user, 'auth.login_failed', meta);
    const after = await this.users.findOneAndUpdate(
      { _id: user._id },
      { $inc: { failedLogins: 1 } },
      { returnDocument: 'after', includeResultMetadata: false },
    );
    if (after && after.failedLogins >= this.config.LOGIN_MAX_FAILURES_ACCOUNT) {
      await this.users.updateOne(
        { _id: user._id },
        {
          $set: { failedLogins: 0, lockedUntil: new Date(Date.now() + window * 1000), updatedAt: new Date() },
        },
      );
      this.log.warn(`account locked after repeated failures: user ${user._id.toHexString()}`);
      await this.note(user, 'auth.locked', meta);
    }
  }

  async login(
    input: { tenant?: string | undefined; login: string; password: string },
    meta: ClientMeta,
  ): Promise<LoginResult> {
    const ipKey = `login:ip:${meta.ip}`;
    const ipState = await this.limiter.peek(ipKey);
    if (ipState.count >= this.config.LOGIN_MAX_FAILURES_IP) throw tooMany(ipState.retryAfterSecs);

    const tenantId = await this.resolveTenant(input.tenant, meta.host);
    const user =
      tenantId === undefined
        ? null
        : await this.users.findOne({ tenantId, ...normalizeLogin(input.login) } as Filter<UserDoc>);

    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      throw tooMany(Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000));
    }
    const ok = await verifyPassword(user?.passwordHash, input.password);
    if (!ok || !user || user.type === 'customer') {
      await this.recordFailure(user, meta);
      throw invalidCredentials();
    }

    const su = await this.sessions.resolve(user._id);
    if (!su || user.status !== 'active' || !su.tenantActive) {
      throw new AppError(403, 'ACCOUNT_DISABLED', 'This account is disabled. Contact your administrator.');
    }

    const set: Partial<UserDoc> = { failedLogins: 0, lastLoginAt: new Date(), updatedAt: new Date() };
    if (needsRehash(user.passwordHash!)) set.passwordHash = await hashPassword(input.password);
    await this.users.updateOne({ _id: user._id }, { $set: set, $unset: { lockedUntil: '' } });

    if (user.totp?.enabled) {
      const { token } = await this.tokens.signMfa(user._id.toHexString());
      return { kind: 'mfa', challenge: token };
    }
    const mfa = su.requireMfa ? 'enroll' : 'ok';
    await this.note(user, 'auth.login', meta);
    return { kind: 'session', session: await this.startSession(user, mfa, meta), userId: user._id, mfa };
  }

  async verifyMfa(
    challenge: string | undefined,
    code: string,
    meta: ClientMeta,
  ): Promise<{ session: IssuedSession; userId: ObjectId }> {
    const claims = challenge ? await this.tokens.verifyMfa(challenge) : null;
    if (!claims) throw new AppError(401, 'MFA_REQUIRED', 'Sign-in step expired. Enter your password again.');
    const attempts = await this.limiter.hit(`mfa:${claims.jti}`, 300);
    if (attempts.count > 5)
      throw new AppError(401, 'MFA_REQUIRED', 'Too many wrong codes. Enter your password again.');

    const user = await this.users.findOne({ _id: new ObjectId(claims.sub) });
    if (!user?.totp?.enabled || !user.totp.secret || user.status !== 'active') throw unauthenticated();
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw tooMany(Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000));
    }
    const step = await this.consumeTotp(user, user.totp.secret, code);
    if (step === null) {
      await this.recordFailure(user, meta);
      throw new AppError(401, 'MFA_INVALID', 'Wrong or already used code');
    }
    await this.note(user, 'auth.login', meta);
    return { session: await this.startSession(user, 'ok', meta), userId: user._id };
  }

  /** Verifies a code and records its time step atomically, so the same code cannot be used twice (even in a race). */
  private async consumeTotp(
    user: UserDoc,
    secret: NonNullable<NonNullable<UserDoc['totp']>['secret']>,
    code: string,
  ) {
    const plain = this.crypto.decrypt(secret, totpAad(user._id));
    const last = user.totp?.lastUsedStep ?? -1;
    const step = verifyTotp(plain, code, Date.now(), last);
    if (step === null) return null;
    const r = await this.users.updateOne(
      {
        _id: user._id,
        $or: [{ 'totp.lastUsedStep': { $lt: step } }, { 'totp.lastUsedStep': { $exists: false } }],
      },
      { $set: { 'totp.lastUsedStep': step, failedLogins: 0 } },
    );
    return r.modifiedCount === 1 ? step : null;
  }

  async startSession(
    user: UserDoc,
    mfa: 'ok' | 'enroll',
    meta: ClientMeta,
    family?: { id: string; expiresAt: Date },
  ): Promise<IssuedSession> {
    const now = new Date();
    const familyId = family?.id ?? randomUUID();
    const refresh = this.tokens.newRefreshToken();
    const familyExpiresAt = family?.expiresAt ?? new Date(now.getTime() + REFRESH_TTL_SECS * 1000);
    await this.refreshTokens.insertOne({
      _id: new ObjectId(),
      userId: user._id,
      tenantId: user.tenantId,
      tokenHash: this.tokens.hashRefresh(refresh),
      familyId,
      tokenVersion: user.tokenVersion,
      mfa,
      ...(meta.userAgent ? { userAgent: meta.userAgent.slice(0, 300) } : {}),
      ip: meta.ip,
      createdAt: now,
      expiresAt: new Date(Math.min(now.getTime() + REFRESH_TTL_SECS * 1000, familyExpiresAt.getTime())),
      familyExpiresAt,
    });
    const access = await this.tokens.signAccess({
      sub: user._id.toHexString(),
      tid: user.tenantId?.toHexString() ?? null,
      sid: familyId,
      ver: user.tokenVersion,
      mfa,
    });
    return { access, refresh, csrf: this.tokens.csrfFor(familyId) };
  }

  async refresh(
    token: string | undefined,
    meta: ClientMeta,
  ): Promise<{ session: IssuedSession; userId: ObjectId }> {
    if (!token) throw unauthenticated();
    const now = new Date();
    const tokenHash = this.tokens.hashRefresh(token);
    let doc = await this.refreshTokens.findOneAndUpdate(
      { tokenHash, revokedAt: { $exists: false }, expiresAt: { $gt: now } },
      { $set: { revokedAt: now, revokedReason: 'rotated' } },
      { returnDocument: 'before', includeResultMetadata: false },
    );
    if (!doc) {
      const old = await this.refreshTokens.findOne({ tokenHash });
      if (
        old?.revokedReason === 'rotated' &&
        old.revokedAt &&
        now.getTime() - old.revokedAt.getTime() < REFRESH_GRACE_MS
      ) {
        doc = old;
      } else {
        if (old?.revokedReason === 'rotated') {
          await this.revokeFamily(old.familyId, 'reuse');
          this.log.warn(`refresh token reuse, session family revoked: user ${old.userId.toHexString()}`);
        }
        throw unauthenticated('Session ended. Sign in again.');
      }
    }
    if (doc.familyExpiresAt <= now) throw unauthenticated('Session ended. Sign in again.');
    const su = await this.sessions.resolve(doc.userId);
    if (!su || su.user.status !== 'active' || !su.tenantActive || su.user.tokenVersion !== doc.tokenVersion) {
      await this.revokeFamily(doc.familyId, 'admin');
      throw unauthenticated('Session ended. Sign in again.');
    }
    const session = await this.startSession(su.user, doc.mfa, meta, {
      id: doc.familyId,
      expiresAt: doc.familyExpiresAt,
    });
    return { session, userId: doc.userId };
  }

  async revokeFamily(familyId: string, reason: RefreshTokenDoc['revokedReason']): Promise<void> {
    await this.refreshTokens.updateMany(
      { familyId, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date(), revokedReason: reason! } },
    );
  }

  /** Ends every session of the user: bumps tokenVersion (access tokens die at next request) and revokes refresh tokens. */
  async revokeAll(userId: ObjectId, reason: RefreshTokenDoc['revokedReason']): Promise<UserDoc | null> {
    const user = await this.users.findOneAndUpdate(
      { _id: userId },
      { $inc: { tokenVersion: 1 }, $set: { updatedAt: new Date() } },
      { returnDocument: 'after', includeResultMetadata: false },
    );
    await this.refreshTokens.updateMany(
      { userId, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date(), revokedReason: reason! } },
    );
    this.sessions.invalidate(userId);
    return user;
  }

  async logout(refresh: string | undefined, ctx: AuthContext | undefined): Promise<void> {
    if (ctx) return this.revokeFamily(ctx.familyId, 'logout');
    if (!refresh) return;
    const doc = await this.refreshTokens.findOne({ tokenHash: this.tokens.hashRefresh(refresh) });
    if (doc) await this.revokeFamily(doc.familyId, 'logout');
  }

  async setupTotp(ctx: AuthContext): Promise<{ secret: string; otpauthUrl: string }> {
    const user = await this.users.findOne({ _id: ctx.userId });
    if (!user) throw unauthenticated();
    if (user.totp?.enabled) throw new AppError(409, 'CONFLICT', 'Two-factor sign-in is already on');
    const totpSecret = newTotpSecret();
    await this.users.updateOne(
      { _id: user._id },
      {
        $set: {
          'totp.enabled': false,
          'totp.pending': this.crypto.encrypt(totpSecret, totpAad(user._id)),
          updatedAt: new Date(),
        },
      },
    );
    const account = user.email ?? user.phone ?? user.name;
    return { secret: totpSecret, otpauthUrl: otpauthUrl(totpSecret, account, this.config.MFA_ISSUER) };
  }

  async enableTotp(ctx: AuthContext, code: string, meta: ClientMeta): Promise<IssuedSession> {
    const user = await this.users.findOne({ _id: ctx.userId });
    const pending = user?.totp?.pending;
    if (!user || !pending) throw new AppError(409, 'CONFLICT', 'Start two-factor setup first');
    const plain = this.crypto.decrypt(pending, totpAad(user._id));
    const step = verifyTotp(plain, code, Date.now());
    if (step === null)
      throw new AppError(400, 'MFA_INVALID', 'Wrong code. Check the time on your phone and try again.');
    await this.users.updateOne(
      { _id: user._id, 'totp.pending': { $exists: true } },
      {
        $set: {
          totp: { enabled: true, secret: pending, enabledAt: new Date(), lastUsedStep: step },
          updatedAt: new Date(),
        },
      },
    );
    const fresh = await this.revokeAll(user._id, 'password');
    return this.startSession(fresh!, 'ok', meta);
  }

  async disableTotp(
    ctx: AuthContext,
    password: string,
    code: string,
    meta: ClientMeta,
  ): Promise<IssuedSession> {
    const su = await this.sessions.resolve(ctx.userId);
    const user = su?.user;
    if (!user?.totp?.enabled || !user.totp.secret)
      throw new AppError(409, 'CONFLICT', 'Two-factor sign-in is not on');
    if (su!.requireMfa) throw new AppError(403, 'FORBIDDEN', 'Your role requires two-factor sign-in');
    if (!(await verifyPassword(user.passwordHash, password))) throw invalidCredentials();
    if ((await this.consumeTotp(user, user.totp.secret, code)) === null) {
      throw new AppError(400, 'MFA_INVALID', 'Wrong or already used code');
    }
    await this.users.updateOne({ _id: user._id }, { $unset: { totp: '' }, $set: { updatedAt: new Date() } });
    const fresh = await this.revokeAll(user._id, 'password');
    return this.startSession(fresh!, 'ok', meta);
  }

  async changePassword(
    ctx: AuthContext,
    current: string,
    next: string,
    meta: ClientMeta,
  ): Promise<IssuedSession> {
    const user = await this.users.findOne({ _id: ctx.userId });
    if (!user || !(await verifyPassword(user.passwordHash, current))) throw invalidCredentials();
    if (current === next)
      throw new AppError(400, 'VALIDATION_FAILED', 'New password must differ from the current one');
    await this.users.updateOne(
      { _id: user._id },
      {
        $set: {
          passwordHash: await hashPassword(next),
          passwordChangedAt: new Date(),
          updatedAt: new Date(),
        },
      },
    );
    const fresh = await this.revokeAll(user._id, 'password');
    return this.startSession(fresh!, ctx.mfa, meta);
  }
}
