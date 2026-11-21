import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ObjectId } from 'mongodb';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PaymentDoc } from '@isp/db-mongo';
import { maskName } from '../src/portal/pay-page.js';
import {
  Client,
  roleId,
  seedNas,
  seedTenant,
  seedUser,
  signIn,
  startHarness,
  type Harness,
} from './harness.js';

let h: Harness;
let pgAdmin: pg.Pool;
let gw: Server;
const run = randomBytes(3).toString('hex');
const octet = Number.parseInt(run.slice(0, 2), 16);
const nasIp = `198.19.${octet}.1`;
const otherIp = `198.19.${octet}.2`;
const id: Record<string, string> = {};
const RS = 100;
const u = (n: string) => `${n}-${run}`;

const customer = (username: string, extra: object = {}) => ({
  username,
  pppoePassword: `pp-${username}-9`,
  name: 'Ravi Kumar',
  phone: '9876543210',
  address: { line1: '1 Main Rd', city: 'Delhi', state: 'Delhi', pincode: '110001' },
  ...extra,
});

/** A browser behind the router: Caddy (127.0.0.1, trusted) forwards with the router's public address. */
const from = (ip: string) => ({ 'x-forwarded-for': ip });

beforeAll(async () => {
  gw = createServer((req, res) => {
    let body = '';
    req.on('data', (b: Buffer) => (body += b));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v1/payment_links') {
        const b = JSON.parse(body) as { reference_id: string };
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({ id: `plink_${b.reference_id}`, short_url: `https://rzp.io/${b.reference_id}` }),
        );
      }
      res.writeHead(404).end('{}');
    });
  });
  await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r));
  process.env.RAZORPAY_API_URL = `http://127.0.0.1:${(gw.address() as AddressInfo).port}`;

  h = await startHarness();
  pgAdmin = new pg.Pool({ connectionString: process.env.RADIUS_ADMIN_URL });
  const tenant = await seedTenant(h.db, `pay${run}`, 'new.example.test');
  id.tenant = tenant.toHexString();
  id.nas = (await seedNas(h, tenant, nasIp)).toHexString();
  const admin = await signIn(
    h,
    await seedUser(h, {
      tenantId: tenant,
      email: 'a@pay.in',
      roles: [await roleId(h.db, 'ISP Admin')],
      totp: true,
    }),
    `pay${run}`,
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
  for (const [k, phone] of [
    ['a', '9876500001'],
    ['b', '9876500002'],
    ['c', '9876500003'],
  ] as const) {
    const r = await admin.req('POST', '/api/v1/subscribers', customer(u(k), { planId: id.plan, phone }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    id[k] = r.body.id;
    id[`${k}No`] = r.body.customerNo;
  }
  const s = await admin.req('PATCH', '/api/v1/billing/settings', {
    razorpay: {
      enabled: true,
      keyId: 'rzp_test_key',
      keySecret: 'rzp-secret-123',
      webhookSecret: 'hook-secret-123',
    },
  });
  expect(s.status, JSON.stringify(s.body)).toBe(200);

  // What the Radius engine and the sync worker would have written: a is expired and online; b is valid and online;
  // c is expired but offline.
  const tid = (
    await pgAdmin.query<{ id: number }>(
      'INSERT INTO tenants (external_id, slug, name) VALUES ($1, $2, $2) RETURNING id',
      [id.tenant, `pay${run}`],
    )
  ).rows[0]!.id;
  await pgAdmin.query(
    "INSERT INTO nas (tenant_id, nasname, shortname, secret) VALUES ($1, $2, 'POP', 'secret-1234567')",
    [tid, nasIp],
  );
  const pid = (
    await pgAdmin.query<{ id: number }>(
      "INSERT INTO plans (tenant_id, name, rate_limit) VALUES ($1, 'Home 100', '50M/100M') RETURNING id",
      [tid],
    )
  ).rows[0]!.id;
  const sub = async (k: string, expires: string) => {
    const days = Number.parseInt(expires, 10);
    await h.db
      .collection('subscribers')
      .updateOne(
        { _id: new ObjectId(id[k]) },
        { $set: { expiresAt: new Date(Date.now() + days * 86_400_000) } },
      );
    return pgAdmin.query(
      `INSERT INTO subscribers (external_id, tenant_id, username, password_enc, plan_id, expires_at)
       VALUES ($1, $2, $3, radius_encrypt_password('x', 'k'), $4, now() + $5::interval)`,
      [id[k], tid, u(k), pid, expires],
    );
  };
  await sub('a', '-1 day');
  await sub('b', '10 days');
  await sub('c', '-2 days');
  const online = (k: string) =>
    pgAdmin.query(
      `INSERT INTO radacct (tenant_id, acctsessionid, acctuniqueid, username, nasipaddress, acctstarttime, acctupdatetime)
       VALUES ($1, 'x', $2, $3, $4, now() - interval '1 hour', now() - interval '1 minute')`,
      [tid, randomBytes(8).toString('hex'), u(k).toUpperCase(), nasIp],
    );
  await online('a');
  await online('b');
});
afterAll(async () => {
  await pgAdmin?.end();
  await h?.close();
  gw?.close();
});

const tokenOf = (location: string) => new URL(location).searchParams.get('t')!;

describe('walled-garden pay page', () => {
  it('masks names', () => {
    expect(maskName('Ravi  Kumar')).toBe('R••• K••••');
    expect(maskName('Al')).toBe('A••');
  });

  it('entry from an unknown address goes to the plain page', async () => {
    const r = await new Client(h, null).req('GET', '/api/v1/pay/entry', undefined, from('203.0.113.9'));
    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/\/pay$/);
  });

  it('the one expired customer online behind the router is recognised and can pay the plan price', async () => {
    const c = new Client(h);
    const e = await c.req('GET', '/api/v1/pay/entry', undefined, from(nasIp));
    expect(e.status).toBe(302);
    const t = tokenOf(String(e.headers.location));
    const ctx = await c.req('GET', `/api/v1/pay/context?t=${encodeURIComponent(t)}`);
    expect(ctx.status, JSON.stringify(ctx.body)).toBe(200);
    expect(ctx.body).toMatchObject({
      online: true,
      subscriber: {
        name: 'R••• K••••',
        customerNo: id.aNo,
        plan: { name: 'Home 100', pricePaise: 590 * RS },
      },
    });
    expect(JSON.stringify(ctx.body.subscriber)).not.toMatch(/9876|Ravi/);

    const o = await c.req('POST', '/api/v1/pay/order', { t });
    expect(o.status, JSON.stringify(o.body)).toBe(200);
    expect(o.body).toMatchObject({ amountPaise: 590 * RS, method: 'razorpay', status: 'created' });
    expect(o.body.linkUrl).toMatch(/^https:\/\/rzp\.io\//);
    const p = await h.db.collection<PaymentDoc>('payments').findOne({ _id: new ObjectId(o.body.id) });
    expect(p!.subscriberId.toHexString()).toBe(id.a);
    expect(p!.purpose).toMatchObject({ type: 'recharge' });
    // Same link handed back within 30 minutes.
    const again = await c.req('POST', '/api/v1/pay/order', { t });
    expect(again.body.id).toBe(o.body.id);
  });

  it('lookup finds only customers online behind this router', async () => {
    const c = new Client(h);
    const t = tokenOf(
      String((await c.req('GET', '/api/v1/pay/entry', undefined, from(nasIp))).headers.location),
    );
    const byPhone = await c.req('POST', '/api/v1/pay/lookup', { t, login: '98765 00002' }, from(nasIp));
    expect(byPhone.status, JSON.stringify(byPhone.body)).toBe(200);
    expect(byPhone.body.subscriber).toMatchObject({ customerNo: id.bNo, expired: false });
    const byNo = await c.req('POST', '/api/v1/pay/lookup', { t, login: id.aNo!.toLowerCase() }, from(nasIp));
    expect(byNo.body.subscriber).toMatchObject({ customerNo: id.aNo, expired: true });
    const offline = await c.req('POST', '/api/v1/pay/lookup', { t, login: u('c') }, from(nasIp));
    expect(offline.status).toBe(404);
  });

  it('a forged or expired token is refused; lookups are rate limited per address', async () => {
    const c = new Client(h);
    const t = tokenOf(
      String((await c.req('GET', '/api/v1/pay/entry', undefined, from(nasIp))).headers.location),
    );
    const [body] = t.split('.');
    const forged = `${Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), s: id.c }),
    ).toString('base64url')}.${t.split('.')[1]}`;
    expect((await c.req('GET', `/api/v1/pay/context?t=${encodeURIComponent(forged)}`)).status).toBe(410);
    expect((await c.req('POST', '/api/v1/pay/order', { t: forged })).status).toBe(410);

    const statuses: number[] = [];
    for (let i = 0; i < 11; i++)
      statuses.push(
        (await c.req('POST', '/api/v1/pay/lookup', { t, login: `nobody-${i}` }, from(otherIp))).status,
      );
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
