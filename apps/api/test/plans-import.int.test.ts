import readXlsxFile from 'read-excel-file/node';
import writeXlsxFile, { type SheetData } from 'write-excel-file/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OutboxDoc, PlanDoc } from '@isp/db-mongo';
import { PLAN_COLUMNS } from '../src/network/plans-excel.js';
import { XLSX_MIME } from '../src/subscribers/excel.js';
import { roleId, seedTenant, seedUser, signIn, startHarness, type Client, type Harness } from './harness.js';

let h: Harness;
let admin: Client;
let support: Client;

const row = (o: Record<string, string | number>) => PLAN_COLUMNS.map((c) => o[c.key] ?? null);
const xlsx = (rows: (string | number | null)[][]) =>
  writeXlsxFile([PLAN_COLUMNS.map((c) => c.key), ...rows] as SheetData).toBuffer();
const upload = (c: Client, file: Buffer, query = '') =>
  c.req('POST', `/api/v1/plans/import${query}`, file, {
    'content-type': XLSX_MIME,
    'x-file-name': 'plans.xlsx',
  });

beforeAll(async () => {
  h = await startHarness();
  const t = await seedTenant(h.db, 'pimp', 'new.example.test');
  admin = await signIn(
    h,
    await seedUser(h, {
      tenantId: t,
      email: 'a@pimp.in',
      roles: [await roleId(h.db, 'ISP Admin')],
      totp: true,
    }),
  );
  support = await signIn(
    h,
    await seedUser(h, { tenantId: t, email: 's@pimp.in', roles: [await roleId(h.db, 'Support')] }),
  );
  await admin.req('POST', '/api/v1/plans', {
    name: 'Home 50',
    downloadKbps: 50_000,
    uploadKbps: 20_000,
    pricePaise: 49_900,
  });
});
afterAll(() => h?.close());

describe('plan import/export over HTTP', () => {
  it('serves the template and an export in the same columns', async () => {
    const t = await admin.req('GET', '/api/v1/plans/import/template');
    expect(t.status).toBe(200);
    expect(t.headers['content-type']).toBe(XLSX_MIME);
    const e = await support.req('GET', '/api/v1/plans/export');
    expect(e.status).toBe(200);
    const [sheet] = await readXlsxFile(e.raw);
    expect(sheet!.data[0]).toEqual(PLAN_COLUMNS.map((c) => c.key));
    expect(sheet!.data[1]!.slice(0, 4)).toEqual(['Home 50', 50, 20, 499]);
  });

  it('checks, then creates new plans and updates existing ones through the outbox', async () => {
    const file = await xlsx([
      row({ name: 'FAB5-40MB', download_mbps: 40, upload_mbps: 40, price: 600 }),
      row({ name: 'Home 50', download_mbps: 50, upload_mbps: 20, price: 549 }),
    ]);
    const dry = await upload(admin, file, '?dryRun=true&updateExisting=true');
    expect(dry.status).toBe(200);
    expect(dry.body.rows.map((r: { action: string }) => r.action)).toEqual(['create', 'update']);
    expect(await h.db.collection<PlanDoc>('plans').countDocuments({ name: 'FAB5-40MB' })).toBe(0);

    const r = await upload(admin, file, '?updateExisting=true');
    expect(r.body).toMatchObject({ status: 'done', counts: { created: 1, updated: 1, failed: 0 } });
    const fab = await h.db.collection<PlanDoc>('plans').findOne({ name: 'FAB5-40MB' });
    expect(fab).toMatchObject({
      downloadKbps: 40_000,
      pricePaise: 60_000,
      rateLimit: '40M/40M',
      status: 'active',
    });
    expect((await h.db.collection<PlanDoc>('plans').findOne({ name: 'Home 50' }))?.pricePaise).toBe(54_900);
    expect(await h.db.collection<OutboxDoc>('outbox').countDocuments({ entityId: fab!._id })).toBe(1);
    const audit = await h.db.collection('audit_logs').findOne({ action: 'plan.import' });
    expect(audit).toBeTruthy();
  });

  it('needs plans.write to import', async () => {
    const file = await xlsx([row({ name: 'X', download_mbps: 1, upload_mbps: 1, price: 1 })]);
    expect((await upload(support, file, '?dryRun=true')).status).toBe(403);
  });
});
