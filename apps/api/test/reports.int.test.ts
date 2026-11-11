import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { gstLine, gstTotals } from '@isp/db-mongo';
import { roleId, seedTenant, seedUser, signIn, startHarness, type Client, type Harness } from './harness.js';

let h: Harness;
let tenant: ObjectId;
let admin: Client;
let l1: Client;
const id: Record<string, ObjectId> = {};

const party = (stateCode: string, gstin?: string) => ({
  name: `Party ${stateCode}`,
  stateCode,
  address: 'x',
  ...(gstin ? { gstin } : {}),
});
async function invoice(n: number, at: Date, buyerState: string, ancestors: ObjectId[], gstin?: string) {
  const line = gstLine({
    description: 'Home 100',
    hsnSac: '998422',
    ratePaise: 50_000,
    gstRatePercent: 18,
    intraState: buyerState === '07',
  });
  const _id = new ObjectId();
  await h.db.collection('invoices').insertOne({
    _id,
    tenantId: tenant,
    subscriberId: new ObjectId(),
    ancestors,
    number: `INV/2627/${String(n).padStart(5, '0')}`,
    financialYear: '2026-27',
    type: 'prepaid_recharge',
    issueDate: at,
    dueDate: at,
    seller: party('07', '07AAAAA0000A1Z5'),
    buyer: party(buyerState, gstin),
    placeOfSupply: buyerState,
    lines: [line],
    ...gstTotals([line]),
    paidPaise: 0,
    creditedPaise: 0,
    balancePaise: 0,
    status: 'paid',
    createdAt: at,
    updatedAt: at,
    createdBy: 'test',
  });
  return _id;
}

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
  id.l1 = new ObjectId(
    (await admin.req('POST', '/api/v1/resellers', { name: 'L1', ownerName: 'A' })).body.id,
  );
  const ru = await seedUser(h, {
    tenantId: tenant,
    email: 'l1@r.in',
    type: 'reseller',
    roles: [await roleId(h.db, 'Reseller Owner')],
  });
  await h.db.collection('users').updateOne({ _id: ru._id }, { $set: { resellerId: id.l1 } });
  l1 = await signIn(h, ru);

  const d1 = new Date('2026-12-02T06:00:00Z');
  const d2 = new Date('2026-12-03T06:00:00Z');
  await invoice(1, d1, '07', []);
  await invoice(2, d1, '09', [id.l1]);
  await invoice(3, d2, '07', [], '07BBBBB1111B1Z5');
  await invoice(4, new Date('2026-11-30T06:00:00Z'), '07', []);
  await h.db.collection('payments').insertMany([
    {
      tenantId: tenant,
      subscriberId: new ObjectId(),
      ancestors: [],
      method: 'cash',
      amountPaise: 59_000,
      status: 'captured',
      purpose: { type: 'invoice' },
      capturedAt: d1,
      createdAt: d1,
      updatedAt: d1,
      createdBy: 't',
    },
    {
      tenantId: tenant,
      subscriberId: new ObjectId(),
      ancestors: [id.l1],
      method: 'razorpay',
      amountPaise: 59_000,
      status: 'captured',
      purpose: { type: 'recharge' },
      capturedAt: d1,
      createdAt: d1,
      updatedAt: d1,
      createdBy: 't',
    },
    {
      tenantId: tenant,
      subscriberId: new ObjectId(),
      ancestors: [],
      method: 'razorpay',
      amountPaise: 99_900,
      status: 'created',
      purpose: { type: 'recharge' },
      createdAt: d1,
      updatedAt: d1,
      createdBy: 't',
    },
  ]);
  await h.db.collection('recharges').insertMany(
    [0, 1, 2].map((i) => ({
      tenantId: tenant,
      subscriberId: new ObjectId(),
      planId: new ObjectId(),
      siteResellerId: id.l1,
      ancestors: [id.l1],
      walletId: null,
      walletTxnId: null,
      amountPaise: 40_000,
      customerPricePaise: 50_000,
      taxPaise: 9_000,
      channel: 'reseller_wallet',
      status: i === 2 ? 'REVERSED' : 'SUCCESS',
      rechargeDate: d2,
      oldExpiresAt: null,
      newExpiresAt: d2,
      oldPlanId: null,
      actorId: 't',
      idempotencyKey: `r-${i}`,
      createdAt: d2,
    })),
  );
});
afterAll(() => h?.close());

const dec = { from: '2026-12-01', to: '2026-12-31' };
const q = (o: Record<string, string>) => `?${new URLSearchParams(o).toString()}`;

describe('reports', () => {
  it('revenue: by IST day with GST split, only invoices in the range', async () => {
    const r = await admin.req('GET', `/api/v1/reports/revenue${q(dec)}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const byDay = r.body.tables[0];
    expect(byDay.rows.map((x: { day: string; n: number }) => [x.day, x.n])).toEqual([
      ['2026-12-02', 2],
      ['2026-12-03', 1],
    ]);
    expect(byDay.totals).toMatchObject({
      n: 3,
      taxable: 150_000,
      igst: 9_000,
      cgst: 9_000,
      sgst: 9_000,
      total: 177_000,
    });
  });

  it('a reseller sees only its branch', async () => {
    const r = await l1.req('GET', `/api/v1/reports/revenue${q(dec)}`);
    expect(r.body.tables[0].totals).toMatchObject({ n: 1, total: 59_000 });
    const c = await l1.req('GET', `/api/v1/reports/collections${q(dec)}`);
    expect(c.body.tables[0].totals).toMatchObject({ n: 1, razorpay: 59_000, cash: 0 });
    expect((await l1.req('GET', '/api/v1/reports/gstr1?month=2026-12')).status).toBe(403);
    expect((await l1.req('GET', `/api/v1/reports/usage${q(dec)}`)).status).toBe(403);
  });

  it('collections: captured payments only, by method', async () => {
    const r = await admin.req('GET', `/api/v1/reports/collections${q(dec)}`);
    expect(r.body.tables[0].totals).toMatchObject({ n: 2, cash: 59_000, razorpay: 59_000, total: 118_000 });
  });

  it('reseller sales: successful recharges by the level that recharged; refunds counted apart', async () => {
    const r = await admin.req('GET', `/api/v1/reports/reseller-sales${q(dec)}`);
    expect(r.body.tables[0].rows).toEqual([
      expect.objectContaining({ level: 'L1', n: 2, reversed: 1, wallet: 80_000, customer: 118_000 }),
    ]);
  });

  it('Excel and PDF downloads (audited)', async () => {
    const x = await admin.req('GET', `/api/v1/reports/revenue/download${q({ ...dec, format: 'xlsx' })}`);
    expect(x.status).toBe(200);
    expect(x.headers['content-type']).toContain('spreadsheetml');
    expect(x.raw.subarray(0, 2).toString()).toBe('PK');
    const p = await admin.req('GET', `/api/v1/reports/subscribers/download${q({ ...dec, format: 'pdf' })}`);
    expect(p.status).toBe(200);
    expect(p.raw.subarray(0, 4).toString()).toBe('%PDF');
    // Audit rows of file downloads are written right after the response is sent.
    await vi.waitFor(async () =>
      expect(await h.db.collection('audit_logs').countDocuments({ action: 'report.export' })).toBe(2),
    );
  });

  it('GSTR-1: b2b for the registered buyer, b2cs for the rest, docs series', async () => {
    const r = await admin.req('GET', '/api/v1/reports/gstr1?month=2026-12');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.summary).toMatchObject({ invoices: 3, creditNotes: 0, taxablePaise: 150_000 });
    const rows = Object.fromEntries(
      r.body.sheets.map((s: { name: string; rows: number }) => [s.name, s.rows]),
    );
    expect(rows).toMatchObject({ b2b: 1, b2cl: 0, b2cs: 2, docs: 1 });
    const x = await admin.req('GET', '/api/v1/reports/gstr1/download?month=2026-12');
    expect(x.headers['content-disposition']).toContain('GSTR1-2026-12.xlsx');
  });

  it('rejects a reversed or too long range', async () => {
    expect(
      (await admin.req('GET', `/api/v1/reports/revenue${q({ from: '2026-12-10', to: '2026-12-01' })}`))
        .status,
    ).toBe(400);
    expect(
      (await admin.req('GET', `/api/v1/reports/revenue${q({ from: '2024-01-01', to: '2026-12-01' })}`))
        .status,
    ).toBe(400);
  });
});
