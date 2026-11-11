import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import {
  ScopedDb,
  grossPrice,
  payments,
  rates,
  type BillingTenant,
  type InvoiceDoc,
  type MongoHandle,
  type PaymentDoc,
  type PlanDoc,
  type SubscriberDoc,
} from '@isp/db-mongo';
import { clientMeta } from '../auth/auth.controller.js';
import type { AuthContext } from '../auth/context.js';
import { RateLimiter } from '../auth/rate-limit.js';
import { InvoicesService, invoiceView } from '../billing/invoices.js';
import { PaymentsService, paymentView, toPaymentView } from '../billing/payments.js';
import { AppError, notFound, tooMany } from '../errors.js';
import { Ctx, Endpoint } from '../http/endpoint.js';
import { idParams, objectId, okResponse, page, pageOf, pageQuery } from '../http/schemas.js';
import { MONGO } from '../infra/infra.module.js';
import { SessionsService } from '../sessions/sessions.js';
import { PortalAuth } from './portal-auth.js';

const loginBody = z.object({
  tenant: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,39}$/i)
    .optional(),
  /** PPPoE username or customer number. */
  login: z.string().trim().min(3).max(64),
  password: z.string().min(1).max(256),
});
const loginView = z.object({ ok: z.literal(true), csrfToken: z.string() });
const passwordBody = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z
    .string()
    .min(8, 'must be at least 8 characters')
    .max(128)
    .refine((p) => new Set(p).size >= 4, 'is too repetitive'),
});
const gateway = z.enum(['razorpay', 'cashfree']);
const payBody = z
  .object({
    /** Recharge (prepaid) with this plan; a different plan than today's is a plan change from now on. */
    planId: objectId.optional(),
    invoiceId: objectId.optional(),
    gateway: gateway.optional(),
  })
  .refine((b) => !!b.planId !== !!b.invoiceId, 'give either planId (recharge) or invoiceId');

const planView = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  downloadKbps: z.number(),
  uploadKbps: z.number(),
  dataCapBytes: z.number().nullable(),
  validityDays: z.number(),
  /** What the customer pays, GST included. */
  pricePaise: z.number(),
  current: z.boolean(),
});
const meView = z.object({
  name: z.string(),
  customerNo: z.string(),
  username: z.string().nullable(),
  phone: z.string(),
  email: z.string().nullable(),
  city: z.string(),
  billingType: z.enum(['prepaid', 'postpaid']),
  status: z.enum(['active', 'suspended', 'disabled', 'deleted']),
  /** Prepaid validity over: still connected at the slow "expired" speed until a recharge. */
  expired: z.boolean(),
  suspendReason: z.string().nullable(),
  expiresAt: z.string().nullable(),
  plan: planView.nullable(),
  dueInvoices: z.number(),
  duePaise: z.number(),
  gateways: z.array(gateway),
  hasPortalPassword: z.boolean(),
  isp: z.object({ name: z.string(), phone: z.string().nullable(), email: z.string().nullable() }),
});
const usageView = z.object({
  days: z.array(
    z.object({
      day: z.string(),
      uploadBytes: z.number(),
      downloadBytes: z.number(),
      sessionSecs: z.number(),
    }),
  ),
  cycle: z
    .object({
      start: z.string().nullable(),
      usedBytes: z.number(),
      capBytes: z.number(),
      fupActive: z.boolean(),
    })
    .nullable(),
});
const sessionView = z.object({
  start: z.string(),
  stop: z.string().nullable(),
  ip: z.string().nullable(),
  uploadBytes: z.number(),
  downloadBytes: z.number(),
  online: z.boolean(),
});

/** At most this many new payment links per customer per hour (each one is a gateway API call). */
const LINKS_PER_HOUR = 10;
/** An unpaid link for the same thing made within this window is handed back instead of a new one. */
const REUSE_LINK_MS = 30 * 60_000;
const UNPAID = ['issued', 'partially_paid', 'overdue'] as const;

@Injectable()
export class PortalService {
  constructor(
    @Inject(MONGO) private readonly mongo: MongoHandle,
    @Inject(InvoicesService) private readonly invoices: InvoicesService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  private get db() {
    return this.mongo.db;
  }

  private async self(ctx: AuthContext): Promise<SubscriberDoc> {
    const s = await this.db
      .collection<SubscriberDoc>('subscribers')
      .findOne({ _id: ctx.subscriberId!, tenantId: ctx.tenantId!, status: { $ne: 'deleted' } });
    if (!s) throw notFound('Account');
    return s;
  }

  /** Plans this customer may buy (or is on), with their own price incl. GST. One query for the owner's rates. */
  private async priced(s: SubscriberDoc, plans: PlanDoc[]): Promise<z.output<typeof planView>[]> {
    const own = s.resellerId
      ? await rates(this.db)
          .find({ buyerId: s.resellerId, planId: { $in: plans.map((p) => p._id) } })
          .toArray()
      : [];
    const byPlan = new Map(own.map((r) => [r.planId.toHexString(), r]));
    return plans.flatMap((p) => {
      const r = byPlan.get(p._id.toHexString());
      const current = !!s.planId?.equals(p._id);
      if (r && !r.active && !current) return [];
      return [
        {
          id: p._id.toHexString(),
          name: p.name,
          description: p.description ?? null,
          downloadKbps: p.downloadKbps,
          uploadKbps: p.uploadKbps,
          dataCapBytes: p.dataCapBytes ?? null,
          validityDays: p.validityDays,
          pricePaise: grossPrice(r?.customerPricePaise ?? p.pricePaise, p.gstRatePercent),
          current,
        },
      ];
    });
  }

  async me(ctx: AuthContext): Promise<z.output<typeof meView>> {
    const s = await this.self(ctx);
    const [tenant, plan, due] = await Promise.all([
      this.db
        .collection<BillingTenant>('tenants')
        .findOne({ _id: s.tenantId }, { projection: { name: 1, contact: 1, gateways: 1 } }),
      s.planId ? this.db.collection<PlanDoc>('plans').findOne({ _id: s.planId, tenantId: s.tenantId }) : null,
      this.db
        .collection<InvoiceDoc>('invoices')
        .aggregate<{ n: number; paise: number }>([
          { $match: { tenantId: s.tenantId, subscriberId: s._id, status: { $in: [...UNPAID] } } },
          { $group: { _id: null, n: { $sum: 1 }, paise: { $sum: '$balancePaise' } } },
        ])
        .next(),
    ]);
    const g = tenant?.gateways;
    return {
      name: s.name,
      customerNo: s.customerNo,
      username: s.username ?? null,
      phone: s.phone,
      email: s.email ?? null,
      city: s.address.city,
      billingType: s.billingType,
      status: s.status,
      suspendReason: s.suspendReason ?? null,
      expired: s.billingType === 'prepaid' && (!s.expiresAt || s.expiresAt <= new Date()),
      expiresAt: s.expiresAt?.toISOString() ?? null,
      plan: plan ? ((await this.priced(s, [plan]))[0] ?? null) : null,
      dueInvoices: due?.n ?? 0,
      duePaise: due?.paise ?? 0,
      gateways: [
        ...(g?.razorpay?.enabled ? (['razorpay'] as const) : []),
        ...(g?.cashfree?.enabled ? (['cashfree'] as const) : []),
      ],
      hasPortalPassword: !!s.portal?.passwordHash,
      isp: {
        name: tenant?.name ?? '',
        phone: tenant?.contact?.phone ?? null,
        email: tenant?.contact?.email ?? null,
      },
    };
  }

  async plans(ctx: AuthContext) {
    const s = await this.self(ctx);
    const plans = await this.db
      .collection<PlanDoc>('plans')
      .find(
        {
          tenantId: s.tenantId,
          $or: [{ status: 'active', billingTypes: s.billingType }, ...(s.planId ? [{ _id: s.planId }] : [])],
        },
        { sort: { pricePaise: 1, name: 1 }, limit: 100 },
      )
      .toArray();
    return { items: await this.priced(s, plans) };
  }

  usage(ctx: AuthContext) {
    return this.sessions.usage(ctx, ctx.subscriberId!, {});
  }

  async recentSessions(ctx: AuthContext) {
    const r = await this.sessions.history(ctx, ctx.subscriberId!, { limit: 10 });
    return {
      items: r.items.map((x) => ({
        start: x.startedAt,
        stop: x.stoppedAt,
        ip: x.framedIp,
        uploadBytes: x.uploadBytes,
        downloadBytes: x.downloadBytes,
        online: x.stoppedAt === null && !x.stale,
      })),
    };
  }

  async invoiceList(ctx: AuthContext, q: z.output<typeof pageQuery>) {
    const f: Filter<InvoiceDoc> = { tenantId: ctx.tenantId!, subscriberId: ctx.subscriberId! };
    if (q.cursor) f._id = { $lt: new ObjectId(q.cursor) };
    const docs = await this.db
      .collection<InvoiceDoc>('invoices')
      .find(f, { sort: { _id: -1 }, limit: q.limit + 1 })
      .toArray();
    return pageOf(docs, q.limit, (d) => this.invoices.view(d));
  }

  async invoicePdf(ctx: AuthContext, id: ObjectId) {
    const d = await this.db
      .collection<InvoiceDoc>('invoices')
      .findOne({ _id: id, tenantId: ctx.tenantId!, subscriberId: ctx.subscriberId! });
    if (!d) throw notFound('Invoice');
    return this.invoices.pdfOf(d);
  }

  async paymentList(ctx: AuthContext, q: z.output<typeof pageQuery>) {
    const f: Filter<PaymentDoc> = { tenantId: ctx.tenantId!, subscriberId: ctx.subscriberId! };
    if (q.cursor) f._id = { $lt: new ObjectId(q.cursor) };
    const docs = await payments(this.db)
      .find(f, { sort: { _id: -1 }, limit: q.limit + 1 })
      .toArray();
    return pageOf(docs, q.limit, (p) => toPaymentView(p));
  }

  /** Online payment link for the signed-in customer: a recharge (optionally on another plan) or an invoice. */
  async pay(ctx: AuthContext, b: z.output<typeof payBody>) {
    const s = await this.self(ctx);
    const tenant = await this.db
      .collection<BillingTenant>('tenants')
      .findOne({ _id: s.tenantId }, { projection: { gateways: 1 } });
    const enabled = (['razorpay', 'cashfree'] as const).filter((m) => tenant?.gateways?.[m]?.enabled);
    const method = b.gateway ?? enabled[0];
    if (!method || !enabled.includes(method)) {
      throw new AppError(409, 'GATEWAY_ERROR', 'Online payment is not available. Contact your provider.');
    }
    const purpose = b.planId
      ? { 'purpose.type': 'recharge' as const, 'purpose.planId': b.planId }
      : { 'purpose.type': 'invoice' as const, 'purpose.invoiceId': b.invoiceId! };
    const open = await payments(this.db).findOne(
      {
        tenantId: s.tenantId,
        subscriberId: s._id,
        method,
        status: 'created',
        createdAt: { $gt: new Date(Date.now() - REUSE_LINK_MS) },
        ...purpose,
      },
      { sort: { _id: -1 } },
    );
    if (open?.gateway?.linkUrl) return toPaymentView(open);

    const hit = await this.limiter.hit(`portal:links:${s._id.toHexString()}`, 3600);
    if (hit.count > LINKS_PER_HOUR) throw tooMany(hit.retryAfterSecs);
    const doc = await this.payments.createLink(
      s,
      { gateway: method, planId: b.planId, invoiceId: b.invoiceId },
      `customer:${s._id.toHexString()}`,
    );
    return toPaymentView(doc);
  }
}

@Controller('portal')
export class PortalController {
  constructor(
    @Inject(PortalService) private readonly s: PortalService,
    @Inject(PortalAuth) private readonly auth: PortalAuth,
  ) {}

  @Post('auth/login')
  @HttpCode(200)
  @Endpoint({
    summary:
      'Customer sign-in: PPPoE username (or customer no.) and portal password, else the PPPoE password',
    tags: ['portal'],
    auth: 'public',
    body: loginBody,
    response: loginView,
  })
  async login(
    @Body() b: z.output<typeof loginBody>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const r = await this.auth.login(b, clientMeta(req));
    this.auth.setCookies(reply, r.token, r.csrf);
    return { ok: true as const, csrfToken: r.csrf };
  }

  @Post('auth/logout')
  @HttpCode(200)
  @Endpoint({
    summary: 'Sign out of the portal on this device',
    tags: ['portal'],
    auth: 'portal',
    audit: 'portal.logout',
    response: okResponse,
  })
  async logout(@Ctx() ctx: AuthContext, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.auth.logout(new ObjectId(ctx.familyId));
    this.auth.clearCookies(reply);
    return { ok: true as const };
  }

  @Post('password')
  @HttpCode(200)
  @Endpoint({
    summary: 'Set or change the portal password (signs out other devices)',
    tags: ['portal'],
    auth: 'portal',
    audit: 'portal.password_change',
    body: passwordBody,
    response: okResponse,
  })
  async password(@Ctx() ctx: AuthContext, @Body() b: z.output<typeof passwordBody>) {
    await this.auth.setPassword(ctx, b.currentPassword, b.newPassword);
    return { ok: true as const };
  }

  @Get('me')
  @Endpoint({ summary: 'The signed-in customer', tags: ['portal'], auth: 'portal', response: meView })
  me(@Ctx() ctx: AuthContext) {
    return this.s.me(ctx);
  }

  @Get('plans')
  @Endpoint({
    summary: 'Plans this customer can recharge with (price incl. GST)',
    tags: ['portal'],
    auth: 'portal',
    response: z.object({ items: z.array(planView) }),
  })
  plans(@Ctx() ctx: AuthContext) {
    return this.s.plans(ctx);
  }

  @Get('usage')
  @Endpoint({
    summary: 'Daily data usage (last 31 IST days) and data-cap cycle',
    tags: ['portal'],
    auth: 'portal',
    response: usageView,
  })
  usage(@Ctx() ctx: AuthContext) {
    return this.s.usage(ctx);
  }

  @Get('sessions')
  @Endpoint({
    summary: 'Last 10 connections',
    tags: ['portal'],
    auth: 'portal',
    response: z.object({ items: z.array(sessionView) }),
  })
  recentSessions(@Ctx() ctx: AuthContext) {
    return this.s.recentSessions(ctx);
  }

  @Get('invoices')
  @Endpoint({
    summary: 'Own invoices, newest first',
    tags: ['portal'],
    auth: 'portal',
    query: pageQuery,
    response: page(invoiceView),
  })
  invoices(@Ctx() ctx: AuthContext, @Query() q: z.output<typeof pageQuery>) {
    return this.s.invoiceList(ctx, q);
  }

  @Get('invoices/:id/pdf')
  @Endpoint({ summary: 'Own invoice as PDF', tags: ['portal'], auth: 'portal', params: idParams })
  async invoicePdf(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }, @Res() reply: FastifyReply) {
    const { name, data } = await this.s.invoicePdf(ctx, p.id);
    void reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="${name}"`)
      .header('cache-control', 'private, no-store')
      .send(data);
  }

  @Get('payments')
  @Endpoint({
    summary: 'Own payments, newest first',
    tags: ['portal'],
    auth: 'portal',
    query: pageQuery,
    response: page(paymentView),
  })
  paymentList(@Ctx() ctx: AuthContext, @Query() q: z.output<typeof pageQuery>) {
    return this.s.paymentList(ctx, q);
  }

  @Post('pay')
  @HttpCode(200)
  @Endpoint({
    summary: 'Online payment link: recharge (prepaid, any allowed plan) or an invoice',
    tags: ['portal'],
    auth: 'portal',
    audit: 'payment.link',
    body: payBody,
    response: paymentView,
  })
  pay(@Ctx() ctx: AuthContext, @Body() b: z.output<typeof payBody>) {
    return this.s.pay(ctx, b);
  }
}

/** Staff side of the portal. */
@Controller('subscribers')
export class PortalAdminController {
  constructor(
    @Inject(MONGO) private readonly mongo: MongoHandle,
    @Inject(PortalAuth) private readonly auth: PortalAuth,
  ) {}

  @Post(':id/portal-reset')
  @HttpCode(200)
  @Endpoint({
    summary: 'Portal sign-in back to the PPPoE password; signs the customer out of the portal everywhere',
    tags: ['subscribers'],
    permission: 'subscribers.write',
    audit: 'subscriber.portal_reset',
    params: idParams,
    response: okResponse,
  })
  async reset(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }) {
    const s = await new ScopedDb(this.mongo.db, ctx.scope)
      .collection<SubscriberDoc>('subscribers')
      .findOne({ _id: p.id, status: { $ne: 'deleted' } }, { projection: { _id: 1 } });
    if (!s) throw notFound('Subscriber');
    await this.auth.reset(s._id);
    return { ok: true as const };
  }
}
