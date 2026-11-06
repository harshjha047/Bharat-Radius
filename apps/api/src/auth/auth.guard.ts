import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { ObjectId } from 'mongodb';
import { CONFIG, type Config } from '../config.js';
import { AppError, forbidden, notFound, unauthenticated } from '../errors.js';
import { ENDPOINT, type EndpointOptions } from '../http/endpoint.js';
import { scopeFor } from './context.js';
import { COOKIE, CSRF_HEADER, Cookies } from './cookies.js';
import { SessionUsers } from './session-users.js';
import { Tokens } from './tokens.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

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
  ) {}

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
      scope: scopeFor(u),
    };
    req.log = req.log.child({ userId: u._id.toHexString(), tenantId: u.tenantId?.toHexString() ?? null });
    return true;
  }
}
