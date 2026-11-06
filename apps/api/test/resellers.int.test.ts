import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResellerDoc, SubscriberDoc } from '@isp/db-mongo';
import { MAX_LEVEL } from '../src/resellers/resellers.js';
import { roleId, seedTenant, seedUser, signIn, startHarness, type Client, type Harness } from './harness.js';

let h: Harness;
let tenant: ObjectId;
let admin: Client;
let support: Client;
let rUser: Client;
const id: Record<string, string> = {};

const R = '/api/v1/resellers';
const S = '/api/v1/subscribers';
const doc = (x?: string) => h.db.collection<ResellerDoc>('resellers').findOne({ _id: new ObjectId(x!) });
const sub = (x?: string) => h.db.collection<SubscriberDoc>('subscribers').findOne({ _id: new ObjectId(x!) });
const hex = (a: ObjectId[]) => a.map(String);
const customer = (username: string, extra: object = {}) => ({
  username,
  name: `Customer ${username}`,
  phone: '98765 43210',
  address: { line1: '1 Main Rd', city: 'Noida', state: 'UP', pincode: '201301' },
  ...extra,
});

beforeAll(async () => {
  h = await startHarness();
  tenant = await seedTenant(h.db, 'alpha', 'new.example.test');
  admin = await signIn(
    h,
    await seedUser(h, {
      tenantId: tenant,
      email: 'admin@r.in',
      roles: [await roleId(h.db, 'ISP Admin')],
      totp: true,
    }),
  );
  support = await signIn(
    h,
    await seedUser(h, { tenantId: tenant, email: 'sup@r.in', roles: [await roleId(h.db, 'Support')] }),
  );
});
afterAll(() => h?.close());

describe('reseller tree', () => {
  it('builds a tree of any depth with codes, levels and the path above', async () => {
    const l1 = await admin.req('POST', R, { name: 'Noida Net', ownerName: 'Amit', phone: '9811111111' });
    expect(l1.status).toBe(201);
    expect(l1.body).toMatchObject({ code: 'R-0001', level: 1, parentId: null, path: [], status: 'active' });
    id.l1 = l1.body.id;
    const l2 = await admin.req('POST', R, { parentId: id.l1, name: 'Sector 62', ownerName: 'Bina' });
    id.l2 = l2.body.id;
    const l3 = await admin.req('POST', R, { parentId: id.l2, name: 'Block C', ownerName: 'Chetan' });
    id.l3 = l3.body.id;
    expect(l3.body).toMatchObject({ code: 'R-0003', level: 3, parentId: id.l2 });
    expect(l3.body.path.map((p: { code: string }) => p.code)).toEqual(['R-0001', 'R-0002']);
    expect(hex((await doc(id.l3))!.ancestors)).toEqual([id.l1, id.l2]);

    const top = await admin.req('GET', `${R}?parentId=none`);
    expect(top.body.items.map((r: { id: string }) => r.id)).toEqual([id.l1]);
    const kids = await admin.req('GET', `${R}?parentId=${id.l1}`);
    expect(kids.body.items.map((r: { id: string }) => r.id)).toEqual([id.l2]);
    expect((await admin.req('GET', `${R}?q=sector`)).body.items).toHaveLength(1);
  });

  it('rejects an unknown parent, a missing permission and a tree deeper than the limit', async () => {
    expect(
      (await admin.req('POST', R, { parentId: new ObjectId().toHexString(), name: 'x', ownerName: 'y' }))
        .status,
    ).toBe(404);
    expect((await support.req('GET', R)).status).toBe(200);
    expect((await support.req('POST', R, { name: 'x', ownerName: 'y' })).status).toBe(403);

    let parent = id.l3!;
    for (let level = 4; level <= MAX_LEVEL; level++) {
      parent = (await admin.req('POST', R, { parentId: parent, name: `Deep ${level}`, ownerName: 'z' })).body
        .id;
    }
    const tooDeep = await admin.req('POST', R, { parentId: parent, name: 'Too deep', ownerName: 'z' });
    expect(tooDeep.status).toBe(400);
    id.deepest = parent;
  });

  it('customers carry the reseller chain; counts and branch filters follow it', async () => {
    const c = await admin.req('POST', S, customer('c.block', { resellerId: id.l3 }));
    expect(c.status).toBe(201);
    expect(c.body.reseller).toMatchObject({ id: id.l3, code: 'R-0003' });
    id.cBlock = c.body.id;
    expect(hex((await sub(id.cBlock))!.ancestors)).toEqual([id.l1, id.l2, id.l3]);
    id.cDirect = (await admin.req('POST', S, customer('c.direct'))).body.id;

    const l1 = await admin.req('GET', `${R}/${id.l1}`);
    expect(l1.body.counts).toEqual({ subResellers: 1, directCustomers: 0, totalCustomers: 1 });
    const l3 = await admin.req('GET', `${R}/${id.l3}`);
    expect(l3.body.counts).toMatchObject({ subResellers: 1, directCustomers: 1, totalCustomers: 1 });

    const under = await admin.req('GET', `${S}?under=${id.l1}`);
    expect(under.body.items.map((s: { id: string }) => s.id)).toEqual([id.cBlock]);
    const direct = await admin.req('GET', `${S}?resellerId=none`);
    expect(direct.body.items.map((s: { id: string }) => s.id)).toEqual([id.cDirect]);

    const moved = await admin.req('PATCH', `${S}/${id.cDirect}`, { resellerId: id.l2 });
    expect(moved.body.reseller.id).toBe(id.l2);
    expect(hex((await sub(id.cDirect))!.ancestors)).toEqual([id.l1, id.l2]);
  });
});

describe('a reseller sees and manages only its branch', () => {
  beforeAll(async () => {
    const u = await seedUser(h, {
      tenantId: tenant,
      email: 'owner@l2.in',
      type: 'reseller',
      roles: [await roleId(h.db, 'Reseller Owner')],
    });
    await h.db.collection('users').updateOne({ _id: u._id }, { $set: { resellerId: new ObjectId(id.l2) } });
    rUser = await signIn(h, u);
  });

  it('lists itself and below; resellers above are not found', async () => {
    const all = await rUser.req('GET', `${R}?limit=200`);
    const ids = all.body.items.map((r: { id: string }) => r.id);
    expect(ids).toContain(id.l2);
    expect(ids).toContain(id.l3);
    expect(ids).not.toContain(id.l1);
    expect((await rUser.req('GET', `${R}/${id.l1}`)).status).toBe(404);
    const self = await rUser.req('GET', `${R}/${id.l2}`);
    expect(self.body.path).toEqual([]);
  });

  it('adds below itself by default, edits only resellers below it, never credit limits', async () => {
    const child = await rUser.req('POST', R, { name: 'Shop 7', ownerName: 'Dev' });
    expect(child.status).toBe(201);
    expect(child.body).toMatchObject({ parentId: id.l2, level: 3 });
    id.shop = child.body.id;
    expect((await rUser.req('POST', R, { parentId: null, name: 'x', ownerName: 'y' })).status).toBe(403);
    expect((await rUser.req('POST', R, { name: 'x', ownerName: 'y', creditLimitPaise: 100 })).status).toBe(
      403,
    );
    expect((await rUser.req('PATCH', `${R}/${id.l2}`, { name: 'Self edit' })).status).toBe(403);
    expect((await rUser.req('PATCH', `${R}/${id.l3}`, { name: 'Block C (edited)' })).status).toBe(200);
    expect((await rUser.req('PATCH', `${R}/${id.l3}`, { creditLimitPaise: 500 })).status).toBe(403);
    expect((await rUser.req('POST', `${R}/${id.l2}/suspend`, {})).status).toBe(403);
  });

  it('customers it creates belong to it; it cannot make direct ISP customers or see others', async () => {
    const c = await rUser.req('POST', S, customer('c.l2'));
    expect(c.status).toBe(201);
    expect(c.body.reseller.id).toBe(id.l2);
    expect(hex((await sub(c.body.id))!.ancestors)).toEqual([id.l1, id.l2]);
    expect((await rUser.req('POST', S, customer('c.none', { resellerId: null }))).status).toBe(403);
    expect((await rUser.req('POST', S, customer('c.l1', { resellerId: id.l1 }))).status).toBe(404);
    const seen = (await rUser.req('GET', `${S}?limit=200`)).body.items.map(
      (s: { username: string }) => s.username,
    );
    expect(seen).toContain('c.l2');
    expect(seen).toContain('c.block');
  });
});

describe('move, suspend and delete', () => {
  it('moves a whole branch in one go and refuses cycles', async () => {
    expect((await admin.req('POST', `${R}/${id.l1}/move`, { parentId: id.l3 })).status).toBe(400);
    expect((await admin.req('POST', `${R}/${id.l3}/move`, { parentId: id.l3 })).status).toBe(400);

    const m = await admin.req('POST', `${R}/${id.l3}/move`, { parentId: id.l1 });
    expect(m.status).toBe(200);
    expect(m.body).toMatchObject({ parentId: id.l1, level: 2 });
    expect(hex((await sub(id.cBlock))!.ancestors)).toEqual([id.l1, id.l3]);
    const below = await h.db
      .collection<ResellerDoc>('resellers')
      .find({ ancestors: new ObjectId(id.l3) })
      .toArray();
    expect(below.length).toBe(MAX_LEVEL - 3);
    for (const r of below) {
      expect(hex(r.ancestors.slice(0, 2))).toEqual([id.l1, id.l3]);
      expect(r.level).toBe(r.ancestors.length + 1);
    }
    const deepest = await doc(id.deepest!);
    expect(deepest!.level).toBe(MAX_LEVEL - 1);

    // L3 has left L2's branch: L2's owner can no longer see it.
    expect((await rUser.req('GET', `${R}/${id.l3}`)).status).toBe(404);
    expect((await rUser.req('GET', `${S}/${id.cBlock}`)).status).toBe(404);
  });

  it('suspending a reseller blocks sign-in and new customers across its branch', async () => {
    const s = await admin.req('POST', `${R}/${id.l1}/suspend`, { reason: 'dues' });
    expect(s.body).toMatchObject({ status: 'suspended', suspendReason: 'dues' });
    expect((await rUser.req('GET', R)).status).toBe(401);
    expect((await admin.req('GET', `${R}/${id.l2}`)).body.blockedBy).toMatchObject({ id: id.l1 });
    expect((await admin.req('POST', S, customer('c.blocked', { resellerId: id.l3 }))).status).toBe(409);
    expect((await admin.req('POST', R, { parentId: id.l2, name: 'x', ownerName: 'y' })).status).toBe(409);

    await admin.req('POST', `${R}/${id.l1}/activate`);
    expect((await rUser.req('GET', R)).status).toBe(200);
    expect((await admin.req('GET', `${R}/${id.l2}`)).body.blockedBy).toBeNull();
  });

  it('deletes only an empty reseller and disables its sign-ins', async () => {
    expect((await admin.req('DELETE', `${R}/${id.l1}`)).status).toBe(409);
    expect((await admin.req('DELETE', `${R}/${id.deepest}`)).status).toBe(200);
    expect((await admin.req('GET', `${R}/${id.deepest}`)).status).toBe(404);

    const shopUser = await seedUser(h, {
      tenantId: tenant,
      email: 'owner@shop.in',
      type: 'reseller',
      roles: [await roleId(h.db, 'Reseller Owner')],
    });
    await h.db
      .collection('users')
      .updateOne({ _id: shopUser._id }, { $set: { resellerId: new ObjectId(id.shop) } });
    const shop = await signIn(h, shopUser);
    expect((await admin.req('DELETE', `${R}/${id.shop}`)).status).toBe(200);
    expect((await shop.req('GET', R)).status).toBe(401);
    expect((await h.db.collection('users').findOne({ _id: shopUser._id }))!.status).toBe('disabled');
  });
});
