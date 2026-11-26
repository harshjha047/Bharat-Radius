import { Controller, Get, HttpCode, Inject, Injectable, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ObjectId } from 'mongodb';
import readXlsxFile from 'read-excel-file/node';
import writeXlsxFile, { type SheetData } from 'write-excel-file/node';
import { z } from 'zod';
import { ScopedDb, type MongoHandle, type PlanDoc } from '@isp/db-mongo';
import { noteChange } from '../audit/audit.js';
import type { AuthContext } from '../auth/context.js';
import { AppError } from '../errors.js';
import { Ctx, Endpoint } from '../http/endpoint.js';
import { MONGO } from '../infra/infra.module.js';
import { XLSX_MIME } from '../subscribers/excel.js';
import { PlansService, createBody, derive, updateBody } from './plans.js';

export const PLANS_IMPORT_PATH = '/api/v1/plans/import';
const MAX_ROWS = 1000;

interface Column {
  key: string;
  required?: boolean;
  example: string | number;
  help: string;
}

/** The template and the import parser both use this one list. */
export const PLAN_COLUMNS: readonly Column[] = [
  {
    key: 'name',
    required: true,
    example: 'Home 50',
    help: 'Unique per ISP. Matches existing plans by name.',
  },
  {
    key: 'download_mbps',
    required: true,
    example: 50,
    help: 'Mbps; decimals allowed (0.5 = 512 kbps ≈ 500 k)',
  },
  { key: 'upload_mbps', required: true, example: 50, help: 'Mbps' },
  { key: 'price', required: true, example: 499, help: '₹ before GST, e.g. 499 or 499.50' },
  { key: 'gst_percent', example: 18, help: '0, 5, 12, 18 or 28; empty = 18' },
  { key: 'hsn_sac', example: '', help: 'Empty = 998422 (internet access)' },
  { key: 'validity_days', example: 30, help: 'Days one recharge lasts; empty = 30' },
  {
    key: 'billing_types',
    example: 'prepaid',
    help: 'prepaid, postpaid or "prepaid, postpaid"; empty = prepaid',
  },
  { key: 'data_cap_gb', example: '', help: 'Empty = unlimited. Needs the two fup_* speeds.' },
  { key: 'fup_download_mbps', example: '', help: 'Speed after the data cap' },
  { key: 'fup_upload_mbps', example: '', help: 'Speed after the data cap' },
  { key: 'fup_cycle', example: '', help: 'billing_cycle (default) or calendar_month' },
  { key: 'burst_download_mbps', example: '', help: 'MikroTik burst: all five burst_* columns or none' },
  { key: 'burst_upload_mbps', example: '', help: '' },
  { key: 'burst_threshold_download_mbps', example: '', help: '' },
  { key: 'burst_threshold_upload_mbps', example: '', help: '' },
  { key: 'burst_seconds', example: '', help: '1-3600' },
  { key: 'ip_pool', example: '', help: 'MikroTik /ip pool name; empty = router default' },
  { key: 'sim_use', example: 1, help: 'Logins at once; empty = 1' },
  {
    key: 'extra_attributes',
    example: '',
    help: 'Extra RADIUS reply, e.g. "Idle-Timeout := 900; Port-Limit = 1"',
  },
  { key: 'description', example: '', help: 'Optional' },
  { key: 'status', example: 'active', help: 'active or archived; empty = active' },
];

const importQuery = z.object({
  dryRun: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Rows whose name matches an existing plan update it (default: such rows are skipped). */
  updateExisting: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  skipInvalid: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

const issue = z.object({ row: z.number(), column: z.string().optional(), message: z.string() });
const resultView = z.object({
  fileName: z.string(),
  status: z.enum(['validated', 'rejected', 'done']),
  counts: z.object({
    read: z.number(),
    create: z.number(),
    update: z.number(),
    unchanged: z.number(),
    skip: z.number(),
    invalid: z.number(),
    created: z.number(),
    updated: z.number(),
    failed: z.number(),
  }),
  rows: z.array(
    z.object({
      row: z.number(),
      name: z.string(),
      action: z.enum(['create', 'update', 'unchanged', 'skip', 'invalid']),
      changes: z.array(z.string()),
      result: z.enum(['created', 'updated', 'failed']).nullable(),
    }),
  ),
  errors: z.array(issue),
});
type Result = z.output<typeof resultView>;
type Issue = z.output<typeof issue>;
type CreateInput = z.output<typeof createBody>;
type UpdateInput = z.output<typeof updateBody>;

/** Cell → trimmed text. */
function text(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

/** The fields an import compares and may change; same shape for an existing plan and a file row. */
function comparable(p: CreateInput | PlanDoc) {
  return {
    name: p.name,
    description: p.description ?? null,
    downloadKbps: p.downloadKbps,
    uploadKbps: p.uploadKbps,
    burst: p.burst
      ? {
          downloadKbps: p.burst.downloadKbps,
          uploadKbps: p.burst.uploadKbps,
          thresholdDownloadKbps: p.burst.thresholdDownloadKbps,
          thresholdUploadKbps: p.burst.thresholdUploadKbps,
          timeSecs: p.burst.timeSecs,
        }
      : null,
    dataCapBytes: p.dataCapBytes ?? null,
    fup: p.fup ? { downloadKbps: p.fup.downloadKbps, uploadKbps: p.fup.uploadKbps } : null,
    fupCycle: p.fup ? (p.fupCycle ?? 'billing_cycle') : null,
    validityDays: p.validityDays,
    ipPool: p.ipPool ?? null,
    simUse: p.simUse,
    billingTypes: [...new Set(p.billingTypes)].sort(),
    pricePaise: p.pricePaise,
    gstRatePercent: p.gstRatePercent,
    hsnSac: p.hsnSac,
    extraAttributes: p.extraAttributes.map((a) => ({ attribute: a.attribute, op: a.op, value: a.value })),
  };
}
type Comparable = ReturnType<typeof comparable>;

/** Only what differs, as a PATCH body; a field emptied in the file is removed (null). */
function diff(cur: Comparable, next: Comparable): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(next) as (keyof Comparable)[]) {
    if (JSON.stringify(cur[k]) === JSON.stringify(next[k])) continue;
    out[k] = next[k];
  }
  // fupCycle follows fup: dropping the cap clears it in PlansService.update.
  if (out.fup === null) delete out.fupCycle;
  return out;
}

interface Parsed {
  row: number;
  name: string;
  input?: CreateInput;
  status: 'active' | 'archived';
  issues: Issue[];
}

@Injectable()
export class PlanExcel {
  constructor(
    @Inject(MONGO) private readonly mongo: MongoHandle,
    @Inject(PlansService) private readonly plans: PlansService,
  ) {}

  private tenantOnly(ctx: AuthContext) {
    if (!ctx.tenantId || ctx.scope.kind !== 'tenant') {
      throw new AppError(400, 'VALIDATION_FAILED', 'Plans are imported by an ISP’s staff');
    }
  }

  private existing(ctx: AuthContext) {
    return new ScopedDb(this.mongo.db, ctx.scope).collection<PlanDoc>('plans').find({}).toArray();
  }

  template(): Promise<Buffer> {
    const bold = (v: string) => ({ value: v, fontWeight: 'bold' as const });
    return writeXlsxFile([
      {
        sheet: 'Plans',
        data: [
          PLAN_COLUMNS.map((c) => bold(c.required ? `${c.key}*` : c.key)),
          PLAN_COLUMNS.map((c) => (c.example === '' ? null : c.example)),
        ] as SheetData,
        stickyRowsCount: 1,
        columns: PLAN_COLUMNS.map(() => ({ width: 16 })),
      },
      {
        sheet: 'Help',
        data: [
          ['column', 'required', 'meaning'].map(bold),
          ...PLAN_COLUMNS.map((c) => [c.key, c.required ? 'yes' : '', c.help]),
          [],
          [`Up to ${MAX_ROWS} plans per file. Delete the example row. Export gives the same columns, so you`],
          ['can export, edit and import again with "update existing plans" ticked.'],
        ] as SheetData,
        columns: [{ width: 30 }, { width: 10 }, { width: 80 }],
      },
    ]).toBuffer();
  }

  private parseRow(row: number, get: (k: string) => string): Parsed {
    const issues: Issue[] = [];
    const name = get('name');
    const num = (key: string, int = false): number | undefined => {
      const t = get(key).replace(/,/g, '');
      if (!t) return undefined;
      const n = Number(t);
      if (!Number.isFinite(n) || n < 0 || (int && !Number.isInteger(n))) {
        issues.push({ row, column: key, message: int ? 'Must be a whole number' : 'Must be a number' });
        return undefined;
      }
      return n;
    };
    const kbps = (key: string) => {
      const n = num(key);
      return n === undefined ? undefined : Math.round(n * 1000);
    };
    const pair = (a: string, b: string) => {
      const d = kbps(a);
      const u = kbps(b);
      if ((d === undefined) !== (u === undefined)) {
        issues.push({ row, column: d === undefined ? a : b, message: `Fill both ${a} and ${b}, or neither` });
      }
      return d !== undefined && u !== undefined ? { downloadKbps: d, uploadKbps: u } : undefined;
    };

    const fup = pair('fup_download_mbps', 'fup_upload_mbps');
    const burstKeys = [
      'burst_download_mbps',
      'burst_upload_mbps',
      'burst_threshold_download_mbps',
      'burst_threshold_upload_mbps',
      'burst_seconds',
    ];
    const burstFilled = burstKeys.filter((k) => get(k) !== '').length;
    let burst: CreateInput['burst'];
    if (burstFilled && burstFilled < burstKeys.length) {
      issues.push({ row, column: 'burst_seconds', message: 'Fill all five burst_* columns, or none' });
    } else if (burstFilled) {
      const [bd, bu, td, tu] = burstKeys.slice(0, 4).map((k) => kbps(k));
      const secs = num('burst_seconds', true);
      if (
        bd !== undefined &&
        bu !== undefined &&
        td !== undefined &&
        tu !== undefined &&
        secs !== undefined
      ) {
        burst = {
          downloadKbps: bd,
          uploadKbps: bu,
          thresholdDownloadKbps: td,
          thresholdUploadKbps: tu,
          timeSecs: secs,
        };
      }
    }

    const extraAttributes: { attribute: string; op: string; value: string }[] = [];
    for (const part of get('extra_attributes')
      .split(';')
      .map((x) => x.trim())
      .filter(Boolean)) {
      const m = /^([A-Za-z][A-Za-z0-9-]*)\s*(:=|\+=|=)\s*(.+)$/.exec(part);
      if (!m)
        issues.push({ row, column: 'extra_attributes', message: `"${part}" is not "Attribute := value"` });
      else extraAttributes.push({ attribute: m[1]!, op: m[2]!, value: m[3]!.trim() });
    }

    const statusText = get('status').toLowerCase() || 'active';
    if (statusText !== 'active' && statusText !== 'archived') {
      issues.push({ row, column: 'status', message: 'active or archived' });
    }
    const price = num('price');
    const gb = num('data_cap_gb');
    const billing = get('billing_types')
      .toLowerCase()
      .split(/[,\s/]+/)
      .filter(Boolean);
    const raw = {
      name,
      description: get('description') || undefined,
      downloadKbps: kbps('download_mbps'),
      uploadKbps: kbps('upload_mbps'),
      burst,
      dataCapBytes: gb === undefined ? undefined : Math.round(gb * 1e9),
      fup,
      fupCycle: get('fup_cycle').toLowerCase() || undefined,
      validityDays: num('validity_days', true),
      ipPool: get('ip_pool') || undefined,
      simUse: num('sim_use', true),
      billingTypes: billing.length ? billing : undefined,
      pricePaise: price === undefined ? undefined : Math.round(price * 100),
      gstRatePercent: num('gst_percent'),
      hsnSac: get('hsn_sac') || undefined,
      extraAttributes,
    };
    const COL: Record<string, string> = {
      name: 'name',
      description: 'description',
      downloadKbps: 'download_mbps',
      uploadKbps: 'upload_mbps',
      burst: 'burst_seconds',
      dataCapBytes: 'data_cap_gb',
      fup: 'fup_download_mbps',
      fupCycle: 'fup_cycle',
      validityDays: 'validity_days',
      ipPool: 'ip_pool',
      simUse: 'sim_use',
      billingTypes: 'billing_types',
      pricePaise: 'price',
      gstRatePercent: 'gst_percent',
      hsnSac: 'hsn_sac',
      extraAttributes: 'extra_attributes',
    };
    const parsed = createBody.safeParse(raw);
    let input: CreateInput | undefined;
    if (!parsed.success) {
      const seen = new Set(issues.map((i) => i.column));
      for (const i of parsed.error.issues) {
        const column = COL[String(i.path[0])] ?? String(i.path[0] ?? '');
        if (seen.has(column)) continue; // already explained (e.g. "Must be a number")
        const required = PLAN_COLUMNS.find((c) => c.key === column)?.required;
        issues.push({
          row,
          column,
          message: required && raw[i.path[0] as keyof typeof raw] === undefined ? 'Required' : i.message,
        });
      }
    } else {
      input = parsed.data;
      try {
        derive(input);
      } catch (e) {
        issues.push({ row, message: e instanceof Error ? e.message : String(e) });
        input = undefined;
      }
    }
    return {
      row,
      name,
      ...(input && !issues.length ? { input } : {}),
      status: statusText === 'archived' ? 'archived' : 'active',
      issues,
    };
  }

  async import(ctx: AuthContext, file: Buffer, fileName: string, q: z.output<typeof importQuery>) {
    this.tenantOnly(ctx);
    let data: unknown[][];
    try {
      const sheets = await readXlsxFile(file);
      data = (sheets.find((s) => s.sheet === 'Plans') ?? sheets[0])?.data ?? [];
    } catch {
      throw new AppError(
        400,
        'VALIDATION_FAILED',
        'This is not a readable .xlsx file. Save it from Excel as .xlsx.',
      );
    }
    const head = (data[0] ?? []).map((h) => text(h).toLowerCase().replace(/\*$/, '').trim());
    const missing = PLAN_COLUMNS.filter((c) => c.required && !head.includes(c.key)).map((c) => c.key);
    if (missing.length) {
      throw new AppError(
        400,
        'VALIDATION_FAILED',
        `Missing columns: ${missing.join(', ')}. Start from the template.`,
      );
    }
    const lines = data
      .slice(1)
      .map((cells, i) => ({ row: i + 2, cells }))
      .filter((r) => r.cells.some((c) => text(c) !== ''));
    if (lines.length > MAX_ROWS)
      throw new AppError(400, 'VALIDATION_FAILED', `At most ${MAX_ROWS} plans per file`);

    const current = await this.existing(ctx);
    const byName = new Map(current.map((p) => [p.name.toLowerCase(), p]));
    const seen = new Map<string, number>();
    const res: Result = {
      fileName,
      status: 'validated',
      counts: {
        read: lines.length,
        create: 0,
        update: 0,
        unchanged: 0,
        skip: 0,
        invalid: 0,
        created: 0,
        updated: 0,
        failed: 0,
      },
      rows: [],
      errors: [],
    };
    const work: {
      idx: number;
      kind: 'create' | 'update';
      input: CreateInput;
      patch: Record<string, unknown>;
      status: Parsed['status'];
      existing?: PlanDoc;
    }[] = [];

    for (const { row, cells } of lines) {
      const p = this.parseRow(row, (k) => {
        const i = head.indexOf(k);
        return i < 0 ? '' : text(cells[i]);
      });
      const key = p.name.toLowerCase();
      if (key && seen.has(key))
        p.issues.push({ row, column: 'name', message: `Same name as row ${seen.get(key)}` });
      if (key) seen.set(key, seen.get(key) ?? row);
      const ex = byName.get(key);
      const entry: Result['rows'][number] = {
        row,
        name: p.name,
        action: 'invalid',
        changes: [],
        result: null,
      };
      res.rows.push(entry);
      if (p.issues.length || !p.input) {
        res.errors.push(...p.issues);
        res.counts.invalid++;
        continue;
      }
      if (!ex) {
        entry.action = 'create';
        res.counts.create++;
        work.push({ idx: res.rows.length - 1, kind: 'create', input: p.input, patch: {}, status: p.status });
        continue;
      }
      const patch = diff(comparable(ex), comparable(p.input));
      if (p.status !== ex.status) patch.status = p.status;
      // Only the changed fields go through the PATCH rules, so a valid file never trips a cross-field check twice.
      const checked = updateBody.safeParse(patch);
      if (Object.keys(patch).length && !checked.success) {
        res.errors.push({ row, message: checked.error.issues[0]?.message ?? 'invalid change' });
        res.counts.invalid++;
        continue;
      }
      entry.changes = Object.keys(patch);
      if (!entry.changes.length) {
        entry.action = 'unchanged';
        res.counts.unchanged++;
      } else if (!q.updateExisting) {
        entry.action = 'skip';
        res.counts.skip++;
      } else {
        entry.action = 'update';
        res.counts.update++;
        work.push({
          idx: res.rows.length - 1,
          kind: 'update',
          input: p.input,
          patch,
          status: p.status,
          existing: ex,
        });
      }
    }
    res.errors.sort((a, b) => a.row - b.row);

    if (q.dryRun || (res.counts.invalid && !q.skipInvalid)) {
      res.status = q.dryRun ? 'validated' : 'rejected';
      return res;
    }
    // Plans are few: applied here, one transaction each, through the same service as the panel
    // (outbox to RADIUS, CoA for online users when a speed changes, one audit note per plan).
    for (const w of work) {
      const entry = res.rows[w.idx]!;
      try {
        if (w.kind === 'create') {
          const v = await this.plans.create(ctx, w.input);
          if (w.status === 'archived')
            await this.plans.update(ctx, new ObjectId(v.id), { status: 'archived' });
          entry.result = 'created';
          res.counts.created++;
        } else {
          await this.plans.update(ctx, w.existing!._id, w.patch as UpdateInput);
          entry.result = 'updated';
          res.counts.updated++;
        }
      } catch (e) {
        entry.result = 'failed';
        res.counts.failed++;
        res.errors.push({ row: entry.row, message: e instanceof Error ? e.message : String(e) });
      }
    }
    res.status = 'done';
    noteChange({ after: { fileName, counts: res.counts } });
    return res;
  }
}

/** Headers only once the file exists, so a 400 on the way is still sent as JSON. */
const attach = (reply: FastifyReply, name: string) =>
  void reply
    .header('content-type', XLSX_MIME)
    .header('content-disposition', `attachment; filename="${name}"`);

@Controller('plans')
export class PlanExcelController {
  constructor(@Inject(PlanExcel) private readonly excel: PlanExcel) {}

  @Get('import/template')
  @Endpoint({
    summary: 'Excel template for plans, with column help',
    tags: ['plans'],
    permission: 'plans.write',
  })
  async template(@Res({ passthrough: true }) reply: FastifyReply) {
    const file = await this.excel.template();
    attach(reply, 'plans-template.xlsx');
    return file;
  }

  /** Body: the .xlsx file itself (Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet). */
  @Post('import')
  @HttpCode(200)
  @Endpoint({
    summary:
      'Import plans from Excel (dryRun=true checks only; existing names are skipped unless updateExisting; invalid rows reject the file unless skipInvalid)',
    tags: ['plans'],
    audit: 'plan.import',
    permission: 'plans.write',
    query: importQuery,
    response: resultView,
  })
  async import(
    @Ctx() ctx: AuthContext,
    @Req() req: FastifyRequest,
    @Query() q: z.output<typeof importQuery>,
  ) {
    if (!Buffer.isBuffer(req.body))
      throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', `Send the file with Content-Type ${XLSX_MIME}`);
    const raw = req.headers['x-file-name'];
    const fileName = (typeof raw === 'string' ? decodeURIComponent(raw) : 'plans.xlsx').slice(0, 120);
    return this.excel.import(ctx, req.body, fileName, q);
  }
}
