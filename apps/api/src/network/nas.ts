import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { Body, Controller, Delete, Get, Inject, Injectable, Param, Patch, Post, Query } from '@nestjs/common';
import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import { FieldCrypto } from '@isp/shared';
import { ScopedDb, type MongoHandle, type NasDeviceDoc } from '@isp/db-mongo';
import type { AuthContext } from '../auth/context.js';
import { AppError, conflict, notFound } from '../errors.js';
import { Ctx, Endpoint } from '../http/endpoint.js';
import { compact, idParams, okResponse, page, pageOf, pageQuery } from '../http/schemas.js';
import { MONGO } from '../infra/infra.module.js';
import { Outbox } from '../sync/outbox.js';

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
  routerOsVersion: z.enum(['6', '7']),
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
  updatedAt: z.string(),
  /** Present only in the response that created or rotated it. */
  radiusSecret: z.string().optional(),
});

const toView = (n: NasDeviceDoc, revealed?: string): z.output<typeof nasView> => ({
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
  updatedAt: n.updatedAt.toISOString(),
  ...(revealed ? { radiusSecret: revealed } : {}),
});

const newSecret = () => randomBytes(18).toString('base64url');
const aad = (id: ObjectId) => `nas.secret:${id.toHexString()}`;
const ipTaken = () => conflict('Another router already uses this IP address');

@Injectable()
export class NasService {
  constructor(
    @Inject(MONGO) private readonly mongo: MongoHandle,
    @Inject(Outbox) private readonly outbox: Outbox,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
  ) {}

  private col(ctx: AuthContext) {
    return new ScopedDb(this.mongo.db, ctx.scope).collection<NasDeviceDoc>('nas_devices');
  }

  private async find(ctx: AuthContext, id: ObjectId) {
    const n = await this.col(ctx).findOne({ _id: id, status: { $ne: 'deleted' } });
    if (!n) throw notFound('Router');
    return n;
  }

  /** IP is unique across all tenants (FreeRADIUS identifies the ISP by it), so check without tenant scope. */
  private async assertIpFree(ip: string, except?: ObjectId) {
    const other = await this.mongo.db
      .collection<NasDeviceDoc>('nas_devices')
      .findOne({ ip, ...(except ? { _id: { $ne: except } } : {}) }, { projection: { _id: 1 } });
    if (other) throw ipTaken();
  }

  async list(ctx: AuthContext, q: z.output<typeof listQuery>) {
    const f: Filter<NasDeviceDoc> = { status: q.status ?? { $ne: 'deleted' } };
    if (q.cursor) f._id = { $lt: new ObjectId(q.cursor) };
    if (q.q) {
      const re = new RegExp(`^${q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
      f.$or = [{ name: re }, { ip: re }, { 'location.popName': re }];
    }
    const docs = await this.col(ctx)
      .find(f, { sort: { _id: -1 }, limit: q.limit + 1 })
      .toArray();
    return pageOf(docs, q.limit, (d) => toView(d));
  }

  get = async (ctx: AuthContext, id: ObjectId) => toView(await this.find(ctx, id));

  async create(ctx: AuthContext, b: z.output<typeof createBody>) {
    if (!ctx.tenantId)
      throw new AppError(400, 'VALIDATION_FAILED', 'Routers belong to an ISP; sign in as its staff');
    await this.assertIpFree(b.ip);
    const now = new Date();
    const actor = ctx.userId.toHexString();
    const _id = new ObjectId();
    const plain = b.radiusSecret ?? newSecret();
    const doc: NasDeviceDoc = {
      _id,
      tenantId: ctx.tenantId,
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
        await this.col(ctx).insertOne(doc, { session });
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
    return toView(doc, b.radiusSecret ? undefined : plain);
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
      const u = await this.col(ctx).findOneAndUpdate(
        { _id: id, status: { $ne: 'deleted' } },
        { $set: set, $inc: { version: 1 }, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
        { returnDocument: 'after', session },
      );
      if (!u) throw notFound('Router');
      await this.outbox.enqueue(session, u.tenantId, 'nas', id);
      return u;
    });
    return toView(updated, b.rotateSecret ? plain : undefined);
  }

  async remove(ctx: AuthContext, id: ObjectId) {
    const current = await this.find(ctx, id);
    await this.outbox.tx(async (session) => {
      const r = await this.col(ctx).updateOne(
        { _id: id, status: { $ne: 'deleted' } },
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
      await this.outbox.enqueue(session, current.tenantId, 'nas', id);
    });
  }

  async revealSecret(ctx: AuthContext, id: ObjectId) {
    const n = await this.find(ctx, id);
    return { radiusSecret: this.crypto.decrypt(n.radiusSecret, aad(n._id)) };
  }
}

type Id = { id: ObjectId };

@Controller('nas')
export class NasController {
  constructor(@Inject(NasService) private readonly nas: NasService) {}

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
    summary: 'Add a router; FreeRADIUS serves it within ~30 s (secret returned once if generated)',
    tags: ['nas'],
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
    summary: 'Show the RADIUS secret (for router setup)',
    tags: ['nas'],
    permission: 'nas.write',
    params: idParams,
    response: z.object({ radiusSecret: z.string() }),
  })
  secret(@Ctx() ctx: AuthContext, @Param() p: Id) {
    return this.nas.revealSecret(ctx, p.id);
  }
}
