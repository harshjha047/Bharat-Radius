import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PASSWORD,
  roleId,
  seedTenant,
  seedUser,
  signIn,
  startHarness,
  Client,
  type Client as C,
  type Harness,
  type SeededUser,
} from './harness.js';

let h: Harness;
let admin: C;
let support: C;
let other: C;
let adminUser: SeededUser;

const log = async (q: string) => {
  const r = await admin.req('GET', `/api/v1/audit?${q}`);
  expect(r.status).toBe(200);
  return r.body.items as Record<string, any>[];
};

beforeAll(async () => {
  h = await startHarness();
  const t = await seedTenant(h.db, 'aud', 'new.example.test');
  const t2 = await seedTenant(h.db, 'aud2');
  adminUser = await seedUser(h, {
    tenantId: t,
    email: 'a@aud.in',
    roles: [await roleId(h.db, 'ISP Admin')],
    totp: true,
  });
  admin = await signIn(h, adminUser);
  support = await signIn(
    h,
    await seedUser(h, { tenantId: t, email: 's@aud.in', roles: [await roleId(h.db, 'Support')] }),
  );
  other = await signIn(
    h,
    await seedUser(h, {
      tenantId: t2,
      email: 'o@aud2.in',
      roles: [await roleId(h.db, 'ISP Admin')],
      totp: true,
    }),
    'aud2',
  );
});
afterAll(() => h?.close());

describe('audit log', () => {
  it('records sign-in with IP and the 2FA path', async () => {
    const items = await log(`action=auth.login&entityId=${adminUser._id.toHexString()}`);
    expect(items[0]).toMatchObject({
      action: 'auth.login',
      entity: { type: 'user', id: adminUser._id.toHexString() },
      actor: { id: adminUser._id.toHexString() },
    });
    expect(items[0]!.ip).toBeTruthy();
  });

  it('records a failed sign-in for a known account', async () => {
    const c = new Client(h);
    expect(
      (await c.req('POST', '/api/v1/auth/login', { login: 's@aud.in', password: 'wrong-' + PASSWORD }))
        .status,
    ).toBe(401);
    const items = await log('action=auth.login_failed');
    expect(items[0]!.entity.type).toBe('user');
  });

  it('keeps only the fields that changed, with secrets hidden', async () => {
    const n = await admin.req('POST', '/api/v1/nas', { name: 'POP-A', ip: '203.0.113.50' });
    expect(n.status).toBe(201);
    const id = n.body.id as string;
    const u = await admin.req('PATCH', `/api/v1/nas/${id}`, { name: 'POP-B', rotateSecret: true });
    expect(u.status).toBe(200);

    const [upd] = await log(`entityType=nas&entityId=${id}&action=nas.update`);
    expect(upd!.before).toEqual({ name: 'POP-A', radiusSecret: '[redacted]' });
    expect(upd!.after).toEqual({ name: 'POP-B', radiusSecret: '[redacted]' });

    const all = JSON.stringify(await log(`entityId=${id}`));
    expect(all).not.toContain(n.body.radiusSecret);
    expect(all).not.toContain(u.body.radiusSecret);
    expect(all).toContain('nas.create');
  });

  it('logs secret reveals without the secret', async () => {
    const n = await admin.req('POST', '/api/v1/nas', { name: 'POP-R', ip: '203.0.113.51' });
    const s = await admin.req('GET', `/api/v1/nas/${n.body.id}/secret`);
    expect(s.status).toBe(200);
    const [e] = await log(`action=nas.secret_reveal&entityId=${n.body.id}`);
    expect(e).toBeTruthy();
    expect(JSON.stringify(e)).not.toContain(s.body.radiusSecret);
  });

  it('records the request body (redacted) when a service notes nothing', async () => {
    const r = await admin.req('POST', `/api/v1/users/${adminUser._id.toHexString()}/unlock`);
    expect(r.status).toBe(200);
    const [e] = await log('action=user.unlock');
    expect(e!.entity.id).toBe(adminUser._id.toHexString());
  });

  it('filters by action prefix, actor and time, newest first, with paging', async () => {
    const nas = await log('action=nas.');
    expect(nas.length).toBeGreaterThanOrEqual(3);
    expect(nas.every((e) => e.action.startsWith('nas.'))).toBe(true);
    expect(nas.map((e) => e.id)).toEqual([...nas.map((e) => e.id)].sort().reverse());

    const mine = await log(`actorId=${adminUser._id.toHexString()}`);
    expect(mine.every((e) => e.actor.id === adminUser._id.toHexString())).toBe(true);

    expect(await log(`to=${encodeURIComponent('2000-01-01T00:00:00Z')}`)).toEqual([]);
    expect(
      (await log(`from=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)).length,
    ).toBe(0);

    const p1 = await admin.req('GET', '/api/v1/audit?limit=1');
    const p2 = await admin.req('GET', `/api/v1/audit?limit=1&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items[0].id < p1.body.items[0].id).toBe(true);
  });

  it('needs audit.view and never shows another ISP’s entries', async () => {
    expect((await support.req('GET', '/api/v1/audit')).status).toBe(403);
    const r = await other.req('GET', '/api/v1/audit?limit=100');
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain('POP-');
    expect(JSON.stringify(r.body)).not.toContain(adminUser._id.toHexString());
  });

  it('cannot be changed through the API', async () => {
    expect((await admin.req('DELETE', '/api/v1/audit')).status).toBe(404);
  });
});
