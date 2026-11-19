import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, roleId, seedTenant, seedUser, signIn, startHarness, type Harness } from './harness.js';

let h: Harness;
let admin: Client;
let support: Client;
let sub = '';

const customer = {
  username: 'dpdp.one',
  pppoePassword: 'pp-dpdp.one-9',
  name: 'Consent Customer',
  phone: '9876543210',
  address: { line1: '1 Main Rd', city: 'Delhi', state: 'Delhi', pincode: '110001' },
};
const portal = async () => {
  const c = new Client(h);
  const r = await c.req('POST', '/api/v1/portal/auth/login', {
    login: 'dpdp.one',
    password: 'pp-dpdp.one-9',
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return c;
};

beforeAll(async () => {
  h = await startHarness();
  const t = await seedTenant(h.db, 'alpha', 'new.example.test');
  admin = await signIn(
    h,
    await seedUser(h, { tenantId: t, email: 'a@t.in', roles: [await roleId(h.db, 'ISP Admin')], totp: true }),
  );
  support = await signIn(
    h,
    await seedUser(h, { tenantId: t, email: 's@t.in', roles: [await roleId(h.db, 'Support')] }),
  );
  sub = (await admin.req('POST', '/api/v1/subscribers', customer)).body.id;
});
afterAll(() => h?.close());

describe('DPDP privacy notice and consent', () => {
  it('nothing to accept until the ISP publishes a notice; draft offered', async () => {
    const n = await admin.req('GET', '/api/v1/tenant/privacy');
    expect(n.body).toMatchObject({ text: null, version: 0 });
    expect(n.body.draft).toMatch(/Privacy notice/);
    expect((await support.req('GET', '/api/v1/tenant/privacy')).status).toBe(403);
    const c = await portal();
    expect((await c.req('GET', '/api/v1/portal/privacy')).body).toMatchObject({
      needsConsent: false,
      text: null,
    });
    expect((await admin.req('POST', `/api/v1/subscribers/${sub}/consent`, { via: 'caf' })).status).toBe(409);
  });

  it('publishing asks every customer; accepting records version, time and address; a new text asks again', async () => {
    const draft = (await admin.req('GET', '/api/v1/tenant/privacy')).body.draft as string;
    const v1 = await admin.req('PUT', '/api/v1/tenant/privacy', { text: draft });
    expect(v1.status, JSON.stringify(v1.body)).toBe(200);
    expect(v1.body.version).toBe(1);
    expect((await admin.req('PUT', '/api/v1/tenant/privacy', { text: draft })).body.version).toBe(1);

    const c = await portal();
    const p = await c.req('GET', '/api/v1/portal/privacy');
    expect(p.body).toMatchObject({ needsConsent: true, version: 1, acceptedVersion: null });
    expect(p.body.text).not.toContain('{isp}');
    expect((await c.req('POST', '/api/v1/portal/privacy/accept', { version: 2 })).status).toBe(409);
    const ok = await c.req('POST', '/api/v1/portal/privacy/accept', { version: 1 });
    expect(ok.body).toMatchObject({ needsConsent: false, acceptedVersion: 1 });
    expect((await support.req('GET', `/api/v1/subscribers/${sub}/consent`)).body).toMatchObject({
      version: 1,
      via: 'portal',
      upToDate: true,
    });

    await admin.req('PUT', '/api/v1/tenant/privacy', { text: `${draft}\n\nUpdated grievance officer.` });
    expect((await c.req('GET', '/api/v1/portal/privacy')).body).toMatchObject({
      needsConsent: true,
      version: 2,
    });
    expect((await support.req('GET', `/api/v1/subscribers/${sub}/consent`)).body.upToDate).toBe(false);
    const paper = await support.req('POST', `/api/v1/subscribers/${sub}/consent`, { via: 'caf' });
    expect(paper.body).toMatchObject({ version: 2, via: 'caf', upToDate: true });
    expect(await h.db.collection('audit_logs').countDocuments({ action: 'subscriber.consent' })).toBe(2);
  });
});
