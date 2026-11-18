import { Body, Controller, Get, HttpCode, Inject, Injectable, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import {
  ScopedDb,
  customerPrice,
  grossPrice,
  payments,
  performRecharge,
  recharges,
  rechargePeriod,
  reverseRecharge,
  endOfIstDay,
  istDate,
  istMidnight,
  walletTerms,
  wallets,
  type BillingTenant,
  type MongoHandle,
  type PaymentDoc,
  type PlanDoc,
  type RechargeDoc,
  type SubscriberDoc,
} from '@isp/db-mongo';
import { noteChange } from '../audit/audit.js';
import type { AuthContext } from '../auth/context.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { Ctx, Endpoint } from '../http/endpoint.js';
import { hexId, idParams, objectId, page, pageOf, pageQuery } from '../http/schemas.js';
import { MONGO } from '../infra/infra.module.js';
import { Outbox } from '../sync/outbox.js';
import {
  assertBranchOpen,
  assertStaff,
  idempotencyKey,
  istDayRange,
  requireTenant,
  selfReseller,
} from './common.js';

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date in YYYY-MM-DD form');
/** 00:00 IST of a YYYY-MM-DD day. */
const istDayStart = (d: string) => {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  return istMidnight(y, m, day);
};
const createBody = z.object({
  subscriberId: objectId,
  /** Defaults to the subscriber's current plan. */
  planId: objectId.optional(),
  /**
   * ISP staff only: `cash` records the customer's cash (billing.cash); `none` is a complimentary recharge with no
   * invoice (wallets.adjust). A reseller always pays from its own wallet.
   */
  payment: z.enum(['cash', 'none']).optional(),
  /** Periods bought at once (3 × 1 month). */
  quantity: z.number().int().min(1).max(12).default(1),
  /**
   * `recharges.override`: customer total incl. GST (whole rupees) and/or last valid day (YYYY-MM-DD, valid to
   * 23:59:59 IST). Changes the invoice and expiry only; the wallet debit stays the plan price/share × periods.
   * A reseller may shorten the period but not extend it past what its wallet pays for.
   */
  override: z
    .object({
      customerTotalPaise: z.number().int().min(0).max(10_000_000_000).optional(),
      expiresOn: isoDay.optional(),
      reason: z.string().trim().min(3).max(200),
    })
    .refine((o) => o.customerTotalPaise !== undefined || o.expiresOn !== undefined, 'nothing to change')
    .optional(),
});
const refundBody = z.object({ reason: z.string().trim().min(5).max(200) });
const listQuery = pageQuery.extend({
  subscriberId: hexId.optional(),
  /** Recharges paid by this reseller's wallet. */
  siteResellerId: hexId.optional(),
  channel: z.enum(['online', 'reseller_wallet', 'cash', 'staff', 'import']).optional(),
  status: z.enum(['SUCCESS', 'REVERSED']).optional(),
  from: isoDay.optional(),
  to: isoDay.optional(),
});
const quoteQuery = z.object({
  subscriberId: hexId,
  planId: hexId.optional(),
  quantity: z.coerce.number().int().min(1).max(12).default(1),
});

const ref = z.object({ id: z.string(), name: z.string() }).nullable();
const rechargeView = z.object({
  id: z.string(),
  subscriber: z.object({
    id: z.string(),
    name: z.string(),
    username: z.string().nullable(),
    customerNo: z.string(),
  }),
  plan: ref,
  siteReseller: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  amountPaise: z.number(),
  customerPricePaise: z.number(),
  taxPaise: z.number(),
  channel: z.enum(['online', 'reseller_wallet', 'cash', 'staff', 'import']),
  status: z.enum(['SUCCESS', 'REVERSED']),
  oldExpiresAt: z.string().nullable(),
  /** Start and end of the period bought. */
  periodStart: z.string(),
  newExpiresAt: z.string(),
  quantity: z.number(),
  /** Who recharged (staff or reseller user); null for online / system. */
  by: z.object({ id: z.string(), name: z.string() }).nullable(),
  invoiceId: z.string().nullable(),
  paymentId: z.string().nullable(),
  walletModel: z.enum(['prepaid', 'revenue_share']),
  sharePercent: z.number().nullable(),
  override: z
    .object({
      customerTotal: z.object({ quotedPaise: z.number(), setPaise: z.number() }).nullable(),
      expiresAt: z.object({ quoted: z.string(), set: z.string() }).nullable(),
      reason: z.string(),
    })
    .nullable(),
  reversal: z.object({ reason: z.string(), at: z.string(), creditNoteId: z.string().nullable() }).nullable(),
  replayed: z.boolean().optional(),
  createdAt: z.string(),
});
const quoteView = z.object({
  plan: z.object({ id: z.string(), name: z.string(), validityDays: z.number() }),
  quantity: z.number(),
  /** Debited from the caller's wallet (0 for ISP staff); totals for the quantity. */
  walletPricePaise: z.number(),
  walletBalancePaise: z.number().nullable(),
  customerPricePaise: z.number(),
  /** Customer price incl. GST, rounded to the rupee. */
  customerTotalPaise: z.number(),
  periodStart: z.string(),
  newExpiresAt: z.string(),
  /** How the wallet debit is worked out for the caller. */
  walletModel: z.enum(['prepaid', 'revenue_share']).nullable(),
  sharePercent: z.number().nullable(),
  /** Caller may change the price and valid-until (recharges.override). */
  canOverride: z.boolean(),
  /** A reseller cannot set valid-until later than this (what its wallet pays for); null for staff. */
  maxExpiresAt: z.string().nullable(),
});

type View = z.output<typeof rechargeView>;

@Injectable()
export class RechargesService {
  constructor(
    @Inject(MONGO) private readonly mongo: MongoHandle,
    @Inject(Outbox) private readonly outbox: Outbox,
  ) {}

  private get db() {
    return this.mongo.db;
  }
  private scoped(ctx: AuthContext) {
    return new ScopedDb(this.db, ctx.scope);
  }

  private async views(ctx: AuthContext, docs: RechargeDoc[]): Promise<View[]> {
    const ids = (k: 'subscriberId' | 'planId' | 'siteResellerId') =>
      [...new Set(docs.flatMap((d) => (d[k] ? [d[k]!.toHexString()] : [])))].map((x) => new ObjectId(x));
    const actorIds = [...new Set(docs.map((d) => d.actorId).filter((a) => ObjectId.isValid(a)))].map(
      (a) => new ObjectId(a),
    );
    const [subs, plans, sellers, users] = await Promise.all([
      this.db
        .collection<SubscriberDoc>('subscribers')
        .find({ _id: { $in: ids('subscriberId') } }, { projection: { name: 1, username: 1, customerNo: 1 } })
        .toArray(),
      this.db
        .collection<PlanDoc>('plans')
        .find({ _id: { $in: ids('planId') } }, { projection: { name: 1 } })
        .toArray(),
      this.db
        .collection<{ _id: ObjectId; code: string; name: string }>('resellers')
        .find({ _id: { $in: ids('siteResellerId') } }, { projection: { code: 1, name: 1 } })
        .toArray(),
      actorIds.length
        ? this.db
            .collection<{ _id: ObjectId; name: string }>('users')
            .find({ _id: { $in: actorIds } }, { projection: { name: 1 } })
            .toArray()
        : [],
    ]);
    const m = <T extends { _id: ObjectId }>(xs: T[]) => new Map(xs.map((x) => [x._id.toHexString(), x]));
    const S = m(subs);
    const P = m(plans);
    const R = m(sellers);
    const U = m(users);
    return docs.map((d) => {
      const s = S.get(d.subscriberId.toHexString());
      const p = P.get(d.planId.toHexString());
      const r = d.siteResellerId ? R.get(d.siteResellerId.toHexString()) : undefined;
      return {
        id: d._id.toHexString(),
        subscriber: {
          id: d.subscriberId.toHexString(),
          name: s?.name ?? '—',
          username: s?.username ?? null,
          customerNo: s?.customerNo ?? '',
        },
        plan: p ? { id: p._id.toHexString(), name: p.name } : null,
        siteReseller: r ? { id: r._id.toHexString(), code: r.code, name: r.name } : null,
        amountPaise: d.amountPaise,
        customerPricePaise: d.customerPricePaise,
        taxPaise: d.taxPaise,
        channel: d.channel,
        status: d.status,
        oldExpiresAt: d.oldExpiresAt?.toISOString() ?? null,
        periodStart: (
          d.periodStart ??
          (d.oldExpiresAt && d.oldExpiresAt > d.rechargeDate ? d.oldExpiresAt : d.rechargeDate)
        ).toISOString(),
        newExpiresAt: d.newExpiresAt.toISOString(),
        quantity: d.quantity ?? 1,
        by: (() => {
          const u = U.get(d.actorId);
          return u ? { id: d.actorId, name: u.name } : null;
        })(),
        invoiceId: d.invoiceId?.toHexString() ?? null,
        paymentId: d.paymentId?.toHexString() ?? null,
        walletModel: d.walletModel ?? 'prepaid',
        sharePercent: d.shareBp !== undefined ? d.shareBp / 100 : null,
        override: d.override
          ? {
              customerTotal: d.override.customerTotalPaise
                ? {
                    quotedPaise: d.override.customerTotalPaise.quoted,
                    setPaise: d.override.customerTotalPaise.set,
                  }
                : null,
              expiresAt: d.override.expiresAt
                ? {
                    quoted: d.override.expiresAt.quoted.toISOString(),
                    set: d.override.expiresAt.set.toISOString(),
                  }
                : null,
              reason: d.override.reason,
            }
          : null,
        reversal: d.reversal
          ? {
              reason: d.reversal.reason,
              at: d.reversal.at.toISOString(),
              creditNoteId: d.reversal.creditNoteId?.toHexString() ?? null,
            }
          : null,
        createdAt: d.createdAt.toISOString(),
      };
    });
  }

  private async subscriber(ctx: AuthContext, id: ObjectId) {
    const s = await this.scoped(ctx)
      .collection<SubscriberDoc>('subscribers')
      .findOne({ _id: id, status: { $ne: 'deleted' } });
    if (!s) throw notFound('Subscriber');
    return s;
  }

  private async plan(ctx: AuthContext, s: SubscriberDoc, planId?: ObjectId) {
    const id = planId ?? s.planId;
    if (!id) throw new AppError(400, 'VALIDATION_FAILED', 'Choose a plan: this customer has none');
    const p = await this.db.collection<PlanDoc>('plans').findOne({ _id: id, tenantId: s.tenantId });
    if (!p) throw notFound('Plan');
    return p;
  }

  async quote(ctx: AuthContext, q: z.output<typeof quoteQuery>) {
    const s = await this.subscriber(ctx, new ObjectId(q.subscriberId));
    const plan = await this.plan(ctx, s, q.planId ? new ObjectId(q.planId) : undefined);
    const self = selfReseller(ctx);
    const w = self ? await wallets(this.db).findOne({ ownerId: self, tenantId: s.tenantId }) : null;
    const cp = await customerPrice(this.db, s.resellerId, plan);
    const n = q.quantity;
    const period = rechargePeriod(s.expiresAt, plan.validityDays, n);
    const terms = self ? await walletTerms(this.db, self, plan) : null;
    return {
      plan: { id: plan._id.toHexString(), name: plan.name, validityDays: plan.validityDays },
      quantity: n,
      walletPricePaise: terms ? terms.amountPaise * n : 0,
      walletModel: terms?.walletModel ?? null,
      sharePercent: terms?.shareBp !== undefined ? terms.shareBp / 100 : null,
      canOverride: ctx.permissions.has('recharges.override'),
      maxExpiresAt: self ? period.end.toISOString() : null,
      walletBalancePaise: w ? w.balancePaise : null,
      customerPricePaise: cp * n,
      customerTotalPaise: grossPrice(cp * n, plan.gstRatePercent),
      periodStart: period.start.toISOString(),
      newExpiresAt: period.end.toISOString(),
    };
  }

  async create(ctx: AuthContext, key: string, b: z.output<typeof createBody>) {
    const tenantId = requireTenant(ctx);
    const self = selfReseller(ctx);
    if (self && b.payment) throw forbidden('A reseller recharges from its own wallet');
    if (!self) {
      if (!b.payment)
        throw new AppError(400, 'VALIDATION_FAILED', 'Choose how the customer paid: cash or complimentary');
      if (b.payment === 'cash' && !ctx.permissions.has('billing.cash'))
        throw forbidden('You cannot record cash payments');
      if (b.payment === 'none' && !ctx.permissions.has('wallets.adjust')) {
        throw forbidden('Only staff with wallet adjustment rights can give complimentary recharges');
      }
    }
    if (b.override && !ctx.permissions.has('recharges.override'))
      throw forbidden('You cannot change the recharge price or valid-until');
    const existing = await recharges(this.db).findOne({ idempotencyKey: key, tenantId });
    if (existing) return { ...(await this.views(ctx, [existing]))[0]!, replayed: true };

    const s = await this.subscriber(ctx, b.subscriberId);
    const plan = await this.plan(ctx, s, b.planId);
    const actor = ctx.userId.toHexString();
    const tenant = (await this.db.collection<BillingTenant>('tenants').findOne({ _id: tenantId }))!;

    const result = await this.run(key, async () =>
      this.outbox.tx(async (session) => {
        const sub = (await this.db
          .collection<SubscriberDoc>('subscribers')
          .findOne({ _id: s._id }, { session }))!;
        let wallet;
        if (self) {
          // Any reseller in the customer's chain at or below the caller being suspended blocks recharges.
          await assertBranchOpen(this.db, tenantId, sub.ancestors, session);
          const w = await wallets(this.db).findOne({ ownerId: self, tenantId }, { session });
          if (!w) throw notFound('Wallet');
          wallet = { doc: w, resellerId: self, ...(await walletTerms(this.db, self, plan, session)) };
        }
        const expiresAt = b.override?.expiresOn ? istDayStart(b.override.expiresOn) : undefined;
        if (self && expiresAt) {
          const paidUntil = rechargePeriod(sub.expiresAt, plan.validityDays, b.quantity).end;
          if (endOfIstDay(expiresAt) > paidUntil) {
            throw new AppError(
              400,
              'VALIDATION_FAILED',
              `Valid until can be at most ${istDate(paidUntil)}: add periods to give more days`,
            );
          }
        }
        const cp = await customerPrice(this.db, sub.resellerId, plan, session);
        let paymentId: ObjectId | undefined;
        if (b.payment === 'cash') {
          paymentId = new ObjectId();
          const now = new Date();
          const p: PaymentDoc = {
            _id: paymentId,
            tenantId,
            subscriberId: sub._id,
            ancestors: sub.ancestors,
            method: 'cash',
            amountPaise: b.override?.customerTotalPaise ?? grossPrice(cp * b.quantity, plan.gstRatePercent),
            status: 'captured',
            purpose: { type: 'recharge', planId: plan._id },
            collectedBy: actor,
            capturedAt: now,
            settledAt: now,
            createdAt: now,
            updatedAt: now,
            createdBy: actor,
          };
          await payments(this.db).insertOne(p, { session });
        }
        const r = await performRecharge(this.db, session, {
          tenant,
          subscriber: sub,
          plan,
          channel: self ? 'reseller_wallet' : b.payment === 'cash' ? 'cash' : 'staff',
          ...(wallet ? { wallet } : {}),
          customerPricePaise: cp,
          quantity: b.quantity,
          invoice: b.payment !== 'none',
          ...(b.override
            ? {
                override: {
                  ...(b.override.customerTotalPaise !== undefined
                    ? { customerTotalPaise: b.override.customerTotalPaise }
                    : {}),
                  ...(expiresAt ? { expiresAt } : {}),
                  reason: b.override.reason,
                },
              }
            : {}),
          idempotencyKey: key,
          actor,
          ...(paymentId ? { paymentId } : {}),
        });
        if (paymentId && !r.replayed) {
          await payments(this.db).updateOne(
            { _id: paymentId },
            {
              $set: {
                rechargeId: r.recharge._id,
                ...(r.recharge.invoiceId ? { invoiceId: r.recharge.invoiceId } : {}),
              },
            },
            { session },
          );
        }
        return r;
      }),
    );
    if (!result.replayed) noteChange({ after: result.recharge, entityId: result.recharge._id });
    return { ...(await this.views(ctx, [result.recharge]))[0]!, replayed: result.replayed };
  }

  /** The same key sent twice at once: the loser's insert hits the unique key; answer with the winner's recharge. */
  private async run<T extends { recharge: RechargeDoc; replayed: boolean }>(
    key: string,
    fn: () => Promise<T>,
  ) {
    try {
      return await fn();
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
      const won = await recharges(this.db).findOne({ idempotencyKey: key });
      if (!won) throw e;
      return { recharge: won, subscriber: null, replayed: true } as unknown as T;
    }
  }

  async list(ctx: AuthContext, q: z.output<typeof listQuery>) {
    const f: Filter<RechargeDoc> = {};
    if (q.subscriberId) f.subscriberId = new ObjectId(q.subscriberId);
    if (q.siteResellerId) f.siteResellerId = new ObjectId(q.siteResellerId);
    if (q.channel) f.channel = q.channel;
    if (q.status) f.status = q.status;
    const range = istDayRange(q.from, q.to);
    if (range) f.createdAt = range;
    if (q.cursor) f._id = { $lt: new ObjectId(q.cursor) };
    const docs = await this.scoped(ctx)
      .collection<RechargeDoc>('recharges')
      .find(f, { sort: { _id: -1 }, limit: q.limit + 1 })
      .toArray();
    const views = new Map((await this.views(ctx, docs.slice(0, q.limit))).map((v) => [v.id, v]));
    return pageOf(docs, q.limit, (d) => views.get(d._id.toHexString())!);
  }

  async get(ctx: AuthContext, id: ObjectId) {
    const d = await this.scoped(ctx).collection<RechargeDoc>('recharges').findOne({ _id: id });
    if (!d) throw notFound('Recharge');
    return (await this.views(ctx, [d]))[0]!;
  }

  async refund(ctx: AuthContext, id: ObjectId, reason: string) {
    assertStaff(ctx, 'refund recharges');
    const tenantId = requireTenant(ctx);
    const d = await this.scoped(ctx).collection<RechargeDoc>('recharges').findOne({ _id: id });
    if (!d) throw notFound('Recharge');
    const tenant = (await this.db.collection<BillingTenant>('tenants').findOne({ _id: tenantId }))!;
    const u = await this.outbox.tx((session) =>
      reverseRecharge(this.db, session, { tenant, recharge: d, reason, actor: ctx.userId.toHexString() }),
    );
    noteChange({ before: d, after: u, entityId: id });
    return (await this.views(ctx, [u]))[0]!;
  }
}

@Controller('recharges')
export class RechargesController {
  constructor(@Inject(RechargesService) private readonly s: RechargesService) {}

  @Get('quote')
  @Endpoint({
    summary: 'What a recharge would cost and the new expiry, before doing it',
    tags: ['recharges'],
    permission: 'recharges.create',
    query: quoteQuery,
    response: quoteView,
  })
  quote(@Ctx() ctx: AuthContext, @Query() q: z.output<typeof quoteQuery>) {
    return this.s.quote(ctx, q);
  }

  @Post()
  @HttpCode(200)
  @Endpoint({
    summary:
      'Prepaid recharge. Reseller: debits its own wallet. Staff: cash or complimentary. Idempotency-Key required',
    tags: ['recharges'],
    audit: 'recharge.create',
    permission: 'recharges.create',
    body: createBody,
    response: rechargeView,
  })
  create(@Ctx() ctx: AuthContext, @Req() req: FastifyRequest, @Body() b: z.output<typeof createBody>) {
    return this.s.create(ctx, idempotencyKey(req, ctx), b);
  }

  @Get()
  @Endpoint({
    summary: 'Recharge history (a reseller sees its branch)',
    tags: ['recharges'],
    permission: 'billing.read',
    query: listQuery,
    response: page(rechargeView),
  })
  list(@Ctx() ctx: AuthContext, @Query() q: z.output<typeof listQuery>) {
    return this.s.list(ctx, q);
  }

  @Get(':id')
  @Endpoint({
    summary: 'One recharge',
    tags: ['recharges'],
    permission: 'billing.read',
    params: idParams,
    response: rechargeView,
  })
  get(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }) {
    return this.s.get(ctx, p.id);
  }

  @Post(':id/refund')
  @HttpCode(200)
  @Endpoint({
    summary: 'Reverse a recharge: REFUND entry, credit note, expiry rolled back (ISP staff)',
    tags: ['recharges'],
    audit: 'recharge.refund',
    permission: 'wallets.refund',
    params: idParams,
    body: refundBody,
    response: rechargeView,
  })
  refund(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }, @Body() b: z.output<typeof refundBody>) {
    return this.s.refund(ctx, p.id, b.reason);
  }
}
