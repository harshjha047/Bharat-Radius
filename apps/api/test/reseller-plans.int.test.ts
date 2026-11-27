import writeXlsxFile, { type SheetData } from 'write-excel-file/node';
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlanDoc, WalletDoc } from '@isp/db-mongo';
import { PLAN_COLUMNS } from '../src/network/plans-excel.js';
import { XLSX_MIME } from '../src/subscribers/excel.js';
import {
  roleId,
  seedTenant,
  seedUser,
  selectPlans,
  signIn,
  startHarness,
  type Client,
  type Harness,
} from './harness.js';

let h: Harness;
let tenant: ObjectId;
let admin: Client;
let r1: Client; // top-level reseller, bulk import on
let r2: Client; // sub-reseller of r1
let rb: Client; // another top-level reseller, bulk import on
const id: Record<string, string> = {};
const R = '/api/v1/resellers';
const P = '/api/v1/plans';
let keyN = 0;
const key = () => ({ 'idempotency-key': `plans-key-${Date.now()}-${keyN++}` });

const plan = (name: string) => ({ name, downloadKbps: 40_000, uploadKbps: 40_000, pricePaise: 50_000 });
const customer = (username: string, extra: object = {}) => ({
  username,
  name: `Customer ${username}`,
  phone: '98765 43210',
  address: { line1: '1 Main Rd', city: 'Seppa', state: 'Arunachal Pradesh', pincode: '790102' },
  ...extra,
});
const names = async (c: Client) =>
  ((await c.req('GET', `${P}?limit=100`)).body.items as { name: string }[]).map((p) => p.name).sort();
const resellerUser = async (email: string, resellerId: string) => {
  const u = await seedUser(h, {
    tenantId: tenant,
    email,
    type: 'reseller',
    roles: [await roleId(h.db, 'Reseller Owner')],
  });
  await h.db
    .collection('users')
    .updateOne({ _id: u._id }, { $set: { resellerId: new ObjectId(resellerId) } });
  return signIn(h, u);
};

beforeAll(async () => {
  h = await startHarness();
  tenant = await seedTenant(h.db, 'rplans', 'new.example.test');
  admin = await signIn(
    h,
    await seedUser(h, {
      tenantId: tenant,
      email: 'admin@rplans.in',
      roles: [await roleId(h.db, 'ISP Admin')],
      totp: true,
    }),
  );
  id.ispPlan = (await admin.req('POST', P, plan('ISP 50'))).body.id;
  id.l1 = (await admin.req('POST', R, { name: 'Xtreme Fiber', ownerName: 'Tana' })).body.id;
  id.l2 = (await admin.req('POST', R, { parentId: id.l1, name: 'Seppa POP', ownerName: 'Nima' })).body.id;
  id.lb = (await admin.req('POST', R, { name: 'Other Net', ownerName: 'Om' })).body.id;
  r1 = await resellerUser('owner@l1.rp', id.l1!);
  r2 = await resellerUser('owner@l2.rp', id.l2!);
  rb = await resellerUser('owner@lb.rp', id.lb!);
  await selectPlans(h.db, [id.l1!, id.l2!, id.lb!], ['ISP 50']);
});
afterAll(() => h?.close());

describe('reseller plans', () => {
  it('a reseller cannot create plans until the ISP switches bulk import on', async () => {
    expect((await r1.req('POST', P, plan('Xtreme 40'))).status).toBe(403);
    for (const r of [id.l1, id.lb])
      expect((await admin.req('PATCH', `${R}/${r}`, { importEnabled: true })).status).toBe(200);
    const created = await r1.req('POST', P, plan('Xtreme 40'));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.reseller).toMatchObject({ id: id.l1, name: 'Xtreme Fiber' });
    id.own = created.body.id;
    const doc = await h.db.collection<PlanDoc>('plans').findOne({ _id: new ObjectId(id.own) });
    expect(String(doc!.resellerId)).toBe(id.l1);
  });

  it('own plans are seen by the reseller, its sub-resellers (once assigned) and the ISP only', async () => {
    expect(await names(r1)).toEqual(['ISP 50', 'Xtreme 40']);
    expect(await names(r2)).toEqual(['ISP 50']);
    const put = await r1.req('PUT', `${R}/${id.l2}/rates`, { rates: [{ planId: id.own, active: true }] });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(await names(r2)).toEqual(['ISP 50', 'Xtreme 40']);
    expect(await names(rb)).toEqual(['ISP 50']);
    expect((await rb.req('GET', `${P}/${id.own}`)).status).toBe(404);
    const isp = (await admin.req('GET', `${P}?limit=100`)).body.items as {
      name: string;
      reseller: unknown;
    }[];
    expect(isp.find((p) => p.name === 'Xtreme 40')!.reseller).toMatchObject({ id: id.l1 });
    expect(isp.find((p) => p.name === 'ISP 50')!.reseller).toBeNull();
  });

  it('a reseller edits only its own plans; sub-resellers cannot create or edit', async () => {
    expect((await r1.req('PATCH', `${P}/${id.ispPlan}`, { pricePaise: 1 })).status).toBe(403);
    expect((await r1.req('PATCH', `${P}/${id.own}`, { pricePaise: 45_000 })).status).toBe(200);
    expect((await r2.req('PATCH', `${P}/${id.own}`, { pricePaise: 1 })).status).toBe(403);
    expect((await r2.req('POST', P, plan('Sub plan'))).status).toBe(403);
    expect((await rb.req('PATCH', `${P}/${id.own}`, { pricePaise: 1 })).status).toBe(404);
  });

  it('own plans go only to customers in the reseller’s branch', async () => {
    expect(
      (await admin.req('POST', '/api/v1/subscribers', customer('isp.c', { planId: id.own }))).status,
    ).toBe(400);
    expect((await rb.req('POST', '/api/v1/subscribers', customer('lb.c', { planId: id.own }))).status).toBe(
      400,
    );
    const c1 = await r1.req('POST', '/api/v1/subscribers', customer('l1.c', { planId: id.own }));
    expect(c1.status, JSON.stringify(c1.body)).toBe(201);
    id.c1 = c1.body.id;
    const c2 = await r2.req('POST', '/api/v1/subscribers', customer('l2.c', { planId: id.own }));
    expect(c2.status).toBe(201);
    const ispC = await admin.req('POST', '/api/v1/subscribers', customer('isp.c2', { planId: id.ispPlan }));
    expect((await admin.req('PATCH', `/api/v1/subscribers/${ispC.body.id}`, { planId: id.own })).status).toBe(
      400,
    );
    expect(
      (
        await admin.req(
          'POST',
          '/api/v1/recharges',
          { subscriberId: ispC.body.id, planId: id.own, payment: 'cash' },
          key(),
        )
      ).status,
    ).toBe(400);
  });

  it('a recharge on its own plan charges nothing to the reseller’s wallet', async () => {
    const before = await h.db.collection<WalletDoc>('wallets').findOne({ ownerId: new ObjectId(id.l1) });
    const r = await r1.req('POST', '/api/v1/recharges', { subscriberId: id.c1 }, key());
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.amountPaise).toBe(0);
    const after = await h.db.collection<WalletDoc>('wallets').findOne({ ownerId: new ObjectId(id.l1) });
    expect(after!.balancePaise).toBe(before!.balancePaise);
    expect(
      await h.db.collection('wallet_txns').countDocuments({ walletId: after!._id, type: 'RECHARGE' }),
    ).toBe(0);
  });

  it('plan import by a reseller creates its own plans and never touches ISP plans', async () => {
    const file = await writeXlsxFile([
      PLAN_COLUMNS.map((c) => c.key),
      PLAN_COLUMNS.map(
        (c) => ({ name: 'Xtreme 100', download_mbps: 100, upload_mbps: 100, price: 799 })[c.key] ?? null,
      ),
      PLAN_COLUMNS.map(
        (c) => ({ name: 'ISP 50', download_mbps: 50, upload_mbps: 50, price: 1 })[c.key] ?? null,
      ),
    ] as SheetData).toBuffer();
    const r = await r1.req('POST', `${P}/import?skipInvalid=true&updateExisting=true`, file, {
      'content-type': XLSX_MIME,
      'x-file-name': 'plans.xlsx',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.counts).toMatchObject({ created: 1, updated: 0 });
    expect(r.body.errors).toEqual([
      { row: 3, column: 'name', message: 'Your ISP already has a plan with this name' },
    ]);
    const made = await h.db.collection<PlanDoc>('plans').findOne({ tenantId: tenant, name: 'Xtreme 100' });
    expect(String(made!.resellerId)).toBe(id.l1);
    const isp = await h.db.collection<PlanDoc>('plans').findOne({ _id: new ObjectId(id.ispPlan) });
    expect(isp!.pricePaise).toBe(50_000);
  });

  it('switching bulk import off stops new plans; existing ones keep selling', async () => {
    await admin.req('PATCH', `${R}/${id.l1}`, { importEnabled: false });
    expect((await r1.req('POST', P, plan('Too late'))).status).toBe(403);
    expect(await names(r1)).toContain('Xtreme 40');
  });
});
