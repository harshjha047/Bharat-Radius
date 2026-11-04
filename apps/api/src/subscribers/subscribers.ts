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
  type SubscriberDoc,
  type TenantDoc,
} from '@isp/db-mongo';
import type { AuthContext } from '../auth/context.js';
import { AppError, conflict, notFound } from '../errors.js';
import { Ctx, Endpoint } from '../http/endpoint.js';
import {
  compact,
  email,
  idParams,
  objectId,
  okResponse,
  page,
  pageOf,
  pageQuery,
  phone,
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
const mac = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase().replace(/[-.]/g, ':'))
  .transform((s) => (/^[0-9A-F]{12}$/.test(s) ? s.match(/../g)!.join(':') : s))
  .pipe(z.string().regex(/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/, 'must be a MAC address'));
const staticIp = z
  .string()
  .trim()
  .refine((s) => isIPv4(s), 'must be an IPv4 address');
const address = z.object({
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(80),
  district: z.string().trim().max(80).optional(),
  state: z.string().trim().min(1).max(80),
  stateCode: z
    .string()
    .regex(/^\d{2}$/)
    .optional(),
  pincode: z.string().regex(/^\d{6}$/),
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
  gstin: z
    .string()
    .regex(/^\d{2}[0-9A-Z]{13}$/)
    .optional(),
  billingType: z.enum(['prepaid', 'postpaid']).default('prepaid'),
  planId: objectId.optional(),
  expiresAt: z.coerce.date().optional(),
  network: network.optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(20).default([]),
  notes: z.string().max(2000).optional(),
});
const updateBody = z
  .object({
    pppoePassword: pppoePassword.optional(),
    name: z.string().trim().min(1).max(120).optional(),
    phone: phone.optional(),
    altPhone: phone.nullable().optional(),
    email: email.nullable().optional(),
    address: address.optional(),
    gstin: z
      .string()
      .regex(/^\d{2}[0-9A-Z]{13}$/)
      .nullable()
      .optional(),
    billingType: z.enum(['prepaid', 'postpaid']).optional(),
    planId: objectId.nullable().optional(),
    expiresAt: z.coerce.date().nullable().optional(),
    network: network.optional(),
    tags: z.array(z.string().trim().min(1).max(30)).max(20).optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'nothing to change');
const listQuery = pageQuery.extend({
  q: z.string().trim().min(1).max(64).optional(),
  status: z.enum(['active', 'suspended', 'disabled', 'expired']).optional(),
  planId: z
    .string()
    .regex(/^[0-9a-f]{24}$/)
    .optional(),
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
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Present only in the response that created the subscriber with a generated password. */
  pppoePassword: z.string().optional(),
});

const toView = (s: SubscriberDoc, revealed?: string): z.output<typeof subscriberView> => ({
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
  createdAt: s.createdAt.toISOString(),
  updatedAt: s.updatedAt.toISOString(),
  ...(revealed ? { pppoePassword: revealed } : {}),
});

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
  ) {}

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
    if (q.status === 'expired') Object.assign(f, { status: 'active', expiresAt: { $lte: now } });
    else if (q.status) f.status = q.status;
    if (q.planId) f.planId = new ObjectId(q.planId);
    if (q.cursor) f._id = { $lt: new ObjectId(q.cursor) };
    if (q.q) {
      const term = q.q.toLowerCase().replace(/^\+?91(?=\d{10}$)/, '');
      f.search = { $regex: `^${escapeRegex(term)}` };
    }
    const docs = await this.col(ctx)
      .find(f, { sort: { _id: -1 }, limit: q.limit + 1 })
      .toArray();
    return pageOf(docs, q.limit, (d) => toView(d));
  }

  get = async (ctx: AuthContext, id: ObjectId) => toView(await this.find(ctx, id));

  async create(ctx: AuthContext, b: z.output<typeof createBody>) {
    if (!ctx.tenantId)
      throw new AppError(400, 'VALIDATION_FAILED', 'Subscribers belong to an ISP; sign in as its staff');
    if (b.planId) await this.assertPlan(ctx, b.planId, b.billingType);
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
          resellerId: ctx.resellerId ?? null,
          ancestors: ctx.resellerId ? [ctx.resellerId] : [],
        },
        toNewSubscriber(b, plain, tenant?.stateCode),
      );
      return toView(doc, b.pppoePassword ? undefined : plain);
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
    if (b.name || b.phone || b.altPhone !== undefined) {
      set.search = searchTokens({
        name: b.name ?? cur.name,
        username: cur.username,
        phone: b.phone ?? cur.phone,
        altPhone: b.altPhone === null ? undefined : (b.altPhone ?? cur.altPhone),
        customerNo: cur.customerNo,
      });
    }
    return toView(await this.apply(ctx, cur, set, unset));
  }

  async setStatus(ctx: AuthContext, id: ObjectId, status: 'active' | 'suspended', reason?: string) {
    const cur = await this.find(ctx, id);
    if (cur.status === status) return toView(cur);
    const set: Record<string, unknown> = { status };
    const unset: Record<string, ''> = {};
    if (status === 'suspended') set.suspendReason = reason ?? 'manual';
    else unset.suspendReason = '';
    return toView(await this.apply(ctx, cur, set, unset));
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

  @Post()
  @Endpoint({
    summary: 'Create a subscriber (PPPoE password returned once if generated)',
    tags: ['subscribers'],
    permission: 'subscribers.write',
    body: createBody,
    response: subscriberView,
  })
  create(@Ctx() ctx: AuthContext, @Body() b: z.output<typeof createBody>) {
    return this.subs.create(ctx, b);
  }

  @Get(':id')
  @Endpoint({
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
    summary: 'Edit a subscriber; RADIUS and an online session follow (CoA or reconnect)',
    tags: ['subscribers'],
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
    permission: 'subscribers.write',
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
    summary: 'Show the PPPoE password',
    tags: ['subscribers'],
    permission: 'subscribers.password.reveal',
    params: idParams,
    response: z.object({ pppoePassword: z.string() }),
  })
  password(@Ctx() ctx: AuthContext, @Param() p: Id) {
    return this.subs.revealPassword(ctx, p.id);
  }

  @Get(':id/coa-log')
  @Endpoint({
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
