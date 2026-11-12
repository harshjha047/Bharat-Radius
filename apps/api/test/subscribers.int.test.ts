import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OutboxDoc, SubscriberDoc } from '@isp/db-mongo';
import { roleId, seedTenant, seedUser, signIn, startHarness, type Client, type Harness } from './harness.js';

let h: Harness;
let admin: Client;
let support: Client;
let planA: string;
let planB: string;

const outbox = (id: string) =>
  h.db
    .collection<OutboxDoc>('outbox')
    .find({ entityId: new ObjectId(id) }, { sort: { createdAt: 1 } })
    .toArray();
const lastCoa = async (id: string) => (await outbox(id)).at(-1)?.coa;
const base = {
  name: 'Rahul Kumar',
  phone: '98765 43210',
  address: { line1: '12 MG Road', city: 'Delhi', state: 'Delhi', pincode: '110001' },
};
const future = () => new Date(Date.now() + 30 * 86_400_000).toISOString();

beforeAll(async () => {
  h = await startHarness();
  const t = await seedTenant(h.db, 'alpha', 'new.example.test');
  admin = await signIn(
    h,
    await seedUser(h, {
      tenantId: t,
      email: 'admin@alpha.in',
      roles: [await roleId(h.db, 'ISP Admin')],
      totp: true,
    }),
  );
  support = await signIn(
    h,
    await seedUser(h, { tenantId: t, email: 'sup@alpha.in', roles: [await roleId(h.db, 'Support')] }),
  );
  planA = (
    await admin.req('POST', '/api/v1/plans', {
      name: 'A',
      downloadKbps: 50_000,
      uploadKbps: 20_000,
      pricePaise: 1,
    })
  ).body.id;
  planB = (
    await admin.req('POST', '/api/v1/plans', {
      name: 'B',
      downloadKbps: 100_000,
      uploadKbps: 50_000,
      pricePaise: 1,
    })
  ).body.id;
});
afterAll(() => h?.close());

describe('subscribers', () => {
  let id: string;

  it('creates with a generated PPPoE password (shown once, stored encrypted) and a customer number', async () => {
    const r = await admin.req('POST', '/api/v1/subscribers', {
      ...base,
      username: 'rahul01',
      planId: planA,
      expiresAt: future(),
      network: { macLock: 'aa-bb-cc-dd-ee-ff' },
    });
    expect(r.status).toBe(201);
    id = r.body.id;
    expect(r.body).toMatchObject({
      customerNo: 'C000001',
      phone: '+919876543210',
      syncStatus: 'pending',
      radiusState: 'active',
      network: { macLock: 'AA:BB:CC:DD:EE:FF' },
      address: { stateCode: '07' },
    });
    expect(r.body.pppoePassword).toMatch(/^[a-z2-9]{10}$/);
    const doc = await h.db.collection<SubscriberDoc>('subscribers').findOne({ _id: new ObjectId(id) });
    expect(JSON.stringify(doc)).not.toContain(r.body.pppoePassword);
    expect((await admin.req('GET', `/api/v1/subscribers/${id}/password`)).body.pppoePassword).toBe(
      r.body.pppoePassword,
    );
    expect(await outbox(id)).toHaveLength(1);
    const second = await admin.req('POST', '/api/v1/subscribers', { ...base, username: 'rahul02' });
    expect(second.body.customerNo).toBe('C000002');
  });

  it('refuses duplicate usernames and static IPs, archived plans and bad MACs', async () => {
    expect((await admin.req('POST', '/api/v1/subscribers', { ...base, username: 'rahul01' })).status).toBe(
      409,
    );
    await admin.req('PATCH', `/api/v1/subscribers/${id}`, { network: { staticIp: '100.64.1.5' } });
    expect(
      (
        await admin.req('POST', '/api/v1/subscribers', {
          ...base,
          username: 'dup-ip',
          network: { staticIp: '100.64.1.5' },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await admin.req('POST', '/api/v1/subscribers', {
          ...base,
          username: 'bad-mac',
          network: { macLock: 'zz' },
        })
      ).status,
    ).toBe(400);
    const pin = await admin.req('POST', '/api/v1/subscribers', {
      ...base,
      username: 'bad-pin',
      address: { ...base.address, pincode: '1234' },
    });
    expect(pin.body.error.details.issues).toContainEqual({
      in: 'body',
      path: 'address.pincode',
      message: 'must be a 6-digit PIN code',
    });
    const archived = (
      await admin.req('POST', '/api/v1/plans', {
        name: 'Old',
        downloadKbps: 1000,
        uploadKbps: 1000,
        pricePaise: 1,
      })
    ).body.id;
    await admin.req('PATCH', `/api/v1/plans/${archived}`, { status: 'archived' });
    expect(
      (await admin.req('POST', '/api/v1/subscribers', { ...base, username: 'old-plan', planId: archived }))
        .status,
    ).toBe(400);
  });

  it('search by name, username, phone and customer number prefix', async () => {
    const q = async (term: string) =>
      (await admin.req('GET', `/api/v1/subscribers?q=${encodeURIComponent(term)}`)).body.items.map(
        (s: { username: string }) => s.username,
      );
    expect(await q('kum')).toEqual(['rahul02', 'rahul01']);
    expect(await q('rahul01')).toEqual(['rahul01']);
    expect(await q('98765')).toHaveLength(2);
    expect(await q('+919876543210')).toHaveLength(2);
    expect(await q('c000002')).toEqual(['rahul02']);
    expect(await q('nobody')).toEqual([]);
  });

  it('plan change → rate CoA; static IP change → disconnect; expiry in the past → expired + disconnect', async () => {
    await admin.req('PATCH', `/api/v1/subscribers/${id}`, { planId: planB });
    expect(await lastCoa(id)).toEqual({ action: 'update', reason: 'plan_change' });
    await admin.req('PATCH', `/api/v1/subscribers/${id}`, { network: { staticIp: '100.64.1.6' } });
    expect(await lastCoa(id)).toEqual({ action: 'disconnect', reason: 'network' });
    const r = await admin.req('PATCH', `/api/v1/subscribers/${id}`, {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(r.body.radiusState).toBe('expired');
    expect(await lastCoa(id)).toEqual({ action: 'disconnect', reason: 'renewal' });
    const list = await admin.req('GET', '/api/v1/subscribers?status=expired');
    expect(list.body.items.map((s: { id: string }) => s.id)).toEqual([id]);
    await admin.req('PATCH', `/api/v1/subscribers/${id}`, { expiresAt: future() });
  });

  it('suspend disconnects; activate needs no CoA; kick queues a disconnect', async () => {
    const s = await admin.req('POST', `/api/v1/subscribers/${id}/suspend`, { reason: 'overdue' });
    expect(s.body).toMatchObject({ status: 'suspended', suspendReason: 'overdue', radiusState: 'blocked' });
    expect(await lastCoa(id)).toEqual({ action: 'disconnect', reason: 'suspend' });
    const a = await admin.req('POST', `/api/v1/subscribers/${id}/activate`);
    expect(a.body.status).toBe('active');
    expect(await lastCoa(id)).toBeUndefined();
    expect((await admin.req('POST', `/api/v1/subscribers/${id}/kick`)).status).toBe(200);
    expect(await lastCoa(id)).toEqual({ action: 'disconnect', reason: 'kick' });
  });

  it('a plan speed change queues a CoA for everyone on the plan; a rename does not', async () => {
    await admin.req('PATCH', `/api/v1/plans/${planB}`, { name: 'B renamed' });
    expect((await outbox(planB)).at(-1)?.coa).toBeUndefined();
    await admin.req('PATCH', `/api/v1/plans/${planB}`, { downloadKbps: 150_000 });
    expect((await outbox(planB)).at(-1)?.coa).toEqual({ action: 'update', reason: 'plan_change' });
  });

  it('permissions: support edits and kicks but cannot read PPPoE passwords or delete', async () => {
    expect((await support.req('PATCH', `/api/v1/subscribers/${id}`, { notes: 'called' })).status).toBe(200);
    expect((await support.req('POST', `/api/v1/subscribers/${id}/kick`)).status).toBe(200);
    expect((await support.req('GET', `/api/v1/subscribers/${id}/password`)).status).toBe(403);
    expect((await support.req('DELETE', `/api/v1/subscribers/${id}`)).status).toBe(403);
  });

  it('delete disconnects and frees the username and static IP', async () => {
    expect((await admin.req('DELETE', `/api/v1/subscribers/${id}`)).status).toBe(200);
    expect(await lastCoa(id)).toEqual({ action: 'disconnect', reason: 'delete' });
    expect((await admin.req('GET', `/api/v1/subscribers/${id}`)).status).toBe(404);
    const again = await admin.req('POST', '/api/v1/subscribers', {
      ...base,
      username: 'rahul01',
      network: { staticIp: '100.64.1.6' },
    });
    expect(again.status).toBe(201);
  });
});

describe('expiring soon', () => {
  it('lists active prepaid customers expiring within N days, soonest first, with the total', async () => {
    const at = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
    const mk = async (username: string, body: Record<string, unknown>) => {
      const r = await admin.req('POST', '/api/v1/subscribers', {
        ...base,
        username,
        planId: planA,
        billingType: 'prepaid',
        ...body,
      });
      expect(r.status).toBe(201);
      return r.body.id as string;
    };
    await mk('exp-5d', { expiresAt: at(5) });
    await mk('exp-2d', { expiresAt: at(2) });
    await mk('exp-20d', { expiresAt: at(20) });
    const susp = await mk('exp-3d-susp', { expiresAt: at(3) });
    expect((await admin.req('POST', `/api/v1/subscribers/${susp}/suspend`, {})).status).toBe(200);

    const names = (b: Record<string, unknown>) =>
      (b.items as { username: string }[]).map((s) => s.username).filter((u) => u.startsWith('exp-'));
    const r = await support.req('GET', '/api/v1/subscribers/expiring');
    expect(r.status).toBe(200);
    expect(names(r.body)).toEqual(['exp-2d', 'exp-5d']);
    const wide = await support.req('GET', '/api/v1/subscribers/expiring?days=30&limit=1');
    expect(wide.body.items).toHaveLength(1);
    expect(wide.body.total).toBeGreaterThanOrEqual(3);
  });
});

describe('renewals summary and the expiry filter', () => {
  it('counts by status and IST expiry window, with renewal value, and the list filter matches', async () => {
    const DAY = 86_400_000;
    const IST = 330 * 60_000;
    const nowIst = new Date(Date.now() + IST);
    const todayStart = Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate()) - IST;
    const tomorrow = todayStart + DAY;
    const monthStart = Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), 1) - IST;
    const iso = (t: number) => new Date(t).toISOString();
    // Later today (or, a minute before midnight, as late as possible), mid-tomorrow, in 5 days, earlier this month.
    const laterToday = Math.min(Date.now() + 30 * 60_000, tomorrow - 30_000);
    const earlierThisMonth = Math.max(monthStart + 60_000, Date.now() - 60 * 60_000);

    const mk = async (username: string, expiresAt: number) => {
      const r = await admin.req('POST', '/api/v1/subscribers', {
        ...base,
        username,
        planId: planA,
        billingType: 'prepaid',
        expiresAt: iso(expiresAt),
      });
      expect(r.status).toBe(201);
    };
    await mk('ren-today', laterToday);
    await mk('ren-tomorrow', tomorrow + 12 * 3_600_000);
    await mk('ren-5d', Date.now() + 5 * DAY);
    await mk('ren-expired', earlierThisMonth);

    const s = await support.req('GET', '/api/v1/subscribers/summary');
    expect(s.status).toBe(200);
    const b = s.body as {
      [
        k in
          | 'total'
          | 'active'
          | 'suspended'
          | 'disabled'
          | 'expired'
          | 'expiredThisMonth'
          | 'expiringToday'
          | 'expiringTomorrow'
          | 'expiring7d'
      ]: number;
    } & { renewPaise: { today: number; tomorrow: number; next7d: number; expiredThisMonth: number } };
    expect(b.expiringToday).toBeGreaterThanOrEqual(1);
    expect(b.expiringTomorrow).toBeGreaterThanOrEqual(1);
    expect(b.expiring7d).toBeGreaterThanOrEqual(b.expiringToday + b.expiringTomorrow);
    expect(b.expiredThisMonth).toBeGreaterThanOrEqual(1);
    expect(b.expired).toBeGreaterThanOrEqual(b.expiredThisMonth);
    expect(b.active + b.expired + b.suspended + b.disabled).toBe(b.total);
    expect(b.renewPaise.today).toBeGreaterThan(0);
    expect(b.renewPaise.next7d).toBeGreaterThanOrEqual(b.renewPaise.today + b.renewPaise.tomorrow);

    const names = async (expiry: string) => {
      const r = await support.req('GET', `/api/v1/subscribers?expiry=${expiry}&limit=200`);
      expect(r.status).toBe(200);
      return (r.body.items as { username: string }[])
        .map((x) => x.username)
        .filter((u) => u.startsWith('ren-'));
    };
    expect(await names('today')).toEqual(['ren-today']);
    expect(await names('tomorrow')).toEqual(['ren-tomorrow']);
    expect((await names('7d')).sort()).toEqual(['ren-5d', 'ren-today', 'ren-tomorrow']);
    expect(await names('expired-month')).toEqual(['ren-expired']);
    const st = async (status: string) =>
      (
        (await support.req('GET', `/api/v1/subscribers?status=${status}&limit=200`)).body.items as {
          username: string;
        }[]
      ).map((x) => x.username);
    expect(await st('expired')).toContain('ren-expired');
    expect(await st('active')).not.toContain('ren-expired');
    expect(await st('active')).toContain('ren-5d');

    const w = await support.req('GET', '/api/v1/subscribers/expiring?window=tomorrow&limit=100');
    expect(w.status).toBe(200);
    expect(
      (w.body.items as { username: string }[]).map((x) => x.username).filter((u) => u.startsWith('ren-')),
    ).toEqual(['ren-tomorrow']);
  });
});
