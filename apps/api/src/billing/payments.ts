import { Body, Controller, Get, HttpCode, Inject, Injectable, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import { FieldCrypto } from '@isp/shared';
import {
  ScopedDb,
  applyInvoicePayment,
  customerPrice,
  gatewayFor,
  grossPrice,
  payments,
  settlePayment,
  verifyCashfree,
  verifyRazorpay,
  webhookSecretFor,
  type BillingTenant,
  type InvoiceDoc,
  type MongoHandle,
  type PaymentDoc,
  type PlanDoc,
  type SubscriberDoc,
} from '@isp/db-mongo';
import { noteChange } from '../audit/audit.js';
import type { AuthContext } from '../auth/context.js';
import { AppError, notFound } from '../errors.js';
import { Ctx, Endpoint } from '../http/endpoint.js';
import { hexId, idParams, objectId, page, pageOf, pageQuery } from '../http/schemas.js';
import { MONGO } from '../infra/infra.module.js';
import { Outbox } from '../sync/outbox.js';
import { assertBranchOpen, idempotencyKey, istDayRange, requireTenant } from './common.js';

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date in YYYY-MM-DD form');
const cashBody = z.object({
  invoiceId: objectId,
  amountPaise: z.number().int().min(1).max(10_000_000_000),
  receiptNo: z.string().trim().max(40).optional(),
  note: z.string().trim().max(200).optional(),
});
const linkBody = z
  .object({
    subscriberId: objectId,
    gateway: z.enum(['razorpay', 'cashfree']),
    /** Recharge with this plan (prepaid), or pay this invoice. */
    planId: objectId.optional(),
    invoiceId: objectId.optional(),
  })
  .refine((b) => !!b.planId !== !!b.invoiceId, 'give either planId (recharge) or invoiceId');
const listQuery = pageQuery.extend({
  subscriberId: hexId.optional(),
  method: z.enum(['razorpay', 'cashfree', 'cash', 'wallet', 'bank_transfer']).optional(),
  status: z.enum(['created', 'pending', 'captured', 'failed', 'refunded']).optional(),
  from: isoDay.optional(),
  to: isoDay.optional(),
});
const paymentView = z.object({
  id: z.string(),
  subscriber: z.object({ id: z.string(), name: z.string(), customerNo: z.string() }),
  method: z.enum(['razorpay', 'cashfree', 'cash', 'wallet', 'bank_transfer']),
  amountPaise: z.number(),
  status: z.enum(['created', 'pending', 'captured', 'failed', 'refunded']),
  purpose: z.object({
    type: z.enum(['recharge', 'invoice']),
    planId: z.string().nullable(),
    invoiceId: z.string().nullable(),
  }),
  linkUrl: z.string().nullable(),
  gatewayPaymentId: z.string().nullable(),
  receiptNo: z.string().nullable(),
  failureReason: z.string().nullable(),
  rechargeId: z.string().nullable(),
  invoiceId: z.string().nullable(),
  capturedAt: z.string().nullable(),
  createdAt: z.string(),
});

const toView = (
  p: PaymentDoc,
  s?: Pick<SubscriberDoc, 'name' | 'customerNo'>,
): z.output<typeof paymentView> => ({
  id: p._id.toHexString(),
  subscriber: { id: p.subscriberId.toHexString(), name: s?.name ?? '—', customerNo: s?.customerNo ?? '' },
  method: p.method,
  amountPaise: p.amountPaise,
  status: p.status,
  purpose: {
    type: p.purpose.type,
    planId: p.purpose.planId?.toHexString() ?? null,
    invoiceId: p.purpose.invoiceId?.toHexString() ?? null,
  },
  linkUrl: p.gateway?.linkUrl ?? null,
  gatewayPaymentId: p.gateway?.paymentId ?? null,
  receiptNo: p.receiptNo ?? null,
  failureReason: p.failureReason ?? null,
  rechargeId: p.rechargeId?.toHexString() ?? null,
  invoiceId: p.invoiceId?.toHexString() ?? null,
  capturedAt: p.capturedAt?.toISOString() ?? null,
  createdAt: p.createdAt.toISOString(),
});

@Injectable()
export class PaymentsService {
  constructor(
    @Inject(MONGO) private readonly mongo: MongoHandle,
    @Inject(Outbox) private readonly outbox: Outbox,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
  ) {}

  private get db() {
    return this.mongo.db;
  }
  private scoped(ctx: AuthContext) {
    return new ScopedDb(this.db, ctx.scope);
  }

  private async withSubs(docs: PaymentDoc[]) {
    const ids = [...new Set(docs.map((d) => d.subscriberId.toHexString()))].map((x) => new ObjectId(x));
    const rows = await this.db
      .collection<SubscriberDoc>('subscribers')
      .find({ _id: { $in: ids } }, { projection: { name: 1, customerNo: 1 } })
      .toArray();
    const m = new Map(rows.map((r) => [r._id.toHexString(), r]));
    return (p: PaymentDoc) => toView(p, m.get(p.subscriberId.toHexString()));
  }

  async list(ctx: AuthContext, q: z.output<typeof listQuery>) {
    const f: Filter<PaymentDoc> = {};
    if (q.subscriberId) f.subscriberId = new ObjectId(q.subscriberId);
    if (q.method) f.method = q.method;
    if (q.status) f.status = q.status;
    const range = istDayRange(q.from, q.to);
    if (range) f.createdAt = range;
    if (q.cursor) f._id = { $lt: new ObjectId(q.cursor) };
    const docs = await this.scoped(ctx)
      .collection<PaymentDoc>('payments')
      .find(f, { sort: { _id: -1 }, limit: q.limit + 1 })
      .toArray();
    return pageOf(docs, q.limit, await this.withSubs(docs.slice(0, q.limit)));
  }

  async get(ctx: AuthContext, id: ObjectId) {
    const p = await this.scoped(ctx).collection<PaymentDoc>('payments').findOne({ _id: id });
    if (!p) throw notFound('Payment');
    return (await this.withSubs([p]))(p);
  }

  /** Cash received against an invoice (postpaid); reactivates an overdue-suspended customer once settled. */
  async cash(ctx: AuthContext, key: string, b: z.output<typeof cashBody>) {
    const tenantId = requireTenant(ctx);
    const inv = await this.scoped(ctx).collection<InvoiceDoc>('invoices').findOne({ _id: b.invoiceId });
    if (!inv) throw notFound('Invoice');
    if (b.amountPaise > inv.balancePaise) {
      throw new AppError(
        400,
        'VALIDATION_FAILED',
        `At most the balance due (${inv.balancePaise / 100} rupees)`,
      );
    }
    const prior = await payments(this.db).findOne({ idempotencyKey: key });
    if (prior) return (await this.withSubs([prior]))(prior);
    const actor = ctx.userId.toHexString();
    const p = await this.outbox.tx(async (session) => {
      const now = new Date();
      const doc: PaymentDoc = {
        _id: new ObjectId(),
        tenantId,
        subscriberId: inv.subscriberId,
        ancestors: inv.ancestors,
        method: 'cash',
        amountPaise: b.amountPaise,
        status: 'captured',
        purpose: { type: 'invoice', invoiceId: inv._id },
        idempotencyKey: key,
        collectedBy: actor,
        ...(b.receiptNo ? { receiptNo: b.receiptNo } : {}),
        ...(b.note ? { note: b.note } : {}),
        invoiceId: inv._id,
        capturedAt: now,
        settledAt: now,
        createdAt: now,
        updatedAt: now,
        createdBy: actor,
      };
      await payments(this.db).insertOne(doc, { session });
      await applyInvoicePayment(this.db, session, {
        tenantId,
        invoiceId: inv._id,
        amountPaise: b.amountPaise,
        actor,
        paymentId: doc._id,
      });
      return doc;
    });
    noteChange({ after: p, entityId: p._id });
    return (await this.withSubs([p]))(p);
  }

  /** Razorpay / Cashfree payment link for a recharge or an invoice; settled by webhook or the hourly check. */
  async link(ctx: AuthContext, b: z.output<typeof linkBody>) {
    const tenantId = requireTenant(ctx);
    const s = await this.scoped(ctx)
      .collection<SubscriberDoc>('subscribers')
      .findOne({ _id: b.subscriberId, status: { $ne: 'deleted' } });
    if (!s) throw notFound('Subscriber');
    const tenant = (await this.db.collection<BillingTenant>('tenants').findOne({ _id: tenantId }))!;
    let amount: number;
    let purposeText: string;
    let purpose: PaymentDoc['purpose'];
    if (b.planId) {
      if (s.billingType !== 'prepaid')
        throw new AppError(400, 'VALIDATION_FAILED', 'Postpaid customers pay invoices');
      await assertBranchOpen(this.db, tenantId, s.ancestors);
      const plan = await this.db
        .collection<PlanDoc>('plans')
        .findOne({ _id: b.planId, tenantId, status: 'active' });
      if (!plan || !plan.billingTypes.includes('prepaid')) throw notFound('Plan');
      amount = grossPrice(await customerPrice(this.db, s.resellerId, plan), plan.gstRatePercent);
      purposeText = `${plan.name} recharge for ${s.username ?? s.customerNo}`;
      purpose = { type: 'recharge', planId: plan._id };
    } else {
      const inv = await this.scoped(ctx)
        .collection<InvoiceDoc>('invoices')
        .findOne({ _id: b.invoiceId!, subscriberId: s._id });
      if (!inv || inv.balancePaise <= 0)
        throw new AppError(400, 'VALIDATION_FAILED', 'Nothing is due on this invoice');
      amount = inv.balancePaise;
      purposeText = `Invoice ${inv.number}`;
      purpose = { type: 'invoice', invoiceId: inv._id };
    }
    const gw = gatewayFor(tenant, b.gateway, this.crypto);
    const now = new Date();
    const id = new ObjectId();
    const link = await gw.createLink({
      ref: id.toHexString(),
      amountPaise: amount,
      purpose: purposeText,
      customer: { name: s.name, phone: s.phone },
      expiresAt: new Date(now.getTime() + 7 * 86_400_000),
    });
    const doc: PaymentDoc = {
      _id: id,
      tenantId,
      subscriberId: s._id,
      ancestors: s.ancestors,
      method: b.gateway,
      amountPaise: amount,
      status: 'created',
      purpose,
      gateway: { linkId: link.linkId, linkUrl: link.url },
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId.toHexString(),
    };
    await payments(this.db).insertOne(doc);
    noteChange({ after: doc, entityId: id });
    return (await this.withSubs([doc]))(doc);
  }
}

interface WebhookEvent {
  linkId?: string | undefined;
  ref?: string | undefined;
  gatewayPaymentId?: string | undefined;
  amountPaise?: number | undefined;
  method?: string | undefined;
  success: boolean;
  event: string;
}

const rzpBody = z.object({
  event: z.string(),
  payload: z
    .object({
      payment: z
        .object({
          entity: z.object({
            id: z.string(),
            amount: z.number().optional(),
            method: z.string().optional(),
            notes: z.union([z.object({ ref: z.string().optional() }), z.array(z.unknown())]).optional(),
          }),
        })
        .optional(),
      payment_link: z
        .object({ entity: z.object({ id: z.string(), reference_id: z.string().optional() }) })
        .optional(),
    })
    .optional(),
});
const cfBody = z.object({
  type: z.string(),
  data: z
    .object({
      link_id: z.string().optional(),
      link_status: z.string().optional(),
      link_amount_paid: z.union([z.number(), z.string()]).optional(),
      order: z
        .object({ order_id: z.string().optional(), order_tags: z.record(z.string(), z.string()).nullish() })
        .optional(),
      payment: z
        .object({
          cf_payment_id: z.union([z.number(), z.string()]).optional(),
          payment_status: z.string().optional(),
          payment_amount: z.union([z.number(), z.string()]).optional(),
          payment_group: z.string().optional(),
        })
        .optional(),
    })
    .default({}),
});

function parseRazorpay(body: unknown): WebhookEvent {
  const b = rzpBody.safeParse(body);
  if (!b.success) return { success: false, event: 'unparsed' };
  const payment = b.data.payload?.payment?.entity;
  const link = b.data.payload?.payment_link?.entity;
  const notes = payment?.notes && !Array.isArray(payment.notes) ? payment.notes : undefined;
  return {
    linkId: link?.id,
    ref: link?.reference_id ?? notes?.ref,
    gatewayPaymentId: payment?.id,
    amountPaise: payment?.amount,
    method: payment?.method,
    success: b.data.event === 'payment_link.paid' || b.data.event === 'payment.captured',
    event: b.data.event,
  };
}

function parseCashfree(body: unknown): WebhookEvent {
  const b = cfBody.safeParse(body);
  if (!b.success) return { success: false, event: 'unparsed' };
  const { type: event, data: d } = b.data;
  const linkId = d.link_id ?? d.order?.order_tags?.link_id;
  const ok =
    event === 'PAYMENT_SUCCESS_WEBHOOK' ? d.payment?.payment_status === 'SUCCESS' : d.link_status === 'PAID';
  const amount = d.payment?.payment_amount ?? d.link_amount_paid;
  return {
    linkId,
    ref: linkId,
    gatewayPaymentId:
      d.payment?.cf_payment_id !== undefined ? String(d.payment.cf_payment_id) : d.order?.order_id,
    amountPaise: amount !== undefined ? Math.round(Number(amount) * 100) : undefined,
    method: d.payment?.payment_group,
    success: (event === 'PAYMENT_SUCCESS_WEBHOOK' || event === 'PAYMENT_LINK_EVENT') && ok,
    event,
  };
}

/**
 * Webhook handling (TRD §6.6): verify the signature on the raw body (constant time), find our payment, confirm
 * the status with the gateway's API, then settle exactly once. Duplicates answer 200 with no action; a failed
 * payment only records the event.
 */
@Injectable()
export class WebhooksService {
  constructor(
    @Inject(MONGO) private readonly mongo: MongoHandle,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
  ) {}

  async handle(method: 'razorpay' | 'cashfree', tenantId: ObjectId, req: FastifyRequest) {
    const tenant = await this.mongo.db.collection<BillingTenant>('tenants').findOne({ _id: tenantId });
    const secret = tenant ? webhookSecretFor(tenant, method, this.crypto) : null;
    const raw = (req as FastifyRequest & { rawBody?: Buffer }).rawBody?.toString('utf8') ?? '';
    const sig = (h: string) => (typeof req.headers[h] === 'string' ? (req.headers[h] as string) : undefined);
    const valid =
      !!secret &&
      (method === 'razorpay'
        ? verifyRazorpay(raw, sig('x-razorpay-signature'), secret)
        : verifyCashfree(raw, sig('x-webhook-signature'), sig('x-webhook-timestamp'), secret));
    if (!valid) throw new AppError(401, 'UNAUTHENTICATED', 'Bad webhook signature');

    const e = method === 'razorpay' ? parseRazorpay(req.body) : parseCashfree(req.body);
    const refs = [
      ...(e.ref && ObjectId.isValid(e.ref) ? [{ _id: new ObjectId(e.ref) }] : []),
      ...(e.linkId ? [{ 'gateway.linkId': e.linkId }] : []),
    ];
    // Dashboard "test" deliveries and unrelated events carry no link: acknowledge them.
    if (!refs.length) return { ok: true as const, action: 'ignored' };
    const p = await payments(this.mongo.db).findOne({
      tenantId,
      method,
      $or: refs,
    });
    if (!p) return { ok: true as const, action: 'ignored' };
    if (!e.success) {
      await payments(this.mongo.db).updateOne(
        { _id: p._id, status: { $in: ['created', 'pending'] } },
        {
          $push: {
            rawEvents: {
              at: new Date(),
              event: e.event,
              ...(e.gatewayPaymentId ? { id: e.gatewayPaymentId } : {}),
            },
          },
        },
      );
      return { ok: true as const, action: 'recorded' };
    }
    if (p.settledAt) return { ok: true as const, action: 'duplicate' };
    // Never trust the webhook body for money: ask the gateway.
    const status = await gatewayFor(tenant!, method, this.crypto).linkStatus(p.gateway!.linkId!);
    if (!status.paid) return { ok: true as const, action: 'not_paid' };
    const r = await settlePayment(this.mongo.client, this.mongo.db, {
      paymentId: p._id,
      gatewayPaymentId: status.paymentId ?? e.gatewayPaymentId ?? p.gateway!.linkId!,
      amountPaise: status.amountPaidPaise,
      ...(status.method || e.method ? { method: (status.method ?? e.method)! } : {}),
      event: e.event,
    });
    return { ok: true as const, action: r.settled ? 'settled' : 'duplicate' };
  }
}

@Controller()
export class PaymentsController {
  constructor(
    @Inject(PaymentsService) private readonly s: PaymentsService,
    @Inject(WebhooksService) private readonly hooks: WebhooksService,
  ) {}

  @Get('payments')
  @Endpoint({
    summary: 'Payments: cash and online (a reseller sees its branch)',
    tags: ['billing'],
    permission: 'billing.read',
    query: listQuery,
    response: page(paymentView),
  })
  list(@Ctx() ctx: AuthContext, @Query() q: z.output<typeof listQuery>) {
    return this.s.list(ctx, q);
  }

  @Get('payments/:id')
  @Endpoint({
    summary: 'One payment',
    tags: ['billing'],
    permission: 'billing.read',
    params: idParams,
    response: paymentView,
  })
  get(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }) {
    return this.s.get(ctx, p.id);
  }

  @Post('payments/cash')
  @HttpCode(200)
  @Endpoint({
    summary: 'Cash received against an invoice. Idempotency-Key header required',
    tags: ['billing'],
    audit: 'payment.cash',
    permission: 'billing.cash',
    body: cashBody,
    response: paymentView,
  })
  cash(@Ctx() ctx: AuthContext, @Req() req: FastifyRequest, @Body() b: z.output<typeof cashBody>) {
    return this.s.cash(ctx, idempotencyKey(req, ctx), b);
  }

  @Post('payments/link')
  @HttpCode(200)
  @Endpoint({
    summary: 'Online payment link (Razorpay or Cashfree) for a recharge or an invoice',
    tags: ['billing'],
    audit: 'payment.link',
    permission: 'recharges.create',
    body: linkBody,
    response: paymentView,
  })
  link(@Ctx() ctx: AuthContext, @Body() b: z.output<typeof linkBody>) {
    return this.s.link(ctx, b);
  }

  @Post('webhooks/razorpay/:id')
  @HttpCode(200)
  @Endpoint({
    summary: 'Razorpay webhook (signature verified; :id = the ISP id shown in billing settings)',
    tags: ['webhooks'],
    auth: 'public',
    csrf: false,
    params: idParams,
  })
  razorpay(@Req() req: FastifyRequest, @Param() p: { id: ObjectId }) {
    return this.hooks.handle('razorpay', p.id, req);
  }

  @Post('webhooks/cashfree/:id')
  @HttpCode(200)
  @Endpoint({
    summary: 'Cashfree webhook (signature verified; :id = the ISP id shown in billing settings)',
    tags: ['webhooks'],
    auth: 'public',
    csrf: false,
    params: idParams,
  })
  cashfree(@Req() req: FastifyRequest, @Param() p: { id: ObjectId }) {
    return this.hooks.handle('cashfree', p.id, req);
  }
}
