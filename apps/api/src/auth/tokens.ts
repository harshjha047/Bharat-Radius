import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { SignJWT, errors as joseErrors, jwtVerify } from 'jose';
import { CONFIG, type Config } from '../config.js';

export const ACCESS_TTL_SECS = 15 * 60;
export const REFRESH_TTL_SECS = 30 * 24 * 3600;
export const MFA_CHALLENGE_TTL_SECS = 5 * 60;

export interface AccessClaims {
  sub: string;
  tid: string | null;
  sid: string;
  ver: number;
  mfa: 'ok' | 'enroll';
}

export interface MfaClaims {
  sub: string;
  jti: string;
}

const ISS = 'isp-api';

const b64url = (b: Buffer) => b.toString('base64url');

@Injectable()
export class Tokens {
  private readonly key: Uint8Array;
  private readonly pepper: Buffer;

  constructor(@Inject(CONFIG) config: Config) {
    this.key = new TextEncoder().encode(config.JWT_SIGNING_KEY);
    this.pepper = Buffer.from(config.REFRESH_TOKEN_PEPPER);
  }

  signAccess(c: AccessClaims): Promise<string> {
    return new SignJWT({ tid: c.tid, sid: c.sid, ver: c.ver, mfa: c.mfa })
      .setProtectedHeader({ alg: 'HS512' })
      .setSubject(c.sub)
      .setIssuer(ISS)
      .setAudience('isp-session')
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TTL_SECS}s`)
      .sign(this.key);
  }

  async verifyAccess(token: string): Promise<AccessClaims | null> {
    try {
      const { payload: p } = await jwtVerify(token, this.key, {
        issuer: ISS,
        audience: 'isp-session',
        algorithms: ['HS512'],
        clockTolerance: 5,
      });
      if (
        typeof p.sub !== 'string' ||
        typeof p.sid !== 'string' ||
        typeof p.ver !== 'number' ||
        (p.mfa !== 'ok' && p.mfa !== 'enroll') ||
        (p.tid !== null && typeof p.tid !== 'string')
      ) {
        return null;
      }
      return { sub: p.sub, tid: p.tid as string | null, sid: p.sid, ver: p.ver, mfa: p.mfa };
    } catch (e) {
      if (e instanceof joseErrors.JOSEError) return null;
      throw e;
    }
  }

  signMfa(sub: string): Promise<{ token: string; jti: string }> {
    const jti = b64url(randomBytes(16));
    return new SignJWT({})
      .setProtectedHeader({ alg: 'HS512' })
      .setSubject(sub)
      .setJti(jti)
      .setIssuer(ISS)
      .setAudience('isp-mfa')
      .setIssuedAt()
      .setExpirationTime(`${MFA_CHALLENGE_TTL_SECS}s`)
      .sign(this.key)
      .then((token) => ({ token, jti }));
  }

  async verifyMfa(token: string): Promise<MfaClaims | null> {
    try {
      const { payload: p } = await jwtVerify(token, this.key, {
        issuer: ISS,
        audience: 'isp-mfa',
        algorithms: ['HS512'],
      });
      return typeof p.sub === 'string' && typeof p.jti === 'string' ? { sub: p.sub, jti: p.jti } : null;
    } catch (e) {
      if (e instanceof joseErrors.JOSEError) return null;
      throw e;
    }
  }

  newRefreshToken(): string {
    return b64url(randomBytes(32));
  }

  /** Peppered HMAC: a database dump alone cannot be replayed as cookies. */
  hashRefresh(token: string): string {
    return createHmac('sha256', this.pepper).update(token).digest('hex');
  }

  /** CSRF token bound to the session family, so a token planted by a sibling subdomain is useless. */
  csrfFor(familyId: string): string {
    const nonce = b64url(randomBytes(16));
    return `${nonce}.${this.csrfMac(familyId, nonce)}`;
  }

  checkCsrf(familyId: string, token: string | undefined): boolean {
    if (!token) return false;
    const [nonce, mac] = token.split('.');
    if (!nonce || !mac) return false;
    const want = Buffer.from(this.csrfMac(familyId, nonce));
    const got = Buffer.from(mac);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  private csrfMac(familyId: string, nonce: string): string {
    return createHmac('sha256', this.key).update(`csrf:${familyId}:${nonce}`).digest('base64url');
  }
}
