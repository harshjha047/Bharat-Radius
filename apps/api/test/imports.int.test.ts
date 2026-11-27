import readXlsxFile from 'read-excel-file/node';
import writeXlsxFile, { type SheetData } from 'write-excel-file/node';
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ImportBatchDoc, ImportRowDoc } from '@isp/db-mongo';
import { COLUMNS, XLSX_MIME } from '../src/subscribers/excel.js';
import { roleId, seedTenant, seedUser, signIn, startHarness, type Client, type Harness } from './harness.js';

let h: Harness;
let admin: Client;
let support: Client;

const header = COLUMNS.map((c) => c.key);
const row = (o: Record<string, string | number>) => COLUMNS.map((c) => o[c.key] ?? null);
const base = {
  name: 'Import User',
  phone: '9876500000',
  address_line1: 'x',
  city: 'Noida',
  state: 'UP',
  pincode: '201301',
};
const xlsx = (rows: (string | number | null)[][]) => writeXlsxFile([header, ...rows] as SheetData).toBuffer();
const upload = (c: Client, file: Buffer, query = '') =>
  c.req('POST', `/api/v1/subscribers/import${query}`, file, {
    'content-type': XLSX_MIME,
    'x-file-name': 'list.xlsx',
  });

beforeAll(async () => {
  h = await startHarness();
  const t = await seedTenant(h.db, 'imp', 'new.example.test');
  admin = await signIn(
    h,
    await seedUser(h, {
      tenantId: t,
      email: 'a@imp.in',
      roles: [await roleId(h.db, 'ISP Admin')],
      totp: true,
    }),
  );
  support = await signIn(
    h,
    await seedUser(h, { tenantId: t, email: 's@imp.in', roles: [await roleId(h.db, 'Support')] }),
  );
  await admin.req('POST', '/api/v1/plans', {
    name: 'Home 50',
    downloadKbps: 50_000,
    uploadKbps: 20_000,
    pricePaise: 1,
  });
  await admin.req('POST', '/api/v1/subscribers', {
    username: 'existing',
    name: 'Old',
    phone: '9876511111',
    address: { line1: 'x', city: 'Noida', state: 'UP', pincode: '201301' },
  });
});
afterAll(() => h?.close());

describe('Excel import / export', () => {
  it('template downloads as xlsx with the ISP’s plans', async () => {
    const r = await admin.req('GET', '/api/v1/subscribers/import/template');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe(XLSX_MIME);
    const sheets = await readXlsxFile(r.raw);
    expect(sheets[1]!.data[1]![0]).toBe('Home 50');
  });

  it('dry run reports problems per row and writes nothing', async () => {
    const file = await xlsx([
      row({ ...base, username: 'new1', plan: 'Home 50' }),
      row({ ...base, username: 'existing' }),
    ]);
    const r = await upload(admin, file, '?dryRun=true');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'validated', counts: { read: 2, valid: 1 }, id: null });
    expect(r.body.errors).toEqual([{ row: 3, column: 'username', message: 'Already used by a subscriber' }]);
    expect(await h.db.collection('import_batches').countDocuments()).toBe(0);
  });

  it('a file with problems is rejected unless skipInvalid; then valid rows are queued with encrypted passwords', async () => {
    const file = await xlsx([
      row({ ...base, username: 'new1', plan: 'Home 50', pppoe_password: 'plain-secret-1' }),
      row({ ...base, username: 'new2' }),
      row({ ...base, username: 'existing' }),
    ]);
    expect((await upload(admin, file)).body.status).toBe('rejected');
    const r = await upload(admin, file, '?skipInvalid=true');
    expect(r.body).toMatchObject({ status: 'queued', counts: { read: 3, valid: 2, created: 0 } });
    const rows = await h.db
      .collection<ImportRowDoc>('import_rows')
      .find({ batchId: new ObjectId(r.body.id) })
      .toArray();
    expect(rows.map((x) => x.row)).toEqual([2, 3]);
    expect(JSON.stringify(rows)).not.toContain('plain-secret-1');
    expect(h.crypto.decrypt(rows[0]!.input.pppoePassword, `import_rows:${rows[0]!._id.toHexString()}`)).toBe(
      'plain-secret-1',
    );

    const status = await admin.req('GET', `/api/v1/subscribers/imports/${r.body.id}`);
    expect(status.body).toMatchObject({ status: 'queued', fileName: 'list.xlsx' });
    const report = await admin.req('GET', `/api/v1/subscribers/imports/${r.body.id}/errors`);
    const problems = await readXlsxFile(report.raw);
    expect(problems[0]!.data[1]).toEqual([4, 'username', 'Already used by a subscriber']);
    expect((await admin.req('GET', '/api/v1/subscribers/imports')).body).toHaveLength(1);
  });

  it('only form-free uploads of the xlsx type are accepted, and only by permitted staff', async () => {
    const file = await xlsx([row({ ...base, username: 'zzz' })]);
    expect(
      (await support.req('POST', '/api/v1/subscribers/import', file, { 'content-type': XLSX_MIME })).status,
    ).toBe(403);
    expect(
      (
        await admin.req('POST', '/api/v1/subscribers/import', file, {
          'content-type': 'application/octet-stream',
        })
      ).status,
    ).toBe(415);
  });

  it('export streams every subscriber without passwords; support may not export', async () => {
    const r = await admin.req('GET', '/api/v1/subscribers/export');
    expect(r.status).toBe(200);
    const [sheet] = await readXlsxFile(r.raw);
    expect(sheet!.data[0]).toContain('customer_no');
    expect(sheet!.data[0]).not.toContain('pppoe_password');
    expect(sheet!.data[0]).toContain('reseller_code');
    expect(sheet!.data.slice(1).map((x) => x[0])).toEqual(['existing']);
    expect((await support.req('GET', '/api/v1/subscribers/export')).status).toBe(403);
  });

  it('batches are per ISP', async () => {
    const b = await h.db.collection<ImportBatchDoc>('import_batches').findOne({});
    const other = await seedTenant(h.db, 'imp2');
    const c = await signIn(
      h,
      await seedUser(h, {
        tenantId: other,
        email: 'a@imp2.in',
        roles: [await roleId(h.db, 'ISP Admin')],
        totp: true,
      }),
      'imp2',
    );
    expect((await c.req('GET', `/api/v1/subscribers/imports/${b!._id.toHexString()}`)).status).toBe(404);
    expect((await c.req('GET', '/api/v1/subscribers/imports')).body).toEqual([]);
  });
});

describe('reseller bulk import (switched on by the ISP, top level only)', () => {
  let l1: string;
  let l2: string;
  let r1: Client;
  let r2: Client;
  const R = '/api/v1/resellers';
  const can = async (c: Client) =>
    ((await c.req('GET', '/api/v1/auth/me')).body.permissions as string[]).includes('imports.run');
  const resellerUser = async (email: string, resellerId: string) => {
    const tenantId = (await h.db.collection('resellers').findOne({ _id: new ObjectId(resellerId) }))!
      .tenantId;
    const u = await seedUser(h, {
      tenantId,
      email,
      type: 'reseller',
      roles: [await roleId(h.db, 'Reseller Owner')],
    });
    await h.db
      .collection('users')
      .updateOne({ _id: u._id }, { $set: { resellerId: new ObjectId(resellerId) } });
    return signIn(h, u);
  };

  beforeAll(async () => {
    l1 = (await admin.req('POST', R, { name: 'Xtreme Fiber', ownerName: 'Tana' })).body.id;
    l2 = (await admin.req('POST', R, { parentId: l1, name: 'Seppa POP', ownerName: 'Nima' })).body.id;
    r1 = await resellerUser('owner@l1.imp', l1);
    r2 = await resellerUser('owner@l2.imp', l2);
  });

  it('is off by default: no permission, uploads refused', async () => {
    expect((await admin.req('GET', `${R}/${l1}`)).body.importEnabled).toBe(false);
    expect(await can(r1)).toBe(false);
    expect((await upload(r1, await xlsx([row({ ...base, username: 'r1.a' })]))).status).toBe(403);
  });

  it('only ISP staff switch it, and only for resellers directly under the ISP', async () => {
    expect((await r1.req('PATCH', `${R}/${l2}`, { importEnabled: true })).status).toBe(403);
    expect((await admin.req('PATCH', `${R}/${l2}`, { importEnabled: true })).status).toBe(400);
    const on = await admin.req('PATCH', `${R}/${l1}`, { importEnabled: true });
    expect(on.status).toBe(200);
    expect(on.body.importEnabled).toBe(true);
  });

  it('the reseller imports its own customers; sub-resellers cannot', async () => {
    expect(await can(r1)).toBe(true);
    expect(await can(r2)).toBe(false);
    expect((await upload(r2, await xlsx([row({ ...base, username: 'r2.a' })]))).status).toBe(403);

    const t = await r1.req('GET', '/api/v1/subscribers/import/template');
    expect(t.status).toBe(200);
    const r = await upload(r1, await xlsx([row({ ...base, username: 'r1.a', plan: 'Home 50' })]));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe('queued');
    const batch = await h.db
      .collection<ImportBatchDoc>('import_batches')
      .findOne({ _id: new ObjectId(r.body.id) });
    expect(String(batch!.resellerId)).toBe(l1);

    const mine = (await r1.req('GET', '/api/v1/subscribers/imports')).body as { id: string }[];
    expect(mine.map((b) => b.id)).toEqual([r.body.id]);
    expect(
      (await admin.req('GET', '/api/v1/subscribers/imports')).body.map((b: { id: string }) => b.id),
    ).toContain(r.body.id);
    const isp = await h.db
      .collection<ImportBatchDoc>('import_batches')
      .findOne({ resellerId: { $exists: false } });
    expect((await r1.req('GET', `/api/v1/subscribers/imports/${isp!._id.toHexString()}`)).status).toBe(404);
    expect((await r1.req('GET', '/api/v1/subscribers/export')).status).toBe(403);
  });

  it('reseller_code puts rows under the reseller’s own sub-resellers; any other code is refused', async () => {
    const code = async (id: string) => (await admin.req('GET', `${R}/${id}`)).body.code as string;
    const other = (await admin.req('POST', R, { name: 'Other Partner', ownerName: 'Om' })).body.id;
    const paused = (await admin.req('POST', R, { parentId: l1, name: 'Paused POP', ownerName: 'Pa' })).body
      .id;
    await h.db
      .collection('resellers')
      .updateOne({ _id: new ObjectId(paused) }, { $set: { status: 'suspended' } });
    const [c1, c2, cOther, cPaused] = await Promise.all([l1, l2, other, paused].map(code));
    const file = await xlsx([
      row({ ...base, username: 'r1.sub', plan: 'Home 50', reseller_code: c2!.toLowerCase() }),
      row({ ...base, username: 'r1.self', reseller_code: c1! }),
      row({ ...base, username: 'r1.empty' }),
      row({ ...base, username: 'r1.other', reseller_code: cOther! }),
      row({ ...base, username: 'r1.paused', reseller_code: cPaused! }),
      row({ ...base, username: 'r1.nope', reseller_code: 'R-9999' }),
    ]);
    const dry = await upload(r1, file, '?dryRun=true');
    expect(dry.body.counts).toEqual({ read: 6, valid: 3, created: 0, failed: 0 });
    expect(dry.body.errors).toEqual([
      { row: 5, column: 'reseller_code', message: `No reseller with code ${cOther} under you` },
      { row: 6, column: 'reseller_code', message: `Paused POP (${cPaused}) is suspended` },
      { row: 7, column: 'reseller_code', message: 'No reseller with code R-9999 under you' },
    ]);
    const r = await upload(r1, file, '?skipInvalid=true');
    expect(r.body.status, JSON.stringify(r.body)).toBe('queued');
    const rows = await h.db
      .collection<ImportRowDoc>('import_rows')
      .find({ batchId: new ObjectId(r.body.id) }, { sort: { row: 1 } })
      .toArray();
    expect(rows.map((x) => [x.input.username, String(x.resellerId), x.ancestors?.map(String)])).toEqual([
      ['r1.sub', l2, [l1, l2]],
      ['r1.self', l1, [l1]],
      ['r1.empty', l1, [l1]],
    ]);
  });

  it('ISP staff may use any reseller’s code; empty = direct ISP customer', async () => {
    const c2 = (await admin.req('GET', `${R}/${l2}`)).body.code as string;
    const r = await upload(
      admin,
      await xlsx([
        row({ ...base, username: 'isp.sub', reseller_code: c2 }),
        row({ ...base, username: 'isp.direct' }),
      ]),
    );
    expect(r.body.status, JSON.stringify(r.body)).toBe('queued');
    const rows = await h.db
      .collection<ImportRowDoc>('import_rows')
      .find({ batchId: new ObjectId(r.body.id) }, { sort: { row: 1 } })
      .toArray();
    expect(rows.map((x) => [x.input.username, x.resellerId ? String(x.resellerId) : null])).toEqual([
      ['isp.sub', l2],
      ['isp.direct', null],
    ]);
  });

  it('switching it off takes the permission away at once', async () => {
    expect((await admin.req('PATCH', `${R}/${l1}`, { importEnabled: false })).body.importEnabled).toBe(false);
    expect(await can(r1)).toBe(false);
    expect((await upload(r1, await xlsx([row({ ...base, username: 'r1.b' })]))).status).toBe(403);
  });
});
