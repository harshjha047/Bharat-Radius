import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { ObjectId } from 'mongodb';
import type { MongoHandle, ResellerDoc } from '@isp/db-mongo';
import { RESELLER_PERMISSIONS, type Permission } from '@isp/shared';
import { CONFIG, type Config } from '../config.js';
import { MONGO } from '../infra/infra.module.js';
import { AppError, forbidden, notFound, unauthenticated } from '../errors.js';
import { ENDPOINT, type EndpointOptions } from '../http/endpoint.js';
import { PortalAuth } from '../portal/portal-auth.js';
import { scopeFor, type AuthContext } from './context.js';
import { COOKIE, CSRF_HEADER, Cookies } from './cookies.js';
import { SessionUsers } from './session-users.js';
import { Tokens } from './tokens.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
export const VIEW_AS_HEADER = 'x-view-as';
const RESELLER_SET = new Set<Permission>(RESELLER_PERMISSIONS);

/**
 * Global guard. Every route is authenticated unless it is an @Endpoint with auth: 'public'; routes without
 * @Endpoint (health) are public. Unsafe methods must come from an allowed Origin and, with a session, carry the
 * CSRF token bound to that session.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(Tokens) private readonly tokens: Tokens,
    @Inject(SessionUsers) private readonly sessions: SessionUsers,
    @Inject(Cookies) private readonly cookies: Cookies,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(PortalAuth) private readonly portal: PortalAuth,
    @Inject(MONGO) private readonly mongo: MongoHandle,
  ) {}

  /**
   * "Login as site": ISP staff with resellers.write, or a reseller for a reseller below it, works inside that
   * reseller's branch. Rights = the actor's rights ∩ reseller rights (never more than either). Sign-in routes keep
   * acting on the real user.
   */
  private async viewAs(ctx: AuthContext, header: string, path: string): Promise<AuthContext> {
    if (path.startsWith('/api/v1/auth/') && path !== '/api/v1/auth/me') return ctx;
    if (!ObjectId.isValid(header)) throw new AppError(400, 'VALIDATION_FAILED', 'Bad X-View-As reseller id');
    const id = new ObjectId(header);
    const s = ctx.scope;
    if (s.kind === 'platform') throw forbidden('Open the ISP first');
    if (s.kind === 'tenant' && !ctx.permissions.has('resellers.write'))
      throw forbidden('You cannot open reseller panels');
    const r = await this.mongo.db
      .collection<ResellerDoc>('resellers')
      .findOne(
        { _id: id, tenantId: s.tenantId, status: { $ne: 'deleted' } },
        { projection: { code: 1, name: 1, ancestors: 1 } },
      );
    if (!r) throw notFound('Reseller');
    if (s.kind === 'branch' && !r.ancestors.some((a) => a.equals(s.resellerId))) throw notFound('Reseller');
    return {
      ...ctx,
      type: 'reseller',
      name: `${ctx.name} (as ${r.code})`,
      resellerId: r._id,
      permissions: new Set([...ctx.permissions].filter((p) => RESELLER_SET.has(p))),
      scope: { kind: 'branch', tenantId: s.tenantId, resellerId: r._id, rootId: r.ancestors[0] ?? r._id },
      viewAs: { resellerId: r._id, code: r.code, name: r.name, byName: ctx.name },
    };
  }

  async canActivate(ec: ExecutionContext): Promise<boolean> {
    const opts = this.reflector.get<EndpointOptions | undefined>(ENDPOINT, ec.getHandler());
    if (!opts) return true;
    const req = ec.switchToHttp().getRequest<FastifyRequest>();
    const unsafe = !SAFE.has(req.method);
    const csrf = opts.csrf ?? true;

    if (unsafe && csrf) {
      const origin = req.headers.origin;
      if (origin !== undefined && !this.config.allowedOrigins.has(origin)) {
        throw new AppError(403, 'CSRF_FAILED', 'Request origin not allowed');
      }
    }
    if ((opts.auth ?? 'session') === 'public') return true;

    if (opts.auth === 'portal') {
      const p = await this.portal.load(req);
      if (!p) throw unauthenticated('Session ended. Sign in again.');
      if (unsafe && csrf && !this.portal.checkCsrf(p.sessionId, req.headers[CSRF_HEADER])) {
        throw new AppError(403, 'CSRF_FAILED', 'Security token missing or stale. Reload the page.');
      }
      req.ctx = this.portal.contextFor(p);
      req.log = req.log.child({
        subscriberId: p.subscriberId.toHexString(),
        tenantId: p.tenantId.toHexString(),
      });
      return true;
    }

    const token = this.cookies.read(req, COOKIE.access);
    const claims = token ? await this.tokens.verifyAccess(token) : null;
    if (!claims || !ObjectId.isValid(claims.sub)) throw unauthenticated();

    if (unsafe && csrf) {
      const header = req.headers[CSRF_HEADER];
      if (typeof header !== 'string' || !this.tokens.checkCsrf(claims.sid, header)) {
        throw new AppError(403, 'CSRF_FAILED', 'Security token missing or stale. Reload the page.');
      }
    }

    const su = await this.sessions.load(new ObjectId(claims.sub));
    const u = su?.user;
    if (
      !su ||
      !u ||
      u.status !== 'active' ||
      !su.active ||
      u.tokenVersion !== claims.ver ||
      u.type === 'customer'
    ) {
      throw unauthenticated('Session ended. Sign in again.');
    }
    if (claims.mfa === 'enroll' && opts.auth !== 'enroll') {
      throw new AppError(403, 'MFA_ENROLLMENT_REQUIRED', 'Turn on two-factor sign-in to continue');
    }
    if (opts.platformOnly && u.type !== 'superadmin') throw notFound();
    if (opts.permission && !su.permissions.has(opts.permission)) throw forbidden();

    req.ctx = {
      userId: u._id,
      tenantId: u.tenantId,
      type: u.type,
      name: u.name,
      ...(u.resellerId ? { resellerId: u.resellerId } : {}),
      permissions: su.permissions,
      familyId: claims.sid,
      mfa: claims.mfa,
      scope: scopeFor(u, su.branchRoot),
    };
    const viewAs = req.headers[VIEW_AS_HEADER];
    if (typeof viewAs === 'string' && viewAs) {
      req.ctx = await this.viewAs(req.ctx, viewAs, req.url.split('?')[0]!);
      if (opts.permission && !req.ctx.permissions.has(opts.permission)) throw forbidden();
    }
    req.log = req.log.child({
      userId: u._id.toHexString(),
      tenantId: u.tenantId?.toHexString() ?? null,
      ...(req.ctx.viewAs ? { viewAs: req.ctx.viewAs.resellerId.toHexString() } : {}),
    });
    return true;
  }
}
