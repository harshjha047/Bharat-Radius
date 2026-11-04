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
