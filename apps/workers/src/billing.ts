import type { Db, MongoClient } from 'mongodb';
import type { Logger } from 'pino';
import type { FieldCrypto } from '@isp/shared';
import {
  fillTemplate,
  gatewayFor,
  notifications,
  payments,
  settlePayment,
  type BillingTenant,
  type MessageTemplateDoc,
  type NotificationDoc,
} from '@isp/db-mongo';

const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000];
const MAX_ATTEMPTS = 3;
const BATCH = 50;
const SEND_TIMEOUT_MS = 10_000;

/**
 * SMS queue (TRD §6.8): claims due rows with a short lock, fills the tenant's DLT template, calls the provider's
 * HTTP API and records the outcome; 3 attempts with backoff, then `failed`. Not set up → `skipped` with the reason.
 */
export class SmsSender {
  constructor(
    private readonly db: Db,
    private readonly crypto: FieldCrypto,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async run(): Promise<Record<string, number>> {
    const counts = { sent: 0, failed: 0, retried: 0, skipped: 0 };
    const tenants = new Map<string, BillingTenant | null>();
    const templates = new Map<string, MessageTemplateDoc | null>();
    for (let i = 0; i < BATCH; i++) {
      const now = new Date();
      const n = await notifications(this.db).findOneAndUpdate(
        {
          status: 'queued',
          nextAttemptAt: { $lte: now },
          $or: [{ lockedUntil: { $exists: false } }, { lockedUntil: { $lt: now } }],
        },
        { $set: { lockedUntil: new Date(now.getTime() + 60_000) } },
        { sort: { nextAttemptAt: 1 }, returnDocument: 'after' },
      );
      if (!n) break;
      const tk = n.tenantId.toHexString();
      if (!tenants.has(tk))
        tenants.set(tk, await this.db.collection<BillingTenant>('tenants').findOne({ _id: n.tenantId }));
      const tplKey = `${tk}:${n.templateKey}`;
      if (!templates.has(tplKey)) {
        templates.set(
          tplKey,
          await this.db
            .collection<MessageTemplateDoc>('message_templates')
            .findOne({ tenantId: n.tenantId, key: n.templateKey, channel: 'sms' }),
        );
      }
      const outcome = await this.send(n, tenants.get(tk) ?? null, templates.get(tplKey) ?? null);
      counts[outcome]++;
    }
    return counts;
  }

  private async finish(n: NotificationDoc, set: Partial<NotificationDoc>) {
    await notifications(this.db).updateOne({ _id: n._id }, { $set: set, $unset: { lockedUntil: '' } });
  }

  private async send(
    n: NotificationDoc,
    t: BillingTenant | null,
    tpl: MessageTemplateDoc | null,
  ): Promise<'sent' | 'failed' | 'retried' | 'skipped'> {
    const sms = t?.sms;
    if (!sms?.enabled)
      return this.finish(n, { status: 'skipped', error: 'SMS is not set up' }).then(() => 'skipped');
    if (!tpl?.active) {
      return this.finish(n, { status: 'skipped', error: `No active ${n.templateKey} template` }).then(
        () => 'skipped',
      );
    }
    const message = fillTemplate(tpl.body, n.vars);
    const apiKey = sms.apiKey
      ? this.crypto.decrypt(sms.apiKey, `tenants.sms:${n.tenantId.toHexString()}:apiKey`)
      : '';
    const to = n.to.replace(/^\+/, '');
    // Indian 10-digit number for providers that want it without the country code (RapidSMS `mobileno`).
    const mobile = to.replace(/^91(?=\d{10}$)/, '');
    const values: Record<string, string> = {
      apiKey,
      sender: sms.senderId,
      entityId: sms.entityId ?? '',
      templateId: tpl.dltTemplateId,
      to,
      mobile,
      message,
    };
    const url = sms.urlTemplate.replace(
      /\{(apiKey|sender|entityId|templateId|to|mobile|message)\}/g,
      (_m, k: string) => encodeURIComponent(values[k] ?? ''),
    );
    const attempts = n.attempts + 1;
    try {
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
      const body = (await res.text()).slice(0, 500);
      const ok = res.ok && (!sms.successPattern || new RegExp(sms.successPattern, 'i').test(body));
      if (ok) {
        await this.finish(n, {
          status: 'sent',
          attempts,
          sentAt: new Date(),
          providerMessageId: body.slice(0, 100),
        });
        return 'sent';
      }
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    } catch (e) {
      // Never log the URL: it carries the API key.
      const error = (e as Error).message.slice(0, 300);
      if (attempts >= MAX_ATTEMPTS) {
        await this.finish(n, { status: 'failed', attempts, error });
        this.log.warn({ notification: n._id.toHexString(), error }, 'SMS failed');
        return 'failed';
      }
      await this.finish(n, {
        attempts,
        error,
        nextAttemptAt: new Date(Date.now() + BACKOFF_MS[attempts - 1]!),
      });
      return 'retried';
    }
  }
}

/**
 * Hourly gateway check (TRD §6.6): links created in the last 48 hours that are still open are asked about
 * directly, so a lost webhook never loses a payment. Links past expiry are closed as failed.
 */
export async function gatewayReconcile(client: MongoClient, db: Db, crypto: FieldCrypto, log: Logger) {
  const now = Date.now();
  const counts = { checked: 0, settled: 0, expired: 0, errors: 0 };
  const expired = await payments(db).updateMany(
    {
      status: 'created',
      method: { $in: ['razorpay', 'cashfree'] },
      createdAt: { $lt: new Date(now - 8 * 86_400_000) },
    },
    { $set: { status: 'failed', failureReason: 'Payment link expired', updatedAt: new Date() } },
  );
  counts.expired = expired.modifiedCount;
  const open = payments(db).find({
    status: 'created',
    method: { $in: ['razorpay', 'cashfree'] },
    createdAt: { $gte: new Date(now - 48 * 3600_000), $lte: new Date(now - 2 * 60_000) },
  });
  const tenants = new Map<string, BillingTenant | null>();
  for await (const p of open) {
    counts.checked++;
    try {
      const tk = p.tenantId.toHexString();
      if (!tenants.has(tk))
        tenants.set(tk, await db.collection<BillingTenant>('tenants').findOne({ _id: p.tenantId }));
      const t = tenants.get(tk);
      if (!t || !p.gateway?.linkId) continue;
      const s = await gatewayFor(t, p.method as 'razorpay' | 'cashfree', crypto).linkStatus(p.gateway.linkId);
      if (!s.paid) continue;
      const r = await settlePayment(client, db, {
        paymentId: p._id,
        gatewayPaymentId: s.paymentId ?? p.gateway.linkId,
        amountPaise: s.amountPaidPaise,
        ...(s.method ? { method: s.method } : {}),
        event: 'reconcile',
      });
      if (r.settled) counts.settled++;
    } catch (e) {
      counts.errors++;
      log.warn({ payment: p._id.toHexString(), err: (e as Error).message }, 'gateway check failed');
    }
  }
  return counts;
}
