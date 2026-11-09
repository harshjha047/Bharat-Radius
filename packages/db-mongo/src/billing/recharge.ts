import { ObjectId, type ClientSession, type Db } from 'mongodb';
import { coaFor } from '../coa-policy.js';
import type { OutboxDoc, PlanDoc, SubscriberDoc } from '../types.js';
import { invoices, issueCreditNote, issueInvoice, type BillingTenant } from './invoices.js';
import { move } from './ledger.js';
import { MoneyError, istDate, renewedExpiry, rupees } from './money.js';
import { notify } from './notify.js';
import type { PaymentDoc, RechargeChannel, RechargeDoc, WalletDoc } from './types.js';

export const recharges = (db: Db) => db.collection<RechargeDoc>('recharges');

export async function enqueueSubscriberSync(
  db: Db,
  session: ClientSession,
  s: Pick<SubscriberDoc, '_id' | 'tenantId'>,
  coa?: OutboxDoc['coa'],
) {
  const now = new Date();
  await db.collection<OutboxDoc>('outbox').insertOne(
    {
      _id: new ObjectId(),
      tenantId: s.tenantId,
      entity: 'subscriber',
      entityId: s._id,
      ...(coa ? { coa } : {}),
      status: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
    },
    { session },
  );
}

/** Applies a subscriber change with optimistic locking, queues the RADIUS sync and the CoA it needs. */
export async function updateSubscriber(
  db: Db,
  session: ClientSession,
  cur: SubscriberDoc,
  set: Record<string, unknown>,
  unset: Record<string, ''> = {},
  actor = 'system',
): Promise<SubscriberDoc> {
  const u = await db.collection<SubscriberDoc>('subscribers').findOneAndUpdate(
    { _id: cur._id, tenantId: cur.tenantId, version: cur.version },
    {
      $set: { ...set, syncStatus: 'pending', updatedAt: new Date(), updatedBy: actor },
      $inc: { version: 1 },
      ...(Object.keys(unset).length ? { $unset: unset } : {}),
    },
    { returnDocument: 'after', session },
  );
  if (!u) throw new MoneyError(409, 'CONFLICT', 'The subscriber was changed at the same time; try again');
  await enqueueSubscriberSync(db, session, u, coaFor(cur, u));
  return u;
}

export interface RechargeInput {
  tenant: BillingTenant;
  subscriber: SubscriberDoc;
  plan: PlanDoc;
  channel: RechargeChannel;
  /** The recharging reseller's wallet and the price it pays; absent for ISP staff and direct customers. */
  wallet?: { doc: WalletDoc; resellerId: ObjectId; amountPaise: number };
  /** Taxable price to the customer (invoice), excl. GST. */
  customerPricePaise: number;
  /** false for complimentary staff recharges (no invoice). */
  invoice: boolean;
  idempotencyKey: string;
  actor: string;
  paymentId?: ObjectId;
  now?: Date;
}

export interface RechargeResult {
  recharge: RechargeDoc;
  subscriber: SubscriberDoc | null;
  replayed: boolean;
}

/**
 * Prepaid recharge (accounts team §12, TRD §6.5) in the caller's transaction: idempotency check → conditional
 * debit of the recharging level's wallet only → recharge + RECHARGE ledger entry → new expiry and plan → RADIUS
 * sync with the CoA that restores speed → paid GST invoice → receipt SMS. Short balance → nothing changes.
 */
export async function performRecharge(
  db: Db,
  session: ClientSession,
  r: RechargeInput,
): Promise<RechargeResult> {
  const prior = await recharges(db).findOne({ idempotencyKey: r.idempotencyKey }, { session });
  if (prior) {
    if (!prior.subscriberId.equals(r.subscriber._id)) {
      throw new MoneyError(409, 'CONFLICT', 'This idempotency key was already used for another recharge');
    }
    return { recharge: prior, subscriber: null, replayed: true };
  }
  const s = r.subscriber;
  if (s.status === 'deleted') throw new MoneyError(404, 'NOT_FOUND', 'Subscriber not found');
  if (s.billingType !== 'prepaid') {
    throw new MoneyError(
      400,
      'VALIDATION_FAILED',
      'Postpaid customers pay their invoices; they are not recharged',
    );
  }
  if (r.plan.status !== 'active' || !r.plan.billingTypes.includes('prepaid')) {
    throw new MoneyError(400, 'VALIDATION_FAILED', 'This plan cannot be sold as prepaid');
  }
  const now = r.now ?? new Date();
  const id = new ObjectId();
  let walletTxnId: ObjectId | null = null;
  if (r.wallet) {
    const txn = await move(db, session, {
      tenantId: s.tenantId,
      walletId: r.wallet.doc._id,
      deltaPaise: -r.wallet.amountPaise,
      type: 'RECHARGE',
      referenceId: id,
      description: `Recharge ${s.username ?? s.customerNo} · ${r.plan.name}`,
      actor: r.actor,
    });
    walletTxnId = txn._id;
  }
  const newExpiresAt = renewedExpiry(s.expiresAt, r.plan.validityDays, now);
  const updated = await updateSubscriber(
    db,
    session,
    s,
    { planId: r.plan._id, expiresAt: newExpiresAt },
    {},
    r.actor,
  );

  const grossCustomer = r.invoice
    ? await issueInvoice(db, session, {
        tenant: r.tenant,
        subscriber: updated,
        plan: r.plan,
        ratePaise: r.customerPricePaise,
        description: `${r.plan.name} · ${r.plan.validityDays} days to ${istDate(newExpiresAt)}`,
        type: 'prepaid_recharge',
        issueDate: now,
        rechargeId: id,
        paidPaise: Number.MAX_SAFE_INTEGER,
        actor: r.actor,
      })
    : null;

  const doc: RechargeDoc = {
    _id: id,
    tenantId: s.tenantId,
    subscriberId: s._id,
    planId: r.plan._id,
    siteResellerId: r.wallet?.resellerId ?? null,
    ancestors: s.ancestors,
    walletId: r.wallet?.doc._id ?? null,
    walletTxnId,
    amountPaise: r.wallet?.amountPaise ?? 0,
    customerPricePaise: r.customerPricePaise,
    taxPaise: grossCustomer
      ? grossCustomer.totalPaise - grossCustomer.taxablePaise - grossCustomer.roundOffPaise
      : 0,
    channel: r.channel,
    status: 'SUCCESS',
    rechargeDate: now,
    oldExpiresAt: s.expiresAt ?? null,
    newExpiresAt,
    oldPlanId: s.planId ?? null,
    ...(r.paymentId ? { paymentId: r.paymentId } : {}),
    ...(grossCustomer ? { invoiceId: grossCustomer._id } : {}),
    actorId: r.actor,
    idempotencyKey: r.idempotencyKey,
    createdAt: now,
  };
  await recharges(db).insertOne(doc, { session });
  if (grossCustomer) {
    await notify(db, session, {
      tenantId: s.tenantId,
      to: s.phone,
      key: 'payment_receipt',
      vars: [
        s.name,
        rupees(grossCustomer.totalPaise),
        r.plan.name,
        istDate(newExpiresAt),
        grossCustomer.number,
      ],
      ref: { type: 'recharge', id },
    });
  }
  return { recharge: doc, subscriber: updated, replayed: false };
}

/**
 * Refund / reversal (accounts team §17): a new REFUND credit to the wallet that paid, recharge marked REVERSED,
 * credit note against its invoice, expiry and plan rolled back while this recharge is still the latest.
 * Nothing is edited or deleted.
 */
export async function reverseRecharge(
  db: Db,
  session: ClientSession,
  input: { tenant: BillingTenant; recharge: RechargeDoc; reason: string; actor: string },
): Promise<RechargeDoc> {
  const rc = await recharges(db).findOne(
    { _id: input.recharge._id, tenantId: input.recharge.tenantId },
    { session },
  );
  if (!rc) throw new MoneyError(404, 'NOT_FOUND', 'Recharge not found');
  if (rc.status !== 'SUCCESS') throw new MoneyError(409, 'CONFLICT', 'This recharge is already reversed');

  const refund = rc.walletId
    ? await move(db, session, {
        tenantId: rc.tenantId,
        walletId: rc.walletId,
        deltaPaise: rc.amountPaise,
        type: 'REFUND',
        referenceId: rc._id,
        description: `Refund of recharge — ${input.reason}`,
        actor: input.actor,
      })
    : null;

  const sub = await db
    .collection<SubscriberDoc>('subscribers')
    .findOne({ _id: rc.subscriberId }, { session });
  if (sub && sub.expiresAt?.getTime() === rc.newExpiresAt.getTime()) {
    const set: Record<string, unknown> = { expiresAt: rc.oldExpiresAt ?? new Date() };
    if (rc.oldPlanId) set.planId = rc.oldPlanId;
    await updateSubscriber(db, session, sub, set, {}, input.actor);
  }

  let creditNoteId: ObjectId | null = null;
  if (rc.invoiceId) {
    const inv = await invoices(db).findOne({ _id: rc.invoiceId }, { session });
    if (inv && inv.creditedPaise === 0) {
      creditNoteId = (
        await issueCreditNote(db, session, {
          tenant: input.tenant,
          invoice: inv,
          reason: input.reason,
          actor: input.actor,
        })
      )._id;
    }
  }
  if (rc.paymentId) {
    await db
      .collection<PaymentDoc>('payments')
      .updateOne({ _id: rc.paymentId }, { $set: { status: 'refunded', updatedAt: new Date() } }, { session });
  }
  const u = await recharges(db).findOneAndUpdate(
    { _id: rc._id, status: 'SUCCESS' },
    {
      $set: {
        status: 'REVERSED',
        reversal: {
          refundTxnId: refund?._id ?? null,
          creditNoteId,
          reason: input.reason,
          by: input.actor,
          at: new Date(),
        },
      },
    },
    { returnDocument: 'after', session },
  );
  if (!u) throw new MoneyError(409, 'CONFLICT', 'This recharge is already reversed');
  return u;
}
