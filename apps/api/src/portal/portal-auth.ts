import { timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ObjectId } from 'mongodb';
import { FieldCrypto } from '@isp/shared';
import { pppoeAad, type MongoHandle, type PortalSessionDoc, type SubscriberDoc } from '@isp/db-mongo';
import { resolveTenant, type ClientMeta } from '../auth/auth.service.js';
import type { AuthContext } from '../auth/context.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { RateLimiter } from '../auth/rate-limit.js';
import { Tokens } from '../auth/tokens.js';
import { CONFIG, type Config } from '../config.js';
import { AppError, tooMany } from '../errors.js';
import { MONGO } from '../infra/infra.module.js';

export const PORTAL_COOKIE = { session: 'isp_pt', csrf: 'isp_pcsrf' } as const;
const PORTAL_PATH = '/api/v1/portal';
/** Idle sign-out after 7 days; at most 30 days per sign-in. */
export const PORTAL_IDLE_SECS = 7 * 86_400;
export const PORTAL_MAX_SECS = 30 * 86_400;
/** lastSeenAt/expiresAt are written at most this often per session (one write per hour, not per request). */
const TOUCH_EVERY_MS = 3_600_000;

const invalid = () =>
  new AppError(401, 'INVALID_CREDENTIALS', 'Wrong username or password. Use your internet (PPPoE) login.');

const sameString = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export interface PortalSession {
  tenantId: ObjectId;
  subscriberId: ObjectId;
  sessionId: ObjectId;
  name: string;
}

/**
 * Customer sign-in for the portal. Separate from staff sessions: own cookie (path /api/v1/portal, SameSite=Strict),
 * own CSRF cookie, opaque token stored only as a peppered HMAC, revocable per session or per customer.
 */
@Injectable()
export class PortalAuth {
  private readonly log = new Logger('portal-auth');

  constructor(
    @Inject(MONGO) private readonly mongo: MongoHandle,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(Tokens) private readonly tokens: Tokens,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
  ) {}

  private get subs() {
    return this.mongo.db.collection<SubscriberDoc>('subscribers');
  }
  private get sessions() {
    return this.mongo.db.collection<PortalSessionDoc>('portal_sessions');
  }

  async login(
    input: { tenant?: string | undefined; login: string; password: string },
    meta: ClientMeta,
  ): Promise<{ token: string; csrf: string; subscriberId: ObjectId }> {
    const ipKey = `portal:ip:${meta.ip}`;
    const ipState = await this.limiter.peek(ipKey);
    if (ipState.count >= this.config.LOGIN_MAX_FAILURES_IP) throw tooMany(ipState.retryAfterSecs);

    const tenantId = await resolveTenant(this.mongo.db, input.tenant, meta.host);
    const login = input.login.trim();
    const s = tenantId
      ? await this.subs.findOne({
          tenantId,
          status: { $ne: 'deleted' },
          $or: [{ username: login }, { customerNo: login.toUpperCase() }],
        })
      : null;

    if (s?.portal?.lockedUntil && s.portal.lockedUntil > new Date()) {
      throw tooMany(Math.ceil((s.portal.lockedUntil.getTime() - Date.now()) / 1000));
    }
    const ok = await this.check(s, input.password);
    if (!ok || !s) {
      await this.limiter.hit(ipKey, this.config.LOGIN_WINDOW_SECS);
      if (s) await this.recordFailure(s);
      throw invalid();
    }

    const now = new Date();
    await this.subs.updateOne(
      { _id: s._id },
      {
        $set: {
          'portal.failedLogins': 0,
          'portal.lastLoginAt': now,
          ...(s.portal ? {} : { 'portal.tokenVersion': 0 }),
        },
        $unset: { 'portal.lockedUntil': '' },
      },
    );
    const token = this.tokens.newRefreshToken();
    const sessionId = new ObjectId();
    await this.sessions.insertOne({
      _id: sessionId,
      tenantId: s.tenantId,
      subscriberId: s._id,
      tokenHash: this.tokens.hashRefresh(token),
      tokenVersion: s.portal?.tokenVersion ?? 0,
      ip: meta.ip,
      ...(meta.userAgent ? { userAgent: meta.userAgent.slice(0, 300) } : {}),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + PORTAL_IDLE_SECS * 1000),
    });
    return { token, csrf: this.tokens.csrfFor(sessionId.toHexString()), subscriberId: s._id };
  }

  /** Portal password if set, else the PPPoE password (what every customer already has). Constant work if unknown. */
  private async check(s: SubscriberDoc | null, password: string): Promise<boolean> {
    if (!s) return verifyPassword(undefined, password);
    if (s.portal?.passwordHash) return verifyPassword(s.portal.passwordHash, password);
    let pppoe: string;
    try {
      pppoe = this.crypto.decrypt(s.pppoePassword, pppoeAad(s._id));
    } catch (e) {
      this.log.error(`PPPoE password unreadable for ${s._id.toHexString()}: ${String(e)}`);
      return false;
    }
    await verifyPassword(undefined, password);
    return sameString(pppoe, password);
  }

  private async recordFailure(s: SubscriberDoc) {
    const after = await this.subs.findOneAndUpdate(
      { _id: s._id },
      { $inc: { 'portal.failedLogins': 1 }, ...(s.portal ? {} : { $set: { 'portal.tokenVersion': 0 } }) },
      { returnDocument: 'after', includeResultMetadata: false, projection: { portal: 1 } },
    );
    if ((after?.portal?.failedLogins ?? 0) >= this.config.LOGIN_MAX_FAILURES_ACCOUNT) {
      await this.subs.updateOne(
        { _id: s._id },
        {
          $set: {
            'portal.failedLogins': 0,
            'portal.lockedUntil': new Date(Date.now() + this.config.LOGIN_WINDOW_SECS * 1000),
          },
        },
      );
      this.log.warn(`portal login locked after repeated failures: subscriber ${s._id.toHexString()}`);
    }
  }

  /** Session from the cookie, or null. Slides the idle expiry at most once an hour. */
  async load(req: FastifyRequest): Promise<PortalSession | null> {
    const raw = req.cookies[PORTAL_COOKIE.session];
    if (!raw || raw.length > 128) return null;
    const now = new Date();
    const ps = await this.sessions.findOne({
      tokenHash: this.tokens.hashRefresh(raw),
      expiresAt: { $gt: now },
    });
    if (!ps) return null;
    const s = await this.subs.findOne(
      { _id: ps.subscriberId, tenantId: ps.tenantId, status: { $ne: 'deleted' } },
      { projection: { name: 1, portal: 1 } },
    );
    if (!s || (s.portal?.tokenVersion ?? 0) !== ps.tokenVersion) {
      await this.sessions.deleteOne({ _id: ps._id });
      return null;
    }
    if (now.getTime() - ps.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
      const cap = ps.createdAt.getTime() + PORTAL_MAX_SECS * 1000;
      const expiresAt = new Date(Math.min(now.getTime() + PORTAL_IDLE_SECS * 1000, cap));
      await this.sessions.updateOne({ _id: ps._id }, { $set: { lastSeenAt: now, expiresAt } });
    }
    return { tenantId: ps.tenantId, subscriberId: ps.subscriberId, sessionId: ps._id, name: s.name };
  }

  checkCsrf(sessionId: ObjectId, header: unknown): boolean {
    return typeof header === 'string' && this.tokens.checkCsrf(sessionId.toHexString(), header);
  }

  async logout(sessionId: ObjectId) {
    await this.sessions.deleteOne({ _id: sessionId });
  }

  /** Customer sets (or changes) a portal password; every other portal session ends. */
  async setPassword(ctx: AuthContext, current: string, next: string) {
    const s = await this.subs.findOne({ _id: ctx.subscriberId!, tenantId: ctx.tenantId! });
    if (!s || !(await this.check(s, current))) {
      throw new AppError(400, 'VALIDATION_FAILED', 'Current password is wrong', {
        issues: [{ path: 'currentPassword', message: 'is wrong' }],
      });
    }
    const version = (s.portal?.tokenVersion ?? 0) + 1;
    await this.subs.updateOne(
      { _id: s._id },
      { $set: { 'portal.passwordHash': await hashPassword(next), 'portal.tokenVersion': version } },
    );
    await this.sessions.updateOne({ _id: new ObjectId(ctx.familyId) }, { $set: { tokenVersion: version } });
    await this.sessions.deleteMany({ subscriberId: s._id, _id: { $ne: new ObjectId(ctx.familyId) } });
  }

  /** Staff: back to the PPPoE password and sign the customer out everywhere. */
  async reset(subscriberId: ObjectId) {
    await this.subs.updateOne(
      { _id: subscriberId },
      {
        $unset: { 'portal.passwordHash': '', 'portal.lockedUntil': '' },
        $set: { 'portal.failedLogins': 0 },
        $inc: { 'portal.tokenVersion': 1 },
      },
    );
    await this.sessions.deleteMany({ subscriberId });
  }

  setCookies(reply: FastifyReply, token: string, csrf: string) {
    const secure = this.config.COOKIE_SECURE;
    reply.setCookie(PORTAL_COOKIE.session, token, {
      httpOnly: true,
      secure,
      sameSite: 'strict',
      path: PORTAL_PATH,
      maxAge: PORTAL_MAX_SECS,
    });
    reply.setCookie(PORTAL_COOKIE.csrf, csrf, {
      httpOnly: false,
      secure,
      sameSite: 'strict',
      path: '/',
      maxAge: PORTAL_MAX_SECS,
    });
  }

  clearCookies(reply: FastifyReply) {
    reply.clearCookie(PORTAL_COOKIE.session, { path: PORTAL_PATH });
    reply.clearCookie(PORTAL_COOKIE.csrf, { path: '/' });
  }

  /** Request context for a portal call: tenant scope, but every portal query also filters on subscriberId. */
  contextFor(p: PortalSession): AuthContext {
    return {
      userId: p.subscriberId,
      tenantId: p.tenantId,
      type: 'customer',
      name: p.name,
      subscriberId: p.subscriberId,
      permissions: new Set(),
      familyId: p.sessionId.toHexString(),
      mfa: 'ok',
      scope: { kind: 'tenant', tenantId: p.tenantId },
    };
  }
}
