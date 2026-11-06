import { Body, Controller, Get, Inject, Injectable, Param, Patch, Post, Query } from '@nestjs/common';
import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import { ScopedDb, type MongoHandle, type TenantDoc } from '@isp/db-mongo';
import { PLATFORM_SLUG } from '../auth/auth.service.js';
import { noteChange } from '../audit/audit.js';
import type { AuthContext } from '../auth/context.js';
import { SessionUsers } from '../auth/session-users.js';
import { AppError, notFound } from '../errors.js';
import { Ctx, Endpoint } from '../http/endpoint.js';
import {
  compact,
  email,
  gstin,
  idParams,
  page,
  pageOf,
  pageQuery,
  phone,
  pincode,
  stateCode,
} from '../http/schemas.js';
import { MONGO } from '../infra/infra.module.js';
import { Outbox } from '../sync/outbox.js';

const rate = z.string().regex(/^\d+[kM]?\/\d+[kM]?$/, 'must look like 256k/256k');
const address = z.object({
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(80),
  district: z.string().trim().max(80).optional(),
  state: z.string().trim().min(1).max(80),
  pincode: pincode,
});
const radius = z.object({
  expiredRate: rate,
  expiredAddressList: z.string().regex(/^[\w-]{1,32}$/, 'must be 1–32 letters, digits, _ -'),
  expiredSessionSecs: z.number().int().min(60).max(86_400),
  interimInterval: z.number().int().min(60).max(3600),
});
const editable = {
  name: z.string().trim().min(1).max(120),
  legalName: z.string().trim().min(1).max(200),
  gstin: gstin.nullable(),
  stateCode: stateCode,
  address,
  contact: z.object({ phone: phone.optional(), email: email.optional() }),
  radius,
};
const ownFields = {
  name: editable.name.optional(),
  legalName: editable.legalName.optional(),
  gstin: editable.gstin.optional(),
  stateCode: editable.stateCode.optional(),
  address: address.optional(),
  contact: editable.contact.optional(),
  radius: radius.partial().optional(),
};
const nonEmpty = (b: object) => Object.keys(b).length > 0;
const ownUpdate = z.object(ownFields).refine(nonEmpty, 'nothing to change');
const domain = z
  .string()
  .toLowerCase()
  .regex(/^(?=.{4,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/, 'must be a host name');
const platformUpdate = z
  .object({
    ...ownFields,
    status: z.enum(['active', 'suspended']).optional(),
    domain: domain.nullable().optional(),
  })
  .refine(nonEmpty, 'nothing to change');
const createBody = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,39}$/, 'must be 2–40 lower-case letters, digits, -')
    .refine((s) => s !== PLATFORM_SLUG, 'reserved'),
  name: editable.name,
  legalName: editable.legalName,
  gstin: editable.gstin.optional(),
  stateCode: editable.stateCode,
  address,
  contact: editable.contact.optional(),
  domain: domain.optional(),
  radius: radius.partial().optional(),
});

const tenantView = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  legalName: z.string(),
  status: z.enum(['active', 'suspended', 'deleted']),
  gstin: z.string().nullable(),
  stateCode: z.string(),
  address: address,
  contact: z.object({ phone: z.string().optional(), email: z.string().optional() }),
  domain: z.string().nullable(),
  radius,
  radiusId: z.number().nullable(),
  updatedAt: z.string(),
});

const toView = (t: TenantDoc & { radiusId?: number }): z.output<typeof tenantView> => ({
  id: t._id.toHexString(),
  slug: t.slug,
  name: t.name,
  legalName: t.legalName,
  status: t.status,
  gstin: t.gstin ?? null,
  stateCode: t.stateCode,
  address: t.address as z.output<typeof address>,
  contact: t.contact ?? {},
  domain: t.branding?.domain ?? null,
  radius: t.radius,
  radiusId: t.radiusId ?? null,
  updatedAt: t.updatedAt.toISOString(),
});

const DEFAULT_RADIUS = {
  expiredRate: '256k/256k',
  expiredAddressList: 'expired',
  expiredSessionSecs: 3600,
  interimInterval: 300,
};

type OwnUpdate = z.output<typeof ownUpdate>;
type PlatformUpdate = z.output<typeof platformUpdate>;

@Injectable()
export class TenantsService {
  constructor(
    @Inject(MONGO) private readonly mongo: MongoHandle,
    @Inject(Outbox) private readonly outbox: Outbox,
    @Inject(SessionUsers) private readonly sessions: SessionUsers,
  ) {}

  private col(ctx: AuthContext) {
    return new ScopedDb(this.mongo.db, ctx.scope).collection<TenantDoc>('tenants');
  }

  async get(ctx: AuthContext, id: ObjectId) {
    const t = await this.col(ctx).findOne({ _id: id, status: { $ne: 'deleted' } });
    if (!t) throw notFound('Tenant');
    return toView(t);
  }

  async list(ctx: AuthContext, q: z.output<typeof pageQuery> & { q?: string | undefined }) {
    const f: Filter<TenantDoc> = { status: { $ne: 'deleted' } };
    if (q.cursor) f._id = { $lt: new ObjectId(q.cursor) };
    if (q.q) f.slug = { $regex: `^${q.q.toLowerCase().replace(/[^a-z0-9-]/g, '')}` };
    const docs = await this.col(ctx)
      .find(f, { sort: { _id: -1 }, limit: q.limit + 1 })
      .toArray();
    return pageOf(docs, q.limit, toView);
  }

  async create(ctx: AuthContext, b: z.output<typeof createBody>) {
    if (b.gstin && b.gstin.slice(0, 2) !== b.stateCode) {
      throw new AppError(400, 'VALIDATION_FAILED', 'GSTIN must start with the state code');
    }
    const now = new Date();
    const actor = ctx.userId.toHexString();
    const doc: TenantDoc = {
      _id: new ObjectId(),
      slug: b.slug,
      name: b.name,
      legalName: b.legalName,
      status: 'active',
      stateCode: b.stateCode,
      ...(b.gstin ? { gstin: b.gstin } : {}),
      address: compact(b.address),
      ...(b.contact ? { contact: compact(b.contact) } : {}),
      ...(b.domain ? { branding: { domain: b.domain } } : {}),
      radius: { ...DEFAULT_RADIUS, ...compact(b.radius ?? {}) },
      version: 0,
      createdAt: now,
      updatedAt: now,
      createdBy: actor,
      updatedBy: actor,
    };
    await this.outbox.tx(async (session) => {
      await this.col(ctx).insertOne(doc, { session });
      await this.outbox.enqueue(session, doc._id, 'tenant', doc._id);
    });
    noteChange({ after: doc, entityId: doc._id, tenantId: doc._id });
    return toView(doc);
  }

  async update(ctx: AuthContext, id: ObjectId, b: OwnUpdate & Partial<PlatformUpdate>) {
    const current = await this.col(ctx).findOne({ _id: id, status: { $ne: 'deleted' } });
    if (!current) throw notFound('Tenant');
    const gstin = b.gstin === null ? undefined : (b.gstin ?? current.gstin);
    if (gstin && gstin.slice(0, 2) !== (b.stateCode ?? current.stateCode)) {
      throw new AppError(400, 'VALIDATION_FAILED', 'GSTIN must start with the state code');
    }
    const set: Record<string, unknown> = { updatedAt: new Date(), updatedBy: ctx.userId.toHexString() };
    const unset: Record<string, ''> = {};
    for (const k of ['name', 'legalName', 'stateCode', 'address', 'contact', 'status'] as const) {
      if (b[k] !== undefined) set[k] = compact(b[k]);
    }
    if (b.gstin === null) unset.gstin = '';
    else if (b.gstin) set.gstin = b.gstin;
    if (b.domain === null) unset['branding.domain'] = '';
    else if (b.domain) set['branding.domain'] = b.domain;
    if (b.radius) for (const [k, v] of Object.entries(compact(b.radius))) set[`radius.${k}`] = v;

    const updated = await this.outbox.tx(async (session) => {
      const u = await this.col(ctx).findOneAndUpdate(
        { _id: id },
        { $set: set, $inc: { version: 1 }, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
        { returnDocument: 'after', session },
      );
      if (!u) throw notFound('Tenant');
      noteChange({ before: current, after: u, entityId: id, tenantId: id });
      if (b.radius || b.status || b.name) await this.outbox.enqueue(session, id, 'tenant', id);
      return u;
    });
    if (b.status) {
      const staff = await this.mongo.db
        .collection('users')
        .find({ tenantId: id }, { projection: { _id: 1 } })
        .toArray();
      for (const s of staff) this.sessions.invalidate(s._id);
    }
    return toView(updated);
  }
}

@Controller()
export class TenantsController {
  constructor(@Inject(TenantsService) private readonly tenants: TenantsService) {}

  @Get('tenant')
  @Endpoint({
    summary: 'Own ISP settings',
    tags: ['tenants'],
    permission: 'tenant.settings',
    response: tenantView,
  })
  own(@Ctx() ctx: AuthContext) {
    if (!ctx.tenantId) throw notFound('Tenant');
    return this.tenants.get(ctx, ctx.tenantId);
  }

  @Patch('tenant')
  @Endpoint({
    summary: 'Edit own ISP settings (RADIUS settings sync to routers)',
    tags: ['tenants'],
    audit: 'tenant.update',
    permission: 'tenant.settings',
    body: ownUpdate,
    response: tenantView,
  })
  updateOwn(@Ctx() ctx: AuthContext, @Body() b: OwnUpdate) {
    if (!ctx.tenantId) throw notFound('Tenant');
    return this.tenants.update(ctx, ctx.tenantId, b);
  }

  @Get('tenants')
  @Endpoint({
    summary: 'All ISPs (super-admin)',
    tags: ['tenants'],
    permission: 'tenant.settings',
    platformOnly: true,
    query: pageQuery.extend({ q: z.string().max(40).optional() }),
    response: page(tenantView),
  })
  list(@Ctx() ctx: AuthContext, @Query() q: z.output<typeof pageQuery> & { q?: string }) {
    return this.tenants.list(ctx, q);
  }

  @Post('tenants')
  @Endpoint({
    summary: 'Create an ISP (super-admin)',
    tags: ['tenants'],
    audit: 'tenant.create',
    permission: 'tenant.settings',
    platformOnly: true,
    body: createBody,
    response: tenantView,
  })
  create(@Ctx() ctx: AuthContext, @Body() b: z.output<typeof createBody>) {
    return this.tenants.create(ctx, b);
  }

  @Get('tenants/:id')
  @Endpoint({
    summary: 'One ISP (super-admin)',
    tags: ['tenants'],
    permission: 'tenant.settings',
    platformOnly: true,
    params: idParams,
    response: tenantView,
  })
  get(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }) {
    return this.tenants.get(ctx, p.id);
  }

  @Patch('tenants/:id')
  @Endpoint({
    summary: 'Edit or suspend an ISP (super-admin)',
    tags: ['tenants'],
    audit: 'tenant.update',
    permission: 'tenant.settings',
    platformOnly: true,
    params: idParams,
    body: platformUpdate,
    response: tenantView,
  })
  update(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }, @Body() b: PlatformUpdate) {
    return this.tenants.update(ctx, p.id, b);
  }
}
