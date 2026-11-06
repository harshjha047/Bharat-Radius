import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RoleDoc, UserDoc } from '@isp/db-mongo';
import { API_PREFIX } from '../src/app.js';
import { listRoutes } from '../src/http/openapi.js';
import {
  Client,
  roleId,
  seedNas,
  seedPlan,
  seedSubscriber,
  seedTenant,
  seedUser,
  signIn,
  startHarness,
  type Harness,
} from './harness.js';

/**
 * Cross-tenant harness (WP 2.2, TRD §8.2): every route that addresses a record by id is called by tenant B's
 * administrator with an id that belongs to tenant A, and must answer 404 and change nothing.
 * Adding an :id route without a fixture here fails the suite, so isolation coverage grows with the API.
 */

let h: Harness;
let bAdmin: Client;
const ids: Record<string, string> = {};

const FIXTURES: Record<string, keyof typeof ids> = {
  '/api/v1/users/:id': 'userA',
  '/api/v1/users/:id/unlock': 'userA',
  '/api/v1/users/:id/password': 'userA',
  '/api/v1/users/:id/reset-2fa': 'userA',
  '/api/v1/roles/:id': 'roleA',
  '/api/v1/tenants/:id': 'tenantA',
  '/api/v1/nas/:id': 'nasA',
  '/api/v1/nas/:id/secret': 'nasA',
  '/api/v1/plans/:id': 'planA',
  '/api/v1/subscribers/:id': 'subA',
  '/api/v1/subscribers/:id/suspend': 'subA',
  '/api/v1/subscribers/:id/activate': 'subA',
  '/api/v1/subscribers/:id/kick': 'subA',
  '/api/v1/subscribers/:id/password': 'subA',
  '/api/v1/subscribers/:id/coa-log': 'subA',
  '/api/v1/subscribers/:id/sessions': 'subA',
  '/api/v1/subscribers/:id/auth-log': 'subA',
  '/api/v1/subscribers/:id/usage': 'subA',
  '/api/v1/subscribers/imports/:id': 'importA',
  '/api/v1/resellers/:id': 'resellerA',
  '/api/v1/resellers/:id/suspend': 'resellerA',
  '/api/v1/resellers/:id/activate': 'resellerA',
  '/api/v1/resellers/:id/move': 'resellerA',
  '/api/v1/subscribers/imports/:id/errors': 'importA',
};

const BODIES: Record<string, unknown> = {
  'PATCH /api/v1/users/:id': { name: 'Changed by B' },
  'POST /api/v1/users/:id/password': { password: 'Changed-By-Tenant-B-1' },
  'PATCH /api/v1/roles/:id': { name: 'Changed by B' },
  'PATCH /api/v1/tenants/:id': { name: 'Changed by B' },
  'PATCH /api/v1/nas/:id': { name: 'Changed by B' },
  'PATCH /api/v1/plans/:id': { name: 'Changed by B' },
  'PATCH /api/v1/subscribers/:id': { name: 'Changed by B' },
  'POST /api/v1/subscribers/:id/suspend': {},
  'PATCH /api/v1/resellers/:id': { name: 'Changed by B' },
  'POST /api/v1/resellers/:id/suspend': {},
  'POST /api/v1/resellers/:id/move': { parentId: null },
};

beforeAll(async () => {
  h = await startHarness();
  const a = await seedTenant(h.db, 'alpha');
  const b = await seedTenant(h.db, 'bravo');
  const adminRole = await roleId(h.db, 'ISP Admin');
  const userA = await seedUser(h, {
    tenantId: a,
    email: 'staff@alpha.in',
    roles: [await roleId(h.db, 'Support')],
  });
  const roleA = await h.db.collection<RoleDoc>('roles').insertOne({
    _id: new ObjectId(),
    tenantId: a,
    name: 'Alpha only',
    scope: 'tenant',
    permissions: ['subscribers.read'],
    builtIn: false,
    requireMfa: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  ids.userA = userA._id.toHexString();
  ids.roleA = roleA.insertedId.toHexString();
  ids.tenantA = a.toHexString();
  ids.nasA = (await seedNas(h, a, '10.10.0.1')).toHexString();
  ids.planA = (await seedPlan(h, a, 'Alpha 50M')).toHexString();
  ids.subA = (await seedSubscriber(h, a, 'alpha-user')).toHexString();
  const importA = new ObjectId();
  await h.db.collection('import_batches').insertOne({
    _id: importA,
    tenantId: a,
    source: 'excel',
    fileName: 'a.xlsx',
    status: 'done',
    counts: { read: 0, valid: 0, created: 0, failed: 0 },
    errors: [],
    createdBy: 'test',
    createdAt: new Date(),
  });
  ids.importA = importA.toHexString();
  const resellerA = new ObjectId();
  await h.db.collection('resellers').insertOne({
    _id: resellerA,
    tenantId: a,
    parentId: null,
    ancestors: [],
    level: 1,
    code: 'R-0001',
    name: 'Alpha reseller',
    ownerName: 'A',
    creditLimitPaise: 0,
    canCreateSubResellers: true,
    status: 'active',
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: 'test',
    updatedBy: 'test',
  });
  ids.resellerA = resellerA.toHexString();
  const adminB = await seedUser(h, { tenantId: b, email: 'admin@bravo.in', roles: [adminRole], totp: true });
  bAdmin = await signIn(h, adminB, 'bravo');
});
afterAll(() => h?.close());

describe('tenant isolation', () => {
  const routes = listRoutes(API_PREFIX).filter((r) => r.path.includes('/:'));

  it('every :id route has a fixture', () => {
    const missing = routes.map((r) => r.path).filter((p) => !FIXTURES[p]);
    expect(missing).toEqual([]);
  });

  for (const r of routes) {
    it(`${r.method} ${r.path} → 404 for another tenant`, async () => {
      const id = ids[FIXTURES[r.path]!]!;
      const before = await snapshot();
      const res = await bAdmin.req(
        r.method as 'GET',
        r.path.replace(':id', id),
        BODIES[`${r.method} ${r.path}`],
      );
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(await snapshot()).toEqual(before);
    });
  }

  it('lists never include another tenant’s routers or plans', async () => {
    const nas = await bAdmin.req('GET', '/api/v1/nas');
    expect(nas.body.items.map((x: { id: string }) => x.id)).not.toContain(ids.nasA);
    const plans = await bAdmin.req('GET', '/api/v1/plans');
    expect(plans.body.items.map((x: { id: string }) => x.id)).not.toContain(ids.planA);
    expect((await bAdmin.req('GET', '/api/v1/tenants')).status).toBe(404);
  });

  it('subscriber search never returns another tenant’s subscribers; the same username is allowed per ISP', async () => {
    const r = await bAdmin.req('GET', '/api/v1/subscribers?q=alpha');
    expect(r.body.items).toEqual([]);
    const plan = await bAdmin.req('POST', '/api/v1/plans', {
      name: 'B plan',
      downloadKbps: 10_000,
      uploadKbps: 10_000,
      pricePaise: 100,
    });
    const created = await bAdmin.req('POST', '/api/v1/subscribers', {
      username: 'alpha-user',
      name: 'Bravo customer',
      phone: '9812345678',
      address: { line1: 'x', city: 'Delhi', state: 'Delhi', pincode: '110001' },
      planId: plan.body.id,
    });
    expect(created.status).toBe(201);
  });

  it('a router IP is unique across ISPs', async () => {
    const r = await bAdmin.req('POST', '/api/v1/nas', { name: 'dup', ip: '10.10.0.1' });
    expect(r.status).toBe(409);
  });

  it('lists never include another tenant’s rows', async () => {
    const users = await bAdmin.req('GET', '/api/v1/users');
    expect(users.status).toBe(200);
    expect(users.body.items.map((u: { id: string }) => u.id)).not.toContain(ids.userA);
    const roles = await bAdmin.req('GET', '/api/v1/roles');
    expect(roles.body.map((x: { id: string }) => x.id)).not.toContain(ids.roleA);
    expect(roles.body.some((x: { name: string }) => x.name === 'ISP Admin')).toBe(true);
  });

  it('cannot attach another tenant’s role to its own user', async () => {
    const r = await bAdmin.req('POST', '/api/v1/users', {
      name: 'B staff',
      email: 'staff@bravo.in',
      password: 'Bravo-Staff-Pass-1',
      roleIds: [ids.roleA],
    });
    expect(r.status).toBe(400);
  });

  it('cannot create a user in another tenant by passing tenantId', async () => {
    const r = await bAdmin.req('POST', '/api/v1/users', {
      tenantId: (await h.db.collection('tenants').findOne({ slug: 'alpha' }))!._id.toHexString(),
      name: 'Planted',
      email: 'planted@alpha.in',
      password: 'Planted-Pass-123',
    });
    expect(r.status).toBe(201);
    const planted = await h.db.collection<UserDoc>('users').findOne({ email: 'planted@alpha.in' });
    const bravo = await h.db.collection('tenants').findOne({ slug: 'bravo' });
    expect(planted?.tenantId?.equals(bravo!._id)).toBe(true);
  });
});

async function snapshot() {
  const docs = await Promise.all(
    (
      [
        ['users', 'userA'],
        ['roles', 'roleA'],
        ['tenants', 'tenantA'],
        ['nas_devices', 'nasA'],
        ['plans', 'planA'],
        ['subscribers', 'subA'],
        ['resellers', 'resellerA'],
      ] as const
    ).map(([c, k]) => h.db.collection(c).findOne({ _id: new ObjectId(ids[k]) })),
  );
  const outbox = await h.db.collection('outbox').countDocuments({});
  return JSON.stringify([docs, outbox]);
}
