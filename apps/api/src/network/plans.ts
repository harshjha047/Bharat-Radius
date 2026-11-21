import { Body, Controller, Get, Inject, Injectable, Param, Patch, Post, Query } from '@nestjs/common';
import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import { burstProblem, mikrotikRateLimit } from '@isp/shared';
import { ScopedDb, type MongoHandle, type PlanDoc } from '@isp/db-mongo';
import { noteChange } from '../audit/audit.js';
import type { AuthContext } from '../auth/context.js';
import { AppError, notFound } from '../errors.js';
import { Ctx, Endpoint } from '../http/endpoint.js';
import { idParams, page, pageOf, pageQuery } from '../http/schemas.js';
import { MONGO } from '../infra/infra.module.js';
import { Outbox } from '../sync/outbox.js';

/** Set by radius_reply() from plan and subscriber fields; a plan attribute must not override them. */
const RESERVED_ATTRIBUTES = new Set(
  [
    'Mikrotik-Rate-Limit',
    'Mikrotik-Address-List',
    'Framed-IP-Address',
    'Framed-Pool',
    'Session-Timeout',
    'Acct-Interim-Interval',
    'Reply-Message',
    'Cleartext-Password',
    'Simultaneous-Use',
    'Auth-Type',
  ].map((a) => a.toLowerCase()),
);

const kbps = z.number().int().min(8).max(100_000_000);
const speeds = z.object({ downloadKbps: kbps, uploadKbps: kbps });
const burst = speeds.extend({
  thresholdDownloadKbps: kbps,
  thresholdUploadKbps: kbps,
  timeSecs: z.number().int().min(1).max(3600),
});
const attribute = z.object({
  attribute: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9-]{1,63}$/, 'must be a Radius attribute name (letters, digits, -)')
    .refine((a) => !RESERVED_ATTRIBUTES.has(a.toLowerCase()), 'is set by the plan itself'),
  op: z.enum([':=', '=', '+=']).default(':='),
  value: z.string().min(1).max(253),
});
const fields = {
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().max(500),
  burst,
  dataCapBytes: z.number().int().min(1_000_000).max(Number.MAX_SAFE_INTEGER),
  fup: speeds,
  fupCycle: z.enum(['billing_cycle', 'calendar_month']),
  validityDays: z.number().int().min(1).max(3660),
  ipPool: z.string().regex(/^[\w.-]{1,64}$/, 'must be 1–64 letters, digits, . _ -'),
  simUse: z.number().int().min(1).max(10),
  billingTypes: z
    .array(z.enum(['prepaid', 'postpaid']))
    .min(1)
    .max(2),
  pricePaise: z.number().int().min(0).max(2_000_000_000),
  gstRatePercent: z.union([z.literal(0), z.literal(5), z.literal(12), z.literal(18), z.literal(28)]),
  hsnSac: z.string().regex(/^\d{4,8}$/, 'must be a 4–8 digit HSN/SAC code'),
  extraAttributes: z.array(attribute).max(20),
};
export const createBody = speeds.extend({
  name: fields.name,
  description: fields.description.optional(),
  burst: burst.optional(),
  dataCapBytes: fields.dataCapBytes.optional(),
  fup: fields.fup.optional(),
  fupCycle: fields.fupCycle.optional(),
  validityDays: fields.validityDays.default(30),
  ipPool: fields.ipPool.optional(),
  simUse: fields.simUse.default(1),
  billingTypes: fields.billingTypes.default(['prepaid']),
  pricePaise: fields.pricePaise,
  gstRatePercent: fields.gstRatePercent.default(18),
  hsnSac: fields.hsnSac.default('998422'),
  extraAttributes: fields.extraAttributes.default([]),
});
// Explicit optional fields, not createBody.partial(): zod 4 would apply the defaults on every PATCH.
export const updateBody = z
  .object({
    name: fields.name.optional(),
    description: fields.description.nullable().optional(),
    downloadKbps: kbps.optional(),
    uploadKbps: kbps.optional(),
    burst: burst.nullable().optional(),
    dataCapBytes: fields.dataCapBytes.nullable().optional(),
    fup: fields.fup.nullable().optional(),
    fupCycle: fields.fupCycle.nullable().optional(),
    validityDays: fields.validityDays.optional(),
    ipPool: fields.ipPool.nullable().optional(),
    simUse: fields.simUse.optional(),
    billingTypes: fields.billingTypes.optional(),
    pricePaise: fields.pricePaise.optional(),
    gstRatePercent: fields.gstRatePercent.optional(),
    hsnSac: fields.hsnSac.optional(),
    extraAttributes: fields.extraAttributes.optional(),
    status: z.enum(['active', 'archived']).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'nothing to change');
const listQuery = pageQuery.extend({
  status: z.enum(['active', 'archived']).optional(),
  q: z.string().trim().max(64).optional(),
});

const planView = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  downloadKbps: z.number(),
  uploadKbps: z.number(),
  burst: burst.nullable(),
  rateLimit: z.string(),
  dataCapBytes: z.number().nullable(),
  fup: speeds.nullable(),
  fupRate: z.string().nullable(),
  fupCycle: fields.fupCycle.nullable(),
  validityDays: z.number(),
  ipPool: z.string().nullable(),
  simUse: z.number(),
  billingTypes: z.array(z.enum(['prepaid', 'postpaid'])),
  pricePaise: z.number(),
  gstRatePercent: z.number(),
  hsnSac: z.string(),
  extraAttributes: z.array(z.object({ attribute: z.string(), op: z.string(), value: z.string() })),
  status: z.enum(['active', 'archived']),
  radiusId: z.number().nullable(),
  updatedAt: z.string(),
});

const toView = (p: PlanDoc): z.output<typeof planView> => ({
  id: p._id.toHexString(),
  name: p.name,
  description: p.description ?? null,
  downloadKbps: p.downloadKbps,
  uploadKbps: p.uploadKbps,
  burst: p.burst ?? null,
  rateLimit: p.rateLimit,
  dataCapBytes: p.dataCapBytes ?? null,
  fup: p.fup ?? null,
  fupRate: p.fupRate ?? null,
  fupCycle: p.fupCycle ?? null,
  validityDays: p.validityDays,
  ipPool: p.ipPool ?? null,
  simUse: p.simUse,
  billingTypes: p.billingTypes,
  pricePaise: p.pricePaise,
  gstRatePercent: p.gstRatePercent,
  hsnSac: p.hsnSac,
  extraAttributes: p.extraAttributes,
  status: p.status,
  radiusId: p.radiusId ?? null,
  updatedAt: p.updatedAt.toISOString(),
});

export interface PlanShape {
  downloadKbps: number;
  uploadKbps: number;
  burst?: PlanDoc['burst'] | undefined;
  dataCapBytes?: number | undefined;
  fup?: PlanDoc['fup'] | undefined;
}

/** Cross-field rules, applied to the merged result of create or update. Returns the derived Radius strings. */
export function derive(p: PlanShape): { rateLimit: string; fupRate?: string } {
  const bad = (m: string) => new AppError(400, 'VALIDATION_FAILED', m);
  if (p.burst) {
    const problem = burstProblem(p, p.burst);
    if (problem) throw bad(problem);
  }
  if (p.dataCapBytes && !p.fup) throw bad('A data cap needs the speed after the cap (fup)');
  if (p.fup && (p.fup.downloadKbps >= p.downloadKbps || p.fup.uploadKbps > p.uploadKbps)) {
    throw bad('The speed after the cap must be below the plan speed');
  }
  return {
    rateLimit: mikrotikRateLimit(p, p.burst),
    ...(p.fup ? { fupRate: mikrotikRateLimit(p.fup) } : {}),
  };
}

@Injectable()
export class PlansService {
  constructor(
    @Inject(MONGO) private readonly mongo: MongoHandle,
    @Inject(Outbox) private readonly outbox: Outbox,
  ) {}

  private col(ctx: AuthContext) {
    return new ScopedDb(this.mongo.db, ctx.scope).collection<PlanDoc>('plans');
  }

  async list(ctx: AuthContext, q: z.output<typeof listQuery>) {
    const f: Filter<PlanDoc> = {};
    if (q.status) f.status = q.status;
    if (q.cursor) f._id = { $lt: new ObjectId(q.cursor) };
    if (q.q) f.name = { $regex: `^${q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, $options: 'i' };
    const docs = await this.col(ctx)
      .find(f, { sort: { _id: -1 }, limit: q.limit + 1 })
      .toArray();
    return pageOf(docs, q.limit, toView);
  }

  async get(ctx: AuthContext, id: ObjectId) {
    const p = await this.col(ctx).findOne({ _id: id });
    if (!p) throw notFound('Plan');
    return p;
  }

  async create(ctx: AuthContext, b: z.output<typeof createBody>) {
    if (!ctx.tenantId)
      throw new AppError(400, 'VALIDATION_FAILED', 'Plans belong to an ISP; sign in as its staff');
    const now = new Date();
    const actor = ctx.userId.toHexString();
    const doc: PlanDoc = {
      _id: new ObjectId(),
      tenantId: ctx.tenantId,
      name: b.name,
      ...(b.description ? { description: b.description } : {}),
      downloadKbps: b.downloadKbps,
      uploadKbps: b.uploadKbps,
      ...(b.burst ? { burst: b.burst } : {}),
      ...(b.dataCapBytes ? { dataCapBytes: b.dataCapBytes } : {}),
      ...(b.fup ? { fup: b.fup, fupCycle: b.fupCycle ?? 'billing_cycle' } : {}),
      ...derive(b),
      validityDays: b.validityDays,
      ...(b.ipPool ? { ipPool: b.ipPool } : {}),
      simUse: b.simUse,
      billingTypes: [...new Set(b.billingTypes)],
      pricePaise: b.pricePaise,
      gstRatePercent: b.gstRatePercent,
      hsnSac: b.hsnSac,
      extraAttributes: b.extraAttributes,
      status: 'active',
      version: 0,
      createdAt: now,
      updatedAt: now,
      createdBy: actor,
      updatedBy: actor,
    };
    await this.outbox.tx(async (session) => {
      await this.col(ctx).insertOne(doc, { session });
      await this.outbox.enqueue(session, ctx.tenantId!, 'plan', doc._id);
    });
    noteChange({ after: doc, entityId: doc._id });
    return toView(doc);
  }

  async update(ctx: AuthContext, id: ObjectId, b: z.output<typeof updateBody>) {
    const cur = await this.get(ctx, id);
    const pick = <K extends 'burst' | 'dataCapBytes' | 'fup'>(k: K) =>
      b[k] === null ? undefined : (b[k] ?? cur[k]);
    const merged: PlanShape = {
      downloadKbps: b.downloadKbps ?? cur.downloadKbps,
      uploadKbps: b.uploadKbps ?? cur.uploadKbps,
      burst: pick('burst') as PlanShape['burst'],
      dataCapBytes: pick('dataCapBytes') as number | undefined,
      fup: pick('fup') as PlanShape['fup'],
    };
    const derived = derive(merged);

    const set: Record<string, unknown> = {
      updatedAt: new Date(),
      updatedBy: ctx.userId.toHexString(),
      ...derived,
    };
    const unset: Record<string, ''> = {};
    for (const [k, v] of Object.entries(b)) {
      if (v === null) unset[k] = '';
      else if (v !== undefined) set[k] = k === 'billingTypes' ? [...new Set(v as string[])] : v;
    }
    if (!derived.fupRate) unset.fupRate = '';
    if (b.fup === null) unset.fupCycle = '';
    else if (b.fup && !cur.fupCycle && !b.fupCycle) set.fupCycle = 'billing_cycle';

    const updated = await this.outbox.tx(async (session) => {
      const u = await this.col(ctx).findOneAndUpdate(
        { _id: id },
        { $set: set, $inc: { version: 1 }, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
        { returnDocument: 'after', session },
      );
      if (!u) throw notFound('Plan');
      noteChange({ before: cur, after: u, entityId: id });
      // New speeds reach users already online by CoA (worker sends the rate Radius would now reply with).
      const speedChanged = u.rateLimit !== cur.rateLimit || u.fupRate !== cur.fupRate;
      await this.outbox.enqueue(
        session,
        u.tenantId,
        'plan',
        id,
        speedChanged ? { action: 'update', reason: 'plan_change' } : undefined,
      );
      return u;
    });
    return toView(updated);
  }
}

@Controller('plans')
export class PlansController {
  constructor(@Inject(PlansService) private readonly plans: PlansService) {}

  @Get()
  @Endpoint({
    summary: 'Plans',
    tags: ['plans'],
    permission: 'plans.read',
    query: listQuery,
    response: page(planView),
  })
  list(@Ctx() ctx: AuthContext, @Query() q: z.output<typeof listQuery>) {
    return this.plans.list(ctx, q);
  }

  @Post()
  @Endpoint({
    summary: 'Create a plan',
    tags: ['plans'],
    audit: 'plan.create',
    permission: 'plans.write',
    body: createBody,
    response: planView,
  })
  create(@Ctx() ctx: AuthContext, @Body() b: z.output<typeof createBody>) {
    return this.plans.create(ctx, b);
  }

  @Get(':id')
  @Endpoint({
    summary: 'One plan',
    tags: ['plans'],
    permission: 'plans.read',
    params: idParams,
    response: planView,
  })
  async get(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }) {
    return toView(await this.plans.get(ctx, p.id));
  }

  @Patch(':id')
  @Endpoint({
    summary: 'Edit or archive a plan (online users on it get the new speed by CoA)',
    tags: ['plans'],
    audit: 'plan.update',
    permission: 'plans.write',
    params: idParams,
    body: updateBody,
    response: planView,
  })
  update(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }, @Body() b: z.output<typeof updateBody>) {
    return this.plans.update(ctx, p.id, b);
  }
}
