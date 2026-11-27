import { createHash } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import {
  ensureMasterWallet,
  move,
  rates,
  sharePaise,
  transfer,
  walletTxns,
  wallets,
  type MongoHandle,
  type PlanDoc,
  type ResellerDoc,
  type ResellerRateDoc,
  type SubscriberDoc,
  type TenantDoc,
  type WalletDoc,
  type WalletTxnDoc,
  planAssignedIn,
  planSelections,
  sellablePlans,
} from '@isp/db-mongo';
import { noteChange } from '../audit/audit.js';
import type { AuthContext } from '../auth/context.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { Ctx, Endpoint } from '../http/endpoint.js';
import { hexId, idParams, page, pageOf, pageQuery } from '../http/schemas.js';
import { MONGO } from '../infra/infra.module.js';
import { Outbox } from '../sync/outbox.js';
import {
  assertStaff,
  idempotencyKey,
  istDayRange,
  requireTenant,
  selfReseller,
  walletState,
} from './common.js';

const paise = z.number().int().min(1).max(10_000_000_000);
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date in YYYY-MM-DD form');

const ownerRef = z.object({ id: z.string(), code: z.string(), name: z.string() });
const walletView = z.object({
  id: z.string(),
  ownerType: z.enum(['tenant', 'reseller']),
  owner: ownerRef,
  walletType: z.string(),
  parentWalletId: z.string().nullable(),
  balancePaise: z.number(),
  creditLimitPaise: z.number(),
  lowBalanceThresholdPaise: z.number(),
  state: z.enum(['normal', 'low', 'empty', 'frozen', 'inactive']),
  frozenReason: z.string().nullable(),
  totals: z.object({
    receivedPaise: z.number(),
    allocatedPaise: z.number(),
    rechargedPaise: z.number(),
    refundedPaise: z.number(),
  }),
  updatedAt: z.string(),
});
const dashboardView = walletView.extend({
  children: z.number(),
  lowChildren: z.number(),
  customers: z.number(),
  /** The caller may move money into this wallet (it is directly below the caller's wallet). */
  canTopUp: z.boolean(),
  canViewLedger: z.boolean(),
});
const txnView = z.object({
  id: z.string(),
  type: z.enum(['TOPUP', 'ALLOCATE', 'RECHARGE', 'REFUND', 'ADJUSTMENT']),
  direction: z.enum(['credit', 'debit']),
  amountPaise: z.number(),
  balanceBeforePaise: z.number(),
  balanceAfterPaise: z.number(),
  referenceId: z.string(),
  description: z.string(),
  createdAt: z.string(),
  createdBy: z.string(),
});
const listQuery = pageQuery.extend({
  parentWalletId: hexId.optional(),
  state: z.enum(['low', 'empty', 'frozen']).optional(),
});
const ledgerQuery = pageQuery.extend({
  type: z.enum(['TOPUP', 'ALLOCATE', 'RECHARGE', 'REFUND', 'ADJUSTMENT']).optional(),
  direction: z.enum(['credit', 'debit']).optional(),
  from: isoDay.optional(),
  to: isoDay.optional(),
});
/** Defaults: the last 30 IST days. */
const reportQuery = z.object({ from: isoDay.optional(), to: isoDay.optional() });
const reportView = z.object({
  rows: z.array(
    z.object({
      day: z.string(),
      creditsPaise: z.number(),
      debitsPaise: z.number(),
      /** Paise per "<TYPE>_<direction>", e.g. RECHARGE_debit. */
      byType: z.record(z.string(), z.number()),
      /** Entries per "<TYPE>_<direction>". */
      countByType: z.record(z.string(), z.number()),
      count: z.number(),
    }),
  ),
});
const transferBody = z.object({
  toWalletId: hexId,
  amountPaise: paise,
  receivedVia: z.enum(['cash', 'upi', 'bank']).optional(),
  reference: z.string().trim().max(60).optional(),
  note: z.string().trim().max(200).optional(),
});
const transferView = z.object({
  id: z.string(),
  replayed: z.boolean(),
  from: walletView,
  to: walletView,
});
const adjustBody = z.object({
  /** + credit, − debit. */
  amountPaise: z
    .number()
    .int()
    .refine((n) => n !== 0 && Math.abs(n) <= 10_000_000_000, 'must be non-zero'),
  reason: z.string().trim().min(5).max(200),
});
const patchBody = z
  .object({
    lowBalanceThresholdPaise: z.number().int().min(0).max(10_000_000_000).optional(),
    unfreeze: z.literal(true).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'nothing to change');

const rateView = z.object({
  planId: z.string(),
  planName: z.string(),
  planPricePaise: z.number(),
  gstRatePercent: z.number(),
  walletPricePaise: z.number(),
  customerPricePaise: z.number(),
  active: z.boolean(),
  /** Set explicitly (false = following the plan price). */
  custom: z.boolean(),
});
const ratesView = z.object({
  /** Caller may change wallet prices / sell-ability (it is the parent, or ISP staff). */
  canSetWalletPrices: z.boolean(),
  /** Caller may change the reseller's own customer prices (the reseller itself, or ISP staff). */
  canSetCustomerPrices: z.boolean(),
  /** `prepaid`: the wallet pays the wallet price per plan. `revenue_share`: sharePercent of the plan price. */
  walletModel: z.enum(['prepaid', 'revenue_share']),
  sharePercent: z.number().nullable(),
  items: z.array(rateView),
});
const ratesBody = z
  .object({
    rates: z
      .array(
        z.object({
          planId: hexId,
          walletPricePaise: z.number().int().min(0).max(10_000_000_000).optional(),
          customerPricePaise: z.number().int().min(0).max(10_000_000_000).nullable().optional(),
          active: z.boolean().optional(),
        }),
      )
      .max(500)
      .default([]),
    /** Parent (or staff): how this reseller's wallet pays for recharges. */
    model: z
      .discriminatedUnion('walletModel', [
        z.object({ walletModel: z.literal('prepaid') }),
        z.object({
          walletModel: z.literal('revenue_share'),
          /** Debited from this reseller per recharge, % of the plan price excl. GST (0.01–100). */
          sharePercent: z
            .number()
            .min(0.01)
            .max(100)
            .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'at most 2 decimals'),
        }),
      ])
      .optional(),
  })
  .refine((b) => b.rates.length > 0 || !!b.model, 'nothing to change');

type WalletView = z.output<typeof walletView>;

@Injectable()
export class WalletsService {
  constructor(
    @Inject(MONGO) private readonly mongo: MongoHandle,
    @Inject(Outbox) private readonly outbox: Outbox,
  ) {}

  private get db() {
    return this.mongo.db;
  }

  /** Owner names for a set of wallets in one query. */
  private async views(ctx: AuthContext, ws: WalletDoc[]): Promise<WalletView[]> {
    const ids = ws.filter((w) => w.ownerType === 'reseller').map((w) => w.ownerId);
    const owners = new Map(
      (ids.length
        ? await this.db
            .collection<ResellerDoc>('resellers')
            .find({ _id: { $in: ids } }, { projection: { code: 1, name: 1 } })
            .toArray()
        : []
      ).map((r) => [r._id.toHexString(), r]),
    );
    const tenant = ws.some((w) => w.ownerType === 'tenant')
      ? await this.db
          .collection<TenantDoc>('tenants')
          .findOne({ _id: requireTenant(ctx) }, { projection: { name: 1 } })
      : null;
    return ws.map((w) => {
      const o = owners.get(w.ownerId.toHexString());
      return {
        id: w._id.toHexString(),
        ownerType: w.ownerType,
        owner:
          w.ownerType === 'tenant'
            ? { id: w.ownerId.toHexString(), code: 'MASTER', name: tenant?.name ?? 'ISP' }
            : { id: w.ownerId.toHexString(), code: o?.code ?? '?', name: o?.name ?? 'Deleted reseller' },
        walletType: w.walletType,
        parentWalletId: w.parentWalletId?.toHexString() ?? null,
        balancePaise: w.balancePaise,
        creditLimitPaise: w.creditLimitPaise,
        lowBalanceThresholdPaise: w.lowBalanceThresholdPaise,
        state: walletState(w),
        frozenReason: w.frozenReason ?? null,
        totals: w.totals,
        updatedAt: w.updatedAt.toISOString(),
      };
    });
  }

  /** The caller's own wallet (Master for ISP staff). */
  async own(ctx: AuthContext): Promise<WalletDoc> {
    const tenantId = requireTenant(ctx);
    const self = selfReseller(ctx);
    if (!self) return ensureMasterWallet(this.db, tenantId);
    const w = await wallets(this.db).findOne({ ownerId: self, tenantId });
    if (!w) throw notFound('Wallet');
    return w;
  }

  /** Staff: any wallet of the ISP. Reseller: its own and its direct children's. */
  async visible(ctx: AuthContext, id: ObjectId): Promise<{ w: WalletDoc; own: boolean; child: boolean }> {
    const tenantId = requireTenant(ctx);
    const w = await wallets(this.db).findOne({ _id: id, tenantId });
    if (!w) throw notFound('Wallet');
    if (ctx.scope.kind !== 'branch') {
      return {
        w,
        own: w.walletType === 'MASTER',
        child: w.parentWalletId?.equals((await this.own(ctx))._id) ?? false,
      };
    }
    const mine = await this.own(ctx);
    if (w._id.equals(mine._id)) return { w, own: true, child: false };
    if (w.parentWalletId?.equals(mine._id)) return { w, own: false, child: true };
    throw notFound('Wallet');
  }

  async list(ctx: AuthContext, q: z.output<typeof listQuery>) {
    const tenantId = requireTenant(ctx);
    const f: Filter<WalletDoc> = { tenantId, isActive: true };
    if (ctx.scope.kind === 'branch') f.parentWalletId = (await this.own(ctx))._id;
    else if (q.parentWalletId) f.parentWalletId = new ObjectId(q.parentWalletId);
    if (q.state === 'frozen') f.frozen = true;
    if (q.state === 'empty') f.$expr = { $lte: [{ $add: ['$balancePaise', '$creditLimitPaise'] }, 0] };
    if (q.state === 'low') {
      f.walletType = { $ne: 'MASTER' };
      f.$expr = { $lte: ['$balancePaise', '$lowBalanceThresholdPaise'] };
    }
    if (q.cursor) f._id = { $lt: new ObjectId(q.cursor) };
    const docs = await wallets(this.db)
      .find(f, { sort: { _id: -1 }, limit: q.limit + 1 })
      .toArray();
    const views = await this.views(ctx, docs.slice(0, q.limit));
    const byId = new Map(views.map((v) => [v.id, v]));
    return pageOf(docs, q.limit, (d) => byId.get(d._id.toHexString())!);
  }

  async dashboard(ctx: AuthContext, w: WalletDoc, own: boolean, child: boolean) {
    const [view] = await this.views(ctx, [w]);
    const [children, lowChildren, customers] = await Promise.all([
      wallets(this.db).countDocuments({ parentWalletId: w._id, isActive: true }),
      wallets(this.db).countDocuments({
        parentWalletId: w._id,
        isActive: true,
        $expr: { $lte: ['$balancePaise', '$lowBalanceThresholdPaise'] },
      }),
      this.db
        .collection<SubscriberDoc>('subscribers')
        .countDocuments(
          w.ownerType === 'tenant'
            ? { tenantId: w.tenantId, status: { $ne: 'deleted' } }
            : { tenantId: w.tenantId, ancestors: w.ownerId, status: { $ne: 'deleted' } },
        ),
    ]);
    return {
      ...view!,
      children,
      lowChildren,
      customers,
      canTopUp: child && ctx.permissions.has('wallets.transfer'),
      canViewLedger: own || ctx.scope.kind !== 'branch',
    };
  }

  async get(ctx: AuthContext, id: ObjectId) {
    const { w, own, child } = await this.visible(ctx, id);
    return this.dashboard(ctx, w, own, child);
  }

  async mine(ctx: AuthContext) {
    const w = await this.own(ctx);
    return this.dashboard(ctx, w, true, false);
  }

  async ledger(ctx: AuthContext, id: ObjectId, q: z.output<typeof ledgerQuery>) {
    const { w, own } = await this.visible(ctx, id);
    if (!own && ctx.scope.kind === 'branch') throw forbidden('You can see only your own ledger');
    const f: Filter<WalletTxnDoc> = { walletId: w._id, tenantId: w.tenantId };
    if (q.type) f.type = q.type;
    if (q.direction) f.direction = q.direction;
    const range = istDayRange(q.from, q.to);
    if (range) f.createdAt = range;
    if (q.cursor) f._id = { $lt: new ObjectId(q.cursor) };
    const docs = await walletTxns(this.db)
      .find(f, { sort: { createdAt: -1, _id: -1 }, limit: q.limit + 1 })
      .toArray();
    return pageOf(docs, q.limit, (t) => ({
      id: t._id.toHexString(),
      type: t.type,
      direction: t.direction,
      amountPaise: t.amountPaise,
      balanceBeforePaise: t.balanceBeforePaise,
      balanceAfterPaise: t.balanceAfterPaise,
      referenceId: t.referenceId.toHexString(),
      description: t.description,
      createdAt: t.createdAt.toISOString(),
      createdBy: t.createdBy,
    }));
  }

  /** Date-wise credits/debits per IST day (accounts team "Wallet Reports"). */
  async report(ctx: AuthContext, id: ObjectId, q: z.output<typeof reportQuery>) {
    const { w, own } = await this.visible(ctx, id);
    if (!own && ctx.scope.kind === 'branch') throw forbidden('You can see only your own wallet report');
    const day = (msAgo: number) => new Date(Date.now() + 330 * 60_000 - msAgo).toISOString().slice(0, 10);
    const to = q.to ?? day(0);
    const from = q.from ?? day(30 * 86_400_000);
    const rows = await walletTxns(this.db)
      .aggregate<{ _id: { day: string; type: string; dir: string }; sum: number; n: number }>([
        { $match: { walletId: w._id, tenantId: w.tenantId, createdAt: istDayRange(from, to) } },
        {
          $group: {
            _id: {
              day: { $dateToString: { date: '$createdAt', format: '%Y-%m-%d', timezone: 'Asia/Kolkata' } },
              type: '$type',
              dir: '$direction',
            },
            sum: { $sum: '$amountPaise' },
            n: { $sum: 1 },
          },
        },
        { $sort: { '_id.day': 1 } },
      ])
      .toArray();
    const byDay = new Map<string, z.output<typeof reportView>['rows'][number]>();
    for (const r of rows) {
      const d = byDay.get(r._id.day) ?? {
        day: r._id.day,
        creditsPaise: 0,
        debitsPaise: 0,
        byType: {},
        countByType: {},
        count: 0,
      };
      if (r._id.dir === 'credit') d.creditsPaise += r.sum;
      else d.debitsPaise += r.sum;
      const key = `${r._id.type}_${r._id.dir}`;
      d.byType[key] = (d.byType[key] ?? 0) + r.sum;
      d.countByType[key] = (d.countByType[key] ?? 0) + r.n;
      d.count += r.n;
      byDay.set(r._id.day, d);
    }
    return { rows: [...byDay.values()] };
  }

  /** Master → L1 (ISP staff) or own wallet → direct child (reseller), one transaction, idempotent. */
  async transfer(ctx: AuthContext, key: string, b: z.output<typeof transferBody>) {
    const tenantId = requireTenant(ctx);
    const from = await this.own(ctx);
    const to = await wallets(this.db).findOne({ _id: new ObjectId(b.toWalletId), tenantId });
    if (!to || !to.parentWalletId?.equals(from._id)) {
      throw new AppError(
        400,
        'VALIDATION_FAILED',
        ctx.scope.kind === 'branch'
          ? 'You can send money only to resellers directly below you'
          : 'The ISP tops up level-1 resellers; they allocate further down',
      );
    }
    const actor = ctx.userId.toHexString();
    const r = await this.outbox.tx((session) =>
      transfer(this.db, session, {
        tenantId,
        from,
        to,
        amountPaise: b.amountPaise,
        idempotencyKey: key,
        actor,
        ...(b.receivedVia ? { receivedVia: b.receivedVia } : {}),
        ...(b.reference ? { reference: b.reference } : {}),
        ...(b.note ? { note: b.note } : {}),
      }),
    );
    if (!r.replayed) noteChange({ after: r.transfer, entityId: r.transfer._id });
    const [fromV, toV] = await this.views(ctx, [
      (await wallets(this.db).findOne({ _id: from._id }))!,
      (await wallets(this.db).findOne({ _id: to._id }))!,
    ]);
    return { id: r.transfer._id.toHexString(), replayed: r.replayed, from: fromV!, to: toV! };
  }

  /** Approved manual correction (staff with wallets.adjust), mandatory reason, idempotent. */
  async adjust(ctx: AuthContext, id: ObjectId, key: string, b: z.output<typeof adjustBody>) {
    assertStaff(ctx, 'adjust wallets');
    const { w } = await this.visible(ctx, id);
    // Deterministic reference from the key: a repeat finds the first adjustment instead of moving money again.
    const ref = new ObjectId(createHash('sha256').update(key).digest().subarray(0, 12));
    const txn = await this.outbox.tx(async (session) => {
      const prior = await walletTxns(this.db).findOne({ referenceId: ref, type: 'ADJUSTMENT' }, { session });
      if (prior) return prior;
      return move(this.db, session, {
        tenantId: w.tenantId,
        walletId: w._id,
        deltaPaise: b.amountPaise,
        type: 'ADJUSTMENT',
        referenceId: ref,
        description: b.reason,
        actor: ctx.userId.toHexString(),
        checkBalance: w.walletType !== 'MASTER',
      });
    });
    noteChange({ after: txn, entityId: w._id });
    return this.get(ctx, id);
  }

  async patch(ctx: AuthContext, id: ObjectId, b: z.output<typeof patchBody>) {
    const { w, child } = await this.visible(ctx, id);
    if (ctx.scope.kind === 'branch' && !child)
      throw forbidden('Only the parent sets a wallet’s low-balance level');
    if (b.unfreeze && (ctx.scope.kind === 'branch' || !ctx.permissions.has('wallets.adjust'))) {
      throw forbidden('Only ISP staff with wallet adjustment rights can unfreeze a wallet');
    }
    const u = await wallets(this.db).findOneAndUpdate(
      { _id: w._id, tenantId: w.tenantId },
      {
        $set: {
          updatedAt: new Date(),
          ...(b.lowBalanceThresholdPaise !== undefined
            ? { lowBalanceThresholdPaise: b.lowBalanceThresholdPaise }
            : {}),
          ...(b.unfreeze ? { frozen: false } : {}),
        },
        ...(b.unfreeze ? { $unset: { frozenReason: '' as const } } : {}),
      },
      { returnDocument: 'after' },
    );
    noteChange({ before: w, after: u!, entityId: w._id });
    return this.get(ctx, id);
  }

  // ---- reseller rates (WP 3.2) ----

  private async resellerFor(ctx: AuthContext, id: ObjectId) {
    const tenantId = requireTenant(ctx);
    const r = await this.db
      .collection<ResellerDoc>('resellers')
      .findOne({ _id: id, tenantId, status: { $ne: 'deleted' } });
    const self = selfReseller(ctx);
    if (!r || (self && !r._id.equals(self) && !r.ancestors.some((a) => a.equals(self))))
      throw notFound('Reseller');
    const staff = !self;
    return {
      r,
      canSetWalletPrices: (staff || !!r.parentId?.equals(self!)) && ctx.permissions.has('resellers.write'),
      canSetCustomerPrices: (staff || r._id.equals(self!)) && ctx.permissions.has('resellers.write'),
    };
  }

  async getRates(ctx: AuthContext, id: ObjectId) {
    const { r, canSetWalletPrices, canSetCustomerPrices } = await this.resellerFor(ctx, id);
    const [all, rows, parentSel] = await Promise.all([
      this.db
        .collection<PlanDoc>('plans')
        .find(
          { tenantId: r.tenantId, status: 'active', ...sellablePlans(r.ancestors) },
          { sort: { name: 1 } },
        )
        .toArray(),
      rates(this.db).find({ buyerId: r._id }).toArray(),
      planSelections(this.db, r.ancestors),
    ]);
    // Only what the level above may sell itself can be passed down; the reseller's own plans need no selection.
    const plans = all.filter((p) => planAssignedIn(p, r.ancestors, parentSel));
    const byPlan = new Map(rows.map((x) => [x.planId.toHexString(), x]));
    const share = r.walletModel === 'revenue_share' && r.shareBp !== undefined ? r.shareBp : null;
    return {
      canSetWalletPrices,
      canSetCustomerPrices,
      walletModel: share !== null ? ('revenue_share' as const) : ('prepaid' as const),
      sharePercent: share !== null ? share / 100 : null,
      items: plans.map((p) => {
        const x = byPlan.get(p._id.toHexString());
        return {
          planId: p._id.toHexString(),
          planName: p.name,
          planPricePaise: p.pricePaise,
          gstRatePercent: p.gstRatePercent,
          walletPricePaise:
            share !== null ? sharePaise(p.pricePaise, share) : (x?.walletPricePaise ?? p.pricePaise),
          customerPricePaise: x?.customerPricePaise ?? p.pricePaise,
          active: x?.active ?? false,
          custom: x?.walletPricePaise !== undefined || x?.customerPricePaise !== undefined,
        };
      }),
    };
  }

  /** The parent (or ISP staff) sets wallet prices and what may be sold; the reseller sets its own customer prices. */
  async putRates(ctx: AuthContext, id: ObjectId, b: z.output<typeof ratesBody>) {
    const { r, canSetWalletPrices, canSetCustomerPrices } = await this.resellerFor(ctx, id);
    let model: { before: object; after: object } | null = null;
    if (b.model) {
      if (!canSetWalletPrices) throw forbidden('The billing model is set by the reseller directly above');
      const shareBp = b.model.walletModel === 'revenue_share' ? Math.round(b.model.sharePercent * 100) : null;
      const set = { updatedAt: new Date(), updatedBy: ctx.userId.toHexString() };
      await this.db
        .collection<ResellerDoc>('resellers')
        .updateOne(
          { _id: r._id, tenantId: r.tenantId },
          shareBp !== null
            ? { $set: { ...set, walletModel: 'revenue_share', shareBp }, $inc: { version: 1 } }
            : { $set: { ...set, walletModel: 'prepaid' }, $unset: { shareBp: '' }, $inc: { version: 1 } },
        );
      model = {
        before: { walletModel: r.walletModel ?? 'prepaid', shareBp: r.shareBp ?? null },
        after: { walletModel: b.model.walletModel, shareBp },
      };
      if (!b.rates.length) {
        noteChange({ before: model.before, after: model.after, entityId: r._id });
        return this.getRates(ctx, id);
      }
    }
    for (const x of b.rates) {
      if ((x.walletPricePaise !== undefined || x.active !== undefined) && !canSetWalletPrices) {
        throw forbidden('Wallet prices are set by the reseller directly above');
      }
      if (x.customerPricePaise !== undefined && !canSetCustomerPrices) {
        throw forbidden('Customer prices are set by the reseller itself');
      }
    }
    const planIds = b.rates.map((x) => new ObjectId(x.planId));
    const plans = new Map(
      (
        await this.db
          .collection<PlanDoc>('plans')
          .find({ _id: { $in: planIds }, tenantId: r.tenantId })
          .toArray()
      ).map((p) => [p._id.toHexString(), p]),
    );
    if (plans.size !== new Set(b.rates.map((x) => x.planId)).size)
      throw new AppError(400, 'VALIDATION_FAILED', 'Unknown plan');
    const parentSel = await planSelections(this.db, r.ancestors);
    for (const x of b.rates) {
      if (x.active && !planAssignedIn(plans.get(x.planId)!, r.ancestors, parentSel))
        throw new AppError(
          400,
          'VALIDATION_FAILED',
          `${plans.get(x.planId)!.name} is not assigned to the level above`,
        );
    }
    const now = new Date();
    const actor = ctx.userId.toHexString();
    const before = await rates(this.db)
      .find({ buyerId: r._id, planId: { $in: planIds } })
      .toArray();
    await rates(this.db).bulkWrite(
      b.rates.map((x) => {
        const plan = plans.get(x.planId)!;
        const set: Partial<ResellerRateDoc> = { updatedAt: now, updatedBy: actor };
        if (x.walletPricePaise !== undefined) set.walletPricePaise = x.walletPricePaise;
        if (x.active !== undefined) set.active = x.active;
        if (typeof x.customerPricePaise === 'number') set.customerPricePaise = x.customerPricePaise;
        return {
          updateOne: {
            filter: { buyerId: r._id, planId: plan._id },
            update: {
              $set: set,
              ...(x.customerPricePaise === null ? { $unset: { customerPricePaise: '' as const } } : {}),
              $setOnInsert: {
                tenantId: r.tenantId,
                setById: r.parentId ?? r.tenantId,
                createdAt: now,
                createdBy: actor,
                // A row created only for a customer price is not a selection.
                ...(x.active === undefined ? { active: false } : {}),
              },
            },
            upsert: true,
          },
        };
      }),
    );
    noteChange({
      before: { rates: before, ...(model ? { model: model.before } : {}) },
      after: { rates: b.rates, ...(model ? { model: model.after } : {}) },
      entityId: r._id,
    });
    return this.getRates(ctx, id);
  }
}

@Controller()
export class WalletsController {
  constructor(@Inject(WalletsService) private readonly s: WalletsService) {}

  @Get('wallets')
  @Endpoint({
    summary: 'Wallet accounts (staff: all; reseller: its direct children)',
    tags: ['wallets'],
    permission: 'billing.read',
    query: listQuery,
    response: page(walletView),
  })
  list(@Ctx() ctx: AuthContext, @Query() q: z.output<typeof listQuery>) {
    return this.s.list(ctx, q);
  }

  @Get('wallets/mine')
  @Endpoint({
    summary: 'The caller’s wallet dashboard (Master for ISP staff)',
    tags: ['wallets'],
    permission: 'billing.read',
    response: dashboardView,
  })
  mine(@Ctx() ctx: AuthContext) {
    return this.s.mine(ctx);
  }

  @Get('wallets/:id')
  @Endpoint({
    summary: 'Wallet dashboard',
    tags: ['wallets'],
    permission: 'billing.read',
    params: idParams,
    response: dashboardView,
  })
  get(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }) {
    return this.s.get(ctx, p.id);
  }

  @Get('wallets/:id/ledger')
  @Endpoint({
    summary: 'Ledger: every credit and debit with balances before and after',
    tags: ['wallets'],
    permission: 'billing.read',
    params: idParams,
    query: ledgerQuery,
    response: page(txnView),
  })
  ledger(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }, @Query() q: z.output<typeof ledgerQuery>) {
    return this.s.ledger(ctx, p.id, q);
  }

  @Get('wallets/:id/report')
  @Endpoint({
    summary: 'Date-wise credits and debits (IST days)',
    tags: ['wallets'],
    permission: 'billing.read',
    params: idParams,
    query: reportQuery,
    response: reportView,
  })
  report(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }, @Query() q: z.output<typeof reportQuery>) {
    return this.s.report(ctx, p.id, q);
  }

  @Post('wallets/transfer')
  @HttpCode(200)
  @Endpoint({
    summary:
      'Top-up (ISP → level 1) or allocation (reseller → direct child). Idempotency-Key header required',
    tags: ['wallets'],
    audit: 'wallet.transfer',
    permission: 'wallets.transfer',
    body: transferBody,
    response: transferView,
  })
  transfer(@Ctx() ctx: AuthContext, @Req() req: FastifyRequest, @Body() b: z.output<typeof transferBody>) {
    return this.s.transfer(ctx, idempotencyKey(req, ctx), b);
  }

  @Post('wallets/:id/adjust')
  @HttpCode(200)
  @Endpoint({
    summary: 'Manual correction with a reason (ISP staff). Idempotency-Key header required',
    tags: ['wallets'],
    audit: 'wallet.adjust',
    permission: 'wallets.adjust',
    params: idParams,
    body: adjustBody,
    response: dashboardView,
  })
  adjust(
    @Ctx() ctx: AuthContext,
    @Req() req: FastifyRequest,
    @Param() p: { id: ObjectId },
    @Body() b: z.output<typeof adjustBody>,
  ) {
    return this.s.adjust(ctx, p.id, idempotencyKey(req, ctx), b);
  }

  @Patch('wallets/:id')
  @Endpoint({
    summary: 'Low-balance level (parent or staff); unfreeze after a reconciliation check (staff)',
    tags: ['wallets'],
    audit: 'wallet.update',
    permission: 'wallets.transfer',
    params: idParams,
    body: patchBody,
    response: dashboardView,
  })
  patch(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }, @Body() b: z.output<typeof patchBody>) {
    return this.s.patch(ctx, p.id, b);
  }

  @Get('resellers/:id/rates')
  @Endpoint({
    summary: 'Per-plan wallet price, customer price and sell-ability of a reseller',
    tags: ['resellers'],
    permission: 'resellers.read',
    params: idParams,
    response: ratesView,
  })
  getRates(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }) {
    return this.s.getRates(ctx, p.id);
  }

  @Put('resellers/:id/rates')
  @Endpoint({
    summary:
      'Set rates: wallet price / sell-ability (parent or staff), customer price (the reseller or staff)',
    tags: ['resellers'],
    audit: 'reseller.rates',
    permission: 'resellers.write',
    params: idParams,
    body: ratesBody,
    response: ratesView,
  })
  putRates(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }, @Body() b: z.output<typeof ratesBody>) {
    return this.s.putRates(ctx, p.id, b);
  }
}
