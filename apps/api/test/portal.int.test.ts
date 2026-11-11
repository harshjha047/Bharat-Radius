import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PaymentDoc, SubscriberDoc } from '@isp/db-mongo';
import { Client, roleId, seedTenant, seedUser, signIn, startHarness, type Harness } from './harness.js';

let h: Harness;
let tenant: ObjectId;
let admin: Client;
const id: Record<string, string> = {};
const RS = 100;

const customer = (username: string, extra: object = {}) => ({
  username,
  pppoePassword: `pp-${username}-9`,
  name: `Cust ${username}`,
  phone: '9876543210',
  address: { line1: '1 Main Rd', city: 'Delhi', state: 'Delhi', pincode: '110001' },
  ...extra,
});

async function portalLogin(login: string, password: string) {
  const c = new Client(h);
  const r = await c.req('POST', '/api/v1/portal/auth/login', { login, password });
  return { c, r };
}

let gw: Server;
let linksMade = 0;

beforeAll(async () => {
  gw = createServer((req, res) => {
    let body = '';
    req.on('data', (b: Buffer) => (body += b));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v1/payment_links') {
        linksMade++;
        const b = JSON.parse(body) as { reference_id: string };
        const lid = `plink_${b.reference_id}`;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: lid, short_url: `https://rzp.io/${lid}` }));
      }
      res.writeHead(404).end('{}');
    });
  });
  await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r));
  process.env.RAZORPAY_API_URL = `http://127.0.0.1:${(gw.address() as AddressInfo).port}`;

  h = await startHarness();
  tenant = await seedTenant(h.db, 'alpha', 'new.example.test');
  admin = await signIn(
    h,
    await seedUser(h, {
      tenantId: tenant,
      email: 'admin@p.in',
      roles: [await roleId(h.db, 'ISP Admin')],
      totp: true,
    }),
  );
  const plan = await admin.req('POST', '/api/v1/plans', {
    name: 'Home 100',
    downloadKbps: 100_000,
    uploadKbps: 50_000,
    validityDays: 30,
    pricePaise: 500 * RS,
    billingTypes: ['prepaid'],
  });
  expect(plan.status, JSON.stringify(plan.body)).toBe(201);
  id.plan = plan.body.id;
  const fast = await admin.req('POST', '/api/v1/plans', {
    name: 'Home 200',
    downloadKbps: 200_000,
    uploadKbps: 100_000,
    validityDays: 30,
    pricePaise: 800 * RS,
    billingTypes: ['prepaid'],
  });
  id.fast = fast.body.id;
  const a = await admin.req('POST', '/api/v1/subscribers', customer('ravi.p', { planId: id.plan }));
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  id.a = a.body.id;
  id.aNo = a.body.customerNo;
  const b = await admin.req('POST', '/api/v1/subscribers', customer('sita.p', { planId: id.plan }));
  id.b = b.body.id;
  const s = await admin.req('PATCH', '/api/v1/billing/settings', {
    razorpay: { enabled: true, keyId: 'rzp_test_key', keySecret: 'rzp-secret-1', webhookSecret: 'hook-1' },
  });
  expect(s.status, JSON.stringify(s.body)).toBe(200);
});
afterAll(async () => {
  await h?.close();
  gw?.close();
});

describe('portal sign-in', () => {
  it('signs in with the PPPoE username or customer no. and the PPPoE password', async () => {
    const { c, r } = await portalLogin('ravi.p', 'pp-ravi.p-9');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(c.jar.has('isp_pt')).toBe(true);
    const me = await c.req('GET', '/api/v1/portal/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      name: 'Cust ravi.p',
      username: 'ravi.p',
      billingType: 'prepaid',
      plan: { id: id.plan, pricePaise: 590 * RS, current: true },
      gateways: ['razorpay'],
      hasPortalPassword: false,
    });
    const byNo = await portalLogin(id.aNo!.toLowerCase(), 'pp-ravi.p-9');
    expect(byNo.r.status).toBe(200);
  });

  it('a wrong password is refused, and five in a row lock the account', async () => {
    for (let i = 0; i < 5; i++) {
      const { r } = await portalLogin('sita.p', `wrong-${i}`);
      expect(r.status).toBe(401);
    }
    const { r } = await portalLogin('sita.p', 'pp-sita.p-9');
    expect(r.status).toBe(429);
    await h.db
      .collection<SubscriberDoc>('subscribers')
      .updateOne({ _id: new ObjectId(id.b) }, { $unset: { 'portal.lockedUntil': '' } });
  });

  it('portal and staff sessions never cross', async () => {
    const { c } = await portalLogin('ravi.p', 'pp-ravi.p-9');
    expect((await c.req('GET', '/api/v1/subscribers')).status).toBe(401);
    expect((await c.req('GET', '/api/v1/auth/me')).status).toBe(401);
    expect((await admin.req('GET', '/api/v1/portal/me')).status).toBe(401);
    expect((await new Client(h).req('GET', '/api/v1/portal/me')).status).toBe(401);
  });

  it('a change without the portal CSRF token is refused', async () => {
    const { c } = await portalLogin('ravi.p', 'pp-ravi.p-9');
    c.jar.delete('isp_pcsrf');
    const r = await c.req('POST', '/api/v1/portal/pay', { planId: id.plan });
    expect(r.status).toBe(403);
  });

  it('setting a portal password retires the PPPoE password and signs out other devices', async () => {
    const one = await portalLogin('ravi.p', 'pp-ravi.p-9');
    const two = await portalLogin('ravi.p', 'pp-ravi.p-9');
    const weak = await one.c.req('POST', '/api/v1/portal/password', {
      currentPassword: 'pp-ravi.p-9',
      newPassword: 'aaaaaaaa',
    });
    expect(weak.status).toBe(400);
    const set = await one.c.req('POST', '/api/v1/portal/password', {
      currentPassword: 'pp-ravi.p-9',
      newPassword: 'Ravi-Portal-77',
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect((await one.c.req('GET', '/api/v1/portal/me')).body.hasPortalPassword).toBe(true);
    expect((await two.c.req('GET', '/api/v1/portal/me')).status).toBe(401);
    expect((await portalLogin('ravi.p', 'pp-ravi.p-9')).r.status).toBe(401);
    expect((await portalLogin('ravi.p', 'Ravi-Portal-77')).r.status).toBe(200);
  });

  it('staff reset: back to the PPPoE password and signed out everywhere (audited)', async () => {
    const { c } = await portalLogin('ravi.p', 'Ravi-Portal-77');
    const r = await admin.req('POST', `/api/v1/subscribers/${id.a}/portal-reset`);
    expect(r.status).toBe(200);
    expect((await c.req('GET', '/api/v1/portal/me')).status).toBe(401);
    expect((await portalLogin('ravi.p', 'pp-ravi.p-9')).r.status).toBe(200);
    expect(await h.db.collection('audit_logs').countDocuments({ action: 'subscriber.portal_reset' })).toBe(1);
  });

  it('sign out ends this session only', async () => {
    const one = await portalLogin('ravi.p', 'pp-ravi.p-9');
    const two = await portalLogin('ravi.p', 'pp-ravi.p-9');
    expect((await one.c.req('POST', '/api/v1/portal/auth/logout')).status).toBe(200);
    expect((await one.c.req('GET', '/api/v1/portal/me')).status).toBe(401);
    expect((await two.c.req('GET', '/api/v1/portal/me')).status).toBe(200);
  });
});

describe('portal data is the customer’s own', () => {
  it('invoices and their PDFs: own only; another customer’s invoice id is not found', async () => {
    const party = { name: 'x', stateCode: '07', address: 'x' };
    const inv = (subscriberId: string, number: string) => ({
      _id: new ObjectId(),
      tenantId: tenant,
      subscriberId: new ObjectId(subscriberId),
      ancestors: [],
      number,
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
    const mine = inv(id.a!, 'INV/2627/09001');
    const theirs = inv(id.b!, 'INV/2627/09002');
    await h.db.collection('invoices').insertMany([mine, theirs]);
    const { c } = await portalLogin('ravi.p', 'pp-ravi.p-9');
    const list = await c.req('GET', '/api/v1/portal/invoices');
    expect(list.body.items.map((i: { number: string }) => i.number)).toEqual(['INV/2627/09001']);
    const own = await c.req('GET', `/api/v1/portal/invoices/${mine._id.toHexString()}/pdf`);
    expect(own.status).toBe(200);
    expect(own.headers['content-type']).toBe('application/pdf');
    expect((await c.req('GET', `/api/v1/portal/invoices/${theirs._id.toHexString()}/pdf`)).status).toBe(404);
    const me = await c.req('GET', '/api/v1/portal/me');
    expect(me.body).toMatchObject({ dueInvoices: 1, duePaise: 100 });
    const payTheirs = await c.req('POST', '/api/v1/portal/pay', { invoiceId: theirs._id.toHexString() });
    expect(payTheirs.status).toBe(400);
  });

  it('plans: active prepaid plans at the customer’s price incl. GST', async () => {
    const { c } = await portalLogin('ravi.p', 'pp-ravi.p-9');
    const r = await c.req('GET', '/api/v1/portal/plans');
    expect(r.body.items).toEqual([
      expect.objectContaining({ id: id.plan, pricePaise: 590 * RS, current: true }),
      expect.objectContaining({ id: id.fast, pricePaise: 944 * RS, current: false }),
    ]);
  });

  it('pay: one link per purpose for 30 minutes, the amount is the server’s, a plan change rides on the recharge', async () => {
    const { c } = await portalLogin('ravi.p', 'pp-ravi.p-9');
    const before = linksMade;
    const one = await c.req('POST', '/api/v1/portal/pay', { planId: id.fast });
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(one.body).toMatchObject({
      method: 'razorpay',
      amountPaise: 944 * RS,
      status: 'created',
      purpose: { type: 'recharge', planId: id.fast },
      linkUrl: expect.stringContaining('rzp.io'),
    });
    const again = await c.req('POST', '/api/v1/portal/pay', { planId: id.fast });
    expect(again.body.id).toBe(one.body.id);
    expect(linksMade).toBe(before + 1);
    const p = await h.db.collection<PaymentDoc>('payments').findOne({ _id: new ObjectId(one.body.id) });
    expect(p?.subscriberId.toHexString()).toBe(id.a);
    expect(p?.createdBy).toBe(`customer:${id.a}`);
    const listed = await c.req('GET', '/api/v1/portal/payments');
    expect(listed.body.items.map((x: { id: string }) => x.id)).toEqual([one.body.id]);
  });
});
