import { Controller, Get, HttpCode, Inject, Injectable, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ObjectId, type Filter } from 'mongodb';
import readXlsxFile from 'read-excel-file/node';
import writeXlsxFile, { type SheetData } from 'write-excel-file/node';
import { z } from 'zod';
import { FieldCrypto } from '@isp/shared';
import {
  ScopedDb,
  type ImportBatchDoc,
  type ImportRowDoc,
  type MongoHandle,
  type PlanDoc,
  type SubscriberDoc,
  type TenantDoc,
  USERNAME_COLLATION,
} from '@isp/db-mongo';
import { noteChange } from '../audit/audit.js';
import type { AuthContext } from '../auth/context.js';
import { AppError, notFound } from '../errors.js';
import { Ctx, Endpoint } from '../http/endpoint.js';
import { hexId, idParams } from '../http/schemas.js';
import { MONGO } from '../infra/infra.module.js';
import { createBody, newPassword, toNewSubscriber } from './subscribers.js';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const IMPORT_PATH = '/api/v1/subscribers/import';
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 50_000;
const MAX_ERRORS = 10_000;
const RESPONSE_ERRORS = 200;

interface Column {
  key: string;
  required?: boolean;
  example: string;
  help: string;
  /** Path in the create body; validation messages are reported under this column. */
  path: string;
}

/** The template, the import parser and the export all use this one list. */
export const COLUMNS: readonly Column[] = [
  {
    key: 'username',
    required: true,
    example: 'rahul01',
    help: 'PPPoE username: 3-64 letters, digits . _ @ -',
    path: 'username',
  },
  {
    key: 'pppoe_password',
    example: '',
    help: 'Leave empty to generate one (reveal it later on the subscriber page)',
    path: 'pppoePassword',
  },
  { key: 'name', required: true, example: 'Rahul Kumar', help: 'Full name', path: 'name' },
  {
    key: 'phone',
    required: true,
    example: '9876543210',
    help: '10-digit mobile or +<country><number>',
    path: 'phone',
  },
  { key: 'alt_phone', example: '', help: 'Optional second number', path: 'altPhone' },
  { key: 'email', example: '', help: 'Optional', path: 'email' },
  {
    key: 'address_line1',
    required: true,
    example: '12 MG Road',
    help: 'House / street',
    path: 'address.line1',
  },
  { key: 'address_line2', example: '', help: 'Optional', path: 'address.line2' },
  { key: 'city', required: true, example: 'Noida', help: '', path: 'address.city' },
  { key: 'district', example: '', help: 'Optional', path: 'address.district' },
  { key: 'state', required: true, example: 'Uttar Pradesh', help: '', path: 'address.state' },
  {
    key: 'state_code',
    example: '09',
    help: 'GST state code; empty = the ISP’s own state',
    path: 'address.stateCode',
  },
  { key: 'pincode', required: true, example: '201301', help: '6 digits', path: 'address.pincode' },
  { key: 'gstin', example: '', help: 'Business customers only', path: 'gstin' },
  { key: 'billing_type', example: 'prepaid', help: 'prepaid (default) or postpaid', path: 'billingType' },
  {
    key: 'plan',
    example: '',
    help: 'Plan name exactly as in the Plans sheet; empty = no plan yet',
    path: 'planId',
  },
  {
    key: 'expires_on',
    example: '',
    help: 'DD-MM-YYYY (day first) or YYYY-MM-DD; service ends at 23:59:59 IST that day',
    path: 'expiresAt',
  },
  { key: 'static_ip', example: '', help: 'Optional IPv4', path: 'network.staticIp' },
  { key: 'mac_lock', example: '', help: 'Optional, AA:BB:CC:DD:EE:FF', path: 'network.macLock' },
  { key: 'sim_use', example: '', help: 'Logins at once; empty = plan default', path: 'network.simUse' },
  { key: 'tags', example: 'fiber, noida-sec62', help: 'Comma separated', path: 'tags' },
  { key: 'notes', example: '', help: 'Optional', path: 'notes' },
];
const COLUMN_BY_PATH = new Map(COLUMNS.map((c) => [c.path, c.key]));

const istDay = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);

/**
 * Expiry cell text → YYYY-MM-DD, or null. ISO stays as is; anything else is day-first (Indian format):
 * 12/10/2026, 12-10-2026, 12.10.2026, 12//10/2026 and 2-digit years all mean 12 October 2026.
 */
export function parseDayFirst(v: string): string | null {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
  const dm = iso ? null : /^(\d{1,2})[./\-\s]+(\d{1,2})[./\-\s]+(\d{2}|\d{4})$/.exec(v);
  const [y, m, d] = iso
    ? [+iso[1]!, +iso[2]!, +iso[3]!]
    : dm
      ? [dm[3]!.length === 2 ? 2000 + +dm[3]! : +dm[3]!, +dm[2]!, +dm[1]!]
      : [0, 0, 0];
  if (!y) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Cell → trimmed text. Excel dates arrive as Date (midnight UTC of that calendar day). */
function text(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  return String(v).trim();
}

export interface RowIssue {
  row: number;
  column?: string;
  message: string;
}

type ValidRow = { row: number; input: z.output<typeof createBody> };

const importQuery = z.object({
  dryRun: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Import the valid rows even if some are wrong (default: nothing is imported until the file is clean). */
  skipInvalid: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});
const exportQuery = z.object({
  status: z.enum(['active', 'suspended', 'disabled']).optional(),
  planId: hexId.optional(),
});
const batchView = z.object({
  id: z.string().nullable(),
  fileName: z.string(),
  status: z.enum(['validated', 'rejected', 'queued', 'running', 'done', 'failed']),
  counts: z.object({ read: z.number(), valid: z.number(), created: z.number(), failed: z.number() }),
  errors: z.array(z.object({ row: z.number(), column: z.string().optional(), message: z.string() })),
  errorsTruncated: z.boolean(),
  createdAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});

const toBatchView = (b: ImportBatchDoc): z.output<typeof batchView> => ({
  id: b._id.toHexString(),
  fileName: b.fileName,
  status: b.status,
  counts: b.counts,
  errors: b.errors.slice(0, RESPONSE_ERRORS),
  errorsTruncated: b.errors.length > RESPONSE_ERRORS,
  createdAt: b.createdAt.toISOString(),
  finishedAt: b.finishedAt?.toISOString() ?? null,
});

@Injectable()
export class SubscriberExcel {
  constructor(
    @Inject(MONGO) private readonly mongo: MongoHandle,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
  ) {}

  private tenant(ctx: AuthContext): ObjectId {
    if (!ctx.tenantId || ctx.scope.kind !== 'tenant') {
      throw new AppError(400, 'VALIDATION_FAILED', 'Imports are done by an ISP’s staff');
    }
    return ctx.tenantId;
  }

  private async plans(tenantId: ObjectId) {
    return this.mongo.db
      .collection<PlanDoc>('plans')
      .find(
        { tenantId },
        {
          projection: {
            name: 1,
            status: 1,
            billingTypes: 1,
            downloadKbps: 1,
            uploadKbps: 1,
            dataCapBytes: 1,
          },
        },
      )
      .toArray();
  }

  async template(ctx: AuthContext): Promise<Buffer> {
    const plans = (await this.plans(this.tenant(ctx))).filter((p) => p.status === 'active');
    const header = COLUMNS.map((c) => ({
      value: c.required ? `${c.key}*` : c.key,
      fontWeight: 'bold' as const,
    }));
    const example = COLUMNS.map((c) => (c.key === 'plan' ? (plans[0]?.name ?? '') : c.example) || null);
    const sheets = [
      {
        sheet: 'Subscribers',
        data: [header, example] as SheetData,
        stickyRowsCount: 1,
        columns: COLUMNS.map(() => ({ width: 18 })),
      },
      {
        sheet: 'Plans',
        data: [
          ['plan', 'download Mbps', 'upload Mbps', 'data cap GB', 'billing types'].map((v) => ({
            value: v,
            fontWeight: 'bold' as const,
          })),
          ...plans.map((p) => [
            p.name,
            p.downloadKbps / 1000,
            p.uploadKbps / 1000,
            p.dataCapBytes ? Math.round(p.dataCapBytes / 1e9) : null,
            p.billingTypes.join(', '),
          ]),
        ] as SheetData,
        columns: [{ width: 28 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 18 }],
      },
      {
        sheet: 'Help',
        data: [
          ['column', 'required', 'meaning'].map((v) => ({ value: v, fontWeight: 'bold' as const })),
          ...COLUMNS.map((c) => [c.key, c.required ? 'yes' : '', c.help]),
          [],
          ['Up to 50,000 rows per file. Rows with a * column empty are rejected. Delete the example row.'],
        ] as SheetData,
        columns: [{ width: 18 }, { width: 10 }, { width: 70 }],
      },
    ];
    return writeXlsxFile(sheets).toBuffer();
  }

  /** Parses and validates every row; nothing is written. */
  async validate(
    ctx: AuthContext,
    file: Buffer,
  ): Promise<{ read: number; valid: ValidRow[]; issues: RowIssue[] }> {
    const tenantId = this.tenant(ctx);
    let data: unknown[][];
    try {
      const sheets = await readXlsxFile(file);
      data = (sheets.find((s) => s.sheet === 'Subscribers') ?? sheets[0])?.data ?? [];
    } catch {
      throw new AppError(
        400,
        'VALIDATION_FAILED',
        'This is not a readable .xlsx file. Save it from Excel as .xlsx and try again.',
      );
    }
    const head = (data[0] ?? []).map((h) => text(h).toLowerCase().replace(/\*$/, '').trim());
    const missing = COLUMNS.filter((c) => c.required && !head.includes(c.key)).map((c) => c.key);
    if (missing.length) {
      throw new AppError(
        400,
        'VALIDATION_FAILED',
        `Missing columns: ${missing.join(', ')}. Start from the template.`,
      );
    }
    const idx = new Map(COLUMNS.map((c) => [c.key, head.indexOf(c.key)]));
    const rows = data
      .slice(1)
      .map((cells, i) => ({ row: i + 2, cells }))
      .filter((r) => r.cells.some((c) => text(c) !== ''));
    if (rows.length > MAX_ROWS)
      throw new AppError(400, 'VALIDATION_FAILED', `At most ${MAX_ROWS} rows per file`);

    const plans = await this.plans(tenantId);
    const planByName = new Map(plans.map((p) => [p.name.toLowerCase(), p]));
    const issues: RowIssue[] = [];
    const valid: ValidRow[] = [];
    const seenUser = new Map<string, number>();
    const seenIp = new Map<string, number>();

    for (const { row, cells } of rows) {
      const get = (key: string) => {
        const i = idx.get(key)!;
        return i < 0 ? '' : text(cells[i]);
      };
      const opt = (key: string) => get(key) || undefined;
      const rowIssues: RowIssue[] = [];
      let planId: ObjectId | undefined;
      const planName = get('plan');
      const billingType = (get('billing_type').toLowerCase() || 'prepaid') as 'prepaid' | 'postpaid';
      if (planName) {
        const p = planByName.get(planName.toLowerCase());
        if (!p) rowIssues.push({ row, column: 'plan', message: `No plan named "${planName}"` });
        else if (p.status !== 'active')
          rowIssues.push({ row, column: 'plan', message: 'This plan is archived' });
        else if (!p.billingTypes.includes(billingType)) {
          rowIssues.push({
            row,
            column: 'plan',
            message: `This plan is not offered for ${billingType} customers`,
          });
        } else planId = p._id;
      }
      const expiresRaw = get('expires_on');
      const expires = expiresRaw ? parseDayFirst(expiresRaw) : null;
      if (expiresRaw && !expires) {
        rowIssues.push({ row, column: 'expires_on', message: 'Use DD-MM-YYYY (or YYYY-MM-DD)' });
      }
      const simUse = get('sim_use');
      const raw = {
        username: get('username'),
        pppoePassword: opt('pppoe_password'),
        name: get('name'),
        phone: get('phone'),
        altPhone: opt('alt_phone'),
        email: opt('email'),
        address: {
          line1: get('address_line1'),
          line2: opt('address_line2'),
          city: get('city'),
          district: opt('district'),
          state: get('state'),
          stateCode: opt('state_code')?.padStart(2, '0'),
          pincode: get('pincode'),
        },
        gstin: opt('gstin')?.toUpperCase(),
        billingType,
        expiresAt: expires ? `${expires}T23:59:59+05:30` : undefined,
        network: {
          staticIp: opt('static_ip'),
          macLock: opt('mac_lock'),
          simUse: simUse ? Number(simUse) : undefined,
        },
        tags: get('tags')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        notes: opt('notes'),
      };
      const parsed = createBody.safeParse(raw);
      if (!parsed.success) {
        for (const i of parsed.error.issues) {
          const path = i.path.map(String).join('.');
          rowIssues.push({
            row,
            column: COLUMN_BY_PATH.get(path) ?? COLUMN_BY_PATH.get(path.split('.')[0]!) ?? path,
            message: i.message,
          });
        }
      }
      const u = raw.username.toLowerCase();
      if (u && seenUser.has(u))
        rowIssues.push({ row, column: 'username', message: `Same username as row ${seenUser.get(u)}` });
      if (u) seenUser.set(u, seenUser.get(u) ?? row);
      const ip = raw.network.staticIp;
      if (ip && seenIp.has(ip))
        rowIssues.push({ row, column: 'static_ip', message: `Same static IP as row ${seenIp.get(ip)}` });
      if (ip) seenIp.set(ip, seenIp.get(ip) ?? row);

      if (rowIssues.length || !parsed.success) issues.push(...rowIssues);
      else valid.push({ row, input: { ...parsed.data, ...(planId ? { planId } : {}) } });
    }

    // Already taken in this ISP (checked in chunks so a 50k-row file stays a few queries).
    const subs = this.mongo.db.collection<SubscriberDoc>('subscribers');
    for (let i = 0; i < valid.length; i += 1000) {
      const chunk = valid.slice(i, i + 1000);
      const [users, ips] = await Promise.all([
        subs
          .find(
            { tenantId, username: { $in: chunk.map((r) => r.input.username) } },
            { projection: { username: 1 }, collation: USERNAME_COLLATION },
          )
          .toArray(),
        subs
          .find(
            {
              tenantId,
              'network.staticIp': {
                $in: chunk.map((r) => r.input.network?.staticIp).filter((x): x is string => !!x),
              },
            },
            { projection: { network: 1 } },
          )
          .toArray(),
      ]);
      const takenUser = new Set(users.map((s) => s.username?.toLowerCase()));
      const takenIp = new Set(ips.map((s) => s.network.staticIp));
      for (const r of chunk) {
        if (takenUser.has(r.input.username.toLowerCase()))
          issues.push({ row: r.row, column: 'username', message: 'Already used by a subscriber' });
        if (r.input.network?.staticIp && takenIp.has(r.input.network.staticIp)) {
          issues.push({ row: r.row, column: 'static_ip', message: 'Already given to a subscriber' });
        }
      }
    }
    const bad = new Set(issues.map((i) => i.row));
    issues.sort((a, b) => a.row - b.row);
    return { read: rows.length, valid: valid.filter((r) => !bad.has(r.row)), issues };
  }

  async import(ctx: AuthContext, file: Buffer, fileName: string, q: z.output<typeof importQuery>) {
    const tenantId = this.tenant(ctx);
    const { read, valid, issues } = await this.validate(ctx, file);
    const tenant = await this.mongo.db
      .collection<TenantDoc>('tenants')
      .findOne({ _id: tenantId }, { projection: { stateCode: 1 } });
    const counts = { read, valid: valid.length, created: 0, failed: 0 };
    const view = (status: 'validated' | 'rejected') => ({
      id: null,
      fileName,
      status,
      counts,
      errors: issues.slice(0, RESPONSE_ERRORS),
      errorsTruncated: issues.length > RESPONSE_ERRORS,
      createdAt: null,
      finishedAt: null,
    });
    if (q.dryRun || (issues.length && !q.skipInvalid)) {
      const status = q.dryRun ? 'validated' : 'rejected';
      noteChange({ after: { fileName, status, counts, issues: issues.length } });
      return view(status);
    }
    if (!valid.length) throw new AppError(400, 'VALIDATION_FAILED', 'No valid rows to import');

    const now = new Date();
    const batch: ImportBatchDoc = {
      _id: new ObjectId(),
      tenantId,
      source: 'excel',
      fileName,
      status: 'queued',
      counts,
      errors: issues.slice(0, MAX_ERRORS),
      createdBy: ctx.userId.toHexString(),
      createdAt: now,
    };
    await this.mongo.db.collection<ImportBatchDoc>('import_batches').insertOne(batch);
    noteChange({ after: { fileName, counts, skippedInvalid: issues.length }, entityId: batch._id });
    const rows = this.mongo.db.collection<ImportRowDoc>('import_rows');
    for (let i = 0; i < valid.length; i += 1000) {
      await rows.insertMany(
        valid.slice(i, i + 1000).map((r) => {
          const _id = new ObjectId();
          const input = toNewSubscriber(r.input, r.input.pppoePassword ?? newPassword(), tenant?.stateCode);
          return {
            _id,
            batchId: batch._id,
            tenantId,
            row: r.row,
            input: {
              ...input,
              pppoePassword: this.crypto.encrypt(input.pppoePassword, `import_rows:${_id.toHexString()}`),
            },
            status: 'pending' as const,
            createdAt: now,
          };
        }),
        { ordered: false },
      );
    }
    return toBatchView(batch);
  }

  private batches(ctx: AuthContext) {
    return new ScopedDb(this.mongo.db, ctx.scope).collection<ImportBatchDoc>('import_batches');
  }

  async list(ctx: AuthContext) {
    const docs = await this.batches(ctx)
      .find({}, { sort: { createdAt: -1 }, limit: 20, projection: { errors: 0 } })
      .toArray();
    return docs.map((d) => toBatchView({ ...d, errors: [] }));
  }

  async get(ctx: AuthContext, id: ObjectId) {
    const b = await this.batches(ctx).findOne({ _id: id });
    if (!b) throw notFound('Import');
    return b;
  }

  async errorReport(ctx: AuthContext, id: ObjectId): Promise<Buffer> {
    const b = await this.get(ctx, id);
    const data: SheetData = [
      ['row', 'column', 'problem'].map((v) => ({ value: v, fontWeight: 'bold' as const })),
      ...b.errors.map((e) => [e.row, e.column ?? '', e.message]),
    ];
    return writeXlsxFile(data, {
      sheet: 'Problems',
      columns: [{ width: 8 }, { width: 18 }, { width: 70 }],
    }).toBuffer();
  }

  async export(ctx: AuthContext, q: z.output<typeof exportQuery>): Promise<Buffer> {
    const scoped = new ScopedDb(this.mongo.db, ctx.scope);
    const f: Filter<SubscriberDoc> = { status: q.status ?? { $ne: 'deleted' } };
    if (q.planId) f.planId = new ObjectId(q.planId);
    const plans = new Map(
      (
        await scoped
          .collection<PlanDoc>('plans')
          .find({}, { projection: { name: 1 } })
          .toArray()
      ).map((p) => [p._id.toHexString(), p.name]),
    );
    const cols = COLUMNS.filter((c) => c.key !== 'pppoe_password');
    const extra = ['customer_no', 'status', 'sync_status', 'created_on'];
    const data: SheetData = [
      [...cols.map((c) => c.key), ...extra].map((v) => ({ value: v, fontWeight: 'bold' as const })),
    ];
    const cursor = scoped
      .collection<SubscriberDoc>('subscribers')
      .find(f, { sort: { customerNo: 1 }, projection: { pppoePassword: 0, search: 0 }, batchSize: 2000 });
    let n = 0;
    for await (const s of cursor) {
      if (++n > 100_000)
        throw new AppError(400, 'VALIDATION_FAILED', 'More than 100,000 rows: filter by status or plan');
      const v: Record<string, string | number | null> = {
        username: s.username ?? '',
        name: s.name,
        phone: s.phone,
        alt_phone: s.altPhone ?? null,
        email: s.email ?? null,
        address_line1: s.address.line1,
        address_line2: s.address.line2 ?? null,
        city: s.address.city,
        district: s.address.district ?? null,
        state: s.address.state,
        state_code: s.address.stateCode,
        pincode: s.address.pincode,
        gstin: s.gstin ?? null,
        billing_type: s.billingType,
        plan: s.planId ? (plans.get(s.planId.toHexString()) ?? null) : null,
        expires_on: s.expiresAt ? istDay(s.expiresAt) : null,
        static_ip: s.network.staticIp ?? null,
        mac_lock: s.network.macLock ?? null,
        sim_use: s.network.simUse ?? null,
        tags: s.tags.join(', ') || null,
        notes: s.notes ?? null,
      };
      data.push([
        ...cols.map((c) => v[c.key] ?? null),
        s.customerNo,
        s.status,
        s.syncStatus,
        istDay(s.createdAt),
      ]);
    }
    noteChange({ after: { rows: n, filter: q } });
    return writeXlsxFile(data, { sheet: 'Subscribers', stickyRowsCount: 1 }).toBuffer();
  }
}

/** Headers only once the file exists, so a 404/400 on the way is still sent as JSON. */
const attach = (reply: FastifyReply, name: string) =>
  void reply
    .header('content-type', XLSX_MIME)
    .header('content-disposition', `attachment; filename="${name}"`);

type Id = { id: ObjectId };

@Controller('subscribers')
export class SubscriberExcelController {
  constructor(@Inject(SubscriberExcel) private readonly excel: SubscriberExcel) {}

  @Get('import/template')
  @Endpoint({
    summary: 'Excel template with the ISP’s plans and column help',
    tags: ['import'],
    permission: 'imports.run',
  })
  async template(@Ctx() ctx: AuthContext, @Res({ passthrough: true }) reply: FastifyReply) {
    const file = await this.excel.template(ctx);
    attach(reply, 'subscribers-template.xlsx');
    return file;
  }

  /** Body: the .xlsx file itself (Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet). */
  @Post('import')
  @HttpCode(200)
  @Endpoint({
    summary:
      'Import subscribers from Excel (dryRun=true checks only; invalid rows reject the file unless skipInvalid)',
    tags: ['import'],
    audit: 'import.create',
    permission: 'imports.run',
    query: importQuery,
    response: batchView,
  })
  async import(
    @Ctx() ctx: AuthContext,
    @Req() req: FastifyRequest,
    @Query() q: z.output<typeof importQuery>,
  ) {
    if (!Buffer.isBuffer(req.body))
      throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', `Send the file with Content-Type ${XLSX_MIME}`);
    const raw = req.headers['x-file-name'];
    const fileName = (typeof raw === 'string' ? decodeURIComponent(raw) : 'upload.xlsx').slice(0, 120);
    return this.excel.import(ctx, req.body, fileName, q);
  }

  @Get('imports')
  @Endpoint({
    summary: 'Recent imports',
    tags: ['import'],
    permission: 'imports.run',
    response: z.array(batchView),
  })
  list(@Ctx() ctx: AuthContext) {
    return this.excel.list(ctx);
  }

  @Get('imports/:id')
  @Endpoint({
    summary: 'Import progress and problems',
    tags: ['import'],
    permission: 'imports.run',
    params: idParams,
    response: batchView,
  })
  async get(@Ctx() ctx: AuthContext, @Param() p: Id) {
    return toBatchView(await this.excel.get(ctx, p.id));
  }

  @Get('imports/:id/errors')
  @Endpoint({
    summary: 'Problems as an Excel sheet',
    tags: ['import'],
    permission: 'imports.run',
    params: idParams,
  })
  async errors(@Ctx() ctx: AuthContext, @Param() p: Id, @Res({ passthrough: true }) reply: FastifyReply) {
    const file = await this.excel.errorReport(ctx, p.id);
    attach(reply, `import-${p.id.toHexString()}-problems.xlsx`);
    return file;
  }

  @Get('export')
  @Endpoint({
    summary: 'Export subscribers to Excel (no passwords; at most 100,000 rows)',
    tags: ['import'],
    audit: 'subscriber.export',
    permission: 'subscribers.export',
    query: exportQuery,
  })
  async export(
    @Ctx() ctx: AuthContext,
    @Query() q: z.output<typeof exportQuery>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const file = await this.excel.export(ctx, q);
    attach(reply, `subscribers-${istDay(new Date())}.xlsx`);
    return file;
  }
}
