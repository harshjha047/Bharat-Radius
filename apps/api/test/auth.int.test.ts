import type { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RefreshTokenDoc, UserDoc } from '@isp/db-mongo';
import {
  Client,
  PASSWORD,
  roleId,
  seedTenant,
  seedUser,
  signIn,
  startHarness,
  totpNow,
  type Harness,
  type SeededUser,
} from './harness.js';

let h: Harness;
let tenantA: ObjectId;
let admin: SeededUser;
let support: SeededUser;

const users = () => h.db.collection<UserDoc>('users');

beforeAll(async () => {
  h = await startHarness();
  tenantA = await seedTenant(h.db, 'alpha', 'new.example.test');
  admin = await seedUser(h, {
    tenantId: tenantA,
    email: 'admin@alpha.in',
    roles: [await roleId(h.db, 'ISP Admin')],
    totp: true,
  });
  support = await seedUser(h, {
    tenantId: tenantA,
    email: 'support@alpha.in',
    roles: [await roleId(h.db, 'Support')],
  });
});
afterAll(() => h?.close());

describe('health and errors', () => {
  it('healthz reports mongo, livez answers, unknown routes use the error format', async () => {
    const c = new Client(h);
    const hz = await c.req('GET', '/healthz');
    expect(hz.status).toBe(200);
    expect(hz.body.checks.mongo.ok).toBe(true);
    expect((await c.req('GET', '/livez')).status).toBe(200);
    const nf = await c.req('GET', '/api/v1/nope');
    expect(nf.status).toBe(404);
    expect(nf.body.error).toMatchObject({ code: 'NOT_FOUND' });
    expect(nf.headers['x-request-id']).toBeTruthy();
  });

  it('echoes a caller request id and reports validation issues', async () => {
    const r = await new Client(h).req(
      'POST',
      '/api/v1/auth/login',
      { login: 'x' },
      { 'x-request-id': 'req-12345678' },
    );
    expect(r.status).toBe(400);
    expect(r.headers['x-request-id']).toBe('req-12345678');
    expect(r.body.error.code).toBe('VALIDATION_FAILED');
    expect(r.body.error.details.issues.map((i: { path: string }) => i.path)).toEqual(
      expect.arrayContaining(['login', 'password']),
    );
  });

  it('serves the OpenAPI document', async () => {
    const r = await new Client(h).req('GET', '/api/v1/openapi.json');
    expect(r.status).toBe(200);
    expect(r.body.paths['/api/v1/users/{id}']).toBeDefined();
  });
});

describe('sign-in', () => {
  it('rejects a wrong password with a generic error and no cookies', async () => {
    const c = new Client(h);
    const r = await c.req('POST', '/api/v1/auth/login', { login: support.email, password: 'wrong-password' });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(c.jar.size).toBe(0);
    const unknown = await c.req('POST', '/api/v1/auth/login', {
      login: 'nobody@alpha.in',
      password: 'wrong-password',
    });
    expect(unknown.body.error.code).toBe('INVALID_CREDENTIALS');
    await users().updateOne({ _id: support._id }, { $set: { failedLogins: 0 } });
  });

  it('a role without 2FA gets a full session; tenant comes from the host', async () => {
    const c = await signIn(h, support);
    const me = await c.req('GET', '/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(support.email);
    expect(me.body.permissions).toContain('subscribers.read');
    expect(me.body.permissions).not.toContain('users.write');
  });

  it('password + TOTP; a code cannot be used twice', async () => {
    const c = new Client(h);
    const r = await c.req('POST', '/api/v1/auth/login', { login: admin.email, password: PASSWORD });
    expect(r.body.status).toBe('mfa_required');
    expect(c.jar.has('isp_at')).toBe(false);
    await users().updateOne({ _id: admin._id }, { $unset: { 'totp.lastUsedStep': '' } });
    const code = totpNow(admin.totpSecret!);
    expect((await c.req('POST', '/api/v1/auth/2fa/verify', { code })).status).toBe(200);
    expect((await c.req('GET', '/api/v1/auth/me')).status).toBe(200);

    const c2 = new Client(h);
    await c2.req('POST', '/api/v1/auth/login', { login: admin.email, password: PASSWORD });
    const replay = await c2.req('POST', '/api/v1/auth/2fa/verify', { code });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('MFA_INVALID');
    await users().updateOne({ _id: admin._id }, { $set: { failedLogins: 0 } });
  });

  it('a 2FA-required role without 2FA must enrol before doing anything else', async () => {
    const fresh = await seedUser(h, {
      tenantId: tenantA,
      email: 'newadmin@alpha.in',
      roles: [await roleId(h.db, 'ISP Admin')],
    });
    const c = new Client(h);
    const r = await c.req('POST', '/api/v1/auth/login', { login: fresh.email, password: PASSWORD });
    expect(r.body.status).toBe('mfa_enroll_required');
    const blocked = await c.req('GET', '/api/v1/users');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('MFA_ENROLLMENT_REQUIRED');

    const setup = await c.req('POST', '/api/v1/auth/2fa/setup');
    expect(setup.status).toBe(200);
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    const bad = await c.req('POST', '/api/v1/auth/2fa/enable', { code: '000000' });
    expect(bad.status).toBe(400);
    const ok = await c.req('POST', '/api/v1/auth/2fa/enable', { code: totpNow(setup.body.secret) });
    expect(ok.body.status).toBe('ok');
    expect((await c.req('GET', '/api/v1/users')).status).toBe(200);
    const stored = await users().findOne({ _id: fresh._id });
    expect(stored?.totp?.enabled).toBe(true);
    expect(JSON.stringify(stored?.totp)).not.toContain(setup.body.secret);
  });

  it('locks the account after 5 failures, even for the right password', async () => {
    const victim = await seedUser(h, {
      tenantId: tenantA,
      email: 'victim@alpha.in',
      roles: [await roleId(h.db, 'Support')],
    });
    const c = new Client(h);
    for (let i = 0; i < 5; i++) {
      expect(
        (await c.req('POST', '/api/v1/auth/login', { login: victim.email, password: `bad-${i}-password` }))
          .status,
      ).toBe(401);
    }
    const locked = await c.req('POST', '/api/v1/auth/login', { login: victim.email, password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);

    const adminC = await signIn(h, admin);
    expect((await adminC.req('POST', `/api/v1/users/${victim._id.toHexString()}/unlock`)).status).toBe(200);
    expect(
      (await c.req('POST', '/api/v1/auth/login', { login: victim.email, password: PASSWORD })).status,
    ).toBe(200);
  });
});

describe('sessions', () => {
  it('refresh rotates the token; reusing an old one after the grace window kills the family', async () => {
    const c = await signIn(h, support);
    const oldRt = c.jar.get('isp_rt')!;
    expect((await c.req('POST', '/api/v1/auth/refresh')).status).toBe(200);
    expect(c.jar.get('isp_rt')).not.toBe(oldRt);

    await h.db
      .collection<RefreshTokenDoc>('refresh_tokens')
      .updateMany({ revokedReason: 'rotated' }, { $set: { revokedAt: new Date(Date.now() - 60_000) } });
    const thief = new Client(h);
    thief.jar.set('isp_rt', oldRt);
    expect((await thief.req('POST', '/api/v1/auth/refresh')).status).toBe(401);
    expect((await c.req('POST', '/api/v1/auth/refresh')).status).toBe(401);
  });

  it('two tabs refreshing at once both keep working (grace window)', async () => {
    const a = await signIn(h, support);
    const b = new Client(h);
    for (const [k, v] of a.jar) b.jar.set(k, v);
    const [ra, rb] = await Promise.all([
      a.req('POST', '/api/v1/auth/refresh'),
      b.req('POST', '/api/v1/auth/refresh'),
    ]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
  });

  it('unsafe requests need the session CSRF token and an allowed Origin', async () => {
    const c = await signIn(h, admin);
    const ok = await c.req('POST', '/api/v1/roles', {
      name: 'Field',
      scope: 'tenant',
      permissions: ['subscribers.read'],
    });
    expect(ok.status).toBe(201);
    const noCsrf = await c.req(
      'POST',
      '/api/v1/roles',
      { name: 'Field2', scope: 'tenant', permissions: ['subscribers.read'] },
      {
        'x-csrf-token': 'x.y',
      },
    );
    expect(noCsrf.body.error.code).toBe('CSRF_FAILED');
    const evil = new Client(h, 'https://evil.example');
    for (const [k, v] of c.jar) evil.jar.set(k, v);
    const cross = await evil.req('POST', '/api/v1/roles', {
      name: 'Field3',
      scope: 'tenant',
      permissions: ['subscribers.read'],
    });
    expect(cross.body.error.code).toBe('CSRF_FAILED');
  });

  it('disabling a user ends their sessions at the next request', async () => {
    const u = await seedUser(h, {
      tenantId: tenantA,
      email: 'temp@alpha.in',
      roles: [await roleId(h.db, 'Support')],
    });
    const victim = await signIn(h, u);
    const adminC = await signIn(h, admin);
    expect(
      (await adminC.req('PATCH', `/api/v1/users/${u._id.toHexString()}`, { status: 'disabled' })).status,
    ).toBe(200);
    expect((await victim.req('GET', '/api/v1/auth/me')).status).toBe(401);
    expect((await victim.req('POST', '/api/v1/auth/refresh')).status).toBe(401);
  });

  it('password change signs out other devices but keeps this one', async () => {
    const u = await seedUser(h, {
      tenantId: tenantA,
      email: 'pw@alpha.in',
      roles: [await roleId(h.db, 'Support')],
    });
    const one = await signIn(h, u);
    const two = await signIn(h, u);
    const r = await one.req('POST', '/api/v1/auth/password', {
      currentPassword: PASSWORD,
      newPassword: 'Another-Strong-77',
    });
    expect(r.status).toBe(200);
    expect((await one.req('GET', '/api/v1/auth/me')).status).toBe(200);
    expect((await two.req('GET', '/api/v1/auth/me')).status).toBe(401);
  });

  it('logout revokes the refresh token', async () => {
    const c = await signIn(h, support);
    const rt = c.jar.get('isp_rt')!;
    expect((await c.req('POST', '/api/v1/auth/logout')).status).toBe(200);
    const again = new Client(h);
    again.jar.set('isp_rt', rt);
    expect((await again.req('POST', '/api/v1/auth/refresh')).status).toBe(401);
  });
});

describe('authorization', () => {
  it('permission checks per route', async () => {
    const c = await signIn(h, support);
    const r = await c.req('GET', '/api/v1/users');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('FORBIDDEN');
  });

  it('no privilege escalation through roles', async () => {
    const custom = await h.db.collection('roles').insertOne({
      tenantId: tenantA,
      name: 'User manager',
      scope: 'tenant',
      permissions: ['users.read', 'users.write'],
      builtIn: false,
      requireMfa: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const mgr = await seedUser(h, { tenantId: tenantA, email: 'mgr@alpha.in', roles: [custom.insertedId] });
    const c = await signIn(h, mgr);
    const adminRole = (await roleId(h.db, 'ISP Admin')).toHexString();
    const escalate = await c.req('POST', '/api/v1/users', {
      name: 'Sneaky',
      email: 'sneaky@alpha.in',
      password: 'Sneaky-Password-1',
      roleIds: [adminRole],
    });
    expect(escalate.status).toBe(403);
    const resetAdmin = await c.req('POST', `/api/v1/users/${admin._id.toHexString()}/password`, {
      password: 'Hijacked-Pass-99',
    });
    expect(resetAdmin.status).toBe(403);
    const self = await c.req('PATCH', `/api/v1/users/${mgr._id.toHexString()}`, { roleIds: [adminRole] });
    expect(self.status).toBe(403);
  });

  it('built-in roles cannot be edited', async () => {
    const c = await signIn(h, admin);
    const r = await c.req('PATCH', `/api/v1/roles/${(await roleId(h.db, 'Support')).toHexString()}`, {
      name: 'x',
    });
    expect(r.status).toBe(403);
  });
});

describe('roles', () => {
  it('a partial role update keeps the fields it does not mention', async () => {
    const c = await signIn(h, admin);
    const created = await c.req('POST', '/api/v1/roles', {
      name: 'Night shift',
      scope: 'tenant',
      permissions: ['subscribers.read'],
      requireMfa: true,
    });
    expect(created.status).toBe(201);
    const upd = await c.req('PATCH', `/api/v1/roles/${created.body.id}`, { name: 'Night shift 2' });
    expect(upd.body).toMatchObject({
      name: 'Night shift 2',
      requireMfa: true,
      permissions: ['subscribers.read'],
    });
  });
});

describe('preferences', () => {
  it('each user saves which dashboard widgets they hide', async () => {
    const c = await signIn(h, support);
    expect((await c.req('GET', '/api/v1/me/preferences')).body).toEqual({ dashboardHidden: [] });
    const put = await c.req('PUT', '/api/v1/me/preferences', {
      dashboardHidden: ['trends', 'kpi-plans', 'trends'],
    });
    expect(put.status).toBe(200);
    expect(put.body.dashboardHidden).toEqual(['trends', 'kpi-plans']);
    expect((await c.req('GET', '/api/v1/me/preferences')).body.dashboardHidden).toEqual([
      'trends',
      'kpi-plans',
    ]);
    expect((await c.req('PUT', '/api/v1/me/preferences', { dashboardHidden: ['Bad Id'] })).status).toBe(400);
  });
});
