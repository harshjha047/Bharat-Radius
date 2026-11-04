import { Inject, Injectable } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CONFIG, type Config } from '../config.js';
import { ACCESS_TTL_SECS, MFA_CHALLENGE_TTL_SECS, REFRESH_TTL_SECS } from './tokens.js';

export const COOKIE = { access: 'isp_at', refresh: 'isp_rt', mfa: 'isp_mfa', csrf: 'isp_csrf' } as const;
export const CSRF_HEADER = 'x-csrf-token';

const AUTH_PATH = '/api/v1/auth';

export interface IssuedSession {
  access: string;
  refresh: string;
  csrf: string;
}

/** Access cookie scoped to /api, refresh and MFA cookies to /api/v1/auth only; CSRF readable by the web app. */
@Injectable()
export class Cookies {
  private readonly secure: boolean;

  constructor(@Inject(CONFIG) config: Config) {
    this.secure = config.COOKIE_SECURE;
  }

  setSession(reply: FastifyReply, s: IssuedSession): void {
    const base = { httpOnly: true, secure: this.secure, sameSite: 'lax' as const };
    reply.setCookie(COOKIE.access, s.access, { ...base, path: '/api', maxAge: ACCESS_TTL_SECS });
    reply.setCookie(COOKIE.refresh, s.refresh, { ...base, path: AUTH_PATH, maxAge: REFRESH_TTL_SECS });
    reply.setCookie(COOKIE.csrf, s.csrf, {
      httpOnly: false,
      secure: this.secure,
      sameSite: 'strict',
      path: '/',
      maxAge: REFRESH_TTL_SECS,
    });
    this.clearMfa(reply);
  }

  setMfa(reply: FastifyReply, token: string): void {
    reply.setCookie(COOKIE.mfa, token, {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'strict',
      path: AUTH_PATH,
      maxAge: MFA_CHALLENGE_TTL_SECS,
    });
  }

  clearMfa(reply: FastifyReply): void {
    reply.clearCookie(COOKIE.mfa, { path: AUTH_PATH });
  }

  clearAll(reply: FastifyReply): void {
    reply.clearCookie(COOKIE.access, { path: '/api' });
    reply.clearCookie(COOKIE.refresh, { path: AUTH_PATH });
    reply.clearCookie(COOKIE.csrf, { path: '/' });
    this.clearMfa(reply);
  }

  read(req: FastifyRequest, name: (typeof COOKIE)[keyof typeof COOKIE]): string | undefined {
    const v = req.cookies[name];
    return v && v.length < 4096 ? v : undefined;
  }
}
