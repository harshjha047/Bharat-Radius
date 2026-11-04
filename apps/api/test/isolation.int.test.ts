import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RoleDoc, UserDoc } from '@isp/db-mongo';
import { API_PREFIX } from '../src/app.js';
import { listRoutes } from '../src/http/openapi.js';
import { Client, roleId, seedTenant, seedUser, signIn, startHarness, type Harness } from './harness.js';

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
};

const BODIES: Record<string, unknown> = {
  'PATCH /api/v1/users/:id': { name: 'Changed by B' },
  'POST /api/v1/users/:id/password': { password: 'Changed-By-Tenant-B-1' },
  'PATCH /api/v1/roles/:id': { name: 'Changed by B' },
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
  const [u, r] = await Promise.all([
    h.db.collection('users').findOne({ _id: new ObjectId(ids.userA) }),
    h.db.collection('roles').findOne({ _id: new ObjectId(ids.roleA) }),
  ]);
  return JSON.stringify([u, r]);
}
