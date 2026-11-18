import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NasDeviceDoc, OutboxDoc } from '@isp/db-mongo';
import { roleId, seedTenant, seedUser, signIn, startHarness, type Client, type Harness } from './harness.js';

let h: Harness;
let tenantA: ObjectId;
let admin: Client;
let support: Client;
let superadmin: Client;

const outboxFor = (entityId: string) =>
  h.db
    .collection<OutboxDoc>('outbox')
    .find({ entityId: new ObjectId(entityId) })
    .toArray();

beforeAll(async () => {
  h = await startHarness();
  tenantA = await seedTenant(h.db, 'alpha', 'new.example.test');
  admin = await signIn(
    h,
    await seedUser(h, {
      tenantId: tenantA,
      email: 'admin@alpha.in',
      roles: [await roleId(h.db, 'ISP Admin')],
      totp: true,
    }),
  );
  support = await signIn(
    h,
    await seedUser(h, { tenantId: tenantA, email: 'sup@alpha.in', roles: [await roleId(h.db, 'Support')] }),
  );
  superadmin = await signIn(
    h,
    await seedUser(h, { tenantId: null, email: 'root@platform.in', totp: true }),
    'platform',
  );
});
afterAll(() => h?.close());

describe('routers (NAS)', () => {
  let id: string;

  it('creates with a generated secret shown once, stored encrypted, queued for RADIUS', async () => {
    const r = await admin.req('POST', '/api/v1/nas', {
      name: 'POP-1 CCR',
      ip: '203.0.113.10',
      routerOsVersion: '7',
    });
    expect(r.status).toBe(201);
    id = r.body.id;
    expect(r.body.radiusSecret).toMatch(/^[\w-]{24}$/);
    const stored = await h.db.collection<NasDeviceDoc>('nas_devices').findOne({ _id: new ObjectId(id) });
    expect(JSON.stringify(stored)).not.toContain(r.body.radiusSecret);
    expect(h.crypto.decrypt(stored!.radiusSecret, `nas.secret:${id}`)).toBe(r.body.radiusSecret);
    expect((await admin.req('GET', `/api/v1/nas/${id}`)).body.radiusSecret).toBeUndefined();
    expect((await admin.req('GET', `/api/v1/nas/${id}/secret`)).body.radiusSecret).toBe(r.body.radiusSecret);
    expect(await outboxFor(id)).toHaveLength(1);
  });

  it('rejects bad input and duplicate IPs', async () => {
    expect((await admin.req('POST', '/api/v1/nas', { name: 'x', ip: '300.1.1.1' })).status).toBe(400);
    expect(
      (
        await admin.req('POST', '/api/v1/nas', {
          name: 'x',
          ip: '203.0.113.11',
          radiusSecret: 'has space in it!!',
        })
      ).status,
    ).toBe(400);
    expect((await admin.req('POST', '/api/v1/nas', { name: 'dup', ip: '203.0.113.10' })).status).toBe(409);
  });

  it('accepts RouterOS versions as written in the field ("v6", "6.49.20") and stores the major', async () => {
    const c = await admin.req('POST', '/api/v1/nas', {
      name: 'ROS',
      ip: '203.0.113.50',
      routerOsVersion: 'v6',
    });
    expect(c.status).toBe(201);
    expect(c.body.routerOsVersion).toBe('6');
    for (const [v, want] of [
      ['6.49.20', '6'],
      ['RouterOS 7', '7'],
    ] as const) {
      const r = await admin.req('PATCH', `/api/v1/nas/${c.body.id}`, { routerOsVersion: v });
      expect(r.status).toBe(200);
      expect(r.body.routerOsVersion).toBe(want);
    }
    expect((await admin.req('PATCH', `/api/v1/nas/${c.body.id}`, { routerOsVersion: 'v8' })).status).toBe(
      400,
    );
    expect((await admin.req('DELETE', `/api/v1/nas/${c.body.id}`)).status).toBe(200);
  });

  it('tells staff where routers send RADIUS', async () => {
    const r = await admin.req('GET', '/api/v1/nas/radius-target');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ instance: expect.stringMatching(/^(production|staging)$/) });
    expect(r.body.authPort).toBeGreaterThan(0);
  });

  it('rotates the secret and queues each change', async () => {
    const r = await admin.req('PATCH', `/api/v1/nas/${id}`, { rotateSecret: true, coaPort: 1700 });
    expect(r.status).toBe(200);
    expect(r.body.radiusSecret).toMatch(/^[\w-]{24}$/);
    expect(r.body.coaPort).toBe(1700);
    expect(await outboxFor(id)).toHaveLength(2);
  });

  it('support can read but not change routers or see secrets', async () => {
    expect((await support.req('GET', '/api/v1/nas')).status).toBe(200);
    expect((await support.req('PATCH', `/api/v1/nas/${id}`, { name: 'x' })).status).toBe(403);
    expect((await support.req('GET', `/api/v1/nas/${id}/secret`)).status).toBe(403);
  });

  it('delete frees the IP for a new router', async () => {
    expect((await admin.req('DELETE', `/api/v1/nas/${id}`)).status).toBe(200);
    expect((await admin.req('GET', `/api/v1/nas/${id}`)).status).toBe(404);
    expect(await outboxFor(id)).toHaveLength(3);
    expect((await admin.req('POST', '/api/v1/nas', { name: 'POP-1 new', ip: '203.0.113.10' })).status).toBe(
      201,
    );
  });
});

describe('plans', () => {
  let id: string;
  const base = { name: 'Home 50', downloadKbps: 50_000, uploadKbps: 25_000, pricePaise: 49_900 };

  it('derives the MikroTik rate and defaults GST fields', async () => {
    const r = await admin.req('POST', '/api/v1/plans', base);
    expect(r.status).toBe(201);
    id = r.body.id;
    expect(r.body).toMatchObject({
      rateLimit: '25M/50M',
      gstRatePercent: 18,
      hsnSac: '998422',
      validityDays: 30,
      simUse: 1,
    });
    expect(await outboxFor(id)).toHaveLength(1);
  });

  it('enforces cap ⇒ FUP speed, burst sanity and reserved attributes', async () => {
    const bad = (body: object) =>
      admin.req('POST', '/api/v1/plans', { ...base, name: `x${Math.random()}`, ...body });
    expect((await bad({ dataCapBytes: 100e9 })).status).toBe(400);
    expect((await bad({ dataCapBytes: 100e9, fup: { downloadKbps: 60_000, uploadKbps: 1000 } })).status).toBe(
      400,
    );
    expect(
      (
        await bad({
          burst: {
            downloadKbps: 40_000,
            uploadKbps: 30_000,
            thresholdDownloadKbps: 1,
            thresholdUploadKbps: 1,
            timeSecs: 8,
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (await bad({ extraAttributes: [{ attribute: 'Mikrotik-Rate-Limit', value: '1M/1M' }] })).status,
    ).toBe(400);
    expect((await admin.req('POST', '/api/v1/plans', base)).status).toBe(409);
  });

  it('a partial update keeps unmentioned fields and recomputes rates', async () => {
    const r = await admin.req('PATCH', `/api/v1/plans/${id}`, {
      downloadKbps: 100_000,
      dataCapBytes: 500e9,
      fup: { downloadKbps: 5000, uploadKbps: 5000 },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      rateLimit: '25M/100M',
      fupRate: '5M/5M',
      fupCycle: 'billing_cycle',
      pricePaise: 49_900,
    });
    const cleared = await admin.req('PATCH', `/api/v1/plans/${id}`, { dataCapBytes: null, fup: null });
    expect(cleared.body).toMatchObject({ dataCapBytes: null, fup: null, fupRate: null, fupCycle: null });
    expect((await admin.req('PATCH', `/api/v1/plans/${id}`, { status: 'archived' })).body.status).toBe(
      'archived',
    );
  });

  it('support reads plans, cannot edit', async () => {
    expect((await support.req('GET', `/api/v1/plans/${id}`)).status).toBe(200);
    expect((await support.req('PATCH', `/api/v1/plans/${id}`, { name: 'x' })).status).toBe(403);
  });
});

describe('tenants', () => {
  it('staff edit their own RADIUS settings; the change is queued', async () => {
    const r = await admin.req('PATCH', '/api/v1/tenant', { radius: { expiredRate: '512k/512k' } });
    expect(r.status).toBe(200);
    expect(r.body.radius).toMatchObject({
      expiredMode: 'reject',
      expiredRate: '512k/512k',
      interimInterval: 300,
    });
    expect(await outboxFor(tenantA.toHexString())).toHaveLength(1);
  });

  it('expired handling switches between reject and walled', async () => {
    const r = await admin.req('PATCH', '/api/v1/tenant', { radius: { expiredMode: 'walled' } });
    expect(r.status).toBe(200);
    expect(r.body.radius.expiredMode).toBe('walled');
    const bad = await admin.req('PATCH', '/api/v1/tenant', { radius: { expiredMode: 'free' } });
    expect(bad.status).toBe(400);
  });

  it('GSTIN must match the state code', async () => {
    expect((await admin.req('PATCH', '/api/v1/tenant', { gstin: '27ABCDE1234F1Z5' })).status).toBe(400);
    expect((await admin.req('PATCH', '/api/v1/tenant', { gstin: '07ABCDE1234F1Z5' })).status).toBe(200);
  });

  it('only a super-admin creates or suspends ISPs; staff of a suspended ISP are signed out', async () => {
    expect((await admin.req('POST', '/api/v1/tenants', {})).status).toBe(404);
    const created = await superadmin.req('POST', '/api/v1/tenants', {
      slug: 'gamma',
      name: 'Gamma Net',
      legalName: 'Gamma Net Pvt Ltd',
      stateCode: '09',
      address: { line1: '1 Road', city: 'Noida', state: 'UP', pincode: '201301' },
    });
    expect(created.status).toBe(201);
    expect(created.body.radius.expiredRate).toBe('256k/256k');
    expect(
      (await superadmin.req('POST', '/api/v1/tenants', { ...created.body, slug: 'platform' })).status,
    ).toBe(400);

    const g = new ObjectId(created.body.id);
    const gAdmin = await signIn(
      h,
      await seedUser(h, { tenantId: g, email: 'a@gamma.in', roles: [await roleId(h.db, 'Support')] }),
      'gamma',
    );
    expect((await gAdmin.req('GET', '/api/v1/plans')).status).toBe(200);
    expect(
      (await superadmin.req('PATCH', `/api/v1/tenants/${created.body.id}`, { status: 'suspended' })).status,
    ).toBe(200);
    expect((await gAdmin.req('GET', '/api/v1/plans')).status).toBe(401);
  });
});
