import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importKycFiles } from '../src/documents/import.js';
import { Files, LocalStore } from '../src/storage/storage.js';
import { Client, roleId, seedTenant, seedUser, signIn, startHarness, type Harness } from './harness.js';

let h: Harness;
let dir: string;
let tenant: ObjectId;
let admin: Client;
let support: Client;
let tech: Client;
let l1: Client;
let l2: Client;
const id: Record<string, string> = {};

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 2),
]);

const customer = (username: string, extra: object = {}) => ({
  username,
  pppoePassword: `pp-${username}-9`,
  name: `Cust ${username}`,
  phone: '9876543210',
  address: { line1: '1 Main Rd', city: 'Delhi', state: 'Delhi', pincode: '110001' },
  ...extra,
});
const up = (c: Client, sub: string | undefined, kind: string, body: Buffer, type: string, number?: string) =>
  c.req(
    'POST',
    `/api/v1/subscribers/${sub}/kyc/documents?kind=${kind}${number ? `&number=${encodeURIComponent(number)}` : ''}`,
    body,
    { 'content-type': type, 'x-file-name': 'scan.pdf' },
  );

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'isp-kyc-'));
  h = await startHarness({ FILES_DIR: dir });
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
  support = await signIn(
    h,
    await seedUser(h, { tenantId: tenant, email: 'sup@t.in', roles: [await roleId(h.db, 'Support')] }),
  );
  tech = await signIn(
    h,
    await seedUser(h, { tenantId: tenant, email: 'tech@t.in', roles: [await roleId(h.db, 'Technician')] }),
  );
  id.l1 = (
    await admin.req('POST', '/api/v1/resellers', {
      name: 'L1 Site',
      ownerName: 'A',
      canCreateSubResellers: true,
    })
  ).body.id;
  id.l2 = (
    await admin.req('POST', '/api/v1/resellers', { name: 'L2 Site', ownerName: 'B', parentId: id.l1 })
  ).body.id;
  id.other = (await admin.req('POST', '/api/v1/resellers', { name: 'Other', ownerName: 'C' })).body.id;
  for (const [k, r] of [
    ['l1', id.l1],
    ['l2', id.l2],
  ] as const) {
    const u = await seedUser(h, {
      tenantId: tenant,
      email: `${k}@t.in`,
      type: 'reseller',
      roles: [await roleId(h.db, 'Reseller Owner')],
    });
    await h.db.collection('users').updateOne({ _id: u._id }, { $set: { resellerId: new ObjectId(r) } });
    if (k === 'l1') l1 = await signIn(h, u);
    else l2 = await signIn(h, u);
  }
  id.sub = (
    await admin.req('POST', '/api/v1/subscribers', customer('kyc.one', { resellerId: id.l2 }))
  ).body.id;
  id.direct = (await admin.req('POST', '/api/v1/subscribers', customer('kyc.direct'))).body.id;
});
afterAll(async () => {
  await h?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('KYC documents', () => {
  it('reseller uploads for its branch (encrypted at rest, number masked) but cannot open files', async () => {
    const r = await up(l2, id.sub, 'aadhaar', JPG, 'image/jpeg', '1234 5678 9012');
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({
      kind: 'aadhaar',
      maskedNumber: 'XXXX-XXXX-9012',
      uploadedVia: 'reseller',
    });
    id.aadhaar = r.body.id;
    const doc = await h.db.collection('kyc_documents').findOne({ _id: new ObjectId(id.aadhaar) });
    const raw = await readFile(join(dir, doc!.storageKey as string));
    expect(raw.subarray(0, 5).toString()).toBe('ISPF1');
    expect(raw.includes(JPG.subarray(4))).toBe(false);
    expect((await l2.req('GET', `/api/v1/kyc-documents/${id.aadhaar}/file`)).status).toBe(403);
    const v = await l2.req('GET', `/api/v1/subscribers/${id.sub}/kyc`);
    expect(v.body).toMatchObject({
      status: 'pending',
      aadhaarLast4: '9012',
      canView: false,
      canUpload: true,
    });
    expect(v.body.missing).toEqual(['photo', 'signed CAF']);
    // Parent sees its branch; another branch and a direct customer are not reachable.
    expect((await l1.req('GET', `/api/v1/subscribers/${id.sub}/kyc`)).status).toBe(200);
    expect((await l2.req('GET', `/api/v1/subscribers/${id.direct}/kyc`)).status).toBe(404);
    expect((await up(l2, id.direct, 'photo', JPG, 'image/jpeg')).status).toBe(404);
  });

  it('checks the real file type and size', async () => {
    expect((await up(admin, id.sub, 'photo', Buffer.from('<html>hi</html>'), 'image/jpeg')).status).toBe(415);
    expect((await up(admin, id.sub, 'photo', JPG, 'text/plain')).status).toBe(415);
    expect(
      (await up(admin, id.sub, 'photo', Buffer.concat([JPG, Buffer.alloc(5 * 1024 * 1024)]), 'image/jpeg'))
        .status,
    ).toBe(413);
    expect((await up(tech, id.sub, 'photo', JPG, 'image/jpeg')).status).toBe(403);
  });

  it('staff with kyc.view open a file, and every view is audited', async () => {
    const f = await support.req('GET', `/api/v1/kyc-documents/${id.aadhaar}/file`);
    expect(f.status).toBe(200);
    expect(f.headers['content-type']).toBe('image/jpeg');
    expect(f.headers['cache-control']).toBe('private, no-store');
    expect(Buffer.from(f.raw).equals(JPG)).toBe(true);
    const a = await h.db.collection('audit_logs').findOne({ action: 'kyc.view', 'entity.id': id.sub });
    expect(a).toMatchObject({ after: { documentId: id.aadhaar, kind: 'aadhaar' } });
  });

  it('verify needs a complete file; CAF form is generated with a number; reject needs a reason', async () => {
    const early = await admin.req('POST', `/api/v1/subscribers/${id.sub}/kyc/verify`, { status: 'verified' });
    expect(early.status).toBe(400);
    expect(early.body.error.message).toMatch(/photo, signed CAF/);
    const caf = await admin.req('GET', `/api/v1/subscribers/${id.sub}/caf`);
    expect(caf.status).toBe(200);
    expect(caf.headers['content-type']).toBe('application/pdf');
    expect(Buffer.from(caf.raw).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await admin.req('GET', `/api/v1/subscribers/${id.sub}/kyc`)).body.cafNo).toMatch(/^CAF\//);
    expect((await up(l2, id.sub, 'photo', PNG, 'image/png')).status).toBe(201);
    expect((await up(l2, id.sub, 'caf_signed', PDF, 'application/pdf')).status).toBe(201);
    expect(
      (await admin.req('POST', `/api/v1/subscribers/${id.sub}/kyc/verify`, { status: 'rejected' })).status,
    ).toBe(400);
    expect(
      (await l2.req('POST', `/api/v1/subscribers/${id.sub}/kyc/verify`, { status: 'verified' })).status,
    ).toBe(403);
    const ok = await admin.req('POST', `/api/v1/subscribers/${id.sub}/kyc/verify`, {
      status: 'verified',
      note: 'checked originals',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'verified', missing: [], note: 'checked originals' });
    expect((await admin.req('GET', `/api/v1/subscribers/${id.sub}`)).body.kycStatus).toBe('verified');
  });

  it('removing a document deletes the file but keeps the record', async () => {
    const extra = await up(admin, id.sub, 'other', PDF, 'application/pdf');
    const doc = await h.db.collection('kyc_documents').findOne({ _id: new ObjectId(extra.body.id) });
    const r = await admin.req('POST', `/api/v1/kyc-documents/${extra.body.id}/remove`, {
      reason: 'wrong customer',
    });
    expect(r.status).toBe(200);
    await expect(readFile(join(dir, doc!.storageKey as string))).rejects.toThrow();
    expect(await h.db.collection('kyc_documents').findOne({ _id: doc!._id })).toMatchObject({
      removed: { reason: 'wrong customer' },
    });
    expect((await admin.req('GET', `/api/v1/kyc-documents/${extra.body.id}/file`)).status).toBe(404);
  });

  it('customers upload their own documents in the portal, without opening them', async () => {
    const c = new Client(h);
    expect(
      (await c.req('POST', '/api/v1/portal/auth/login', { login: 'kyc.direct', password: 'pp-kyc.direct-9' }))
        .status,
    ).toBe(200);
    const r = await c.req('POST', '/api/v1/portal/kyc/documents?kind=pan', JPG, {
      'content-type': 'image/jpeg',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.uploadedVia).toBe('portal');
    const v = await c.req('GET', '/api/v1/portal/kyc');
    expect(v.body).toMatchObject({ status: 'pending', documents: [{ kind: 'pan' }] });
    expect(v.body.canView).toBeUndefined();
  });

  it('import-kyc matches old files by username / customer no. and is re-runnable', async () => {
    const src = await mkdtemp(join(tmpdir(), 'isp-caf-'));
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(src, 'kyc.direct'));
    // Different bytes from the files uploaded above (the same file for the same customer is skipped).
    await writeFile(
      join(src, 'kyc.direct', 'aadhar front.jpg'),
      Buffer.concat([JPG, Buffer.from('old-aadhaar')]),
    );
    await writeFile(join(src, 'kyc.direct', 'CAF.pdf'), Buffer.concat([PDF, Buffer.from('% old caf\n')]));
    await writeFile(join(src, 'nobody_photo.png'), PNG);
    const files = new Files(new LocalStore(dir), h.crypto);
    const dry = await importKycFiles(h.db, files, { tenant: 'alpha', dir: src, apply: false, log: () => {} });
    expect(dry).toMatchObject({ dryRun: true, files: 3, imported: 2, unmatched: ['nobody_photo.png'] });
    const run = await importKycFiles(h.db, files, { tenant: 'alpha', dir: src, apply: true, log: () => {} });
    expect(run).toMatchObject({ imported: 2, byKind: { aadhaar: 1, caf_signed: 1 } });
    const again = await importKycFiles(h.db, files, {
      tenant: 'alpha',
      dir: src,
      apply: true,
      log: () => {},
    });
    expect(again).toMatchObject({ imported: 0, duplicates: 2 });
    const kinds = (await admin.req('GET', `/api/v1/subscribers/${id.direct}/kyc`)).body.documents.map(
      (d: { kind: string }) => d.kind,
    );
    expect(kinds.sort()).toEqual(['aadhaar', 'caf_signed', 'pan']);
    await rm(src, { recursive: true, force: true });
    expect((await readdir(dir)).length).toBeGreaterThan(0);
  });
});

describe('reseller branding (F-8)', () => {
  it('a reseller sets its own name and logo; sub-resellers and customers inherit it', async () => {
    const n = await l1.req('PUT', `/api/v1/resellers/${id.l1}/branding`, { name: 'Shree Ram Net' });
    expect(n.status, JSON.stringify(n.body)).toBe(200);
    const logo = await l1.req('PUT', `/api/v1/resellers/${id.l1}/branding/logo`, PNG, {
      'content-type': 'image/png',
    });
    expect(logo.status, JSON.stringify(logo.body)).toBe(200);
    const url = logo.body.logoUrl as string;
    expect(url).toMatch(new RegExp(`^/api/v1/branding/${id.l1}/logo\\?v=`));
    // Public image, cached by version, served decrypted.
    const img = await new Client(h, null).req('GET', url);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['cache-control']).toContain('immutable');
    expect(Buffer.from(img.raw).equals(PNG)).toBe(true);
    // L2 panel and L2's customer see L1's branding.
    expect((await l2.req('GET', '/api/v1/auth/me')).body.branding).toMatchObject({
      name: 'Shree Ram Net',
      logoUrl: url,
      fromResellerId: id.l1,
    });
    const c = new Client(h);
    await c.req('POST', '/api/v1/portal/auth/login', { login: 'kyc.one', password: 'pp-kyc.one-9' });
    expect((await c.req('GET', '/api/v1/portal/me')).body.branding).toMatchObject({ name: 'Shree Ram Net' });
    // Staff panel and direct customers keep the ISP brand.
    expect((await admin.req('GET', '/api/v1/auth/me')).body.branding).toBeNull();
  });

  it('own branding overrides the parent; a reseller cannot brand a reseller outside its branch', async () => {
    await l2.req('PUT', `/api/v1/resellers/${id.l2}/branding`, { name: 'L2 Fibre' });
    expect((await l2.req('GET', '/api/v1/auth/me')).body.branding).toMatchObject({
      name: 'L2 Fibre',
      logoUrl: null,
    });
    expect((await l2.req('PUT', `/api/v1/resellers/${id.l1}/branding`, { name: 'x' })).status).toBe(404);
    expect((await l1.req('PUT', `/api/v1/resellers/${id.other}/branding`, { name: 'x' })).status).toBe(404);
    expect(
      (
        await l1.req('PUT', `/api/v1/resellers/${id.l1}/branding/logo`, PDF, {
          'content-type': 'application/pdf',
        })
      ).status,
    ).toBe(415);
    const gone = await l1.req('DELETE', `/api/v1/resellers/${id.l1}/branding/logo`);
    expect(gone.body.logoUrl).toBeNull();
    expect((await new Client(h, null).req('GET', `/api/v1/branding/${id.l1}/logo`)).status).toBe(404);
  });
});
