import { randomInt } from 'node:crypto';
import { isIPv4 } from 'node:net';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import { FieldCrypto } from '@isp/shared';
import {
  insertSubscriber,
  pppoeAad,
  ScopedDb,
  type NewSubscriber,
  type CoaLogDoc,
  type MongoHandle,
  type OutboxDoc,
  type PlanDoc,
  type ResellerDoc,
  type SubscriberDoc,
  type TenantDoc,
} from '@isp/db-mongo';
import { noteChange } from '../audit/audit.js';
import { ResellersService } from '../resellers/resellers.js';
import type { AuthContext } from '../auth/context.js';
import { AppError, conflict, forbidden, notFound } from '../errors.js';
import { Ctx, Endpoint } from '../http/endpoint.js';
import {
  compact,
  email,
  gstin,
  hexId,
  idParams,
  objectId,
  okResponse,
  page,
  pageOf,
  pageQuery,
  phone,
  pincode,
  stateCode,
} from '../http/schemas.js';
import { MONGO } from '../infra/infra.module.js';
import { Outbox } from '../sync/outbox.js';
import { coaFor, radiusState, searchTokens } from './coa-policy.js';

const username = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._@-]{3,64}$/, '3-64 letters, digits, . _ @ -');
/** Printable ASCII without spaces: CHAP/MS-CHAP need the exact bytes the router sends. */
const pppoePassword = z.string().regex(/^[\x21-\x7e]{4,64}$/, '4-64 characters, no spaces');
export const mac = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase().replace(/[-.]/g, ':'))
  .transform((s) => (/^[0-9A-F]{12}$/.test(s) ? s.match(/../g)!.join(':') : s))
  .pipe(z.string().regex(/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/, 'must be a MAC address'));
export const staticIp = z
  .string()
  .trim()
  .refine((s) => isIPv4(s), 'must be an IPv4 address');
const address = z.object({
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(80),
  district: z.string().trim().max(80).optional(),
  state: z.string().trim().min(1).max(80),
  stateCode: stateCode.optional(),
  pincode: pincode,
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});
const network = z.object({
  staticIp: staticIp.nullable().optional(),
  macLock: mac.nullable().optional(),
  simUse: z.number().int().min(1).max(10).nullable().optional(),
  popName: z.string().trim().max(80).nullable().optional(),
});

export const createBody = z.object({
  username,
  pppoePassword: pppoePassword.optional(),
  name: z.string().trim().min(1).max(120),
  phone,
  altPhone: phone.optional(),
  email: email.optional(),
  address,
  gstin: gstin.optional(),
  billingType: z.enum(['prepaid', 'postpaid']).default('prepaid'),
  planId: objectId.optional(),
  expiresAt: z.coerce.date().optional(),
  network: network.optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(20).default([]),
  notes: z.string().max(2000).optional(),
  /** Owning reseller; null = direct ISP customer. A reseller's own customers default to that reseller. */
  resellerId: objectId.nullable().optional(),
});
const updateBody = z
  .object({
    pppoePassword: pppoePassword.optional(),
    name: z.string().trim().min(1).max(120).optional(),
    phone: phone.optional(),
    altPhone: phone.nullable().optional(),
    email: email.nullable().optional(),
    address: address.optional(),
    gstin: gstin.nullable().optional(),
    billingType: z.enum(['prepaid', 'postpaid']).optional(),
    planId: objectId.nullable().optional(),
    expiresAt: z.coerce.date().nullable().optional(),
    network: network.optional(),
    tags: z.array(z.string().trim().min(1).max(30)).max(20).optional(),
    notes: z.string().max(2000).nullable().optional(),
    resellerId: objectId.nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'nothing to change');
const listQuery = pageQuery.extend({
  q: z.string().trim().min(1).max(64).optional(),
  status: z.enum(['active', 'suspended', 'disabled', 'expired']).optional(),
  planId: hexId.optional(),
  /** Customers owned directly by this reseller; `none` = direct ISP customers. */
  resellerId: z.union([hexId, z.literal('none')]).optional(),
  /** Customers anywhere in this reseller's branch. */
  under: hexId.optional(),
  /** Validity window (IST days): ends later today, tomorrow, within 7 days, or ended this month and not renewed. */
  expiry: z.enum(['today', 'tomorrow', '7d', 'expired-month']).optional(),
});

const summaryView = z.object({
  asOf: z.string(),
  total: z.number(),
  /** Active and still valid (or with no validity date). */
  active: z.number(),
  suspended: z.number(),
  disabled: z.number(),
  /** Active, but validity has run out. */
  expired: z.number(),
  /** Expired since the start of this IST month and not renewed yet. */
  expiredThisMonth: z.number(),
  expiringToday: z.number(),
  expiringTomorrow: z.number(),
  expiring7d: z.number(),
  /** What renewing each group on its current plan would bring in (plan prices, GST as priced). */
  renewPaise: z.object({
    today: z.number(),
    tomorrow: z.number(),
    next7d: z.number(),
    expiredThisMonth: z.number(),
  }),
});
type SubscriberSummary = z.output<typeof summaryView>;

const DAY_MS = 86_400_000;
const IST_MS = 330 * 60_000;
/** IST midnights around now, as UTC instants: start of today, tomorrow, the day after, and of this month. */
function istBounds(now: Date) {
  const ist = new Date(now.getTime() + IST_MS);
  const today = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_MS;
  const month = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - IST_MS;
  return {
    tomorrow: new Date(today + DAY_MS),
    dayAfter: new Date(today + 2 * DAY_MS),
    monthStart: new Date(month),
  };
}
const SUMMARY_TTL_MS = 60_000;

const expiringQuery = z.object({
  /** Prepaid customers whose validity ends within this many days from now. */
  days: z.coerce.number().int().min(1).max(60).default(7),
  /** IST-day window instead of `days`: later today, tomorrow, or the next 7 days. */
  window: z.enum(['today', 'tomorrow', '7d']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

const subscriberView = z.object({
  id: z.string(),
  customerNo: z.string(),
  username: z.string(),
  name: z.string(),
  phone: z.string(),
  altPhone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.record(z.string(), z.unknown()),
  gstin: z.string().nullable(),
  billingType: z.enum(['prepaid', 'postpaid']),
  planId: z.string().nullable(),
  expiresAt: z.string().nullable(),
  status: z.enum(['active', 'suspended', 'disabled']),
  suspendReason: z.string().nullable(),
  radiusState: z.enum(['blocked', 'expired', 'fup', 'active']),
  network: z.object({
    staticIp: z.string().nullable(),
    macLock: z.string().nullable(),
    simUse: z.number().nullable(),
    popName: z.string().nullable(),
  }),
  fupActive: z.boolean(),
  kycStatus: z.string(),
  tags: z.array(z.string()),
  notes: z.string().nullable(),
  syncStatus: z.enum(['synced', 'pending', 'error']),
  reseller: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Present only in the response that created the subscriber with a generated password. */
  pppoePassword: z.string().optional(),
});

type ResellerRefs = ReadonlyMap<string, Pick<ResellerDoc, '_id' | 'code' | 'name'>>;

const toView = (
  s: SubscriberDoc,
  refs: ResellerRefs,
  revealed?: string,
): z.output<typeof subscriberView> => ({
  id: s._id.toHexString(),
  customerNo: s.customerNo,
  username: s.username ?? s.deletedUsername ?? '',
  name: s.name,
  phone: s.phone,
  altPhone: s.altPhone ?? null,
  email: s.email ?? null,
  address: s.address,
  gstin: s.gstin ?? null,
  billingType: s.billingType,
  planId: s.planId?.toHexString() ?? null,
  expiresAt: s.expiresAt?.toISOString() ?? null,
  status: s.status === 'deleted' ? 'disabled' : s.status,
  suspendReason: s.suspendReason ?? null,
  radiusState: radiusState(s),
  network: {
    staticIp: s.network.staticIp ?? null,
    macLock: s.network.macLock ?? null,
    simUse: s.network.simUse ?? null,
    popName: s.network.popName ?? null,
  },
  fupActive: s.fup?.active === true,
  kycStatus: s.kyc.status,
  tags: s.tags,
  notes: s.notes ?? null,
  syncStatus: s.syncStatus,
  reseller: refOf(s, refs),
  createdAt: s.createdAt.toISOString(),
  updatedAt: s.updatedAt.toISOString(),
  ...(revealed ? { pppoePassword: revealed } : {}),
});

function refOf(s: SubscriberDoc, refs: ResellerRefs) {
  const r = s.resellerId ? refs.get(s.resellerId.toHexString()) : undefined;
  return r ? { id: r._id.toHexString(), code: r.code, name: r.name } : null;
}

const coaLogView = z.object({
  type: z.enum(['coa', 'disconnect']),
  result: z.string(),
  reason: z.string(),
  nasIp: z.string(),
  errorCause: z.number().nullable(),
  latencyMs: z.number().nullable(),
  at: z.string(),
});

/** Validated create input → the shared writer's input (also used by the Excel import). */
export function toNewSubscriber(
  b: z.output<typeof createBody>,
  password: string,
  tenantStateCode: string | undefined,
): NewSubscriber {
  const net = compact(b.network ?? {});
  return {
    username: b.username,
    pppoePassword: password,
    name: b.name,
    phone: b.phone,
    altPhone: b.altPhone,
    email: b.email,
    address: { ...compact(b.address), stateCode: b.address.stateCode ?? tenantStateCode ?? '00' },
    gstin: b.gstin,
    billingType: b.billingType,
    planId: b.planId,
    expiresAt: b.expiresAt,
    network: Object.fromEntries(
      Object.entries(net).filter(([, v]) => v !== null),
    ) as SubscriberDoc['network'],
    tags: b.tags,
    notes: b.notes,
  };
}

const PW_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const newPassword = () =>
  Array.from({ length: 10 }, () => PW_ALPHABET[randomInt(PW_ALPHABET.length)]).join('');
const pwAad = pppoeAad;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function duplicate(e: unknown): never {
  const key = Object.keys((e as { keyPattern?: object }).keyPattern ?? {});
  if (key.includes('username')) throw conflict('This PPPoE username is already used');
  if (key.includes('network.staticIp'))
    throw conflict('This static IP is already given to another subscriber');
  throw e;
}

@Injectable()
export class SubscribersService {
  constructor(
    @Inject(MONGO) private readonly mongo: MongoHandle,
    @Inject(Outbox) private readonly outbox: Outbox,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
    @Inject(ResellersService) private readonly resellers: ResellersService,
  ) {}

  /** Owning resellers of these subscribers in one query. */
  private async refs(ctx: AuthContext, docs: SubscriberDoc[]): Promise<ResellerRefs> {
    const ids = [...new Set(docs.flatMap((d) => (d.resellerId ? [d.resellerId.toHexString()] : [])))];
    if (!ids.length) return new Map();
    const rows = await new ScopedDb(this.mongo.db, ctx.scope)
      .collection<ResellerDoc>('resellers')
      .find({ _id: { $in: ids.map((i) => new ObjectId(i)) } }, { projection: { code: 1, name: 1 } })
      .toArray();
    return new Map(rows.map((r) => [r._id.toHexString(), r]));
  }

  private view = async (ctx: AuthContext, s: SubscriberDoc, revealed?: string) =>
    toView(s, await this.refs(ctx, [s]), revealed);

  /** Owner and ancestors for a subscriber placed under `resellerId` (undefined = the caller's own reseller). */
  private async owner(ctx: AuthContext, resellerId: ObjectId | null | undefined) {
    const self = ctx.scope.kind === 'branch' ? ctx.scope.resellerId : null;
    const id = resellerId === undefined ? self : resellerId;
    if (!id) {
      if (self) throw forbidden('A reseller cannot make a direct ISP customer');
      return { resellerId: null, ancestors: [] as ObjectId[] };
    }
    const r = await this.resellers.assertOpenParent(ctx, id);
    return { resellerId: r._id, ancestors: [...r.ancestors, r._id] };
  }

  private col(ctx: AuthContext) {
    return new ScopedDb(this.mongo.db, ctx.scope).collection<SubscriberDoc>('subscribers');
  }

  private async find(ctx: AuthContext, id: ObjectId) {
    const s = await this.col(ctx).findOne({ _id: id, status: { $ne: 'deleted' } });
    if (!s) throw notFound('Subscriber');
    return s;
  }

  private async assertPlan(ctx: AuthContext, planId: ObjectId, billingType: SubscriberDoc['billingType']) {
    const p = await new ScopedDb(this.mongo.db, ctx.scope)
      .collection<PlanDoc>('plans')
      .findOne({ _id: planId });
    if (!p) throw new AppError(400, 'VALIDATION_FAILED', 'Unknown plan');
    if (p.status !== 'active') throw new AppError(400, 'VALIDATION_FAILED', 'This plan is archived');
    if (!p.billingTypes.includes(billingType)) {
      throw new AppError(400, 'VALIDATION_FAILED', `This plan is not offered for ${billingType} customers`);
    }
  }

  async list(ctx: AuthContext, q: z.output<typeof listQuery>) {
    const now = new Date();
    const f: Filter<SubscriberDoc> = { status: { $ne: 'deleted' } };
    // Active and Expired don't overlap: an active customer whose validity has run out is Expired.
    if (q.status === 'expired') Object.assign(f, { status: 'active', expiresAt: { $lte: now } });
    else if (q.status === 'active')
      Object.assign(f, { status: 'active', $or: [{ expiresAt: { $gt: now } }, { expiresAt: null }] });
    else if (q.status) f.status = q.status;
    if (q.expiry) {
      const b = istBounds(now);
      f.status = 'active';
      f.expiresAt =
        q.expiry === 'today'
          ? { $gt: now, $lt: b.tomorrow }
          : q.expiry === 'tomorrow'
            ? { $gte: b.tomorrow, $lt: b.dayAfter }
            : q.expiry === '7d'
              ? { $gt: now, $lte: new Date(now.getTime() + 7 * DAY_MS) }
              : { $gte: b.monthStart, $lte: now };
    }
    if (q.planId) f.planId = new ObjectId(q.planId);
    if (q.resellerId === 'none') f.resellerId = null;
    else if (q.resellerId) f.resellerId = new ObjectId(q.resellerId);
    if (q.under) f.ancestors = new ObjectId(q.under);
    if (q.cursor) f._id = { $lt: new ObjectId(q.cursor) };
    if (q.q) {
      const term = q.q.toLowerCase().replace(/^\+?91(?=\d{10}$)/, '');
      f.search = { $regex: `^${escapeRegex(term)}` };
    }
    const docs = await this.col(ctx)
      .find(f, { sort: { _id: -1 }, limit: q.limit + 1 })
      .toArray();
    const refs = await this.refs(ctx, docs.slice(0, q.limit));
    return pageOf(docs, q.limit, (d) => toView(d, refs));
  }

  private readonly summaryCache = new Map<string, { at: number; v: SubscriberSummary }>();

  /**
   * Status and renewal counts for the dashboard: one grouped aggregate (per plan, so renewal value
   * comes from plan prices), scoped like the list, cached per scope for a minute.
   */
  async summary(ctx: AuthContext): Promise<SubscriberSummary> {
    const s = ctx.scope;
    const key =
      s.kind === 'branch'
        ? `b:${s.tenantId.toHexString()}:${s.resellerId.toHexString()}`
        : s.kind === 'tenant'
          ? `t:${s.tenantId.toHexString()}`
          : 'all';
    const hit = this.summaryCache.get(key);
    if (hit && Date.now() - hit.at < SUMMARY_TTL_MS) return hit.v;

    const now = new Date();
    const b = istBounds(now);
    const in7 = new Date(now.getTime() + 7 * DAY_MS);
    const isActive = { $eq: ['$status', 'active'] };
    const hasExpiry = { $eq: [{ $type: '$expiresAt' }, 'date'] };
    const when = (...conds: unknown[]) => ({ $sum: { $cond: [{ $and: conds }, 1, 0] } });
    const rows = await this.col(ctx)
      .aggregate<{
        _id: ObjectId | null;
        total: number;
        activeAll: number;
        suspended: number;
        disabled: number;
        expired: number;
        expMonth: number;
        today: number;
        tomorrow: number;
        d7: number;
      }>([
        { $match: { status: { $ne: 'deleted' } } },
        {
          $group: {
            _id: '$planId',
            total: { $sum: 1 },
            activeAll: when(isActive),
            suspended: when({ $eq: ['$status', 'suspended'] }),
            disabled: when({ $eq: ['$status', 'disabled'] }),
            expired: when(isActive, hasExpiry, { $lte: ['$expiresAt', now] }),
            expMonth: when(
              isActive,
              hasExpiry,
              { $gte: ['$expiresAt', b.monthStart] },
              { $lte: ['$expiresAt', now] },
            ),
            today: when(
              isActive,
              hasExpiry,
              { $gt: ['$expiresAt', now] },
              { $lt: ['$expiresAt', b.tomorrow] },
            ),
            tomorrow: when(
              isActive,
              hasExpiry,
              { $gte: ['$expiresAt', b.tomorrow] },
              { $lt: ['$expiresAt', b.dayAfter] },
            ),
            d7: when(isActive, hasExpiry, { $gt: ['$expiresAt', now] }, { $lte: ['$expiresAt', in7] }),
          },
        },
      ])
      .toArray();

    const planIds = rows.map((r) => r._id).filter((id): id is ObjectId => id instanceof ObjectId);
    const prices = new Map(
      (
        await this.mongo.db
          .collection<PlanDoc>('plans')
          .find({ _id: { $in: planIds } }, { projection: { pricePaise: 1 } })
          .toArray()
      ).map((p) => [p._id.toHexString(), p.pricePaise]),
    );
    const sum = (k: keyof (typeof rows)[number]) => rows.reduce((n, r) => n + (r[k] as number), 0);
    const value = (k: 'today' | 'tomorrow' | 'd7' | 'expMonth') =>
      rows.reduce((n, r) => n + r[k] * (r._id ? (prices.get(r._id.toHexString()) ?? 0) : 0), 0);
    const v: SubscriberSummary = {
      asOf: now.toISOString(),
      total: sum('total'),
      active: sum('activeAll') - sum('expired'),
      suspended: sum('suspended'),
      disabled: sum('disabled'),
      expired: sum('expired'),
      expiredThisMonth: sum('expMonth'),
      expiringToday: sum('today'),
      expiringTomorrow: sum('tomorrow'),
      expiring7d: sum('d7'),
      renewPaise: {
        today: value('today'),
        tomorrow: value('tomorrow'),
        next7d: value('d7'),
        expiredThisMonth: value('expMonth'),
      },
    };
    if (this.summaryCache.size > 1000) this.summaryCache.clear();
    this.summaryCache.set(key, { at: Date.now(), v });
    return v;
  }

  /** Active prepaid customers whose validity runs out soon, soonest first, with the total. */
  async expiring(ctx: AuthContext, q: z.output<typeof expiringQuery>) {
    const now = new Date();
    const f: Filter<SubscriberDoc> = {
      status: 'active',
      billingType: 'prepaid',
      expiresAt: { $gt: now, $lte: new Date(now.getTime() + q.days * 86_400_000) },
    };
    if (q.window) {
      const b = istBounds(now);
      f.expiresAt =
        q.window === 'today'
          ? { $gt: now, $lt: b.tomorrow }
          : q.window === 'tomorrow'
            ? { $gte: b.tomorrow, $lt: b.dayAfter }
            : { $gt: now, $lte: new Date(now.getTime() + 7 * DAY_MS) };
    }
    const [docs, total] = await Promise.all([
      this.col(ctx)
        .find(f, { sort: { expiresAt: 1, _id: 1 }, limit: q.limit })
        .toArray(),
      this.col(ctx).countDocuments(f),
    ]);
    const refs = await this.refs(ctx, docs);
    return { total, items: docs.map((d) => toView(d, refs)) };
  }

  get = async (ctx: AuthContext, id: ObjectId) => this.view(ctx, await this.find(ctx, id));

  async create(ctx: AuthContext, b: z.output<typeof createBody>) {
    if (!ctx.tenantId)
      throw new AppError(400, 'VALIDATION_FAILED', 'Subscribers belong to an ISP; sign in as its staff');
    if (b.planId) await this.assertPlan(ctx, b.planId, b.billingType);
    const owner = await this.owner(ctx, b.resellerId);
    const tenant = await this.mongo.db
      .collection<TenantDoc>('tenants')
      .findOne({ _id: ctx.tenantId }, { projection: { stateCode: 1 } });
    const plain = b.pppoePassword ?? newPassword();
    try {
      const doc = await insertSubscriber(
        this.mongo.client,
        this.mongo.db,
        this.crypto,
        {
          tenantId: ctx.tenantId,
          actor: ctx.userId.toHexString(),
          ...owner,
        },
        toNewSubscriber(b, plain, tenant?.stateCode),
      );
      noteChange({ after: doc, entityId: doc._id });
      return this.view(ctx, doc, b.pppoePassword ? undefined : plain);
    } catch (e) {
      if ((e as { code?: number }).code === 11000) duplicate(e);
      throw e;
    }
  }

  /** Applies a change in one transaction with its outbox row and the CoA it implies. */
  private async apply(
    ctx: AuthContext,
    cur: SubscriberDoc,
    set: Record<string, unknown>,
    unset: Record<string, ''>,
    forceCoa?: OutboxDoc['coa'],
  ) {
    set.updatedAt = new Date();
    set.updatedBy = ctx.userId.toHexString();
    set.syncStatus = 'pending';
    try {
      return await this.outbox.tx(async (session) => {
        const u = await this.col(ctx).findOneAndUpdate(
          { _id: cur._id, version: cur.version },
          { $set: set, $inc: { version: 1 }, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
          { returnDocument: 'after', session },
        );
        if (!u) throw conflict('The subscriber was changed at the same time. Reload and try again.');
        noteChange({ before: cur, after: u, entityId: u._id });
        await this.outbox.enqueue(session, u.tenantId, 'subscriber', u._id, forceCoa ?? coaFor(cur, u));
        return u;
      });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) duplicate(e);
      throw e;
    }
  }

  async update(ctx: AuthContext, id: ObjectId, b: z.output<typeof updateBody>) {
    const cur = await this.find(ctx, id);
    const billingType = b.billingType ?? cur.billingType;
    const planId = b.planId === null ? undefined : (b.planId ?? cur.planId);
    if (planId && (b.planId || b.billingType)) await this.assertPlan(ctx, planId, billingType);

    const set: Record<string, unknown> = {};
    const unset: Record<string, ''> = {};
    for (const k of [
      'name',
      'phone',
      'billingType',
      'planId',
      'expiresAt',
      'altPhone',
      'email',
      'gstin',
      'notes',
    ] as const) {
      if (b[k] === null) unset[k] = '';
      else if (b[k] !== undefined) set[k] = b[k];
    }
    if (b.address)
      set.address = { ...compact(b.address), stateCode: b.address.stateCode ?? cur.address.stateCode };
    if (b.tags) set.tags = [...new Set(b.tags)];
    if (b.network) {
      for (const [k, v] of Object.entries(b.network)) {
        if (v === null) unset[`network.${k}`] = '';
        else if (v !== undefined) set[`network.${k}`] = v;
      }
    }
    if (b.pppoePassword) set.pppoePassword = this.crypto.encrypt(b.pppoePassword, pwAad(id));
    if (b.resellerId !== undefined && String(b.resellerId) !== String(cur.resellerId)) {
      if (b.resellerId === null && ctx.scope.kind === 'branch') {
        throw forbidden('A reseller cannot make a direct ISP customer');
      }
      Object.assign(set, await this.owner(ctx, b.resellerId));
    }
    if (b.name || b.phone || b.altPhone !== undefined) {
      set.search = searchTokens({
        name: b.name ?? cur.name,
        username: cur.username,
        phone: b.phone ?? cur.phone,
        altPhone: b.altPhone === null ? undefined : (b.altPhone ?? cur.altPhone),
        customerNo: cur.customerNo,
      });
    }
    return this.view(ctx, await this.apply(ctx, cur, set, unset));
  }

  async setStatus(ctx: AuthContext, id: ObjectId, status: 'active' | 'suspended', reason?: string) {
    const cur = await this.find(ctx, id);
    if (cur.status === status) return this.view(ctx, cur);
    const set: Record<string, unknown> = { status };
    const unset: Record<string, ''> = {};
    if (status === 'suspended') set.suspendReason = reason ?? 'manual';
    else unset.suspendReason = '';
    return this.view(ctx, await this.apply(ctx, cur, set, unset));
  }

  async remove(ctx: AuthContext, id: ObjectId) {
    const cur = await this.find(ctx, id);
    await this.apply(
      ctx,
      cur,
      {
        status: 'deleted',
        deletedAt: new Date(),
        ...(cur.username ? { deletedUsername: cur.username } : {}),
      },
      { username: '', 'network.staticIp': '' },
    );
  }

  async kick(ctx: AuthContext, id: ObjectId) {
    const cur = await this.find(ctx, id);
    await this.outbox.tx((session) =>
      this.outbox.enqueue(session, cur.tenantId, 'subscriber', cur._id, {
        action: 'disconnect',
        reason: 'kick',
      }),
    );
  }

  async revealPassword(ctx: AuthContext, id: ObjectId) {
    const s = await this.find(ctx, id);
    noteChange({ after: { username: s.username }, entityId: id });
    return { pppoePassword: this.crypto.decrypt(s.pppoePassword, pwAad(s._id)) };
  }

  async coaLog(ctx: AuthContext, id: ObjectId) {
    const s = await this.find(ctx, id);
    const rows = await this.mongo.db
      .collection<CoaLogDoc>('coa_log')
      .find({ tenantId: s.tenantId, subscriberId: s._id }, { sort: { createdAt: -1 }, limit: 50 })
      .toArray();
    return rows.map((r) => ({
      type: r.type,
      result: r.result,
      reason: r.trigger.type,
      nasIp: r.nasIp,
      errorCause: r.errorCause ?? null,
      latencyMs: r.latencyMs ?? null,
      at: r.createdAt.toISOString(),
    }));
  }
}

type Id = { id: ObjectId };

@Controller('subscribers')
export class SubscribersController {
  constructor(@Inject(SubscribersService) private readonly subs: SubscribersService) {}

  @Get()
  @Endpoint({
    summary: 'Find subscribers (name, username, phone or customer number prefix)',
    tags: ['subscribers'],
    permission: 'subscribers.read',
    query: listQuery,
    response: page(subscriberView),
  })
  list(@Ctx() ctx: AuthContext, @Query() q: z.output<typeof listQuery>) {
    return this.subs.list(ctx, q);
  }

  @Get('summary')
  @Endpoint({
    summary: 'Status and renewal counts (IST days) with what renewing each group is worth; cached ~60 s',
    tags: ['subscribers'],
    permission: 'subscribers.read',
    response: summaryView,
  })
  summary(@Ctx() ctx: AuthContext) {
    return this.subs.summary(ctx);
  }

  @Get('expiring')
  @Endpoint({
    summary: 'Active prepaid subscribers whose validity ends within N days (default 7), soonest first',
    tags: ['subscribers'],
    permission: 'subscribers.read',
    query: expiringQuery,
    response: z.object({ total: z.number(), items: z.array(subscriberView) }),
  })
  expiring(@Ctx() ctx: AuthContext, @Query() q: z.output<typeof expiringQuery>) {
    return this.subs.expiring(ctx, q);
  }

  @Post()
  @Endpoint({
    summary: 'Create a subscriber (PPPoE password returned once if generated)',
    tags: ['subscribers'],
    audit: 'subscriber.create',
    permission: 'subscribers.write',
    body: createBody,
    response: subscriberView,
  })
  create(@Ctx() ctx: AuthContext, @Body() b: z.output<typeof createBody>) {
    return this.subs.create(ctx, b);
  }

  @Get(':id')
  @Endpoint({
    access: 'subscriber',
    summary: 'One subscriber',
    tags: ['subscribers'],
    permission: 'subscribers.read',
    params: idParams,
    response: subscriberView,
  })
  get(@Ctx() ctx: AuthContext, @Param() p: Id) {
    return this.subs.get(ctx, p.id);
  }

  @Patch(':id')
  @Endpoint({
    summary: 'Edit a subscriber; Radius and an online session follow (CoA or reconnect)',
    tags: ['subscribers'],
    audit: 'subscriber.update',
    permission: 'subscribers.write',
    params: idParams,
    body: updateBody,
    response: subscriberView,
  })
  update(@Ctx() ctx: AuthContext, @Param() p: Id, @Body() b: z.output<typeof updateBody>) {
    return this.subs.update(ctx, p.id, b);
  }

  @Post(':id/suspend')
  @HttpCode(200)
  @Endpoint({
    summary: 'Suspend (disconnects the session; logins are refused)',
    tags: ['subscribers'],
    audit: 'subscriber.suspend',
    permission: 'subscribers.write',
    params: idParams,
    body: z.object({ reason: z.string().trim().min(1).max(60).optional() }),
    response: subscriberView,
  })
  suspend(@Ctx() ctx: AuthContext, @Param() p: Id, @Body() b: { reason?: string }) {
    return this.subs.setStatus(ctx, p.id, 'suspended', b.reason);
  }

  @Post(':id/activate')
  @HttpCode(200)
  @Endpoint({
    summary: 'Lift a suspension',
    tags: ['subscribers'],
    audit: 'subscriber.activate',
    permission: 'subscribers.write',
    params: idParams,
    response: subscriberView,
  })
  activate(@Ctx() ctx: AuthContext, @Param() p: Id) {
    return this.subs.setStatus(ctx, p.id, 'active');
  }

  @Delete(':id')
  @Endpoint({
    summary: 'Delete (disconnects; username and static IP become free; history kept)',
    tags: ['subscribers'],
    audit: 'subscriber.delete',
    permission: 'subscribers.delete',
    params: idParams,
    response: okResponse,
  })
  async remove(@Ctx() ctx: AuthContext, @Param() p: Id) {
    await this.subs.remove(ctx, p.id);
    return { ok: true as const };
  }

  @Post(':id/kick')
  @HttpCode(200)
  @Endpoint({
    summary: 'Disconnect the live session',
    tags: ['subscribers'],
    audit: 'subscriber.kick',
    permission: 'subscribers.kick',
    params: idParams,
    response: okResponse,
  })
  async kick(@Ctx() ctx: AuthContext, @Param() p: Id) {
    await this.subs.kick(ctx, p.id);
    return { ok: true as const };
  }

  @Get(':id/password')
  @Endpoint({
    access: 'subscriber',
    summary: 'Show the PPPoE password',
    tags: ['subscribers'],
    audit: 'subscriber.password_reveal',
    permission: 'subscribers.password.reveal',
    params: idParams,
    response: z.object({ pppoePassword: z.string() }),
  })
  password(@Ctx() ctx: AuthContext, @Param() p: Id) {
    return this.subs.revealPassword(ctx, p.id);
  }

  @Get(':id/coa-log')
  @Endpoint({
    access: 'subscriber',
    summary: 'Recent CoA / disconnect results',
    tags: ['subscribers'],
    permission: 'subscribers.read',
    params: idParams,
    response: z.array(coaLogView),
  })
  coaLog(@Ctx() ctx: AuthContext, @Param() p: Id) {
    return this.subs.coaLog(ctx, p.id);
  }
}
