import type { ClientSession, Db, MongoClient, ObjectId } from 'mongodb';
import type { PlanDoc, ResellerDoc, SubscriberDoc } from '../types.js';
import { invoices, payInvoice, type BillingTenant } from './invoices.js';
import { move, wallets } from './ledger.js';
import { MoneyError, istDate, rupees } from './money.js';
import { notify } from './notify.js';
import { performRecharge, updateSubscriber } from './recharge.js';
import type { PaymentDoc, ResellerRateDoc } from './types.js';

export const payments = (db: Db) => db.collection<PaymentDoc>('payments');
export const rates = (db: Db) => db.collection<ResellerRateDoc>('reseller_rates');

const txOptions = { readConcern: { level: 'snapshot' as const }, writeConcern: { w: 'majority' as const } };
export const withTx = <T>(client: MongoClient, fn: (s: ClientSession) => Promise<T>) =>
  client.withSession((s) => s.withTransaction(() => fn(s), txOptions));

/** `shareBp` / 10,000 of `pricePaise`, half up to the paisa. */
export const sharePaise = (pricePaise: number, shareBp: number) =>
  Math.floor((pricePaise * shareBp) / 10_000 + 0.5);

export interface WalletTerms {
  /** Debited per period. */
  amountPaise: number;
  walletModel: 'prepaid' | 'revenue_share';
  shareBp?: number;
}

/**
 * What the reseller's wallet pays for one recharge of `plan`. Prepaid model: its parent-set rate, else the plan
 * price (MRP). Revenue share: the parent-set share of the plan price. Either way the parent decides what it may sell.
 */
export async function walletTerms(
  db: Db,
  resellerId: ObjectId,
  plan: PlanDoc,
  session?: ClientSession,
): Promise<WalletTerms> {
  const opt = session ? { session } : {};
  const [r, seller] = await Promise.all([
    rates(db).findOne({ buyerId: resellerId, planId: plan._id }, opt),
    db
      .collection<ResellerDoc>('resellers')
      .findOne({ _id: resellerId }, { ...opt, projection: { walletModel: 1, shareBp: 1 } }),
  ]);
  if (r && !r.active)
    throw new MoneyError(403, 'VALIDATION_FAILED', 'This reseller is not allowed to sell this plan');
  if (seller?.walletModel === 'revenue_share' && seller.shareBp !== undefined) {
    return {
      amountPaise: sharePaise(plan.pricePaise, seller.shareBp),
      walletModel: 'revenue_share',
      shareBp: seller.shareBp,
    };
  }
  return { amountPaise: r?.walletPricePaise ?? plan.pricePaise, walletModel: 'prepaid' };
}

export const walletPrice = async (db: Db, resellerId: ObjectId, plan: PlanDoc, session?: ClientSession) =>
  (await walletTerms(db, resellerId, plan, session)).amountPaise;

/** Taxable price to the customer: the owning reseller's own customer price, else the plan price. */
export async function customerPrice(
  db: Db,
  ownerId: ObjectId | null,
  plan: PlanDoc,
  session?: ClientSession,
) {
  if (!ownerId) return plan.pricePaise;
  const r = await rates(db).findOne({ buyerId: ownerId, planId: plan._id }, session ? { session } : {});
  return r?.customerPricePaise ?? plan.pricePaise;
}

/** Overdue-suspended postpaid customer with nothing left overdue → active again (RADIUS + CoA). */
export async function reactivateIfSettled(
  db: Db,
  session: ClientSession,
  subscriberId: ObjectId,
  actor: string,
) {
  const s = await db.collection<SubscriberDoc>('subscribers').findOne({ _id: subscriberId }, { session });
  if (!s || s.status !== 'suspended' || s.suspendReason !== 'overdue') return null;
  const stillOverdue = await invoices(db).findOne(
    {
      tenantId: s.tenantId,
      subscriberId,
      status: { $in: ['issued', 'partially_paid', 'overdue'] },
      dueDate: { $lt: new Date() },
    },
    { session, projection: { _id: 1 } },
  );
  if (stillOverdue) return null;
  return updateSubscriber(db, session, s, { status: 'active' }, { suspendReason: '' }, actor);
}

/** Money received against an invoice (cash or gateway) + reactivation + receipt SMS. */
export async function applyInvoicePayment(
  db: Db,
  session: ClientSession,
  p: { tenantId: ObjectId; invoiceId: ObjectId; amountPaise: number; actor: string; paymentId: ObjectId },
) {
  const inv = await payInvoice(db, session, p.invoiceId, p.tenantId, p.amountPaise);
  await reactivateIfSettled(db, session, inv.subscriberId, p.actor);
  const s = await db.collection<SubscriberDoc>('subscribers').findOne({ _id: inv.subscriberId }, { session });
  if (s) {
    await notify(db, session, {
      tenantId: p.tenantId,
      to: s.phone,
      key: 'payment_receipt',
      vars: [s.name, rupees(p.amountPaise), `invoice ${inv.number}`, istDate(new Date()), inv.number],
      ref: { type: 'payment', id: p.paymentId },
    });
  }
  return inv;
}

/**
 * A captured gateway payment, applied once (TRD §6.6): duplicate webhooks and the reconciliation job may call
 * this any number of times. A reseller's customer: the payment tops up that reseller's wallet, then the normal
 * recharge debits it (PRD §15 item 1 default). A direct customer: recharge or invoice settled directly.
 */
export async function settlePayment(
  client: MongoClient,
  db: Db,
  input: {
    paymentId: ObjectId;
    gatewayPaymentId: string;
    amountPaise: number;
    method?: string;
    event: string;
  },
): Promise<{ settled: boolean; payment: PaymentDoc | null }> {
  try {
    return await settleOnce(client, db, input);
  } catch (e) {
    // Two deliveries racing: the loser hits a unique key (recharge idempotency / gateway payment id).
    if ((e as { code?: number }).code !== 11000) throw e;
    return { settled: false, payment: await payments(db).findOne({ _id: input.paymentId }) };
  }
}

async function settleOnce(
  client: MongoClient,
  db: Db,
  input: {
    paymentId: ObjectId;
    gatewayPaymentId: string;
    amountPaise: number;
    method?: string;
    event: string;
  },
): Promise<{ settled: boolean; payment: PaymentDoc | null }> {
  return withTx(client, async (session) => {
    const p = await payments(db).findOne({ _id: input.paymentId }, { session });
    if (!p) return { settled: false, payment: null };
    if (p.settledAt || p.status === 'captured' || p.status === 'refunded')
      return { settled: false, payment: p };
    if (input.amountPaise < p.amountPaise) {
      await payments(db).updateOne(
        { _id: p._id },
        {
          $set: {
            failureReason: `Paid ${input.amountPaise} paise, expected ${p.amountPaise}`,
            updatedAt: new Date(),
          },
        },
        { session },
      );
      return { settled: false, payment: p };
    }
    const now = new Date();
    const tenant = (await db.collection<BillingTenant>('tenants').findOne({ _id: p.tenantId }, { session }))!;
    const sub = await db
      .collection<SubscriberDoc>('subscribers')
      .findOne({ _id: p.subscriberId, tenantId: p.tenantId }, { session });
    if (!sub) throw new MoneyError(404, 'NOT_FOUND', 'Subscriber not found');
    const set: Partial<PaymentDoc> = {
      status: 'captured',
      capturedAt: now,
      settledAt: now,
      updatedAt: now,
      gateway: {
        ...p.gateway,
        paymentId: input.gatewayPaymentId,
        ...(input.method ? { method: input.method } : {}),
      },
    };

    if (p.purpose.type === 'recharge') {
      const plan = await db
        .collection<PlanDoc>('plans')
        .findOne({ _id: p.purpose.planId!, tenantId: p.tenantId }, { session });
      if (!plan) throw new MoneyError(404, 'NOT_FOUND', 'Plan not found');
      let wallet;
      if (sub.resellerId) {
        const w = await wallets(db).findOne({ ownerId: sub.resellerId, tenantId: p.tenantId }, { session });
        if (!w) throw new MoneyError(409, 'CONFLICT', 'The reseller has no wallet');
        const credit = await move(db, session, {
          tenantId: p.tenantId,
          walletId: w._id,
          deltaPaise: p.amountPaise,
          type: 'TOPUP',
          referenceId: p._id,
          description: `Customer online payment · ${sub.username ?? sub.customerNo}`,
          actor: 'system',
          fromWalletId: null,
          toWalletId: w._id,
        });
        set.walletTxnId = credit._id;
        wallet = {
          doc: w,
          resellerId: sub.resellerId,
          amountPaise: await walletPrice(db, sub.resellerId, plan, session),
        };
      }
      const r = await performRecharge(db, session, {
        tenant,
        subscriber: sub,
        plan,
        channel: 'online',
        ...(wallet ? { wallet } : {}),
        customerPricePaise: await customerPrice(db, sub.resellerId, plan, session),
        invoice: true,
        idempotencyKey: `payment:${p._id.toHexString()}`,
        actor: 'system',
        paymentId: p._id,
        now,
      });
      set.rechargeId = r.recharge._id;
      if (r.recharge.invoiceId) set.invoiceId = r.recharge.invoiceId;
    } else {
      const inv = await applyInvoicePayment(db, session, {
        tenantId: p.tenantId,
        invoiceId: p.purpose.invoiceId!,
        amountPaise: p.amountPaise,
        actor: 'system',
        paymentId: p._id,
      });
      set.invoiceId = inv._id;
    }
    const u = await payments(db).findOneAndUpdate(
      { _id: p._id, settledAt: { $exists: false } },
      { $set: set, $push: { rawEvents: { at: now, event: input.event, id: input.gatewayPaymentId } } },
      { returnDocument: 'after', session },
    );
    if (!u) return { settled: false, payment: p };
    return { settled: true, payment: u };
  });
}
