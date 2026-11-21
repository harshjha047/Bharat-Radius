import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { Body, Controller, Delete, Get, Inject, Injectable, Param, Patch, Post, Query } from '@nestjs/common';
import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import { FieldCrypto } from '@isp/shared';
import { ScopedDb, type MongoHandle, type NasDeviceDoc, type ResellerDoc } from '@isp/db-mongo';
import { noteChange } from '../audit/audit.js';
import type { AuthContext } from '../auth/context.js';
import { AppError, conflict, forbidden, notFound } from '../errors.js';
import { Ctx, Endpoint } from '../http/endpoint.js';
import { compact, hexId, idParams, okResponse, page, pageOf, pageQuery } from '../http/schemas.js';
import { CONFIG, type Config } from '../config.js';
import { MONGO } from '../infra/infra.module.js';
import { SessionsService, type BranchNet } from '../sessions/sessions.js';
import { Outbox } from '../sync/outbox.js';

/** RouterOS major version; spreadsheets and staff write "v6", "6", "6.49.20" or "RouterOS 7" interchangeably. */
const routerOsVersion = z.preprocess(
  (v) =>
    typeof v === 'string' ? (/^\s*(?:routeros\s*)?v?\s*([67])(?:\.[\d.]*)?\s*$/i.exec(v)?.[1] ?? v) : v,
  z.enum(['6', '7']),
);
/** No quotes, spaces or backslashes: the secret is pasted into RouterOS scripts. */
const secret = z.string().regex(/^[A-Za-z0-9!#%+,.:=@_^~-]{16,64}$/, '16-64 characters, no spaces or quotes');
const ip = z
  .string()
  .trim()
  .refine((s) => isIP(s) !== 0, 'must be an IP address')
  .transform((s) => s.toLowerCase());
const location = z.object({
  popName: z.string().trim().max(80).optional(),
  address: z.string().trim().max(200).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});
const fields = {
  name: z.string().trim().min(1).max(64),
  ip,
  coaPort: z.number().int().min(1).max(65535),
  routerOsVersion,
  location,
  description: z.string().trim().max(500),
};
const createBody = z.object({
  name: fields.name,
  ip: fields.ip,
  radiusSecret: secret.optional(),
  coaPort: fields.coaPort.default(3799),
  routerOsVersion: fields.routerOsVersion.optional(),
  location: location.optional(),
  description: fields.description.optional(),
});
const updateBody = z
  .object({
    name: fields.name.optional(),
    ip: fields.ip.optional(),
    coaPort: fields.coaPort.optional(),
    routerOsVersion: fields.routerOsVersion.optional(),
    location: location.optional(),
    description: fields.description.nullable().optional(),
    status: z.enum(['active', 'disabled']).optional(),
    radiusSecret: secret.optional(),
    rotateSecret: z.literal(true).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'nothing to change')
  .refine((b) => !(b.radiusSecret && b.rotateSecret), 'give a secret or ask to rotate, not both');
const listQuery = pageQuery.extend({
  q: z.string().trim().max(64).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  /** Staff: routers added by this reseller (or its sub-resellers). */
  resellerId: hexId.optional(),
});

const nasView = z.object({
  id: z.string(),
  name: z.string(),
  ip: z.string(),
  coaPort: z.number(),
  routerOsVersion: z.enum(['6', '7']).nullable(),
  location: location,
  description: z.string().nullable(),
  status: z.enum(['active', 'disabled']),
  radiusId: z.number().nullable(),
  lastSeenAt: z.string().nullable(),
  /** RouterOS API login set up and on (live graphs, ping, live speed). */
  apiEnabled: z.boolean(),
  monitorPorts: z.array(z.object({ interface: z.string(), label: z.string().nullable() })),
  /** Reseller that added the router; null = the ISP's own. */
  owner: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  /** The caller may edit, disable, delete, see the secret and use live tools (resellers: own routers only). */
  canManage: z.boolean(),
  updatedAt: z.string(),
  /** Present only in the response that created or rotated it. */
  radiusSecret: z.string().optional(),
});

type Owner = { id: string; code: string; name: string };
type ViewOpts = { revealed?: string; owner?: Owner | null; canManage?: boolean };

const toView = (n: NasDeviceDoc, o: ViewOpts = {}): z.output<typeof nasView> => ({
  id: n._id.toHexString(),
  name: n.name,
  ip: n.ip ?? n.deletedIp ?? '',
  coaPort: n.coaPort,
  routerOsVersion: n.routerOsVersion ?? null,
  location: n.location ?? {},
  description: n.description ?? null,
  status: n.status === 'disabled' ? 'disabled' : 'active',
  radiusId: n.radiusId ?? null,
  lastSeenAt: n.lastSeenAt?.toISOString() ?? null,
  apiEnabled: n.api?.enabled === true,
  monitorPorts: (n.monitorPorts ?? []).map((p) => ({ interface: p.interface, label: p.label ?? null })),
  owner: o.owner ?? null,
  canManage: o.canManage ?? true,
  updatedAt: n.updatedAt.toISOString(),
  ...(o.revealed ? { radiusSecret: o.revealed } : {}),
});

const newSecret = () => randomBytes(18).toString('base64url');
const aad = (id: ObjectId) => `nas.secret:${id.toHexString()}`;
const ipTaken = () => conflict('Another router already uses this IP address');

export type NasNeed = 'see' | 'manage';

@Injectable()
export class NasService {
  constructor(
    @Inject(MONGO) private readonly mongo: MongoHandle,
    @Inject(Outbox) private readonly outbox: Outbox,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
    @Inject(SessionsService) private readonly sessions: SessionsService,
  ) {}

  /** Staff: tenant-scoped. Resellers: raw collection, filtered by `branchFilter` (policy denies ScopedDb). */
  private col(ctx: AuthContext) {
    return new ScopedDb(this.mongo.db, ctx.scope).collection<NasDeviceDoc>('nas_devices');
  }
  raw() {
    return this.mongo.db.collection<NasDeviceDoc>('nas_devices');
  }

  private static owns(b: BranchNet, n: NasDeviceDoc) {
    return !!(n.resellerId?.equals(b.resellerId) || n.ancestors?.some((a) => a.equals(b.resellerId)));
  }

  /** Routers a reseller may see: added in its branch, or used by its customers in the last 30 days. */
  private static branchFilter(b: BranchNet, need: NasNeed): Filter<NasDeviceDoc> {
    const own: Filter<NasDeviceDoc>[] = [{ resellerId: b.resellerId }, { ancestors: b.resellerId }];
    return {
      tenantId: b.tenantId,
      $or: need === 'manage' ? own : [...own, { ip: { $in: b.visibleIps } }],
    };
  }

  /** One router the caller may see (or manage); 404 otherwise, so other resellers' routers stay invisible. */
  async doc(ctx: AuthContext, id: ObjectId, need: NasNeed = 'see'): Promise<NasDeviceDoc> {
    const b = await this.sessions.branchNet(ctx);
    if (!b) {
      const n = await this.col(ctx).findOne({ _id: id, status: { $ne: 'deleted' } });
      if (!n) throw notFound('Router');
      return n;
    }
    const n = await this.raw().findOne({
      $and: [{ _id: id, status: { $ne: 'deleted' } }, NasService.branchFilter(b, 'see')],
    });
    if (!n) throw notFound('Router');
    if (need === 'manage' && !NasService.owns(b, n)) {
      throw forbidden('This router belongs to the ISP; ask them to change it');
    }
    return n;
  }

  private find = (ctx: AuthContext, id: ObjectId) => this.doc(ctx, id, 'manage');

  /** Reseller names for a page of routers: one query, no N+1. */
  private async owners(docs: NasDeviceDoc[]): Promise<Map<string, Owner>> {
    const ids = [...new Set(docs.flatMap((d) => (d.resellerId ? [d.resellerId.toHexString()] : [])))];
    if (!ids.length) return new Map();
    const rs = await this.mongo.db
      .collection<ResellerDoc>('resellers')
      .find({ _id: { $in: ids.map((i) => new ObjectId(i)) } }, { projection: { code: 1, name: 1 } })
      .toArray();
    return new Map(
      rs.map((r) => [r._id.toHexString(), { id: r._id.toHexString(), code: r.code, name: r.name }]),
    );
  }

  private async views(docs: NasDeviceDoc[], b: BranchNet | null) {
    const owners = await this.owners(docs);
    return (d: NasDeviceDoc, revealed?: string) =>
      toView(d, {
        ...(revealed ? { revealed } : {}),
        owner: d.resellerId ? (owners.get(d.resellerId.toHexString()) ?? null) : null,
        canManage: !b || NasService.owns(b, d),
      });
  }

  private async one(ctx: AuthContext, d: NasDeviceDoc, revealed?: string) {
    const b = await this.sessions.branchNet(ctx);
    return (await this.views([d], b))(d, revealed);
  }

  /** IP is unique across all tenants (the Radius engine identifies the ISP by it), so check without tenant scope. */
  private async assertIpFree(ip: string, except?: ObjectId) {
    const other = await this.raw().findOne(
      { ip, ...(except ? { _id: { $ne: except } } : {}) },
      { projection: { _id: 1 } },
    );
    if (other) throw ipTaken();
  }

  async list(ctx: AuthContext, q: z.output<typeof listQuery>) {
    const b = await this.sessions.branchNet(ctx);
    const f: Filter<NasDeviceDoc> = { status: q.status ?? { $ne: 'deleted' } };
    if (q.cursor) f._id = { $lt: new ObjectId(q.cursor) };
    if (q.q) {
      const re = new RegExp(`^${q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
      f.$or = [{ name: re }, { ip: re }, { 'location.popName': re }];
    }
    if (q.resellerId && !b) {
      const r = new ObjectId(q.resellerId);
      f.$and = [{ $or: [{ resellerId: r }, { ancestors: r }] }];
    }
    const opts = { sort: { _id: -1 as const }, limit: q.limit + 1 };
    const docs = b
      ? await this.raw()
          .find({ $and: [f, NasService.branchFilter(b, 'see')] }, opts)
          .toArray()
      : await this.col(ctx).find(f, opts).toArray();
    const view = await this.views(docs.slice(0, q.limit), b);
    return pageOf(docs, q.limit, (d) => view(d));
  }

  get = async (ctx: AuthContext, id: ObjectId) => this.one(ctx, await this.doc(ctx, id, 'see'));

  async create(ctx: AuthContext, b: z.output<typeof createBody>) {
    if (!ctx.tenantId)
      throw new AppError(400, 'VALIDATION_FAILED', 'Routers belong to an ISP; sign in as its staff');
    await this.assertIpFree(b.ip);
    // A reseller's router belongs to its branch: it and everyone above it see it, siblings do not.
    let owner: Pick<NasDeviceDoc, 'resellerId' | 'ancestors'> = {};
    if (ctx.scope.kind === 'branch') {
      const r = await this.mongo.db
        .collection<ResellerDoc>('resellers')
        .findOne(
          { _id: ctx.scope.resellerId, tenantId: ctx.scope.tenantId },
          { projection: { ancestors: 1 } },
        );
      if (!r) throw notFound('Reseller');
      owner = { resellerId: r._id, ancestors: r.ancestors };
    }
    const now = new Date();
    const actor = ctx.userId.toHexString();
    const _id = new ObjectId();
    const plain = b.radiusSecret ?? newSecret();
    const doc: NasDeviceDoc = {
      _id,
      tenantId: ctx.tenantId,
      ...owner,
      name: b.name,
      ip: b.ip,
      radiusSecret: this.crypto.encrypt(plain, aad(_id)),
      coaPort: b.coaPort,
      ...(b.routerOsVersion ? { routerOsVersion: b.routerOsVersion } : {}),
      ...(b.location ? { location: compact(b.location) } : {}),
      ...(b.description ? { description: b.description } : {}),
      status: 'active',
      version: 0,
      createdAt: now,
      updatedAt: now,
      createdBy: actor,
      updatedBy: actor,
    };
    try {
      await this.outbox.tx(async (session) => {
        // Resellers insert on the raw collection (ScopedDb denies nas_devices); tenant and owner are set above.
        await (ctx.scope.kind === 'branch' ? this.raw() : this.col(ctx)).insertOne(doc, { session });
        await this.outbox.enqueue(session, ctx.tenantId!, 'nas', _id);
      });
    } catch (e) {
      if (
        (e as { code?: number; keyPattern?: object }).code === 11000 &&
        'ip' in ((e as { keyPattern?: object }).keyPattern ?? {})
      ) {
        throw ipTaken();
      }
      throw e;
    }
    noteChange({ after: doc, entityId: _id });
    this.sessions.forgetBranches();
    return this.one(ctx, doc, b.radiusSecret ? undefined : plain);
  }

  async update(ctx: AuthContext, id: ObjectId, b: z.output<typeof updateBody>) {
    const current = await this.find(ctx, id);
    if (b.ip && b.ip !== current.ip) await this.assertIpFree(b.ip, id);
    const set: Partial<NasDeviceDoc> = { updatedAt: new Date(), updatedBy: ctx.userId.toHexString() };
    const unset: Record<string, ''> = {};
    for (const k of ['name', 'ip', 'coaPort', 'routerOsVersion', 'location', 'status'] as const) {
      if (b[k] !== undefined) (set as Record<string, unknown>)[k] = compact(b[k]);
    }
    if (b.description === null) unset.description = '';
    else if (b.description !== undefined) set.description = b.description;
    const plain = b.rotateSecret ? newSecret() : b.radiusSecret;
    if (plain) set.radiusSecret = this.crypto.encrypt(plain, aad(id));

    const updated = await this.outbox.tx(async (session) => {
      const u = await this.raw().findOneAndUpdate(
        { _id: id, tenantId: current.tenantId, status: { $ne: 'deleted' } },
        { $set: set, $inc: { version: 1 }, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
        { returnDocument: 'after', session },
      );
      if (!u) throw notFound('Router');
      await this.outbox.enqueue(session, u.tenantId, 'nas', id);
      noteChange({ before: current, after: u, entityId: id });
      return u;
    });
    if (b.ip) this.sessions.forgetBranches();
    return this.one(ctx, updated, b.rotateSecret ? plain : undefined);
  }

  async remove(ctx: AuthContext, id: ObjectId) {
    const current = await this.find(ctx, id);
    await this.outbox.tx(async (session) => {
      const r = await this.raw().updateOne(
        { _id: id, tenantId: current.tenantId, status: { $ne: 'deleted' } },
        {
          $set: {
            status: 'deleted',
            deletedAt: new Date(),
            updatedAt: new Date(),
            updatedBy: ctx.userId.toHexString(),
            ...(current.ip ? { deletedIp: current.ip } : {}),
          },
          $unset: { ip: '' },
          $inc: { version: 1 },
        },
        { session },
      );
      if (!r.matchedCount) throw notFound('Router');
      noteChange({ before: current, after: { ...current, status: 'deleted' }, entityId: id });
      await this.outbox.enqueue(session, current.tenantId, 'nas', id);
    });
    this.sessions.forgetBranches();
  }

  async revealSecret(ctx: AuthContext, id: ObjectId) {
    const n = await this.find(ctx, id);
    noteChange({ after: { name: n.name, ip: n.ip }, entityId: id });
    return { radiusSecret: this.crypto.decrypt(n.radiusSecret, aad(n._id)) };
  }
}

type Id = { id: ObjectId };

const radiusTarget = z.object({
  instance: z.enum(['production', 'staging']),
  host: z.string().nullable(),
  authPort: z.number(),
  acctPort: z.number(),
});

@Controller('nas')
export class NasController {
  constructor(
    @Inject(NasService) private readonly nas: NasService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  @Get('radius-target')
  @Endpoint({
    summary: 'Radius host and ports routers must send to (this panel feeds that instance)',
    tags: ['nas'],
    permission: 'nas.read',
    response: radiusTarget,
  })
  target() {
    return this.config.radiusTarget;
  }

  @Get()
  @Endpoint({
    summary: 'Routers (NAS)',
    tags: ['nas'],
    permission: 'nas.read',
    query: listQuery,
    response: page(nasView),
  })
  list(@Ctx() ctx: AuthContext, @Query() q: z.output<typeof listQuery>) {
    return this.nas.list(ctx, q);
  }

  @Post()
  @Endpoint({
    summary: 'Add a router; the Radius engine serves it within ~30 s (secret returned once if generated)',
    tags: ['nas'],
    audit: 'nas.create',
    permission: 'nas.write',
    body: createBody,
    response: nasView,
  })
  create(@Ctx() ctx: AuthContext, @Body() b: z.output<typeof createBody>) {
    return this.nas.create(ctx, b);
  }

  @Get(':id')
  @Endpoint({
    summary: 'One router',
    tags: ['nas'],
    permission: 'nas.read',
    params: idParams,
    response: nasView,
  })
  get(@Ctx() ctx: AuthContext, @Param() p: Id) {
    return this.nas.get(ctx, p.id);
  }

  @Patch(':id')
  @Endpoint({
    summary: 'Edit, disable or rotate the secret of a router',
    tags: ['nas'],
    audit: 'nas.update',
    permission: 'nas.write',
    params: idParams,
    body: updateBody,
    response: nasView,
  })
  update(@Ctx() ctx: AuthContext, @Param() p: Id, @Body() b: z.output<typeof updateBody>) {
    return this.nas.update(ctx, p.id, b);
  }

  @Delete(':id')
  @Endpoint({
    summary: 'Remove a router',
    tags: ['nas'],
    audit: 'nas.delete',
    permission: 'nas.write',
    params: idParams,
    response: okResponse,
  })
  async remove(@Ctx() ctx: AuthContext, @Param() p: Id) {
    await this.nas.remove(ctx, p.id);
    return { ok: true as const };
  }

  @Get(':id/secret')
  @Endpoint({
    summary: 'Show the Radius secret (for router setup)',
    tags: ['nas'],
    audit: 'nas.secret_reveal',
    permission: 'nas.write',
    params: idParams,
    response: z.object({ radiusSecret: z.string() }),
  })
  secret(@Ctx() ctx: AuthContext, @Param() p: Id) {
    return this.nas.revealSecret(ctx, p.id);
  }
}
