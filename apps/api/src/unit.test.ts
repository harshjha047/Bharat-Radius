import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { normalizeLogin } from './auth/auth.service.js';
import { hashPassword, needsRehash, passwordSchema, verifyPassword } from './auth/passwords.js';
import { Tokens } from './auth/tokens.js';
import { buildOpenApi, listRoutes } from './http/openapi.js';
import { API_PREFIX } from './app.js';

export const testEnv = (over: Record<string, string> = {}) => ({
  NODE_ENV: 'test',
  MONGO_URL: 'mongodb://127.0.0.1:27017/isp_test',
  JWT_SIGNING_KEY: 'j'.repeat(48),
  REFRESH_TOKEN_PEPPER: 'p'.repeat(48),
  FIELD_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  PUBLIC_BASE_URL: 'https://new.example.test',
  ...over,
});

describe('config', () => {
  it('parses with defaults and derives origins', () => {
    const c = loadConfig(testEnv({ ALLOWED_ORIGINS: 'http://localhost:3000' }));
    expect(c.API_PORT).toBe(4100);
    expect([...c.allowedOrigins]).toEqual(['https://new.example.test', 'http://localhost:3000']);
    expect(c.COOKIE_SECURE).toBe(false);
    expect(loadConfig(testEnv({ NODE_ENV: 'production' })).COOKIE_SECURE).toBe(true);
  });

  it('fails fast on weak or missing secrets', () => {
    expect(() => loadConfig(testEnv({ JWT_SIGNING_KEY: 'short' }))).toThrow(/JWT_SIGNING_KEY/);
    const noMongo: Record<string, string | undefined> = testEnv();
    delete noMongo.MONGO_URL;
    expect(() => loadConfig(noMongo)).toThrow(/MONGO_URL/);
  });
});

describe('tokens', () => {
  const t = new Tokens(loadConfig(testEnv()));
  const claims = { sub: 'a'.repeat(24), tid: 'b'.repeat(24), sid: 'fam', ver: 3, mfa: 'ok' as const };

  it('round-trips access tokens and rejects tampering', async () => {
    const jwt = await t.signAccess(claims);
    expect(await t.verifyAccess(jwt)).toEqual(claims);
    const [h, p, s] = jwt.split('.');
    const forged = JSON.parse(Buffer.from(p!, 'base64url').toString());
    forged.ver = 4;
    expect(
      await t.verifyAccess(`${h}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${s}`),
    ).toBeNull();
    const other = new Tokens(loadConfig(testEnv({ JWT_SIGNING_KEY: 'x'.repeat(48) })));
    expect(await other.verifyAccess(jwt)).toBeNull();
  });

  it('keeps MFA challenges and sessions apart', async () => {
    const { token } = await t.signMfa(claims.sub);
    expect(await t.verifyAccess(token)).toBeNull();
    expect(await t.verifyMfa(await t.signAccess(claims))).toBeNull();
    expect((await t.verifyMfa(token))?.sub).toBe(claims.sub);
  });

  it('binds CSRF tokens to the session family', () => {
    const c = t.csrfFor('fam-1');
    expect(t.checkCsrf('fam-1', c)).toBe(true);
    expect(t.checkCsrf('fam-2', c)).toBe(false);
    expect(t.checkCsrf('fam-1', `${c}x`)).toBe(false);
    expect(t.checkCsrf('fam-1', undefined)).toBe(false);
  });

  it('hashes refresh tokens deterministically with the pepper', () => {
    const r = t.newRefreshToken();
    expect(t.hashRefresh(r)).toMatch(/^[0-9a-f]{64}$/);
    expect(t.hashRefresh(r)).toBe(t.hashRefresh(r));
    expect(new Tokens(loadConfig(testEnv({ REFRESH_TOKEN_PEPPER: 'q'.repeat(48) }))).hashRefresh(r)).not.toBe(
      t.hashRefresh(r),
    );
  });
});

describe('passwords', () => {
  it('hashes with argon2id and verifies', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(needsRehash(h)).toBe(false);
    expect(await verifyPassword(h, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
    expect(await verifyPassword(undefined, 'anything')).toBe(false);
    expect(needsRehash('$argon2id$v=19$m=4096,t=3,p=1$x$y')).toBe(true);
  });

  it('enforces the password policy', () => {
    expect(passwordSchema.safeParse('short').success).toBe(false);
    expect(passwordSchema.safeParse('aaaaaaaaaaaa').success).toBe(false);
    expect(passwordSchema.safeParse('Monsoon-Fibre-42').success).toBe(true);
  });
});

describe('login normalisation', () => {
  it('lower-cases email and turns Indian mobiles into E.164', () => {
    expect(normalizeLogin(' Admin@ISP.in ')).toEqual({ email: 'admin@isp.in' });
    expect(normalizeLogin('98765 43210')).toEqual({ phone: '+919876543210' });
    expect(normalizeLogin('+919876543210')).toEqual({ phone: '+919876543210' });
  });
});

describe('route table', () => {
  const routes = listRoutes(API_PREFIX);

  it('every protected route declares a permission, except self-service auth routes', () => {
    for (const r of routes) {
      if (r.opts.auth === 'public' || r.opts.auth === 'portal' || r.path.startsWith('/api/v1/auth/'))
        continue;
      expect(r.opts.permission, `${r.method} ${r.path}`).toBeDefined();
    }
  });

  it('customer (portal) sessions reach only /portal routes, and /portal routes take only customers', () => {
    for (const r of routes) {
      const portalPath = r.path.startsWith('/api/v1/portal/');
      if (r.opts.auth === 'portal') expect(portalPath, `${r.method} ${r.path}`).toBe(true);
      if (portalPath) expect(['portal', 'public'], `${r.method} ${r.path}`).toContain(r.opts.auth);
    }
  });

  it('every :id route validates its params', () => {
    for (const r of routes.filter((x) => x.path.includes(':')))
      expect(r.opts.params, `${r.method} ${r.path}`).toBeDefined();
  });

  it('builds a valid-looking OpenAPI document', () => {
    const doc = buildOpenApi(API_PREFIX, 't');
    expect(doc.paths['/api/v1/users/{id}']).toHaveProperty('patch');
    expect(doc.paths['/api/v1/auth/login']).toHaveProperty('post');
    expect(Object.keys(doc.paths).length).toBeGreaterThan(8);
  });
});
