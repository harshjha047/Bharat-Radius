import { ObjectId } from 'mongodb';
import readXlsxFile from 'read-excel-file/node';
import writeXlsxFile, { type SheetData } from 'write-excel-file/node';
import { describe, expect, it } from 'vitest';
import type { PlanDoc } from '@isp/db-mongo';
import { PLAN_COLUMNS, PlanExcel } from './plans-excel.js';
import type { PlansService } from './plans.js';

const T = new ObjectId();
const home: Partial<PlanDoc> = {
  _id: new ObjectId(),
  tenantId: T,
  name: 'Home 50',
  downloadKbps: 50_000,
  uploadKbps: 20_000,
  burst: {
    downloadKbps: 60_000,
    uploadKbps: 25_000,
    thresholdDownloadKbps: 40_000,
    thresholdUploadKbps: 15_000,
    timeSecs: 16,
  },
  dataCapBytes: 500e9,
  fup: { downloadKbps: 5000, uploadKbps: 2000 },
  fupCycle: 'billing_cycle',
  validityDays: 30,
  simUse: 1,
  billingTypes: ['prepaid', 'postpaid'],
  pricePaise: 49_950,
  gstRatePercent: 18,
  hsnSac: '998422',
  extraAttributes: [{ attribute: 'Idle-Timeout', op: ':=', value: '900' }],
  status: 'active',
};
const mongo = {
  db: { collection: () => ({ find: () => ({ toArray: async () => [home] }) }) },
} as any;
const ctx = { tenantId: T, userId: new ObjectId(), scope: { kind: 'tenant', tenantId: T } } as any;

function setup() {
  const calls: { op: string; arg: unknown }[] = [];
  const plans = {
    create: async (_c: unknown, b: unknown) => {
      calls.push({ op: 'create', arg: b });
      return { id: new ObjectId().toHexString() };
    },
    update: async (_c: unknown, id: ObjectId, b: unknown) => {
      calls.push({ op: 'update', arg: { id: id.toHexString(), ...(b as object) } });
      return {};
    },
  } as unknown as PlansService;
  return { calls, excel: new PlanExcel(mongo, plans) };
}

const header = PLAN_COLUMNS.map((c) => c.key);
const row = (o: Record<string, string | number>) => PLAN_COLUMNS.map((c) => o[c.key] ?? null);
const file = (rows: (string | number | null)[][]) =>
  writeXlsxFile([header, ...rows] as SheetData, { sheet: 'Plans' }).toBuffer();
const q = (o: Partial<Record<'dryRun' | 'updateExisting' | 'skipInvalid', boolean>> = {}) => ({
  dryRun: false,
  updateExisting: false,
  skipInvalid: false,
  ...o,
});

describe('plan Excel import/export', () => {
  it('template has the columns and a help sheet', async () => {
    const sheets = await readXlsxFile(await setup().excel.template());
    expect(sheets.map((s) => s.sheet)).toEqual(['Plans', 'Help']);
    expect(sheets[0]!.data[0]![0]).toBe('name*');
  });

  it('export → import round-trips with nothing to change', async () => {
    const { excel, calls } = setup();
    const exported = await excel.export(ctx);
    const [sheet] = await readXlsxFile(exported);
    expect(sheet!.data[1]).toContain('Idle-Timeout := 900');
    const r = await excel.import(ctx, exported, 'p.xlsx', q({ updateExisting: true }));
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => x.action)).toEqual(['unchanged']);
    expect(calls).toEqual([]);
  });

  it('creates new plans; changes to existing ones are skipped unless asked, then sent as a minimal patch', async () => {
    const rows = [
      row({ name: 'FAB5-40MB', download_mbps: 40, upload_mbps: 40, price: 600 }),
      row({
        name: 'home 50',
        download_mbps: 50,
        upload_mbps: 20,
        price: 549,
        billing_types: 'prepaid, postpaid',
        validity_days: 30,
        data_cap_gb: 500,
        fup_download_mbps: 5,
        fup_upload_mbps: 2,
        burst_download_mbps: 60,
        burst_upload_mbps: 25,
        burst_threshold_download_mbps: 40,
        burst_threshold_upload_mbps: 15,
        burst_seconds: 16,
        extra_attributes: 'Idle-Timeout := 900',
      }),
    ];
    const a = setup();
    const skipped = await a.excel.import(ctx, await file(rows), 'p.xlsx', q());
    expect(skipped.rows.map((x) => x.action)).toEqual(['create', 'skip']);
    expect(a.calls.map((c) => c.op)).toEqual(['create']);
    expect(a.calls[0]!.arg).toMatchObject({
      name: 'FAB5-40MB',
      downloadKbps: 40_000,
      pricePaise: 60_000,
      validityDays: 30,
      billingTypes: ['prepaid'],
      gstRatePercent: 18,
    });

    const b = setup();
    const r = await b.excel.import(ctx, await file(rows), 'p.xlsx', q({ updateExisting: true }));
    expect(r.status).toBe('done');
    expect(r.counts).toMatchObject({ created: 1, updated: 1, failed: 0 });
    expect(r.rows[1]!.changes.sort()).toEqual(['name', 'pricePaise']);
    expect(b.calls[1]).toEqual({
      op: 'update',
      arg: { id: home._id!.toHexString(), name: 'home 50', pricePaise: 54_900 },
    });
  });

  it('an emptied optional cell removes that setting from an existing plan', async () => {
    const { excel, calls } = setup();
    const r = await excel.import(
      ctx,
      await file([
        row({
          name: 'Home 50',
          download_mbps: 50,
          upload_mbps: 20,
          price: 499.5,
          billing_types: 'postpaid prepaid',
        }),
      ]),
      'p.xlsx',
      q({ updateExisting: true }),
    );
    expect(r.errors).toEqual([]);
    expect(calls[0]!.arg).toMatchObject({ burst: null, dataCapBytes: null, fup: null, extraAttributes: [] });
    expect(calls[0]!.arg).not.toHaveProperty('fupCycle');
  });

  it('reports every problem per row and imports nothing until the file is clean', async () => {
    const { excel, calls } = setup();
    const r = await excel.import(
      ctx,
      await file([
        row({ name: 'A', download_mbps: 10, upload_mbps: 10 }),
        row({ name: 'B', download_mbps: 'ten', upload_mbps: 10, price: 1, gst_percent: 7 }),
        row({ name: 'C', download_mbps: 10, upload_mbps: 10, price: 1, fup_download_mbps: 1 }),
        row({ name: 'D', download_mbps: 10, upload_mbps: 10, price: 1, data_cap_gb: 100 }),
        row({ name: 'E', download_mbps: 10, upload_mbps: 10, price: 1, extra_attributes: 'oops' }),
        row({ name: 'F', download_mbps: 10, upload_mbps: 10, price: 1 }),
        row({ name: 'f', download_mbps: 10, upload_mbps: 10, price: 1 }),
      ]),
      'p.xlsx',
      q(),
    );
    expect(r.status).toBe('rejected');
    const by = (n: number) =>
      r.errors.filter((e) => e.row === n).map((e) => `${e.column ?? ''}: ${e.message}`);
    expect(by(2)).toEqual(['price: Required']);
    expect(by(3)).toEqual(expect.arrayContaining(['download_mbps: Must be a number']));
    expect(by(3).some((m) => m.startsWith('gst_percent'))).toBe(true);
    expect(by(4)).toEqual(['fup_upload_mbps: Fill both fup_download_mbps and fup_upload_mbps, or neither']);
    expect(by(5)).toEqual([': A data cap needs the speed after the cap (fup)']);
    expect(by(6)[0]).toMatch(/^extra_attributes/);
    expect(by(8)).toEqual(['name: Same name as row 7']);
    expect(r.counts).toMatchObject({ read: 7, create: 1, invalid: 6 });
    expect(calls).toEqual([]);

    const skip = await excel.import(
      ctx,
      await file([
        row({ name: 'A', download_mbps: 1, upload_mbps: 1 }),
        row({ name: 'G', download_mbps: 1, upload_mbps: 1, price: 1 }),
      ]),
      'p.xlsx',
      q({ skipInvalid: true }),
    );
    expect(skip.counts).toMatchObject({ created: 1, invalid: 1 });
  });

  it('dry run changes nothing and rejects files without the required columns', async () => {
    const { excel, calls } = setup();
    const r = await excel.import(
      ctx,
      await file([row({ name: 'N', download_mbps: 1, upload_mbps: 1, price: 0 })]),
      'p.xlsx',
      q({ dryRun: true }),
    );
    expect(r.status).toBe('validated');
    expect(r.rows[0]!.action).toBe('create');
    expect(calls).toEqual([]);
    const bad = await writeXlsxFile([['PackageName', 'Speed']] as SheetData).toBuffer();
    await expect(excel.import(ctx, bad, 'x.xlsx', q())).rejects.toThrow(
      /Missing columns: name, download_mbps/,
    );
  });
});
