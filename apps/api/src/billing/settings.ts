import { Body, Controller, Get, Inject, Injectable, Param, Patch, Put, Query } from '@nestjs/common';
import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import { FieldCrypto } from '@isp/shared';
import {
  billingOf,
  gatewayAad,
  invoices,
  notifications,
  recharges,
  wallets,
  type BillingTenant,
  type MessageTemplateDoc,
  type MongoHandle,
  type NotificationDoc,
  type TemplateKey,
} from '@isp/db-mongo';
import { noteChange } from '../audit/audit.js';
import type { AuthContext } from '../auth/context.js';
import { AppError } from '../errors.js';
import { Ctx, Endpoint } from '../http/endpoint.js';
import { page, pageOf, pageQuery } from '../http/schemas.js';
import { CONFIG, type Config } from '../config.js';
import { MONGO } from '../infra/infra.module.js';
import { assertStaff, requireTenant } from './common.js';

const KEYS = [
  'expiry_reminder',
  'expired',
  'payment_receipt',
  'invoice_issued',
  'overdue_suspended',
  'otp',
] as const;
/** Variables each template receives, in order (the DLT text must use {#var#} in the same order). */
export const TEMPLATE_VARS: Record<TemplateKey, string[]> = {
  expiry_reminder: ['customer name', 'expiry date', 'days left'],
  expired: ['customer name', 'expiry date'],
  payment_receipt: ['customer name', 'amount', 'plan or invoice', 'valid until / date', 'invoice number'],
  invoice_issued: ['customer name', 'invoice number', 'amount', 'due date'],
  overdue_suspended: ['customer name'],
  otp: ['code'],
};

const secret = z.string().trim().min(8).max(200);
const settingsBody = z
  .object({
    billing: z
      .object({
        invoicePrefix: z.string().regex(/^[A-Z0-9]{1,3}$/, 'must be 1–3 capital letters or digits'),
        reminderDaysBefore: z.array(z.number().int().min(1).max(30)).max(5),
        dueDays: z.number().int().min(0).max(60),
        graceDays: z.number().int().min(0).max(60),
        lowBalancePaise: z.number().int().min(0).max(1_000_000_000),
      })
      .partial()
      .optional(),
    razorpay: z
      .object({
        enabled: z.boolean(),
        keyId: z.string().trim().min(5).max(80),
        keySecret: secret,
        webhookSecret: secret,
      })
      .partial()
      .nullable()
      .optional(),
    cashfree: z
      .object({
        enabled: z.boolean(),
        sandbox: z.boolean(),
        appId: z.string().trim().min(5).max(120),
        secretKey: secret,
      })
      .partial()
      .nullable()
      .optional(),
    sms: z
      .object({
        enabled: z.boolean(),
        urlTemplate: z
          .string()
          .trim()
          .url()
          .refine((u) => u.startsWith('https://') || u.startsWith('http://'), 'must be an http(s) URL')
          .refine((u) => u.includes('{to}') && u.includes('{message}'), 'must contain {to} and {message}'),
        apiKey: secret,
        senderId: z
          .string()
          .trim()
          .regex(/^[A-Z]{6}$/, 'must be the 6-letter DLT header'),
        entityId: z.string().trim().max(30),
        successPattern: z.string().trim().max(100),
      })
      .partial()
      .nullable()
      .optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'nothing to change');

const settingsView = z.object({
  billing: z.object({
    invoicePrefix: z.string(),
    reminderDaysBefore: z.array(z.number()),
    dueDays: z.number(),
    graceDays: z.number(),
    lowBalancePaise: z.number(),
  }),
  razorpay: z.object({ enabled: z.boolean(), keyId: z.string(), webhookUrl: z.string() }).nullable(),
  cashfree: z
    .object({ enabled: z.boolean(), sandbox: z.boolean(), appId: z.string(), webhookUrl: z.string() })
    .nullable(),
  sms: z
    .object({
      enabled: z.boolean(),
      urlTemplate: z.string(),
      senderId: z.string(),
      entityId: z.string().nullable(),
      successPattern: z.string().nullable(),
      apiKeySet: z.boolean(),
    })
    .nullable(),
  webhookUrls: z.object({ razorpay: z.string(), cashfree: z.string() }),
});

const templateView = z.object({
  key: z.enum(KEYS),
  variables: z.array(z.string()),
  dltTemplateId: z.string().nullable(),
  body: z.string().nullable(),
  active: z.boolean(),
});
const templateBody = z.object({
  dltTemplateId: z
    .string()
    .trim()
    .regex(/^\d{10,25}$/, 'must be the numeric DLT template id'),
  body: z.string().trim().min(5).max(1000),
  active: z.boolean(),
});
const notifQuery = pageQuery.extend({ status: z.enum(['queued', 'sent', 'failed', 'skipped']).optional() });
const notifView = z.object({
  id: z.string(),
  to: z.string(),
  templateKey: z.enum(KEYS),
  status: z.enum(['queued', 'sent', 'failed', 'skipped']),
  attempts: z.number(),
  error: z.string().nullable(),
  createdAt: z.string(),
  sentAt: z.string().nullable(),
});
const summaryView = z.object({
  today: z.object({ recharges: z.number(), rechargePaise: z.number() }),
  month: z.object({ recharges: z.number(), invoicedPaise: z.number(), collectedPaise: z.number() }),
  unpaid: z.object({ count: z.number(), balancePaise: z.number(), overdue: z.number() }),
  wallets: z.object({ resellerBalancePaise: z.number(), low: z.number(), frozen: z.number() }),
  sms: z.object({ queued: z.number(), failed24h: z.number() }),
});

@Injectable()
export class BillingSettingsService {
  constructor(
    @Inject(MONGO) private readonly mongo: MongoHandle,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  private tenants() {
    return this.mongo.db.collection<BillingTenant>('tenants');
  }

  private hookUrls(tenantId: ObjectId) {
    const base = this.config.PUBLIC_BASE_URL.replace(/\/$/, '');
    return {
      razorpay: `${base}/api/v1/webhooks/razorpay/${tenantId.toHexString()}`,
      cashfree: `${base}/api/v1/webhooks/cashfree/${tenantId.toHexString()}`,
    };
  }

  async get(ctx: AuthContext) {
    const id = requireTenant(ctx);
    const t = (await this.tenants().findOne({ _id: id }))!;
    const urls = this.hookUrls(id);
    const g = t.gateways ?? {};
    return {
      billing: billingOf(t),
      razorpay: g.razorpay
        ? { enabled: g.razorpay.enabled, keyId: g.razorpay.keyId, webhookUrl: urls.razorpay }
        : null,
      cashfree: g.cashfree
        ? {
            enabled: g.cashfree.enabled,
            sandbox: g.cashfree.sandbox,
            appId: g.cashfree.appId,
            webhookUrl: urls.cashfree,
          }
        : null,
      sms: t.sms
        ? {
            enabled: t.sms.enabled,
            urlTemplate: t.sms.urlTemplate,
            senderId: t.sms.senderId,
            entityId: t.sms.entityId ?? null,
            successPattern: t.sms.successPattern ?? null,
            apiKeySet: !!t.sms.apiKey,
          }
        : null,
      webhookUrls: urls,
    };
  }

  /** Secrets are write-only: stored encrypted (AAD bound to the ISP and field), never returned. */
  async update(ctx: AuthContext, b: z.output<typeof settingsBody>) {
    assertStaff(ctx, 'change billing settings');
    const id = requireTenant(ctx);
    const t = (await this.tenants().findOne({ _id: id }))!;
    const set: Record<string, unknown> = { updatedAt: new Date(), updatedBy: ctx.userId.toHexString() };
    const unset: Record<string, ''> = {};
    if (b.billing) set.billing = { ...billingOf(t), ...b.billing };
    const enc = (v: string, f: string) => this.crypto.encrypt(v, gatewayAad(id, f));

    if (b.razorpay === null) unset['gateways.razorpay'] = '';
    else if (b.razorpay) {
      const cur = t.gateways?.razorpay;
      const next = {
        enabled: b.razorpay.enabled ?? cur?.enabled ?? false,
        keyId: b.razorpay.keyId ?? cur?.keyId,
        keySecret: b.razorpay.keySecret ? enc(b.razorpay.keySecret, 'razorpay.keySecret') : cur?.keySecret,
        webhookSecret: b.razorpay.webhookSecret
          ? enc(b.razorpay.webhookSecret, 'razorpay.webhookSecret')
          : cur?.webhookSecret,
      };
      if (!next.keyId || !next.keySecret || !next.webhookSecret) {
        throw new AppError(
          400,
          'VALIDATION_FAILED',
          'Razorpay needs the key id, key secret and webhook secret',
        );
      }
      set['gateways.razorpay'] = next;
    }
    if (b.cashfree === null) unset['gateways.cashfree'] = '';
    else if (b.cashfree) {
      const cur = t.gateways?.cashfree;
      const next = {
        enabled: b.cashfree.enabled ?? cur?.enabled ?? false,
        sandbox: b.cashfree.sandbox ?? cur?.sandbox ?? true,
        appId: b.cashfree.appId ?? cur?.appId,
        secretKey: b.cashfree.secretKey ? enc(b.cashfree.secretKey, 'cashfree.secretKey') : cur?.secretKey,
      };
      if (!next.appId || !next.secretKey) {
        throw new AppError(400, 'VALIDATION_FAILED', 'Cashfree needs the app id and secret key');
      }
      set['gateways.cashfree'] = next;
    }
    if (b.sms === null) unset.sms = '';
    else if (b.sms) {
      const cur = t.sms;
      const next = {
        enabled: b.sms.enabled ?? cur?.enabled ?? false,
        urlTemplate: b.sms.urlTemplate ?? cur?.urlTemplate,
        senderId: b.sms.senderId ?? cur?.senderId,
        ...((b.sms.entityId ?? cur?.entityId) ? { entityId: b.sms.entityId ?? cur?.entityId } : {}),
        ...((b.sms.successPattern ?? cur?.successPattern)
          ? { successPattern: b.sms.successPattern ?? cur?.successPattern }
          : {}),
        ...(b.sms.apiKey
          ? { apiKey: this.crypto.encrypt(b.sms.apiKey, `tenants.sms:${id.toHexString()}:apiKey`) }
          : cur?.apiKey
            ? { apiKey: cur.apiKey }
            : {}),
      };
      if (!next.urlTemplate || !next.senderId) {
        throw new AppError(400, 'VALIDATION_FAILED', 'SMS needs the provider URL and the sender id');
      }
      if (next.successPattern) {
        try {
          new RegExp(next.successPattern, 'i');
        } catch {
          throw new AppError(
            400,
            'VALIDATION_FAILED',
            'The success pattern is not a valid regular expression',
          );
        }
      }
      set.sms = next;
    }
    await this.tenants().updateOne(
      { _id: id },
      { $set: set, $inc: { version: 1 }, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
    );
    noteChange({
      before: { billing: t.billing, gateways: t.gateways, sms: t.sms },
      after: {
        billing: set.billing ?? t.billing,
        gateways: set['gateways.razorpay'] ?? set['gateways.cashfree'],
        sms: set.sms,
      },
      entityId: id,
    });
    return this.get(ctx);
  }

  async templates(ctx: AuthContext) {
    const id = requireTenant(ctx);
    const rows = await this.mongo.db
      .collection<MessageTemplateDoc>('message_templates')
      .find({ tenantId: id })
      .toArray();
    const m = new Map(rows.map((r) => [r.key, r]));
    return KEYS.map((key) => {
      const r = m.get(key);
      return {
        key,
        variables: TEMPLATE_VARS[key],
        dltTemplateId: r?.dltTemplateId ?? null,
        body: r?.body ?? null,
        active: r?.active ?? false,
      };
    });
  }

  async putTemplate(ctx: AuthContext, key: TemplateKey, b: z.output<typeof templateBody>) {
    assertStaff(ctx, 'change SMS templates');
    const id = requireTenant(ctx);
    const placeholders = (b.body.match(/\{#var#\}/gi) ?? []).length;
    if (placeholders > TEMPLATE_VARS[key].length) {
      throw new AppError(
        400,
        'VALIDATION_FAILED',
        `This template has at most ${TEMPLATE_VARS[key].length} {#var#} values`,
      );
    }
    await this.mongo.db.collection<MessageTemplateDoc>('message_templates').updateOne(
      { tenantId: id, key, channel: 'sms' },
      {
        $set: { ...b, updatedAt: new Date(), updatedBy: ctx.userId.toHexString() },
        $setOnInsert: { _id: new ObjectId(), tenantId: id, key, channel: 'sms' },
      },
      { upsert: true },
    );
    noteChange({ after: { key, ...b }, entityId: id });
    return (await this.templates(ctx)).find((t) => t.key === key)!;
  }

  async notifications(ctx: AuthContext, q: z.output<typeof notifQuery>) {
    const f: Filter<NotificationDoc> = { tenantId: requireTenant(ctx) };
    if (q.status) f.status = q.status;
    if (q.cursor) f._id = { $lt: new ObjectId(q.cursor) };
    const docs = await notifications(this.mongo.db)
      .find(f, { sort: { _id: -1 }, limit: q.limit + 1 })
      .toArray();
    return pageOf(docs, q.limit, (n) => ({
      id: n._id.toHexString(),
      to: n.to.replace(/^(\+91)?(\d{2})\d{6}(\d{2})$/, '$1$2••••••$3'),
      templateKey: n.templateKey,
      status: n.status,
      attempts: n.attempts,
      error: n.error ?? null,
      createdAt: n.createdAt.toISOString(),
      sentAt: n.sentAt?.toISOString() ?? null,
    }));
  }

  /** ISP billing overview for the admin dashboard; a few indexed aggregations. */
  async summary(ctx: AuthContext) {
    assertStaff(ctx, 'see the ISP billing summary');
    const tenantId = requireTenant(ctx);
    const now = new Date();
    const ist = new Date(now.getTime() + 330 * 60_000);
    const dayStart = new Date(
      Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 330 * 60_000,
    );
    const monthStart = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - 330 * 60_000);
    const db = this.mongo.db;
    const sum = async <T extends object>(col: string, pipeline: object[]) =>
      (await db.collection(col).aggregate<T>(pipeline).toArray())[0];
    const [today, month, invoiced, collected, unpaid, w, smsQueued, smsFailed] = await Promise.all([
      sum<{ n: number; s: number }>('recharges', [
        { $match: { tenantId, status: 'SUCCESS', createdAt: { $gte: dayStart } } },
        { $group: { _id: null, n: { $sum: 1 }, s: { $sum: '$customerPricePaise' } } },
      ]),
      recharges(db).countDocuments({ tenantId, status: 'SUCCESS', createdAt: { $gte: monthStart } }),
      sum<{ s: number }>('invoices', [
        { $match: { tenantId, issueDate: { $gte: monthStart }, status: { $ne: 'cancelled' } } },
        { $group: { _id: null, s: { $sum: '$totalPaise' } } },
      ]),
      sum<{ s: number }>('payments', [
        { $match: { tenantId, status: 'captured', capturedAt: { $gte: monthStart } } },
        { $group: { _id: null, s: { $sum: '$amountPaise' } } },
      ]),
      sum<{ n: number; s: number; o: number }>('invoices', [
        { $match: { tenantId, status: { $in: ['issued', 'partially_paid', 'overdue'] } } },
        {
          $group: {
            _id: null,
            n: { $sum: 1 },
            s: { $sum: '$balancePaise' },
            o: { $sum: { $cond: [{ $eq: ['$status', 'overdue'] }, 1, 0] } },
          },
        },
      ]),
      sum<{ s: number; low: number; frozen: number }>('wallets', [
        { $match: { tenantId, walletType: { $ne: 'MASTER' }, isActive: true } },
        {
          $group: {
            _id: null,
            s: { $sum: '$balancePaise' },
            low: { $sum: { $cond: [{ $lte: ['$balancePaise', '$lowBalanceThresholdPaise'] }, 1, 0] } },
            frozen: { $sum: { $cond: ['$frozen', 1, 0] } },
          },
        },
      ]),
      notifications(db).countDocuments({ tenantId, status: 'queued' }),
      notifications(db).countDocuments({
        tenantId,
        status: 'failed',
        createdAt: { $gte: new Date(now.getTime() - 86_400_000) },
      }),
    ]);
    void wallets;
    void invoices;
    return {
      today: { recharges: today?.n ?? 0, rechargePaise: today?.s ?? 0 },
      month: { recharges: month, invoicedPaise: invoiced?.s ?? 0, collectedPaise: collected?.s ?? 0 },
      unpaid: { count: unpaid?.n ?? 0, balancePaise: unpaid?.s ?? 0, overdue: unpaid?.o ?? 0 },
      wallets: { resellerBalancePaise: w?.s ?? 0, low: w?.low ?? 0, frozen: w?.frozen ?? 0 },
      sms: { queued: smsQueued, failed24h: smsFailed },
    };
  }
}

@Controller('billing')
export class BillingSettingsController {
  constructor(@Inject(BillingSettingsService) private readonly s: BillingSettingsService) {}

  @Get('settings')
  @Endpoint({
    summary: 'Billing, gateway and SMS settings (secrets never returned)',
    tags: ['billing'],
    permission: 'tenant.settings',
    response: settingsView,
  })
  get(@Ctx() ctx: AuthContext) {
    return this.s.get(ctx);
  }

  @Patch('settings')
  @Endpoint({
    summary: 'Change billing, gateway and SMS settings; null removes a gateway / SMS',
    tags: ['billing'],
    audit: 'tenant.billing_settings',
    permission: 'tenant.settings',
    body: settingsBody,
    response: settingsView,
  })
  update(@Ctx() ctx: AuthContext, @Body() b: z.output<typeof settingsBody>) {
    return this.s.update(ctx, b);
  }

  @Get('templates')
  @Endpoint({
    summary: 'SMS templates (DLT)',
    tags: ['billing'],
    permission: 'tenant.settings',
    response: z.array(templateView),
  })
  templates(@Ctx() ctx: AuthContext) {
    return this.s.templates(ctx);
  }

  @Put('templates/:key')
  @Endpoint({
    summary: 'Set one SMS template',
    tags: ['billing'],
    audit: 'tenant.sms_template',
    permission: 'tenant.settings',
    params: z.object({ key: z.enum(KEYS) }),
    body: templateBody,
    response: templateView,
  })
  putTemplate(
    @Ctx() ctx: AuthContext,
    @Param() p: { key: TemplateKey },
    @Body() b: z.output<typeof templateBody>,
  ) {
    return this.s.putTemplate(ctx, p.key, b);
  }

  @Get('notifications')
  @Endpoint({
    summary: 'SMS log',
    tags: ['billing'],
    permission: 'billing.read',
    query: notifQuery,
    response: page(notifView),
  })
  notifications(@Ctx() ctx: AuthContext, @Query() q: z.output<typeof notifQuery>) {
    return this.s.notifications(ctx, q);
  }

  @Get('summary')
  @Endpoint({
    summary: 'ISP billing overview',
    tags: ['billing'],
    permission: 'billing.read',
    response: summaryView,
  })
  summary(@Ctx() ctx: AuthContext) {
    return this.s.summary(ctx);
  }
}
