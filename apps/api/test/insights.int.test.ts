import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gstLine, gstTotals } from '@isp/db-mongo';
import {
  roleId,
  seedPlan,
  seedSubscriber,
  seedTenant,
  seedUser,
  signIn,
  startHarness,
  type Client,
  type Harness,
} from './harness.js';

const DAY = 86_400_000;
const ago = (n: number) => new Date(Date.now() - n * DAY);
const istDay = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);

let h: Harness;
let tenant: ObjectId;
let admin: Client;
let l1: Client;
const id: Record<string, ObjectId> = {};
let invoiceB = 0;

const party = { name: 'P', stateCode: '07', address: 'x' };
async function invoice(
  n: number,
  o: { at: Date; sub: ObjectId; ancestors: ObjectId[]; type?: string; due?: Date; open?: boolean },
) {
  const line = gstLine({
    description: 'Home 100',
    hsnSac: '998422',
    ratePaise: 50_000,
    gstRatePercent: 18,
    intraState: true,
  });
  const t = gstTotals([line]);
  await h.db.collection('invoices').insertOne({
    tenantId: tenant,
    subscriberId: o.sub,
    ancestors: o.ancestors,
    number: `INS/2627/${String(n).padStart(5, '0')}`,
    financialYear: '2026-27',
    type: o.type ?? 'prepaid_recharge',
    issueDate: o.at,
    dueDate: o.due ?? o.at,
    seller: party,
    buyer: party,
    placeOfSupply: '07',
    lines: [line],
    ...t,
    paidPaise: o.open ? 0 : t.totalPaise,
    creditedPaise: 0,
    balancePaise: o.open ? t.totalPaise : 0,
    status: o.open ? 'overdue' : 'paid',
    createdAt: o.at,
    updatedAt: o.at,
    createdBy: 'test',
  });
  return t.totalPaise;
}

beforeAll(async () => {
  h = await startHarness();
  tenant = await seedTenant(h.db, 'insights', 'new.example.test');
  admin = await signIn(
    h,
    await seedUser(h, {
      tenantId: tenant,
      email: 'admin@i.in',
      roles: [await roleId(h.db, 'ISP Admin')],
      totp: true,
    }),
  );
  id.l1 = new ObjectId(
    (await admin.req('POST', '/api/v1/resellers', { name: 'L1', ownerName: 'A' })).body.id,
  );
  const ru = await seedUser(h, {
    tenantId: tenant,
    email: 'l1@i.in',
    type: 'reseller',
    roles: [await roleId(h.db, 'Reseller Owner')],
  });
  await h.db.collection('users').updateOne({ _id: ru._id }, { $set: { resellerId: id.l1 } });
  l1 = await signIn(h, ru);

  id.plan = await seedPlan(h, tenant, 'Home 100');
  const sub = async (u: string, set: Record<string, unknown>) => {
    const s = await seedSubscriber(h, tenant, u);
    await h.db.collection('subscribers').updateOne({ _id: s }, { $set: { planId: id.plan, ...set } });
    return s;
  };
  id.due = await sub('due', { expiresAt: new Date(Date.now() + 3 * DAY) });
  id.lapsed = await sub('lapsed', { expiresAt: ago(5) });
  id.renewed = await sub('renewed', {
    expiresAt: new Date(Date.now() + 20 * DAY),
    resellerId: id.l1,
    ancestors: [id.l1],
  });

  await invoice(1, { at: ago(2), sub: id.due, ancestors: [] });
  await invoice(2, { at: new Date(Date.now() - 60_000), sub: id.renewed, ancestors: [id.l1] });
  invoiceB = await invoice(3, {
    at: ago(40),
    due: ago(35),
    sub: id.lapsed,
    ancestors: [],
    type: 'postpaid_monthly',
    open: true,
  });

  await h.db.collection('payments').insertOne({
    tenantId: tenant,
    subscriberId: id.due,
    ancestors: [],
    method: 'cash',
    amountPaise: 59_000,
    status: 'captured',
    purpose: { type: 'recharge' },
    capturedAt: ago(2),
    createdAt: ago(2),
    updatedAt: ago(2),
    createdBy: 't',
  });
  await h.db.collection('recharges').insertOne({
    tenantId: tenant,
    subscriberId: id.renewed,
    planId: id.plan,
    siteResellerId: id.l1,
    ancestors: [id.l1],
    walletId: null,
    walletTxnId: null,
    amountPaise: 40_000,
    customerPricePaise: 50_000,
    taxPaise: 9_000,
    channel: 'reseller_wallet',
    status: 'SUCCESS',
    rechargeDate: ago(9),
    oldExpiresAt: ago(10),
    newExpiresAt: new Date(Date.now() + 20 * DAY),
    oldPlanId: id.plan,
    actorId: 't',
    idempotencyKey: 'ins-1',
    createdAt: ago(9),
  });
});
afterAll(() => h?.close());

const range = () => `?from=${istDay(ago(29))}&to=${istDay(new Date())}`;
type Body = {
  kpis: { key: string; value: number | null; previous: number | null; change: number | null }[];
  alerts: { code: string; severity: string }[];
  [k: string]: unknown;
};
const k = (b: Body, key: string) => b.kpis.find((x) => x.key === key)!;

describe('financial insights', () => {
  it('compares the period with the one before and reads the base', async () => {
    const r = await admin.req('GET', `/api/v1/reports/insights${range()}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const b = r.body as Body & Record<string, any>;
    expect(k(b, 'netRevenue')).toMatchObject({ value: 100_000, previous: 50_000, change: 100 });
    expect(k(b, 'collected').value).toBe(59_000);
    expect(k(b, 'renewalRate').value).toBe(0.5);
    expect(k(b, 'lapsed').value).toBe(1);
    expect(k(b, 'arpu').value).toBe(50_000);
    expect(k(b, 'resellerMargin').value).toBe(10_000);

    expect(b.ageing.find((a: { key: string }) => a.key === 'd31_60').amountPaise).toBe(invoiceB);
    expect(b.defaulters).toEqual([
      expect.objectContaining({
        subscriberId: id.lapsed!.toHexString(),
        balancePaise: invoiceB,
        daysOverdue: 35,
      }),
    ]);
    expect(b.resellers).toEqual([
      expect.objectContaining({ level: 'L1', marginPaise: 10_000, marginPct: 20 }),
    ]);
    expect(b.plans).toEqual([
      expect.objectContaining({ plan: 'Home 100', recharges: 1, revenuePaise: 50_000 }),
    ]);
    expect(b.forecast).toMatchObject({ renewalsDueCount: 2, renewalsDuePaise: 100_000, next30Paise: 50_000 });
    expect(b.daily).toHaveLength(30);

    const codes = b.alerts.map((a) => a.code);
    expect(codes).toEqual(
      expect.arrayContaining(['revenue_growth', 'receivables_overdue', 'renewals_low', 'expiring_soon']),
    );
    expect(b.narrative[0]).toContain('up 100%');
  });

  it('a reseller sees only its branch, and no wallet alerts', async () => {
    const r = await l1.req('GET', `/api/v1/reports/insights${range()}`);
    expect(r.status).toBe(200);
    const b = r.body as Body & Record<string, unknown>;
    expect(k(b, 'netRevenue').value).toBe(50_000);
    expect(b.defaulters).toEqual([]);
    expect(b.alerts.some((a) => a.code.startsWith('wallets_'))).toBe(false);
  });

  it('as a report table and an Excel download', async () => {
    const r = await admin.req('GET', `/api/v1/reports/financial${range()}`);
    expect(r.status).toBe(200);
    expect(r.body.tables[0].title).toBe('Summary');
    const x = await admin.req('GET', `/api/v1/reports/financial/download${range()}&format=xlsx`);
    expect(x.status).toBe(200);
    expect(x.raw.subarray(0, 2).toString()).toBe('PK');
    const p = await admin.req('GET', `/api/v1/reports/financial/download${range()}&format=pdf`);
    expect(p.raw.subarray(0, 4).toString()).toBe('%PDF');
  });
});
