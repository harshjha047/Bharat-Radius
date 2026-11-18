import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  endOfIstDay,
  istMidnight,
  istParts,
  postpaidInvoices,
  postpaidOverdue,
  reconcileWallets,
  type InvoiceDoc,
  type OutboxDoc,
  type SubscriberDoc,
  type WalletDoc,
  type WalletTxnDoc,
} from '@isp/db-mongo';
import { roleId, seedTenant, seedUser, signIn, startHarness, type Client, type Harness } from './harness.js';

let h: Harness;
let tenant: ObjectId;
let admin: Client;
let l1User: Client;
let l2User: Client;
const id: Record<string, string> = {};
let keyN = 0;
const key = () => ({ 'idempotency-key': `test-key-${Date.now()}-${keyN++}` });
const RS = 100; // paise per rupee

const wallet = async (ownerId?: string) =>
  (await h.db.collection<WalletDoc>('wallets').findOne({ ownerId: new ObjectId(ownerId!) }))!;
const sub = async (x?: string) =>
  (await h.db.collection<SubscriberDoc>('subscribers').findOne({ _id: new ObjectId(x!) }))!;
const customer = (username: string, extra: object = {}) => ({
  username,
  name: `Cust ${username}`,
  phone: '9876543210',
  address: { line1: '1 Main Rd', city: 'Delhi', state: 'Delhi', pincode: '110001' },
  ...extra,
});
const resellerUser = async (email: string, resellerId?: string) => {
  const u = await seedUser(h, {
    tenantId: tenant,
    email,
    type: 'reseller',
    roles: [await roleId(h.db, 'Reseller Owner')],
  });
  await h.db
    .collection('users')
    .updateOne({ _id: u._id }, { $set: { resellerId: new ObjectId(resellerId!) } });
  return signIn(h, u);
};

// Mock gateway: payment links and their status, controlled by the test.
const links = new Map<string, { paid: boolean; amount: number; ref: string }>();
let gw: Server;

beforeAll(async () => {
  gw = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c));
    req.on('end', () => {
      const send = (o: unknown, code = 200) =>
        res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(o));
      const url = req.url ?? '';
      if (req.method === 'POST' && url === '/v1/payment_links') {
        const b = JSON.parse(body) as { amount: number; reference_id: string };
        const lid = `plink_${links.size + 1}`;
        links.set(lid, { paid: false, amount: b.amount, ref: b.reference_id });
        return send({ id: lid, short_url: `https://rzp.io/${lid}` });
      }
      const m = /^\/v1\/payment_links\/(.+)$/.exec(url);
      if (m) {
        const l = links.get(m[1]!);
        if (!l) return send({ error: { description: 'not found' } }, 404);
        return send({
          status: l.paid ? 'paid' : 'created',
          amount_paid: l.paid ? l.amount : 0,
          payments: l.paid ? [{ payment_id: `pay_${m[1]}`, status: 'captured', method: 'upi' }] : [],
        });
      }
      if (req.method === 'POST' && url === '/pg/links') {
        const b = JSON.parse(body) as { link_id: string; link_amount: number };
        links.set(b.link_id, { paid: false, amount: Math.round(b.link_amount * 100), ref: b.link_id });
        return send({ link_id: b.link_id, link_url: `https://cfre.in/${b.link_id}` });
      }
      const c = /^\/pg\/links\/([^/]+)(\/orders)?$/.exec(url);
      if (c) {
        const l = links.get(c[1]!);
        if (!l) return send({ message: 'not found' }, 404);
        if (c[2]) return send([{ order_id: `order_${c[1]}`, order_status: l.paid ? 'PAID' : 'ACTIVE' }]);
        return send({
          link_status: l.paid ? 'PAID' : 'ACTIVE',
          link_amount_paid: l.paid ? l.amount / 100 : 0,
        });
      }
      send({ message: 'no route' }, 404);
    });
  });
  await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(gw.address() as AddressInfo).port}`;
  process.env.RAZORPAY_API_URL = base;
  process.env.CASHFREE_API_URL = base;

  h = await startHarness();
  tenant = await seedTenant(h.db, 'alpha', 'new.example.test');
  admin = await signIn(
    h,
    await seedUser(h, {
      tenantId: tenant,
      email: 'admin@m.in',
      roles: [await roleId(h.db, 'ISP Admin')],
      totp: true,
    }),
  );
  const plan = await admin.req('POST', '/api/v1/plans', {
    name: 'Basic 100',
    downloadKbps: 20_000,
    uploadKbps: 10_000,
    validityDays: 30,
    pricePaise: 100 * RS,
    billingTypes: ['prepaid', 'postpaid'],
  });
  expect(plan.status).toBe(201);
  id.plan = plan.body.id;
  id.l1 = (await admin.req('POST', '/api/v1/resellers', { name: 'L1 Distributor', ownerName: 'A' })).body.id;
  id.l2 = (
    await admin.req('POST', '/api/v1/resellers', { parentId: id.l1, name: 'L2 Site', ownerName: 'B' })
  ).body.id;
  l1User = await resellerUser('l1@m.in', id.l1);
  l2User = await resellerUser('l2@m.in', id.l2);
});
afterAll(async () => {
  await h?.close();
  gw?.close();
});

describe('accounts team worked example (exact numbers)', () => {
  it('Master → L1 1,00,000; L1 → L2 50,000; 50 × Rs. 100; L1 → L2 20,000 → L1 30,000, L2 65,000', async () => {
    const l1w = await wallet(id.l1!);
    const l2w = await wallet(id.l2!);
    expect(l1w.walletType).toBe('L1');
    expect(l2w.walletType).toBe('L2');

    const t1 = await admin.req(
      'POST',
      '/api/v1/wallets/transfer',
      { toWalletId: l1w._id.toHexString(), amountPaise: 100_000 * RS },
      key(),
    );
    expect(t1.status).toBe(200);
    expect(t1.body.to.balancePaise).toBe(100_000 * RS);

    const t2 = await l1User.req(
      'POST',
      '/api/v1/wallets/transfer',
      { toWalletId: l2w._id.toHexString(), amountPaise: 50_000 * RS },
      key(),
    );
    expect(t2.body.from.balancePaise).toBe(50_000 * RS);
    expect(t2.body.to.balancePaise).toBe(50_000 * RS);

    for (let i = 0; i < 50; i++) {
      const c = await admin.req(
        'POST',
        '/api/v1/subscribers',
        customer(`we${i}`, { resellerId: id.l2, planId: id.plan }),
      );
      expect(c.status).toBe(201);
      const r = await l2User.req('POST', '/api/v1/recharges', { subscriberId: c.body.id }, key());
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.amountPaise).toBe(100 * RS);
      if (i === 0) id.firstRecharge = r.body.id;
    }
    expect((await wallet(id.l2!)).balancePaise).toBe(45_000 * RS);

    await l1User.req(
      'POST',
      '/api/v1/wallets/transfer',
      { toWalletId: l2w._id.toHexString(), amountPaise: 20_000 * RS },
      key(),
    );
    expect((await wallet(id.l1!)).balancePaise).toBe(30_000 * RS);
    expect((await wallet(id.l2!)).balancePaise).toBe(65_000 * RS);

    await admin.req(
      'POST',
      '/api/v1/wallets/transfer',
      { toWalletId: l1w._id.toHexString(), amountPaise: 100_000 * RS },
      key(),
    );
    expect((await wallet(id.l1!)).balancePaise).toBe(130_000 * RS);

    const dash = await l2User.req('GET', '/api/v1/wallets/mine');
    expect(dash.body).toMatchObject({
      balancePaise: 65_000 * RS,
      totals: { receivedPaise: 70_000 * RS, rechargedPaise: 5_000 * RS },
      customers: 50,
      state: 'normal',
    });
    const l1dash = await l1User.req('GET', '/api/v1/wallets/mine');
    expect(l1dash.body).toMatchObject({
      totals: { receivedPaise: 200_000 * RS, allocatedPaise: 70_000 * RS },
      children: 1,
    });

    const ledger = await l2User.req('GET', `/api/v1/wallets/${l2w._id.toHexString()}/ledger?limit=200`);
    expect(ledger.body.items).toHaveLength(52);
    expect(ledger.body.items[0]).toMatchObject({
      type: 'TOPUP',
      direction: 'credit',
      balanceBeforePaise: 45_000 * RS,
      balanceAfterPaise: 65_000 * RS,
    });
    const items = ledger.body.items as { direction: string }[];
    const credits = await l2User.req(
      'GET',
      `/api/v1/wallets/${l2w._id.toHexString()}/ledger?limit=200&direction=credit`,
    );
    expect(credits.body.items).toHaveLength(items.filter((t) => t.direction === 'credit').length);
    expect(credits.body.items.every((t: { direction: string }) => t.direction === 'credit')).toBe(true);

    const report = await l2User.req('GET', `/api/v1/wallets/${l2w._id.toHexString()}/report`);
    expect(report.status).toBe(200);
    const rows = report.body.rows as { count: number; countByType: Record<string, number> }[];
    expect(rows.reduce((a, r) => a + r.count, 0)).toBe(52);
    for (const r of rows) expect(Object.values(r.countByType).reduce((a, b) => a + b, 0)).toBe(r.count);
    const credit = rows.reduce(
      (a, r) =>
        a + Object.entries(r.countByType).reduce((s, [k, v]) => s + (k.endsWith('_credit') ? v : 0), 0),
      0,
    );
    expect(credit).toBe(items.filter((t) => t.direction === 'credit').length);
  });

  it('every balance equals the sum of its ledger', async () => {
    const r = await reconcileWallets(h.db);
    expect(r.mismatches).toBe(0);
  });
});

describe('balance rules', () => {
  beforeAll(async () => {
    id.l3 = (await l2User.req('POST', '/api/v1/resellers', { name: 'L3 Shop', ownerName: 'C' })).body.id;
    const l3w = await wallet(id.l3!);
    await l2User.req(
      'POST',
      '/api/v1/wallets/transfer',
      { toWalletId: l3w._id.toHexString(), amountPaise: 150 * RS },
      key(),
    );
    id.l3user = 'l3@m.in';
    id.c3 = (
      await admin.req(
        'POST',
        '/api/v1/subscribers',
        customer('l3cust', { resellerId: id.l3, planId: id.plan }),
      )
    ).body.id;
    id.c3b = (
      await admin.req(
        'POST',
        '/api/v1/subscribers',
        customer('l3cust2', { resellerId: id.l3, planId: id.plan }),
      )
    ).body.id;
  });

  it('two simultaneous recharges cannot overspend; the same key debits once', async () => {
    const l3 = await resellerUser(id.l3user!, id.l3!);
    const [a, b] = await Promise.all([
      l3.req('POST', '/api/v1/recharges', { subscriberId: id.c3 }, key()),
      l3.req('POST', '/api/v1/recharges', { subscriberId: id.c3b }, key()),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error).toMatchObject({
      code: 'WALLET_INSUFFICIENT',
      message: 'Insufficient Wallet Balance',
    });
    expect((await wallet(id.l3!)).balancePaise).toBe(50 * RS);

    await l2User.req(
      'POST',
      '/api/v1/wallets/transfer',
      { toWalletId: (await wallet(id.l3!))._id.toHexString(), amountPaise: 1000 * RS },
      key(),
    );
    const same = key();
    const [x, y] = await Promise.all([
      l3.req('POST', '/api/v1/recharges', { subscriberId: id.c3 }, same),
      l3.req('POST', '/api/v1/recharges', { subscriberId: id.c3 }, same),
    ]);
    expect(x.status).toBe(200);
    expect(y.status).toBe(200);
    expect(x.body.id).toBe(y.body.id);
    expect((await wallet(id.l3!)).balancePaise).toBe(950 * RS);
    const again = await l3.req('POST', '/api/v1/recharges', { subscriberId: id.c3 }, same);
    expect(again.body).toMatchObject({ id: x.body.id, replayed: true });
    expect((await wallet(id.l3!)).balancePaise).toBe(950 * RS);
  });

  it('a recharge or allocation larger than the balance is refused and nothing moves', async () => {
    const l3 = await resellerUser('l3b@m.in', id.l3!);
    const l3w = await wallet(id.l3!);
    await h.db
      .collection<WalletDoc>('wallets')
      .updateOne({ _id: l3w._id }, { $set: { lowBalanceThresholdPaise: 500 * RS } });
    // drain to Rs. 50 with 9 recharges
    for (let i = 0; i < 9; i++) await l3.req('POST', '/api/v1/recharges', { subscriberId: id.c3b }, key());
    expect((await wallet(id.l3!)).balancePaise).toBe(50 * RS);
    expect((await l3.req('GET', '/api/v1/wallets/mine')).body.state).toBe('low');

    const before = await sub(id.c3b!);
    const txns = await h.db.collection<WalletTxnDoc>('wallet_txns').countDocuments({ walletId: l3w._id });
    const r = await l3.req('POST', '/api/v1/recharges', { subscriberId: id.c3b }, key());
    expect(r.status).toBe(409);
    expect(r.body.error.message).toBe('Insufficient Wallet Balance');
    expect((await sub(id.c3b!)).expiresAt).toEqual(before.expiresAt);
    expect(await h.db.collection<WalletTxnDoc>('wallet_txns').countDocuments({ walletId: l3w._id })).toBe(
      txns,
    );

    const big = await l2User.req(
      'POST',
      '/api/v1/wallets/transfer',
      { toWalletId: l3w._id.toHexString(), amountPaise: 1_000_000 * RS },
      key(),
    );
    expect(big.status).toBe(409);
    expect(big.body.error.code).toBe('WALLET_INSUFFICIENT');
  });

  it('recharges are blocked at zero', async () => {
    const l3 = await resellerUser('l3c@m.in', id.l3!);
    const w = await wallet(id.l3!);
    await admin.req(
      'POST',
      `/api/v1/wallets/${w._id.toHexString()}/adjust`,
      { amountPaise: -50 * RS, reason: 'test drain to zero' },
      key(),
    );
    expect((await wallet(id.l3!)).balancePaise).toBe(0);
    expect((await l3.req('GET', '/api/v1/wallets/mine')).body.state).toBe('empty');
    expect((await l3.req('POST', '/api/v1/recharges', { subscriberId: id.c3b }, key())).status).toBe(409);
  });
});

describe('refund, renewal dates, scope', () => {
  it('a refund adds REFUND, restores the balance, marks REVERSED and deletes nothing', async () => {
    const before = await wallet(id.l2!);
    const r = await admin.req('POST', `/api/v1/recharges/${id.firstRecharge}/refund`, {
      reason: 'customer cancelled',
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('REVERSED');
    expect(r.body.reversal.creditNoteId).toBeTruthy();
    expect((await wallet(id.l2!)).balancePaise).toBe(before.balancePaise + 100 * RS);
    const legs = await h.db
      .collection<WalletTxnDoc>('wallet_txns')
      .find({ referenceId: new ObjectId(id.firstRecharge) })
      .toArray();
    expect(legs.map((l) => l.type).sort()).toEqual(['RECHARGE', 'REFUND']);
    expect(
      (await admin.req('POST', `/api/v1/recharges/${id.firstRecharge}/refund`, { reason: 'twice' })).status,
    ).toBe(409);
    expect(
      (await l2User.req('POST', `/api/v1/recharges/${id.firstRecharge}/refund`, { reason: 'reseller try' }))
        .status,
    ).toBe(403);
  });

  it('renewal extends from the right date and restores speed at once', async () => {
    const c = await admin.req(
      'POST',
      '/api/v1/subscribers',
      customer('renew1', { planId: id.plan, expiresAt: new Date(Date.now() - 86_400_000).toISOString() }),
    );
    const r = await admin.req(
      'POST',
      '/api/v1/recharges',
      { subscriberId: c.body.id, payment: 'cash' },
      key(),
    );
    expect(r.status).toBe(200);
    expect(r.body.channel).toBe('cash');
    const today = istParts(new Date());
    expect(new Date(r.body.newExpiresAt)).toEqual(endOfIstDay(istMidnight(today.y, today.m, today.d + 29)));
    const coa = await h.db
      .collection<OutboxDoc>('outbox')
      .findOne({ entityId: new ObjectId(c.body.id), coa: { $exists: true } }, { sort: { _id: -1 } });
    expect(coa?.coa).toEqual({ action: 'disconnect', reason: 'renewal' });

    const r2 = await admin.req(
      'POST',
      '/api/v1/recharges',
      { subscriberId: c.body.id, payment: 'cash' },
      key(),
    );
    expect(new Date(r2.body.newExpiresAt).getTime()).toBe(
      new Date(r.body.newExpiresAt).getTime() + 30 * 86_400_000,
    );

    const pay = await admin.req('GET', `/api/v1/payments?subscriberId=${c.body.id}`);
    expect(pay.body.items).toHaveLength(2);
    expect(pay.body.items[0]).toMatchObject({ method: 'cash', status: 'captured', amountPaise: 118 * RS });
  });

  it('quantity buys several periods: price × N, one invoice line, period start → end, who recharged', async () => {
    const c = await admin.req(
      'POST',
      '/api/v1/subscribers',
      customer('qty3', { planId: id.plan, expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString() }),
    );
    const before = new Date(c.body.expiresAt).getTime();
    const q = await admin.req('GET', `/api/v1/recharges/quote?subscriberId=${c.body.id}&quantity=3`);
    expect(q.body).toMatchObject({ quantity: 3, customerPricePaise: 300 * RS, customerTotalPaise: 354 * RS });
    expect(new Date(q.body.periodStart).getTime()).toBe(before);
    const r = await admin.req(
      'POST',
      '/api/v1/recharges',
      { subscriberId: c.body.id, payment: 'cash', quantity: 3 },
      key(),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ quantity: 3, customerPricePaise: 300 * RS });
    expect(r.body.by?.name).toBeTruthy();
    expect(new Date(r.body.periodStart).getTime()).toBe(before);
    expect(new Date(r.body.newExpiresAt).getTime()).toBe(before + 90 * 86_400_000);
    const inv = (await admin.req('GET', `/api/v1/invoices?subscriberId=${c.body.id}`)).body.items[0];
    expect(inv).toMatchObject({ taxablePaise: 300 * RS, totalPaise: 354 * RS });
    const pay = await admin.req('GET', `/api/v1/payments?subscriberId=${c.body.id}`);
    expect(pay.body.items[0]).toMatchObject({ amountPaise: 354 * RS });
    expect(
      (
        await admin.req(
          'POST',
          '/api/v1/recharges',
          { subscriberId: c.body.id, payment: 'cash', quantity: 13 },
          key(),
        )
      ).status,
    ).toBe(400);
  });

  it('a reseller sees and moves only its own branch’s money (API, not just screens)', async () => {
    const l1w = await wallet(id.l1!);
    const l2w = await wallet(id.l2!);
    const l3w = await wallet(id.l3!);
    expect((await l2User.req('GET', `/api/v1/wallets/${l1w._id.toHexString()}`)).status).toBe(404);
    expect((await l2User.req('GET', `/api/v1/wallets/${l3w._id.toHexString()}`)).status).toBe(200);
    expect((await l2User.req('GET', `/api/v1/wallets/${l3w._id.toHexString()}/ledger`)).status).toBe(403);
    expect(
      (
        await l1User.req(
          'POST',
          '/api/v1/wallets/transfer',
          { toWalletId: l3w._id.toHexString(), amountPaise: RS },
          key(),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await l2User.req(
          'POST',
          `/api/v1/wallets/${l2w._id.toHexString()}/adjust`,
          { amountPaise: 10 * RS, reason: 'free money please' },
          key(),
        )
      ).status,
    ).toBe(403);
    const list = await l2User.req('GET', '/api/v1/wallets');
    expect(list.body.items.map((w: { id: string }) => w.id)).toEqual([l3w._id.toHexString()]);
    const rc = await l1User.req('GET', '/api/v1/recharges?limit=200');
    expect(rc.body.items.length).toBeGreaterThan(0);
    const direct = await l2User.req('GET', '/api/v1/recharges?limit=200');
    expect(
      direct.body.items.every((x: { subscriber: { name: string } }) => !x.subscriber.name.includes('renew')),
    ).toBe(true);
    expect(
      (
        await l2User.req(
          'POST',
          '/api/v1/recharges',
          {
            subscriberId: (await h.db
              .collection('subscribers')
              .findOne({ username: 'renew1' }))!._id.toHexString(),
          },
          key(),
        )
      ).status,
    ).toBe(404);
  });

  it('rates: parent sets the child’s wallet price; the child sets its own customer price', async () => {
    const put = await l1User.req('PUT', `/api/v1/resellers/${id.l2}/rates`, {
      rates: [{ planId: id.plan, walletPricePaise: 80 * RS }],
    });
    expect(put.status).toBe(200);
    expect(
      (
        await l2User.req('PUT', `/api/v1/resellers/${id.l2}/rates`, {
          rates: [{ planId: id.plan, walletPricePaise: 1 }],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await l2User.req('PUT', `/api/v1/resellers/${id.l2}/rates`, {
          rates: [{ planId: id.plan, customerPricePaise: 120 * RS }],
        })
      ).status,
    ).toBe(200);
    const c = await admin.req(
      'POST',
      '/api/v1/subscribers',
      customer('rate1', { resellerId: id.l2, planId: id.plan }),
    );
    const before = (await wallet(id.l2!)).balancePaise;
    const r = await l2User.req('POST', '/api/v1/recharges', { subscriberId: c.body.id }, key());
    expect(r.body).toMatchObject({ amountPaise: 80 * RS, customerPricePaise: 120 * RS });
    expect((await wallet(id.l2!)).balancePaise).toBe(before - 80 * RS);
  });
});

describe('GST invoices and postpaid', () => {
  it('in-state recharge invoices split CGST/SGST; out-of-state uses IGST', async () => {
    const inState = await admin.req('POST', '/api/v1/subscribers', customer('gst-in', { planId: id.plan }));
    const outState = await admin.req(
      'POST',
      '/api/v1/subscribers',
      customer('gst-out', {
        planId: id.plan,
        address: { line1: 'x', city: 'Noida', state: 'Uttar Pradesh', stateCode: '09', pincode: '201301' },
      }),
    );
    await admin.req('POST', '/api/v1/recharges', { subscriberId: inState.body.id, payment: 'cash' }, key());
    await admin.req('POST', '/api/v1/recharges', { subscriberId: outState.body.id, payment: 'cash' }, key());
    const a = (await admin.req('GET', `/api/v1/invoices?subscriberId=${inState.body.id}`)).body.items[0];
    const b = (await admin.req('GET', `/api/v1/invoices?subscriberId=${outState.body.id}`)).body.items[0];
    expect(a).toMatchObject({
      taxablePaise: 100 * RS,
      cgstPaise: 9 * RS,
      sgstPaise: 9 * RS,
      igstPaise: 0,
      totalPaise: 118 * RS,
      status: 'paid',
    });
    expect(b).toMatchObject({
      taxablePaise: 100 * RS,
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 18 * RS,
      totalPaise: 118 * RS,
    });
    expect(a.number).toMatch(/^INV\/\d{4}\/\d{5}$/);
    const pdf = await admin.req('GET', `/api/v1/invoices/${a.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.raw.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('postpaid: invoice on the 1st with the right split; overdue after grace → blocked; payment reactivates', async () => {
    const c = await admin.req(
      'POST',
      '/api/v1/subscribers',
      customer('post1', { planId: id.plan, billingType: 'postpaid' }),
    );
    await h.db
      .collection('subscribers')
      .updateOne({ _id: new ObjectId(c.body.id) }, { $set: { createdAt: new Date('2026-01-01T00:00:00Z') } });
    const { y, m } = istParts(new Date());
    const first = new Date(istMidnight(y, m + 1, 1).getTime() + 3600_000);
    expect((await postpaidInvoices(h.client, h.db, first)).created).toBeGreaterThanOrEqual(1);
    expect((await postpaidInvoices(h.client, h.db, first)).created).toBe(0);
    const inv = (await h.db
      .collection<InvoiceDoc>('invoices')
      .findOne({ subscriberId: new ObjectId(c.body.id) }))!;
    expect(inv).toMatchObject({
      type: 'postpaid_monthly',
      taxablePaise: 100 * RS,
      cgstPaise: 9 * RS,
      sgstPaise: 9 * RS,
      totalPaise: 118 * RS,
      status: 'issued',
    });

    const afterGrace = new Date(inv.dueDate.getTime() + 4 * 86_400_000);
    const od = await postpaidOverdue(h.client, h.db, afterGrace);
    expect(od.suspended).toBeGreaterThanOrEqual(1);
    const s = await sub(c.body.id);
    expect(s).toMatchObject({ status: 'suspended', suspendReason: 'overdue' });
    const disc = await h.db
      .collection<OutboxDoc>('outbox')
      .findOne({ entityId: s._id, coa: { $exists: true } }, { sort: { _id: -1 } });
    expect(disc?.coa).toEqual({ action: 'disconnect', reason: 'suspend' });

    const pay = await admin.req(
      'POST',
      '/api/v1/payments/cash',
      { invoiceId: inv._id.toHexString(), amountPaise: 118 * RS },
      key(),
    );
    expect(pay.status).toBe(200);
    expect((await sub(c.body.id)).status).toBe('active');
    expect((await h.db.collection<InvoiceDoc>('invoices').findOne({ _id: inv._id }))!.status).toBe('paid');
  });
});

describe('payment gateways', () => {
  beforeAll(async () => {
    const s = await admin.req('PATCH', '/api/v1/billing/settings', {
      razorpay: {
        enabled: true,
        keyId: 'rzp_test_key',
        keySecret: 'rzp-secret-123',
        webhookSecret: 'hook-secret-123',
      },
      cashfree: { enabled: true, sandbox: true, appId: 'cf-app-123', secretKey: 'cf-secret-123' },
    });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(JSON.stringify(s.body)).not.toContain('secret-123');
  });

  const rzpHook = (body: object, secret = 'hook-secret-123') => {
    const raw = JSON.stringify(body);
    return h.app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/razorpay/${tenant.toHexString()}`,
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': createHmac('sha256', secret).update(raw).digest('hex'),
      },
      payload: raw,
    });
  };

  it('Razorpay: a webhook sent twice records one payment and one recharge; a bad signature is refused', async () => {
    const c = await admin.req(
      'POST',
      '/api/v1/subscribers',
      customer('online1', { resellerId: id.l2, planId: id.plan }),
    );
    const link = await l2User.req('POST', '/api/v1/payments/link', {
      subscriberId: c.body.id,
      gateway: 'razorpay',
      planId: id.plan,
    });
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    expect(link.body).toMatchObject({
      status: 'created',
      amountPaise: 142 * RS,
      linkUrl: expect.stringContaining('rzp.io'),
    });
    const linkId = [...links.entries()].find(([, v]) => v.ref === link.body.id)![0];
    const event = {
      event: 'payment_link.paid',
      payload: {
        payment_link: { entity: { id: linkId, reference_id: link.body.id } },
        payment: { entity: { id: `pay_${linkId}`, amount: 142 * RS, method: 'upi' } },
      },
    };
    expect((await rzpHook(event, 'wrong-secret')).statusCode).toBe(401);
    // A dashboard test delivery (signed, no payment link) is acknowledged.
    const ping = await rzpHook({ event: 'ping', payload: {} });
    expect(ping.statusCode).toBe(200);
    expect(JSON.parse(ping.body).action).toBe('ignored');
    // Paid only once the gateway says so.
    expect(JSON.parse((await rzpHook(event)).body).action).toBe('not_paid');
    links.get(linkId)!.paid = true;
    const l2before = (await wallet(id.l2!)).balancePaise;
    const [x, y] = await Promise.all([rzpHook(event), rzpHook(event)]);
    expect([JSON.parse(x.body).action, JSON.parse(y.body).action].sort()).toEqual(['duplicate', 'settled']);
    expect(JSON.parse((await rzpHook(event)).body).action).toBe('duplicate');
    const p = await admin.req('GET', `/api/v1/payments/${link.body.id}`);
    expect(p.body).toMatchObject({ status: 'captured', gatewayPaymentId: `pay_${linkId}` });
    expect(await h.db.collection('recharges').countDocuments({ paymentId: new ObjectId(link.body.id) })).toBe(
      1,
    );
    // Customer of L2: 142 credited to L2, then L2's wallet price (80) debited.
    expect((await wallet(id.l2!)).balancePaise).toBe(l2before + 142 * RS - 80 * RS);
  });

  it('a failed payment changes nothing', async () => {
    const c = await admin.req('POST', '/api/v1/subscribers', customer('online2', { planId: id.plan }));
    const link = await admin.req('POST', '/api/v1/payments/link', {
      subscriberId: c.body.id,
      gateway: 'razorpay',
      planId: id.plan,
    });
    const linkId = [...links.entries()].find(([, v]) => v.ref === link.body.id)![0];
    const r = await rzpHook({
      event: 'payment.failed',
      payload: { payment: { entity: { id: 'pay_fail', amount: 118 * RS, notes: { ref: link.body.id } } } },
    });
    expect(JSON.parse(r.body).action).toBe('recorded');
    expect((await admin.req('GET', `/api/v1/payments/${link.body.id}`)).body.status).toBe('created');
    expect((await sub(c.body.id)).expiresAt).toBeUndefined();
    void linkId;
  });

  it('Cashfree: signed webhook settles an invoice payment once', async () => {
    const c = await admin.req(
      'POST',
      '/api/v1/subscribers',
      customer('cfpost', { planId: id.plan, billingType: 'postpaid' }),
    );
    await h.db
      .collection('subscribers')
      .updateOne({ _id: new ObjectId(c.body.id) }, { $set: { createdAt: new Date('2026-01-01T00:00:00Z') } });
    const { y, m } = istParts(new Date());
    await postpaidInvoices(h.client, h.db, new Date(istMidnight(y, m + 1, 1).getTime() + 3600_000));
    const inv = (await h.db
      .collection<InvoiceDoc>('invoices')
      .findOne({ subscriberId: new ObjectId(c.body.id) }))!;
    const link = await admin.req('POST', '/api/v1/payments/link', {
      subscriberId: c.body.id,
      gateway: 'cashfree',
      invoiceId: inv._id.toHexString(),
    });
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    links.get(link.body.id)!.paid = true;
    const raw = JSON.stringify({
      type: 'PAYMENT_SUCCESS_WEBHOOK',
      data: {
        order: { order_id: 'order_x', order_tags: { link_id: link.body.id } },
        payment: { cf_payment_id: 555, payment_status: 'SUCCESS', payment_amount: 118, payment_group: 'upi' },
      },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const send = () =>
      h.app.inject({
        method: 'POST',
        url: `/api/v1/webhooks/cashfree/${tenant.toHexString()}`,
        headers: {
          'content-type': 'application/json',
          'x-webhook-timestamp': ts,
          'x-webhook-signature': createHmac('sha256', 'cf-secret-123')
            .update(ts + raw)
            .digest('base64'),
        },
        payload: raw,
      });
    expect(JSON.parse((await send()).body).action).toBe('settled');
    expect(JSON.parse((await send()).body).action).toBe('duplicate');
    expect((await h.db.collection<InvoiceDoc>('invoices').findOne({ _id: inv._id }))!).toMatchObject({
      status: 'paid',
      paidPaise: 118 * RS,
    });
  });
});

describe('reconciliation', () => {
  it('a tampered balance is caught and the wallet frozen; frozen wallets move no money', async () => {
    expect((await reconcileWallets(h.db)).mismatches).toBe(0);
    const w = await wallet(id.l3!);
    await h.db.collection<WalletDoc>('wallets').updateOne({ _id: w._id }, { $inc: { balancePaise: 999 } });
    const r = await reconcileWallets(h.db);
    expect(r.mismatches).toBe(1);
    expect((await wallet(id.l3!)).frozen).toBe(true);
    const t = await l2User.req(
      'POST',
      '/api/v1/wallets/transfer',
      { toWalletId: w._id.toHexString(), amountPaise: RS },
      key(),
    );
    expect(t.body.error.code).toBe('WALLET_FROZEN');
  });
});
