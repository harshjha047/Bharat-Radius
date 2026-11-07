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
import { ObjectId, type ClientSession, type Filter } from 'mongodb';
import { z } from 'zod';
import {
  ScopedDb,
  wallets,
  createResellerWallet,
  type MongoHandle,
  type ResellerDoc,
  type SubscriberDoc,
  type UserDoc,
} from '@isp/db-mongo';
import { noteChange } from '../audit/audit.js';
import type { AuthContext } from '../auth/context.js';
import { SessionUsers } from '../auth/session-users.js';
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
} from '../http/schemas.js';
import { MONGO } from '../infra/infra.module.js';
import { Outbox } from '../sync/outbox.js';

/** Deep enough for any real distribution chain; stops runaway trees and keeps `ancestors` small. */
export const MAX_LEVEL = 10;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const formatCode = (seq: number) => `R-${String(seq).padStart(4, '0')}`;
const chainOf = (r: Pick<ResellerDoc, '_id' | 'ancestors'>) => [...r.ancestors, r._id];

const address = z.object({
  line1: z.string().trim().min(1).max(200).optional(),
  city: z.string().trim().min(1).max(80).optional(),
  district: z.string().trim().max(80).optional(),
  state: z.string().trim().min(1).max(80).optional(),
  pincode: pincode.optional(),
});
const fields = {
  name: z.string().trim().min(1).max(120),
  ownerName: z.string().trim().min(1).max(120),
  creditLimitPaise: z.number().int().min(0).max(2_000_000_000),
};
const createBody = z.object({
  parentId: objectId.nullable().optional(),
  name: fields.name,
  ownerName: fields.ownerName,
  phone: phone.optional(),
  email: email.optional(),
  gstin: gstin.optional(),
  address: address.optional(),
  creditLimitPaise: fields.creditLimitPaise.default(0),
  canCreateSubResellers: z.boolean().default(true),
});
const updateBody = z
  .object({
    name: fields.name.optional(),
    ownerName: fields.ownerName.optional(),
    phone: phone.nullable().optional(),
    email: email.nullable().optional(),
    gstin: gstin.nullable().optional(),
    address: address.nullable().optional(),
    creditLimitPaise: fields.creditLimitPaise.optional(),
    canCreateSubResellers: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'nothing to change');
const moveBody = z.object({ parentId: objectId.nullable() });
const suspendBody = z.object({ reason: z.string().trim().min(1).max(60).optional() });
const listQuery = pageQuery.extend({
  /** A reseller id for its direct children, `none` for the top level. Omit for every reseller in view. */
  parentId: z.union([hexId, z.literal('none')]).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  q: z.string().trim().min(1).max(64).optional(),
});

const ref = z.object({ id: z.string(), code: z.string(), name: z.string() });
const resellerView = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  ownerName: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  gstin: z.string().nullable(),
  address: address.nullable(),
  parentId: z.string().nullable(),
  level: z.number(),
  creditLimitPaise: z.number(),
  canCreateSubResellers: z.boolean(),
  status: z.enum(['active', 'suspended', 'deleted']),
  suspendReason: z.string().nullable(),
  /** Set when a reseller above this one is suspended: the branch is blocked even though this one is active. */
  blockedBy: ref.nullable(),
  counts: z.object({ subResellers: z.number(), directCustomers: z.number(), totalCustomers: z.number() }),
  updatedAt: z.string(),
});
const detailView = resellerView.extend({
  /** Resellers above this one that the caller may see, top first. */
  path: z.array(ref),
  walletId: z.string().nullable(),
});

type Counts = z.output<typeof resellerView>['counts'];
type Ref = z.output<typeof ref>;
const toRef = (r: Pick<ResellerDoc, '_id' | 'code' | 'name'>): Ref => ({
  id: r._id.toHexString(),
  code: r.code,
  name: r.name,
});
const NO_COUNTS: Counts = { subResellers: 0, directCustomers: 0, totalCustomers: 0 };

const toView = (r: ResellerDoc, counts: Counts, blockedBy: Ref | null): z.output<typeof resellerView> => ({
  id: r._id.toHexString(),
  code: r.code,
  name: r.name,
  ownerName: r.ownerName,
  phone: r.phone ?? null,
  email: r.email ?? null,
  gstin: r.gstin ?? null,
  address: r.address ?? null,
  parentId: r.parentId?.toHexString() ?? null,
  level: r.level,
  creditLimitPaise: r.creditLimitPaise,
  canCreateSubResellers: r.canCreateSubResellers,
  status: r.status,
  suspendReason: r.suspendReason ?? null,
  blockedBy,
  counts,
  updatedAt: r.updatedAt.toISOString(),
});

@Injectable()
export class ResellersService {
  constructor(
    @Inject(MONGO) private readonly mongo: MongoHandle,
    @Inject(Outbox) private readonly outbox: Outbox,
    @Inject(SessionUsers) private readonly sessions: SessionUsers,
  ) {}

  private db(ctx: AuthContext) {
    return new ScopedDb(this.mongo.db, ctx.scope);
  }
  private col(ctx: AuthContext) {
    return this.db(ctx).collection<ResellerDoc>('resellers');
  }

  /** Any reseller the caller can see (resellers see themselves and their branch), not deleted. */
  async find(ctx: AuthContext, id: ObjectId, session?: ClientSession): Promise<ResellerDoc> {
    const r = await this.col(ctx).findOne(
      { _id: id, status: { $ne: 'deleted' } },
      session ? { session } : undefined,
    );
    if (!r) throw notFound('Reseller');
    return r;
  }

  /** Staff manage any reseller; a reseller manages only those below it, never itself. */
  private assertCanManage(ctx: AuthContext, r: ResellerDoc): void {
    if (ctx.scope.kind !== 'branch') return;
    const self = ctx.scope.resellerId;
    if (!r.ancestors.some((a) => a.equals(self))) forbiddenSelf();
  }

  private assertStaffOnly(ctx: AuthContext, what: string): void {
    if (ctx.scope.kind === 'branch') throw forbidden(`Only ISP staff can change ${what}`);
  }

  /** First reseller at or above `r` (in `chain` order, top first) that is not active; null when the branch is open. */
  private async firstBlocked(ctx: AuthContext, chain: ObjectId[], session?: ClientSession) {
    if (!chain.length) return null;
    const blocked = await this.col(ctx)
      .find(
        { _id: { $in: chain }, status: { $ne: 'active' } },
        { projection: { code: 1, name: 1 }, ...(session ? { session } : {}) },
      )
      .toArray();
    if (!blocked.length) return null;
    const order = new Map(chain.map((id, i) => [id.toHexString(), i]));
    blocked.sort((a, b) => order.get(a._id.toHexString())! - order.get(b._id.toHexString())!);
    return blocked[0]!;
  }

  /** Reseller a new record may be placed under: visible, open branch, not too deep. */
  async assertOpenParent(ctx: AuthContext, id: ObjectId, session?: ClientSession): Promise<ResellerDoc> {
    const p = await this.find(ctx, id, session);
    const blocked = await this.firstBlocked(ctx, chainOf(p), session);
    if (blocked) throw conflict(`${blocked.name} (${blocked.code}) is suspended`);
    return p;
  }

  /** Counts for a page of resellers in three indexed queries, not one per row. */
  private async counts(ctx: AuthContext, ids: ObjectId[]): Promise<Map<string, Counts>> {
    const out = new Map<string, Counts>(ids.map((id) => [id.toHexString(), { ...NO_COUNTS }]));
    if (!ids.length) return out;
    const subs = this.db(ctx).collection<SubscriberDoc>('subscribers');
    const [children, direct, total] = await Promise.all([
      this.col(ctx)
        .aggregate<{ _id: ObjectId; n: number }>([
          { $match: { parentId: { $in: ids }, status: { $ne: 'deleted' } } },
          { $group: { _id: '$parentId', n: { $sum: 1 } } },
        ])
        .toArray(),
      subs
        .aggregate<{ _id: ObjectId; n: number }>([
          { $match: { resellerId: { $in: ids }, status: { $ne: 'deleted' } } },
          { $group: { _id: '$resellerId', n: { $sum: 1 } } },
        ])
        .toArray(),
      subs
        .aggregate<{ _id: ObjectId; n: number }>([
          { $match: { ancestors: { $in: ids }, status: { $ne: 'deleted' } } },
          { $project: { ancestors: 1 } },
          { $unwind: '$ancestors' },
          { $match: { ancestors: { $in: ids } } },
          { $group: { _id: '$ancestors', n: { $sum: 1 } } },
        ])
        .toArray(),
    ]);
    for (const c of children) out.get(c._id.toHexString())!.subResellers = c.n;
    for (const c of direct) out.get(c._id.toHexString())!.directCustomers = c.n;
    for (const c of total) out.get(c._id.toHexString())!.totalCustomers = c.n;
    return out;
  }

  /** For each reseller, the topmost suspended reseller above it (one query for the whole page). */
  private async blockedAbove(ctx: AuthContext, docs: ResellerDoc[]): Promise<Map<string, Ref>> {
    const above = [...new Set(docs.flatMap((d) => d.ancestors.map(String)))].map((s) => new ObjectId(s));
    const out = new Map<string, Ref>();
    if (!above.length) return out;
    const suspended = new Map(
      (
        await this.col(ctx)
          .find({ _id: { $in: above }, status: 'suspended' }, { projection: { code: 1, name: 1 } })
          .toArray()
      ).map((r) => [r._id.toHexString(), r]),
    );
    if (!suspended.size) return out;
    for (const d of docs) {
      const hit = d.ancestors.find((a) => suspended.has(a.toHexString()));
      if (hit) out.set(d._id.toHexString(), toRef(suspended.get(hit.toHexString())!));
    }
    return out;
  }

  private async views(ctx: AuthContext, docs: ResellerDoc[]) {
    const [counts, blocked] = await Promise.all([
      this.counts(
        ctx,
        docs.map((d) => d._id),
      ),
      this.blockedAbove(ctx, docs),
    ]);
    return (d: ResellerDoc) =>
      toView(d, counts.get(d._id.toHexString()) ?? NO_COUNTS, blocked.get(d._id.toHexString()) ?? null);
  }

  async list(ctx: AuthContext, q: z.output<typeof listQuery>) {
    const f: Filter<ResellerDoc> = { status: q.status ?? { $ne: 'deleted' } };
    if (q.parentId === 'none') f.parentId = null;
    else if (q.parentId) f.parentId = new ObjectId(q.parentId);
    if (q.cursor) f._id = { $lt: new ObjectId(q.cursor) };
    if (q.q) {
      const re = new RegExp(`^${escapeRegex(q.q)}`, 'i');
      f.$or = [{ code: re }, { name: re }, { ownerName: re }];
    }
    const docs = await this.col(ctx)
      .find(f, { sort: { _id: -1 }, limit: q.limit + 1 })
      .toArray();
    const view = await this.views(ctx, docs.slice(0, q.limit));
    return pageOf(docs, q.limit, view);
  }

  async detail(ctx: AuthContext, r: ResellerDoc) {
    const [view, path, wallet] = await Promise.all([
      this.views(ctx, [r]),
      r.ancestors.length
        ? this.col(ctx)
            .find({ _id: { $in: r.ancestors } }, { projection: { code: 1, name: 1 } })
            .toArray()
        : Promise.resolve([]),
      wallets(this.mongo.db).findOne({ ownerId: r._id, tenantId: r.tenantId }, { projection: { _id: 1 } }),
    ]);
    const order = new Map(r.ancestors.map((id, i) => [id.toHexString(), i]));
    path.sort((a, b) => order.get(a._id.toHexString())! - order.get(b._id.toHexString())!);
    return { ...view(r), path: path.map(toRef), walletId: wallet?._id.toHexString() ?? null };
  }

  get = async (ctx: AuthContext, id: ObjectId) => this.detail(ctx, await this.find(ctx, id));

  async create(ctx: AuthContext, b: z.output<typeof createBody>) {
    if (!ctx.tenantId)
      throw new AppError(400, 'VALIDATION_FAILED', 'Resellers belong to an ISP; sign in as its staff');
    const branch = ctx.scope.kind === 'branch' ? ctx.scope : null;
    if (branch) {
      if (b.parentId === null) throw forbidden('A reseller can only add resellers below itself');
      if (b.creditLimitPaise) this.assertStaffOnly(ctx, 'credit limits');
      const self = await this.find(ctx, branch.resellerId);
      if (!self.canCreateSubResellers) throw forbidden('Your account cannot add sub-resellers');
    }
    const parentId = b.parentId ?? branch?.resellerId ?? null;
    const now = new Date();
    const actor = ctx.userId.toHexString();
    const doc = await this.outbox.tx(async (session) => {
      const parent = parentId ? await this.assertOpenParent(ctx, parentId, session) : null;
      const ancestors = parent ? chainOf(parent) : [];
      if (ancestors.length + 1 > MAX_LEVEL) throw tooDeep();
      const seq = await this.mongo.db
        .collection<{ _id: string; seq: number }>('counters')
        .findOneAndUpdate(
          { _id: `resellerCode:${ctx.tenantId!.toHexString()}` },
          { $inc: { seq: 1 } },
          { upsert: true, returnDocument: 'after', includeResultMetadata: false, session },
        );
      const d: ResellerDoc = {
        _id: new ObjectId(),
        tenantId: ctx.tenantId!,
        parentId,
        ancestors,
        level: ancestors.length + 1,
        code: formatCode(seq!.seq),
        name: b.name,
        ownerName: b.ownerName,
        ...(b.phone ? { phone: b.phone } : {}),
        ...(b.email ? { email: b.email } : {}),
        ...(b.gstin ? { gstin: b.gstin } : {}),
        ...(b.address && Object.keys(compact(b.address)).length ? { address: compact(b.address) } : {}),
        creditLimitPaise: b.creditLimitPaise,
        canCreateSubResellers: b.canCreateSubResellers,
        status: 'active',
        version: 0,
        createdAt: now,
        updatedAt: now,
        createdBy: actor,
        updatedBy: actor,
      };
      await this.col(ctx).insertOne(d, { session });
      await createResellerWallet(this.mongo.db, d, session);
      return d;
    });
    noteChange({ after: doc, entityId: doc._id });
    return this.detail(ctx, doc);
  }

  async update(ctx: AuthContext, id: ObjectId, b: z.output<typeof updateBody>) {
    const cur = await this.find(ctx, id);
    this.assertCanManage(ctx, cur);
    if (b.creditLimitPaise !== undefined && b.creditLimitPaise !== cur.creditLimitPaise) {
      this.assertStaffOnly(ctx, 'credit limits');
    }
    const set: Record<string, unknown> = { updatedAt: new Date(), updatedBy: ctx.userId.toHexString() };
    const unset: Record<string, ''> = {};
    for (const [k, v] of Object.entries(b)) {
      if (v === null) unset[k] = '';
      else if (v !== undefined) set[k] = k === 'address' ? compact(v as object) : v;
    }
    const u = await this.col(ctx).findOneAndUpdate(
      { _id: id, status: { $ne: 'deleted' } },
      { $set: set, $inc: { version: 1 }, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { returnDocument: 'after' },
    );
    if (!u) throw notFound('Reseller');
    if (b.creditLimitPaise !== undefined) {
      await wallets(this.mongo.db).updateOne(
        { ownerId: id, tenantId: u.tenantId },
        { $set: { creditLimitPaise: b.creditLimitPaise, updatedAt: new Date() } },
      );
    }
    noteChange({ before: cur, after: u, entityId: id });
    return this.detail(ctx, u);
  }

  /** Suspend or reactivate. Sign-ins of everyone in the branch follow at once on this replica. */
  async setStatus(ctx: AuthContext, id: ObjectId, status: 'active' | 'suspended', reason?: string) {
    const cur = await this.find(ctx, id);
    this.assertCanManage(ctx, cur);
    const u = await this.col(ctx).findOneAndUpdate(
      { _id: id, status: { $ne: 'deleted' } },
      {
        $set: {
          status,
          updatedAt: new Date(),
          updatedBy: ctx.userId.toHexString(),
          ...(status === 'suspended' && reason ? { suspendReason: reason } : {}),
        },
        $inc: { version: 1 },
        ...(status === 'active' || !reason ? { $unset: { suspendReason: '' as const } } : {}),
      },
      { returnDocument: 'after' },
    );
    if (!u) throw notFound('Reseller');
    noteChange({ before: cur, after: u, entityId: id });
    await this.invalidateBranchSessions(ctx, id);
    return this.detail(ctx, u);
  }

  /**
   * Moves a reseller and everything below it under another parent (or to the top level) in one transaction:
   * parentId/ancestors/level of every reseller in the branch and ancestors of their customers.
   */
  async move(ctx: AuthContext, id: ObjectId, parentId: ObjectId | null) {
    const cur = await this.find(ctx, id);
    this.assertCanManage(ctx, cur);
    if (parentId === null && ctx.scope.kind === 'branch')
      throw forbidden('Only ISP staff can move a reseller to the top level');
    if (String(parentId) === String(cur.parentId)) return this.detail(ctx, cur);
    if (parentId?.equals(id)) throw badMove('A reseller cannot be placed under itself');

    const moved = await this.outbox.tx(async (session) => {
      const target = await this.find(ctx, id, session);
      const parent = parentId ? await this.assertOpenParent(ctx, parentId, session) : null;
      if (parent?.ancestors.some((a) => a.equals(id))) {
        throw badMove('A reseller cannot be placed under one of its own sub-resellers');
      }
      const prefix = parent ? chainOf(parent) : [];
      const keep = target.ancestors.length;
      const below = await this.col(ctx)
        .find({ ancestors: id }, { projection: { ancestors: 1 }, session })
        .toArray();
      const branch = [target, ...below];
      const deepest = Math.max(...branch.map((r) => r.ancestors.length - keep));
      if (prefix.length + 1 + deepest > MAX_LEVEL) throw tooDeep();

      const now = new Date();
      const actor = ctx.userId.toHexString();
      const resellers = this.col(ctx);
      const subs = this.db(ctx).collection<SubscriberDoc>('subscribers');
      for (const r of branch) {
        const ancestors = [...prefix, ...r.ancestors.slice(keep)];
        const isTarget = r._id.equals(id);
        await resellers.updateOne(
          { _id: r._id },
          {
            $set: {
              ancestors,
              level: ancestors.length + 1,
              updatedAt: now,
              updatedBy: actor,
              ...(isTarget ? { parentId } : {}),
            },
            $inc: { version: 1 },
          },
          { session },
        );
        await subs.updateMany(
          { resellerId: r._id },
          { $set: { ancestors: [...ancestors, r._id], updatedAt: now, updatedBy: actor } },
          { session },
        );
        const parentWallet = isTarget
          ? await wallets(this.mongo.db).findOne({ ownerId: parentId ?? target.tenantId }, { session })
          : null;
        await wallets(this.mongo.db).updateOne(
          { ownerId: r._id, tenantId: target.tenantId },
          {
            $set: {
              walletType: `L${ancestors.length + 1}`,
              updatedAt: now,
              ...(parentWallet ? { parentWalletId: parentWallet._id } : {}),
            },
          },
          { session },
        );
      }
      return (await resellers.findOne({ _id: id }, { session }))!;
    });
    noteChange({ before: cur, after: moved, entityId: id });
    await this.invalidateBranchSessions(ctx, id);
    return this.detail(ctx, moved);
  }

  /** Soft delete; only an empty reseller (no sub-resellers, no customers). Its sign-ins are disabled. */
  async remove(ctx: AuthContext, id: ObjectId) {
    const cur = await this.find(ctx, id);
    this.assertCanManage(ctx, cur);
    const [children, customers] = await Promise.all([
      this.col(ctx).countDocuments({ parentId: id, status: { $ne: 'deleted' } }, { limit: 1 }),
      this.db(ctx)
        .collection<SubscriberDoc>('subscribers')
        .countDocuments({ resellerId: id, status: { $ne: 'deleted' } }, { limit: 1 }),
    ]);
    if (children) throw conflict('Move or delete its sub-resellers first');
    if (customers) throw conflict('Move or delete its customers first');
    const w = await wallets(this.mongo.db).findOne({ ownerId: id, tenantId: cur.tenantId });
    if (w && w.balancePaise !== 0)
      throw conflict('Its wallet is not empty: move the balance back to the parent first');
    const now = new Date();
    const actor = ctx.userId.toHexString();
    await this.outbox.tx(async (session) => {
      const u = await this.col(ctx).findOneAndUpdate(
        { _id: id, status: { $ne: 'deleted' } },
        {
          $set: { status: 'deleted', deletedAt: now, updatedAt: now, updatedBy: actor },
          $inc: { version: 1 },
        },
        { returnDocument: 'after', session },
      );
      if (!u) throw notFound('Reseller');
      noteChange({ before: cur, after: u, entityId: id });
      await wallets(this.mongo.db).updateOne(
        { ownerId: id, tenantId: cur.tenantId },
        { $set: { isActive: false, updatedAt: now } },
        { session },
      );
      await this.mongo.db
        .collection<UserDoc>('users')
        .updateMany(
          { tenantId: cur.tenantId, resellerId: id },
          { $set: { status: 'disabled', updatedAt: now, updatedBy: actor }, $inc: { tokenVersion: 1 } },
          { session },
        );
    });
    await this.invalidateBranchSessions(ctx, id);
  }

  private async invalidateBranchSessions(ctx: AuthContext, id: ObjectId) {
    const tenantId = ctx.tenantId;
    if (!tenantId) return;
    const branch = await this.mongo.db
      .collection<ResellerDoc>('resellers')
      .find({ tenantId, $or: [{ _id: id }, { ancestors: id }] }, { projection: { _id: 1 } })
      .map((r) => r._id)
      .toArray();
    const users = await this.mongo.db
      .collection<UserDoc>('users')
      .find({ tenantId, resellerId: { $in: branch } }, { projection: { _id: 1 } })
      .toArray();
    for (const u of users) this.sessions.invalidate(u._id);
  }
}

function forbiddenSelf(): never {
  throw forbidden('A reseller can only change resellers below it');
}
const badMove = (m: string) => new AppError(400, 'VALIDATION_FAILED', m);
const tooDeep = () =>
  new AppError(400, 'VALIDATION_FAILED', `A reseller tree can be at most ${MAX_LEVEL} levels deep`);

@Controller('resellers')
export class ResellersController {
  constructor(@Inject(ResellersService) private readonly resellers: ResellersService) {}

  @Get()
  @Endpoint({
    summary: 'Resellers (a reseller sees itself and its branch)',
    tags: ['resellers'],
    permission: 'resellers.read',
    query: listQuery,
    response: page(resellerView),
  })
  list(@Ctx() ctx: AuthContext, @Query() q: z.output<typeof listQuery>) {
    return this.resellers.list(ctx, q);
  }

  @Post()
  @Endpoint({
    summary: 'Add a reseller (top level, or under a reseller)',
    tags: ['resellers'],
    audit: 'reseller.create',
    permission: 'resellers.write',
    body: createBody,
    response: detailView,
  })
  create(@Ctx() ctx: AuthContext, @Body() b: z.output<typeof createBody>) {
    return this.resellers.create(ctx, b);
  }

  @Get(':id')
  @Endpoint({
    summary: 'One reseller with counts and the path above it',
    tags: ['resellers'],
    permission: 'resellers.read',
    params: idParams,
    response: detailView,
  })
  get(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }) {
    return this.resellers.get(ctx, p.id);
  }

  @Patch(':id')
  @Endpoint({
    summary: 'Edit a reseller (credit limit: ISP staff only)',
    tags: ['resellers'],
    audit: 'reseller.update',
    permission: 'resellers.write',
    params: idParams,
    body: updateBody,
    response: detailView,
  })
  update(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }, @Body() b: z.output<typeof updateBody>) {
    return this.resellers.update(ctx, p.id, b);
  }

  @Post(':id/suspend')
  @HttpCode(200)
  @Endpoint({
    summary: 'Suspend: the branch cannot sign in or recharge; customers stay online',
    tags: ['resellers'],
    audit: 'reseller.suspend',
    permission: 'resellers.write',
    params: idParams,
    body: suspendBody,
    response: detailView,
  })
  suspend(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }, @Body() b: z.output<typeof suspendBody>) {
    return this.resellers.setStatus(ctx, p.id, 'suspended', b.reason);
  }

  @Post(':id/activate')
  @HttpCode(200)
  @Endpoint({
    summary: 'Lift a suspension',
    tags: ['resellers'],
    audit: 'reseller.activate',
    permission: 'resellers.write',
    params: idParams,
    response: detailView,
  })
  activate(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }) {
    return this.resellers.setStatus(ctx, p.id, 'active');
  }

  @Post(':id/move')
  @HttpCode(200)
  @Endpoint({
    summary: 'Move a reseller and its whole branch under another parent (null = top level)',
    tags: ['resellers'],
    audit: 'reseller.move',
    permission: 'resellers.write',
    params: idParams,
    body: moveBody,
    response: detailView,
  })
  move(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }, @Body() b: z.output<typeof moveBody>) {
    return this.resellers.move(ctx, p.id, b.parentId);
  }

  @Delete(':id')
  @Endpoint({
    summary: 'Delete an empty reseller (no sub-resellers or customers); its sign-ins are disabled',
    tags: ['resellers'],
    audit: 'reseller.delete',
    permission: 'resellers.write',
    params: idParams,
    response: okResponse,
  })
  async remove(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }) {
    await this.resellers.remove(ctx, p.id);
    return { ok: true as const };
  }
}
