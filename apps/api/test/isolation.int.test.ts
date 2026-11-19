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
  '/api/v1/nas/:id/api': 'nasA',
  '/api/v1/nas/:id/live/info': 'nasA',
  '/api/v1/nas/:id/live/interfaces': 'nasA',
  '/api/v1/nas/:id/live/traffic': 'nasA',
  '/api/v1/nas/:id/live/ping': 'nasA',
  '/api/v1/nas/:id/live/online': 'nasA',
  '/api/v1/subscribers/:id/live-speed': 'subA',
  '/api/v1/plans/:id': 'planA',
  '/api/v1/subscribers/:id': 'subA',
  '/api/v1/subscribers/:id/suspend': 'subA',
  '/api/v1/subscribers/:id/activate': 'subA',
  '/api/v1/subscribers/:id/kick': 'subA',
  '/api/v1/subscribers/:id/portal-reset': 'subA',
  '/api/v1/subscribers/:id/access-log': 'subA',
  '/api/v1/tickets/:id': 'ticketA',
  '/api/v1/tickets/:id/reply': 'ticketA',
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
  '/api/v1/resellers/:id/rates': 'resellerA',
  '/api/v1/wallets/:id': 'walletA',
  '/api/v1/wallets/:id/ledger': 'walletA',
  '/api/v1/wallets/:id/report': 'walletA',
  '/api/v1/wallets/:id/adjust': 'walletA',
  '/api/v1/wallets/topup-requests/:id/approve': 'topupA',
  '/api/v1/wallets/topup-requests/:id/reject': 'topupA',
  '/api/v1/wallets/topup-requests/:id/cancel': 'topupA',
  '/api/v1/recharges/:id': 'rechargeA',
  '/api/v1/recharges/:id/refund': 'rechargeA',
  '/api/v1/invoices/:id': 'invoiceA',
  '/api/v1/invoices/:id/pdf': 'invoiceA',
  '/api/v1/invoices/:id/credit-note': 'invoiceA',
  '/api/v1/payments/:id': 'paymentA',
  '/api/v1/subscribers/:id/consent': 'subA',
};

/**
 * Path parameters that are not records of a tenant: webhooks (public; the id names the ISP and the signature
 * gates them, tested in money.int.test.ts) and SMS templates (:key is a template name in the caller's own ISP).
 */
const NOT_RECORD_ROUTES = new Set([
  '/api/v1/webhooks/razorpay/:id',
  '/api/v1/webhooks/cashfree/:id',
  '/api/v1/billing/templates/:key',
  // Customer-only (portal cookie); ownership is covered in portal.int.test.ts.
  '/api/v1/portal/invoices/:id/pdf',
  '/api/v1/portal/tickets/:id',
  '/api/v1/portal/tickets/:id/reply',
  '/api/v1/portal/tickets/:id/close',
  '/api/v1/reports/:name',
  '/api/v1/reports/:name/download',
]);

const BODIES: Record<string, unknown> = {
  'PUT /api/v1/nas/:id/api': { enabled: true, username: 'api', password: 'x' },
  'PATCH /api/v1/users/:id': { name: 'Changed by B' },
  'POST /api/v1/users/:id/password': { password: 'Changed-By-Tenant-B-1' },
  'PATCH /api/v1/roles/:id': { name: 'Changed by B' },
  'PATCH /api/v1/tenants/:id': { name: 'Changed by B' },
  'PATCH /api/v1/nas/:id': { name: 'Changed by B' },
  'PATCH /api/v1/plans/:id': { name: 'Changed by B' },
  'PATCH /api/v1/subscribers/:id': { name: 'Changed by B' },
  'PATCH /api/v1/tickets/:id': { status: 'closed' },
  'POST /api/v1/tickets/:id/reply': { body: 'from tenant B' },
  'POST /api/v1/subscribers/:id/suspend': {},
  'PATCH /api/v1/resellers/:id': { name: 'Changed by B' },
  'POST /api/v1/resellers/:id/suspend': {},
  'POST /api/v1/resellers/:id/move': { parentId: null },
  'PUT /api/v1/resellers/:id/rates': { rates: [{ planId: '0123456789abcdef01234567', walletPricePaise: 1 }] },
  'POST /api/v1/wallets/:id/adjust': { amountPaise: 100, reason: 'B adjusting A' },
  'PATCH /api/v1/wallets/:id': { lowBalanceThresholdPaise: 1 },
  'POST /api/v1/recharges/:id/refund': { reason: 'B refunding A' },
  'POST /api/v1/subscribers/:id/consent': { via: 'staff' },
  'POST /api/v1/wallets/topup-requests/:id/approve': {},
  'POST /api/v1/wallets/topup-requests/:id/reject': { note: 'B rejecting A' },
  'POST /api/v1/invoices/:id/credit-note': { reason: 'B crediting A' },
};
const HEADERS: Record<string, Record<string, string>> = {
  'POST /api/v1/wallets/:id/adjust': { 'idempotency-key': 'isolation-test-key' },
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
  const walletA = new ObjectId();
  await h.db.collection('wallets').insertOne({
    _id: walletA,
    tenantId: a,
    ownerType: 'reseller',
    ownerId: resellerA,
    walletType: 'L1',
    parentWalletId: new ObjectId(),
    balancePaise: 5000,
    creditLimitPaise: 0,
    lowBalanceThresholdPaise: 100,
    isActive: true,
    frozen: false,
    totals: { receivedPaise: 0, allocatedPaise: 0, rechargedPaise: 0, refundedPaise: 0 },
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  ids.walletA = walletA.toHexString();
  const topupA = await h.db.collection('topup_requests').insertOne({
    tenantId: a,
    resellerId: resellerA,
    walletId: walletA,
    parentWalletId: new ObjectId(),
    ancestors: [resellerA],
    amountPaise: 100,
    status: 'pending',
    createdBy: 'test',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  ids.topupA = topupA.insertedId.toHexString();
  const subA = new ObjectId(ids.subA);
  const invoiceA = new ObjectId();
  const party = { name: 'x', stateCode: '07', address: 'x' };
  const rechargeA = await h.db.collection('recharges').insertOne({
    tenantId: a,
    subscriberId: subA,
    planId: new ObjectId(ids.planA),
    siteResellerId: null,
    ancestors: [],
    walletId: null,
    walletTxnId: null,
    amountPaise: 0,
    customerPricePaise: 100,
    taxPaise: 18,
    channel: 'cash',
    status: 'SUCCESS',
    rechargeDate: new Date(),
    oldExpiresAt: null,
    newExpiresAt: new Date(),
    oldPlanId: null,
    actorId: 'test',
    idempotencyKey: 'alpha-recharge',
    createdAt: new Date(),
  });
  await h.db.collection('invoices').insertOne({
    _id: invoiceA,
    tenantId: a,
    subscriberId: subA,
    ancestors: [],
    number: 'INV/2627/00001',
    financialYear: '2026-27',
    type: 'postpaid_monthly',
    issueDate: new Date(),
    dueDate: new Date(),
    seller: party,
    buyer: party,
    placeOfSupply: '07',
    lines: [],
    taxablePaise: 100,
    cgstPaise: 9,
    sgstPaise: 9,
    igstPaise: 0,
    roundOffPaise: -18,
    totalPaise: 100,
    paidPaise: 0,
    creditedPaise: 0,
    balancePaise: 100,
    status: 'issued',
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: 'test',
  });
  const paymentA = await h.db.collection('payments').insertOne({
    tenantId: a,
    subscriberId: subA,
    ancestors: [],
    method: 'cash',
    amountPaise: 100,
    status: 'captured',
    purpose: { type: 'invoice', invoiceId: invoiceA },
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: 'test',
  });
  ids.rechargeA = rechargeA.insertedId.toHexString();
  ids.invoiceA = invoiceA.toHexString();
  ids.paymentA = paymentA.insertedId.toHexString();
  const ticketA = await h.db.collection('tickets').insertOne({
    tenantId: a,
    number: 'T000001',
    subscriberId: subA,
    ancestors: [],
    subject: 'No internet',
    category: 'no_internet',
    priority: 'high',
    status: 'open',
    assignee: null,
    source: 'portal',
    openedBy: { type: 'customer', id: ids.subA, name: 'x' },
    messageCount: 1,
    lastActivityAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 0,
  });
  ids.ticketA = ticketA.insertedId.toHexString();
  const adminB = await seedUser(h, { tenantId: b, email: 'admin@bravo.in', roles: [adminRole], totp: true });
  bAdmin = await signIn(h, adminB, 'bravo');
});
afterAll(() => h?.close());

describe('tenant isolation', () => {
  const routes = listRoutes(API_PREFIX).filter(
    (r) => r.path.includes('/:') && !NOT_RECORD_ROUTES.has(r.path),
  );

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
        HEADERS[`${r.method} ${r.path}`],
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
        ['wallets', 'walletA'],
        ['recharges', 'rechargeA'],
        ['invoices', 'invoiceA'],
        ['payments', 'paymentA'],
        ['tickets', 'ticketA'],
      ] as const
    ).map(([c, k]) => h.db.collection(c).findOne({ _id: new ObjectId(ids[k]) })),
  );
  const outbox = await h.db.collection('outbox').countDocuments({});
  const events = await h.db.collection('ticket_events').countDocuments({});
  return JSON.stringify([docs, outbox, events]);
}
