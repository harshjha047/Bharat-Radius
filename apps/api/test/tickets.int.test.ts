import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, roleId, seedTenant, seedUser, signIn, startHarness, type Harness } from './harness.js';

let h: Harness;
let tenant: ObjectId;
let admin: Client;
let support: Client;
let tech: Client;
let l1: Client;
const id: Record<string, string> = {};

const customer = (username: string, extra: object = {}) => ({
  username,
  pppoePassword: `pp-${username}-9`,
  name: `Cust ${username}`,
  phone: '9876543210',
  address: { line1: '1 Main Rd', city: 'Delhi', state: 'Delhi', pincode: '110001' },
  ...extra,
});
const portal = async (username: string) => {
  const c = new Client(h);
  const r = await c.req('POST', '/api/v1/portal/auth/login', {
    login: username,
    password: `pp-${username}-9`,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return c;
};

beforeAll(async () => {
  h = await startHarness();
  tenant = await seedTenant(h.db, 'alpha', 'new.example.test');
  admin = await signIn(
    h,
    await seedUser(h, {
      tenantId: tenant,
      email: 'admin@t.in',
      roles: [await roleId(h.db, 'ISP Admin')],
      totp: true,
    }),
  );
  const sup = await seedUser(h, {
    tenantId: tenant,
    email: 'support@t.in',
    roles: [await roleId(h.db, 'Support')],
  });
  id.support = sup._id.toHexString();
  support = await signIn(h, sup);
  const t = await seedUser(h, {
    tenantId: tenant,
    email: 'tech@t.in',
    roles: [await roleId(h.db, 'Technician')],
  });
  id.tech = t._id.toHexString();
  tech = await signIn(h, t);
  const acc = await seedUser(h, {
    tenantId: tenant,
    email: 'acc@t.in',
    roles: [await roleId(h.db, 'Accountant')],
  });
  id.accountant = acc._id.toHexString();

  id.l1 = (await admin.req('POST', '/api/v1/resellers', { name: 'L1 Site', ownerName: 'A' })).body.id;
  id.l1b = (await admin.req('POST', '/api/v1/resellers', { name: 'Other Site', ownerName: 'B' })).body.id;
  const ru = await seedUser(h, {
    tenantId: tenant,
    email: 'l1@t.in',
    type: 'reseller',
    roles: [await roleId(h.db, 'Reseller Owner')],
  });
  await h.db.collection('users').updateOne({ _id: ru._id }, { $set: { resellerId: new ObjectId(id.l1) } });
  l1 = await signIn(h, ru);

  id.direct = (await admin.req('POST', '/api/v1/subscribers', customer('direct.t'))).body.id;
  id.mine = (
    await admin.req('POST', '/api/v1/subscribers', customer('l1cust.t', { resellerId: id.l1 }))
  ).body.id;
  id.other = (
    await admin.req('POST', '/api/v1/subscribers', customer('l1b.t', { resellerId: id.l1b }))
  ).body.id;
});
afterAll(() => h?.close());

describe('customer ↔ support', () => {
  it('customer raises a ticket; numbered per ISP; no-internet is high priority', async () => {
    const c = await portal('direct.t');
    const r = await c.req('POST', '/api/v1/portal/tickets', {
      subject: 'No internet since morning',
      category: 'no_internet',
      body: 'Red LOS light on the ONT.',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({
      number: 'T000001',
      status: 'open',
      priority: 'high',
      source: 'portal',
      subscriber: { id: id.direct },
      events: [{ kind: 'message', body: 'Red LOS light on the ONT.', author: { type: 'customer' } }],
    });
    id.t1 = r.body.id;
  });

  it('support assigns to a technician; internal notes are hidden from the customer', async () => {
    const a = await support.req('PATCH', `/api/v1/tickets/${id.t1}`, {
      assigneeId: id.tech,
      status: 'in_progress',
    });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.assignee).toEqual({ id: id.tech, name: 'tech' });
    const bad = await support.req('PATCH', `/api/v1/tickets/${id.t1}`, { assigneeId: id.accountant });
    expect(bad.status).toBe(400);
    const techCannotAssign = await tech.req('PATCH', `/api/v1/tickets/${id.t1}`, { assigneeId: id.support });
    expect(techCannotAssign.status).toBe(403);

    const mine = await tech.req('GET', '/api/v1/tickets?assignee=me&status=active');
    expect(mine.body.items.map((t: { id: string }) => t.id)).toEqual([id.t1]);

    await tech.req('POST', `/api/v1/tickets/${id.t1}/reply`, {
      body: 'Fibre cut near pole 12',
      internal: true,
    });
    const reply = await tech.req('POST', `/api/v1/tickets/${id.t1}/reply`, {
      body: 'A technician is on the way.',
      status: 'waiting_customer',
    });
    expect(reply.status).toBe(200);
    expect(reply.body.firstResponseAt).not.toBeNull();
    expect(reply.body.events.map((e: { kind: string }) => e.kind)).toEqual([
      'message',
      'status',
      'assign',
      'note',
      'message',
      'status',
    ]);

    const c = await portal('direct.t');
    const seen = await c.req('GET', `/api/v1/portal/tickets/${id.t1}`);
    expect(seen.body.events.map((e: { kind: string }) => e.kind)).toEqual([
      'message',
      'status',
      'message',
      'status',
    ]);
    expect(JSON.stringify(seen.body)).not.toContain('pole 12');
  });

  it('customer reply reopens; resolve → customer closes; closed cannot be replied to', async () => {
    const c = await portal('direct.t');
    const r = await c.req('POST', `/api/v1/portal/tickets/${id.t1}/reply`, { body: 'Still down.' });
    expect(r.body.status).toBe('open');
    await support.req('PATCH', `/api/v1/tickets/${id.t1}`, { status: 'resolved' });
    expect((await support.req('GET', `/api/v1/tickets/${id.t1}`)).body.resolvedAt).not.toBeNull();
    const closed = await c.req('POST', `/api/v1/portal/tickets/${id.t1}/close`);
    expect(closed.body.status).toBe('closed');
    const after = await c.req('POST', `/api/v1/portal/tickets/${id.t1}/reply`, { body: 'again' });
    expect(after.status).toBe(409);
  });

  it('counts by status, mine and unassigned', async () => {
    await admin.req('POST', '/api/v1/tickets', {
      subscriberId: id.direct,
      subject: 'Relocation',
      category: 'relocation',
      body: 'Moving next week',
    });
    const n = await support.req('GET', '/api/v1/tickets/counts');
    expect(n.body).toMatchObject({ open: 1, closed: 1, unassigned: 1, mine: 0 });
  });

  it('a customer sees only their own tickets', async () => {
    const other = await portal('l1b.t');
    expect((await other.req('GET', `/api/v1/portal/tickets/${id.t1}`)).status).toBe(404);
    expect((await other.req('POST', `/api/v1/portal/tickets/${id.t1}/reply`, { body: 'x' })).status).toBe(
      404,
    );
    expect((await other.req('GET', '/api/v1/portal/tickets')).body.items).toEqual([]);
  });

  it('customers can open at most 5 tickets an hour', async () => {
    const c = await portal('l1b.t');
    for (let i = 0; i < 5; i++) {
      const r = await c.req('POST', '/api/v1/portal/tickets', {
        subject: `s${i}`,
        category: 'other',
        body: 'b',
      });
      expect(r.status).toBe(201);
    }
    const r = await c.req('POST', '/api/v1/portal/tickets', { subject: 's6', category: 'other', body: 'b' });
    expect(r.status).toBe(429);
  });
});

describe('reseller branch', () => {
  it('a reseller opens tickets only for its own customers and sees only its branch', async () => {
    const own = await l1.req('POST', '/api/v1/tickets', {
      subscriberId: id.mine,
      subject: 'Slow speed',
      category: 'slow_speed',
      body: 'Customer says 5 Mbps',
    });
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    expect(own.body.source).toBe('reseller');
    const foreign = await l1.req('POST', '/api/v1/tickets', {
      subscriberId: id.other,
      subject: 'x',
      category: 'other',
      body: 'x',
    });
    expect(foreign.status).toBe(404);
    const none = await l1.req('POST', '/api/v1/tickets', { subject: 'x', category: 'other', body: 'x' });
    expect(none.status).toBe(400);
    const list = await l1.req('GET', '/api/v1/tickets');
    expect(list.body.items.map((t: { id: string }) => t.id)).toEqual([own.body.id]);
    expect((await l1.req('GET', `/api/v1/tickets/${id.t1}`)).status).toBe(404);
    expect((await l1.req('PATCH', `/api/v1/tickets/${own.body.id}`, { assigneeId: id.tech })).status).toBe(
      403,
    );
  });
});
