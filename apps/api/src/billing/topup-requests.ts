import { Body, Controller, Get, HttpCode, Inject, Injectable, Param, Post, Query } from '@nestjs/common';
import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import {
  ensureMasterWallet,
  topupRequests,
  transfer,
  wallets,
  type MongoHandle,
  type ResellerDoc,
  type TopupRequestDoc,
  type WalletDoc,
} from '@isp/db-mongo';
import { noteChange } from '../audit/audit.js';
import type { AuthContext } from '../auth/context.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { Ctx, Endpoint } from '../http/endpoint.js';
import { idParams, page, pageOf, pageQuery } from '../http/schemas.js';
import { MONGO } from '../infra/infra.module.js';
import { Outbox } from '../sync/outbox.js';
import { requireTenant, selfReseller } from './common.js';

const MAX_PENDING = 5;
const paise = z.number().int().min(1).max(10_000_000_000);
const status = z.enum(['pending', 'approved', 'rejected', 'cancelled']);

const createBody = z.object({
  amountPaise: paise,
  /** How the reseller paid (or will pay) its parent. */
  paidVia: z.enum(['cash', 'upi', 'bank']).optional(),
  reference: z.string().trim().max(60).optional(),
  note: z.string().trim().max(200).optional(),
});
const approveBody = z.object({
  /** Defaults to the amount asked for. */
  amountPaise: paise.optional(),
  note: z.string().trim().max(200).optional(),
});
const rejectBody = z.object({ note: z.string().trim().min(3).max(200) });
const listQuery = pageQuery.extend({
  /** incoming: asked of the caller's wallet (to approve). outgoing: the caller's own requests (resellers). */
  box: z.enum(['incoming', 'outgoing']).default('incoming'),
  status: status.optional(),
});

const requestView = z.object({
  id: z.string(),
  reseller: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  walletId: z.string(),
  /** Requester's balance now. */
  balancePaise: z.number(),
  amountPaise: z.number(),
  approvedPaise: z.number().nullable(),
  paidVia: z.enum(['cash', 'upi', 'bank']).nullable(),
  reference: z.string().nullable(),
  note: z.string().nullable(),
  status,
  decisionNote: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  /** The caller may approve or reject (it owns the wallet asked). */
  canDecide: z.boolean(),
  /** The caller may withdraw it (its own pending request). */
  canCancel: z.boolean(),
});
const listView = page(requestView).extend({ pending: z.number() });

type View = z.output<typeof requestView>;

@Injectable()
export class TopupRequestsService {
  constructor(
    @Inject(MONGO) private readonly mongo: MongoHandle,
    @Inject(Outbox) private readonly outbox: Outbox,
  ) {}

  private get db() {
    return this.mongo.db;
  }

  private async own(ctx: AuthContext): Promise<WalletDoc> {
    const tenantId = requireTenant(ctx);
    const self = selfReseller(ctx);
    if (!self) return ensureMasterWallet(this.db, tenantId);
    const w = await wallets(this.db).findOne({ ownerId: self, tenantId });
    if (!w) throw notFound('Wallet');
    return w;
  }

  private async views(ctx: AuthContext, mine: WalletDoc, docs: TopupRequestDoc[]): Promise<View[]> {
    const [sellers, ws] = await Promise.all([
      this.db
        .collection<ResellerDoc>('resellers')
        .find({ _id: { $in: docs.map((d) => d.resellerId) } }, { projection: { code: 1, name: 1 } })
        .toArray(),
      wallets(this.db)
        .find({ _id: { $in: docs.map((d) => d.walletId) } }, { projection: { balancePaise: 1 } })
        .toArray(),
    ]);
    const R = new Map(sellers.map((r) => [r._id.toHexString(), r]));
    const W = new Map(ws.map((w) => [w._id.toHexString(), w.balancePaise]));
    const transfer = ctx.permissions.has('wallets.transfer');
    return docs.map((d) => {
      const r = R.get(d.resellerId.toHexString());
      return {
        id: d._id.toHexString(),
        reseller: { id: d.resellerId.toHexString(), code: r?.code ?? '', name: r?.name ?? '—' },
        walletId: d.walletId.toHexString(),
        balancePaise: W.get(d.walletId.toHexString()) ?? 0,
        amountPaise: d.amountPaise,
        approvedPaise: d.approvedPaise ?? null,
        paidVia: d.paidVia ?? null,
        reference: d.reference ?? null,
        note: d.note ?? null,
        status: d.status,
        decisionNote: d.decisionNote ?? null,
        createdAt: d.createdAt.toISOString(),
        decidedAt: d.decidedAt?.toISOString() ?? null,
        canDecide: transfer && d.status === 'pending' && d.parentWalletId.equals(mine._id),
        canCancel: transfer && d.status === 'pending' && d.walletId.equals(mine._id),
      };
    });
  }

  async list(ctx: AuthContext, q: z.output<typeof listQuery>) {
    const tenantId = requireTenant(ctx);
    const mine = await this.own(ctx);
    const side: Filter<TopupRequestDoc> =
      q.box === 'incoming' ? { parentWalletId: mine._id } : { walletId: mine._id };
    const f: Filter<TopupRequestDoc> = { tenantId, ...side };
    if (q.status) f.status = q.status;
    if (q.cursor) f._id = { $lt: new ObjectId(q.cursor) };
    const [docs, pending] = await Promise.all([
      topupRequests(this.db)
        .find(f, { sort: { _id: -1 }, limit: q.limit + 1 })
        .toArray(),
      topupRequests(this.db).countDocuments({ tenantId, ...side, status: 'pending' }),
    ]);
    const { items, nextCursor } = pageOf(docs, q.limit, (d) => d);
    return { items: await this.views(ctx, mine, items), nextCursor, pending };
  }

  private async load(ctx: AuthContext, id: ObjectId) {
    const tenantId = requireTenant(ctx);
    const mine = await this.own(ctx);
    const d = await topupRequests(this.db).findOne({
      _id: id,
      tenantId,
      $or: [{ parentWalletId: mine._id }, { walletId: mine._id }],
    });
    if (!d) throw notFound('Top-up request');
    return { d, mine };
  }

  private async one(ctx: AuthContext, id: ObjectId) {
    const { d, mine } = await this.load(ctx, id);
    return (await this.views(ctx, mine, [d]))[0]!;
  }

  async create(ctx: AuthContext, b: z.output<typeof createBody>) {
    const tenantId = requireTenant(ctx);
    const self = selfReseller(ctx);
    if (!self) throw forbidden('The ISP tops up resellers directly; only resellers send requests');
    const mine = await this.own(ctx);
    if (!mine.parentWalletId) throw new AppError(400, 'VALIDATION_FAILED', 'This wallet has no parent');
    const seller = await this.db
      .collection<ResellerDoc>('resellers')
      .findOne({ _id: self, tenantId }, { projection: { ancestors: 1 } });
    if (!seller) throw notFound('Reseller');
    const open = await topupRequests(this.db).countDocuments({
      tenantId,
      walletId: mine._id,
      status: 'pending',
    });
    if (open >= MAX_PENDING) {
      throw new AppError(
        409,
        'CONFLICT',
        `You already have ${open} requests waiting; withdraw one or wait for an answer`,
      );
    }
    const now = new Date();
    const actor = ctx.userId.toHexString();
    const doc: TopupRequestDoc = {
      _id: new ObjectId(),
      tenantId,
      resellerId: self,
      walletId: mine._id,
      parentWalletId: mine.parentWalletId,
      ancestors: [...seller.ancestors, self],
      amountPaise: b.amountPaise,
      ...(b.paidVia ? { paidVia: b.paidVia } : {}),
      ...(b.reference ? { reference: b.reference } : {}),
      ...(b.note ? { note: b.note } : {}),
      status: 'pending',
      createdBy: actor,
      createdAt: now,
      updatedAt: now,
    };
    await topupRequests(this.db).insertOne(doc);
    noteChange({ after: doc, entityId: doc._id });
    return (await this.views(ctx, mine, [doc]))[0]!;
  }

  /** The wallet asked sends the money (a normal transfer, idempotent per request) and the request closes. */
  async approve(ctx: AuthContext, id: ObjectId, b: z.output<typeof approveBody>) {
    const { d, mine } = await this.load(ctx, id);
    if (!d.parentWalletId.equals(mine._id)) throw forbidden('Only the wallet asked can approve this request');
    if (d.status !== 'pending') throw new AppError(409, 'CONFLICT', `This request is already ${d.status}`);
    const actor = ctx.userId.toHexString();
    const amount = b.amountPaise ?? d.amountPaise;
    await this.outbox.tx(async (session) => {
      const from = (await wallets(this.db).findOne({ _id: mine._id }, { session }))!;
      const to = await wallets(this.db).findOne({ _id: d.walletId }, { session });
      if (!to) throw notFound('Wallet');
      const t = await transfer(this.db, session, {
        tenantId: d.tenantId,
        from,
        to,
        amountPaise: amount,
        idempotencyKey: `${d.tenantId.toHexString()}:topup-request:${d._id.toHexString()}`,
        actor,
        ...(d.paidVia ? { receivedVia: d.paidVia } : {}),
        ...(d.reference ? { reference: d.reference } : {}),
        note: b.note ? `Top-up request — ${b.note}` : 'Top-up request',
      });
      const now = new Date();
      const u = await topupRequests(this.db).findOneAndUpdate(
        { _id: d._id, status: 'pending' },
        {
          $set: {
            status: 'approved',
            approvedPaise: amount,
            transferId: t.transfer._id,
            ...(b.note ? { decisionNote: b.note } : {}),
            decidedBy: actor,
            decidedAt: now,
            updatedAt: now,
          },
        },
        { session, returnDocument: 'after' },
      );
      if (!u) throw new AppError(409, 'CONFLICT', 'This request was answered at the same time');
      noteChange({ before: d, after: u, entityId: d._id });
    });
    return this.one(ctx, id);
  }

  async reject(ctx: AuthContext, id: ObjectId, b: z.output<typeof rejectBody>) {
    const { d, mine } = await this.load(ctx, id);
    if (!d.parentWalletId.equals(mine._id)) throw forbidden('Only the wallet asked can reject this request');
    return this.close(ctx, d, 'rejected', b.note);
  }

  async cancel(ctx: AuthContext, id: ObjectId) {
    const { d, mine } = await this.load(ctx, id);
    if (!d.walletId.equals(mine._id)) throw forbidden('Only the reseller who asked can withdraw it');
    return this.close(ctx, d, 'cancelled');
  }

  private async close(ctx: AuthContext, d: TopupRequestDoc, to: 'rejected' | 'cancelled', note?: string) {
    const now = new Date();
    const u = await topupRequests(this.db).findOneAndUpdate(
      { _id: d._id, status: 'pending' },
      {
        $set: {
          status: to,
          ...(note ? { decisionNote: note } : {}),
          decidedBy: ctx.userId.toHexString(),
          decidedAt: now,
          updatedAt: now,
        },
      },
      { returnDocument: 'after' },
    );
    if (!u) throw new AppError(409, 'CONFLICT', `This request is already ${d.status}`);
    noteChange({ before: d, after: u, entityId: d._id });
    return this.one(ctx, d._id);
  }
}

@Controller()
export class TopupRequestsController {
  constructor(@Inject(TopupRequestsService) private readonly s: TopupRequestsService) {}

  @Get('wallets/topup-requests')
  @Endpoint({
    summary: 'Top-up requests asked of my wallet (incoming) or sent by me (outgoing), newest first',
    tags: ['wallets'],
    permission: 'billing.read',
    query: listQuery,
    response: listView,
  })
  list(@Ctx() ctx: AuthContext, @Query() q: z.output<typeof listQuery>) {
    return this.s.list(ctx, q);
  }

  @Post('wallets/topup-requests')
  @Endpoint({
    summary: 'Reseller asks the wallet directly above it for money',
    tags: ['wallets'],
    audit: 'topuprequest.create',
    permission: 'wallets.transfer',
    body: createBody,
    response: requestView,
  })
  create(@Ctx() ctx: AuthContext, @Body() b: z.output<typeof createBody>) {
    return this.s.create(ctx, b);
  }

  @Post('wallets/topup-requests/:id/approve')
  @HttpCode(200)
  @Endpoint({
    summary: 'Send the money asked for (or another amount); a normal transfer, once per request',
    tags: ['wallets'],
    audit: 'topuprequest.approve',
    permission: 'wallets.transfer',
    params: idParams,
    body: approveBody,
    response: requestView,
  })
  approve(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }, @Body() b: z.output<typeof approveBody>) {
    return this.s.approve(ctx, p.id, b);
  }

  @Post('wallets/topup-requests/:id/reject')
  @HttpCode(200)
  @Endpoint({
    summary: 'Turn down a top-up request with a note',
    tags: ['wallets'],
    audit: 'topuprequest.reject',
    permission: 'wallets.transfer',
    params: idParams,
    body: rejectBody,
    response: requestView,
  })
  reject(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }, @Body() b: z.output<typeof rejectBody>) {
    return this.s.reject(ctx, p.id, b);
  }

  @Post('wallets/topup-requests/:id/cancel')
  @HttpCode(200)
  @Endpoint({
    summary: 'Withdraw my own pending request',
    tags: ['wallets'],
    audit: 'topuprequest.cancel',
    permission: 'wallets.transfer',
    params: idParams,
    response: requestView,
  })
  cancel(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }) {
    return this.s.cancel(ctx, p.id);
  }
}
