import { ObjectId, type Db, type MongoClient } from 'mongodb';
import type { PlanDoc, SubscriberDoc } from '../types.js';
import { billingOf, invoices, issueInvoice, type BillingTenant } from './invoices.js';
import { walletTransfers, walletTxns, wallets } from './ledger.js';
import { endOfIstDay, istDate, istMidnight, istParts, rupees } from './money.js';
import { notify } from './notify.js';
import { recharges, updateSubscriber } from './recharge.js';
import { customerPrice, withTx } from './settle.js';
import type { WalletDoc, WalletTxnDoc } from './types.js';

const DAY_MS = 86_400_000;
const tenantsOf = (db: Db) =>
  db
    .collection<BillingTenant>('tenants')
    .find({ status: 'active', slug: { $ne: 'platform' } })
    .toArray();

/**
 * Postpaid invoices (TRD §6.5): one per active postpaid subscriber for the previous IST month, issued on the 1st.
 * Runs often and is idempotent (one invoice per subscriber per period), so a missed run catches up.
 * Customers who joined during the month pay pro rata.
 */
export async function postpaidInvoices(client: MongoClient, db: Db, now = new Date()) {
  const { y, m } = istParts(now);
  const periodStart = istMidnight(y, m - 1, 1);
  const periodEnd = new Date(istMidnight(y, m, 1).getTime() - 1000);
  const days = Math.round((periodEnd.getTime() + 1000 - periodStart.getTime()) / DAY_MS);
  let created = 0;
  for (const tenant of await tenantsOf(db)) {
    const b = billingOf(tenant);
    const plans = new Map(
      (await db.collection<PlanDoc>('plans').find({ tenantId: tenant._id }).toArray()).map((p) => [
        p._id.toHexString(),
        p,
      ]),
    );
    const cursor = db.collection<SubscriberDoc>('subscribers').find(
      {
        tenantId: tenant._id,
        billingType: 'postpaid',
        status: { $in: ['active', 'suspended'] },
        planId: { $exists: true },
        createdAt: { $lte: periodEnd },
      },
      { batchSize: 500 },
    );
    for await (const s of cursor) {
      const plan = plans.get(s.planId!.toHexString());
      if (!plan) continue;
      const exists = await invoices(db).findOne(
        { tenantId: tenant._id, subscriberId: s._id, type: 'postpaid_monthly', periodStart },
        { projection: { _id: 1 } },
      );
      if (exists) continue;
      const from = s.createdAt > periodStart ? s.createdAt : periodStart;
      const activeDays = Math.max(1, Math.ceil((periodEnd.getTime() - from.getTime()) / DAY_MS));
      const price = await customerPrice(db, s.resellerId, plan);
      const rate = activeDays >= days ? price : Math.round((price * activeDays) / days);
      const issueDate = now;
      const dueDate = endOfIstDay(new Date(istMidnight(y, m, 1).getTime() + b.dueDays * DAY_MS));
      try {
        const inv = await withTx(client, (session) =>
          issueInvoice(db, session, {
            tenant,
            subscriber: s,
            plan,
            ratePaise: rate,
            description: `${plan.name} · ${istDate(periodStart)} to ${istDate(periodEnd)}${activeDays < days ? ` (${activeDays} of ${days} days)` : ''}`,
            type: 'postpaid_monthly',
            issueDate,
            dueDate,
            periodStart,
            periodEnd,
            actor: 'system',
          }),
        );
        created++;
        await notify(db, undefined, {
          tenantId: tenant._id,
          to: s.phone,
          key: 'invoice_issued',
          vars: [s.name, inv.number, rupees(inv.totalPaise), istDate(inv.dueDate)],
          dedupeKey: `invoice:${inv._id.toHexString()}`,
          ref: { type: 'invoice', id: inv._id },
        });
      } catch (e) {
        if ((e as { code?: number }).code !== 11000) throw e;
      }
    }
  }
  return { created };
}

/**
 * Overdue (TRD §6.5): unpaid after the due date → `overdue`; still unpaid after the grace days → the postpaid
 * customer is suspended (Radius + Disconnect). Payment reactivates (settle.reactivateIfSettled).
 */
export async function postpaidOverdue(client: MongoClient, db: Db, now = new Date()) {
  const marked = await invoices(db).updateMany(
    { status: { $in: ['issued', 'partially_paid'] }, type: 'postpaid_monthly', dueDate: { $lt: now } },
    { $set: { status: 'overdue', updatedAt: now } },
  );
  let suspended = 0;
  for (const tenant of await tenantsOf(db)) {
    const graceCutoff = new Date(now.getTime() - billingOf(tenant).graceDays * DAY_MS);
    const subIds = await invoices(db).distinct('subscriberId', {
      tenantId: tenant._id,
      status: 'overdue',
      dueDate: { $lt: graceCutoff },
    });
    for (const id of subIds) {
      const s = await withTx(client, async (session) => {
        const cur = await db
          .collection<SubscriberDoc>('subscribers')
          .findOne({ _id: id, tenantId: tenant._id, status: 'active', billingType: 'postpaid' }, { session });
        if (!cur) return null;
        return updateSubscriber(
          db,
          session,
          cur,
          { status: 'suspended', suspendReason: 'overdue' },
          {},
          'system',
        );
      });
      if (!s) continue;
      suspended++;
      await notify(db, undefined, {
        tenantId: tenant._id,
        to: s.phone,
        key: 'overdue_suspended',
        vars: [s.name],
        dedupeKey: `overdue:${s._id.toHexString()}:${istDate(now)}`,
        ref: { type: 'subscriber', id: s._id },
      });
    }
  }
  return { overdue: marked.modifiedCount, suspended };
}

/** Expiry reminders N days ahead and an "expired" notice the day after, from 10:00 IST, once per day each. */
export async function expiryReminders(db: Db, now = new Date()) {
  const hourIst = new Date(now.getTime() + 330 * 60_000).getUTCHours();
  if (hourIst < 10) return { queued: 0 };
  const { y, m, d } = istParts(now);
  let queued = 0;
  for (const tenant of await tenantsOf(db)) {
    const subs = db.collection<SubscriberDoc>('subscribers');
    for (const n of billingOf(tenant).reminderDaysBefore) {
      const from = istMidnight(y, m, d + n);
      const to = istMidnight(y, m, d + n + 1);
      for await (const s of subs.find(
        {
          tenantId: tenant._id,
          billingType: 'prepaid',
          status: 'active',
          expiresAt: { $gte: from, $lt: to },
        },
        { projection: { name: 1, phone: 1, expiresAt: 1 } },
      )) {
        await notify(db, undefined, {
          tenantId: tenant._id,
          to: s.phone,
          key: 'expiry_reminder',
          vars: [s.name, istDate(s.expiresAt!), String(n)],
          dedupeKey: `expiry:${s._id.toHexString()}:${istDate(s.expiresAt!)}:${n}`,
          ref: { type: 'subscriber', id: s._id },
        });
        queued++;
      }
    }
    for await (const s of subs.find(
      {
        tenantId: tenant._id,
        billingType: 'prepaid',
        status: 'active',
        expiresAt: { $gte: istMidnight(y, m, d - 1), $lt: istMidnight(y, m, d) },
      },
      { projection: { name: 1, phone: 1, expiresAt: 1 } },
    )) {
      await notify(db, undefined, {
        tenantId: tenant._id,
        to: s.phone,
        key: 'expired',
        vars: [s.name, istDate(s.expiresAt!)],
        dedupeKey: `expired:${s._id.toHexString()}:${istDate(s.expiresAt!)}`,
        ref: { type: 'subscriber', id: s._id },
      });
      queued++;
    }
  }
  return { queued };
}

const signed = (t: Pick<WalletTxnDoc, 'direction' | 'amountPaise'>) =>
  t.direction === 'credit' ? t.amountPaise : -t.amountPaise;

/** True when the entries form one unbroken before → after chain from 0 to `balance`. */
function chainOk(txns: WalletTxnDoc[], balance: number): boolean {
  if (txns.some((t) => t.balanceAfterPaise - t.balanceBeforePaise !== signed(t))) return false;
  let cur = 0;
  let ordered = true;
  for (const t of txns) {
    if (t.balanceBeforePaise !== cur) {
      ordered = false;
      break;
    }
    cur = t.balanceAfterPaise;
  }
  if (ordered) return cur === balance;
  // Commit order can differ from timestamp order across API replicas: walk the chain by balances instead.
  const pending = new Map<number, WalletTxnDoc[]>();
  for (const t of txns) pending.set(t.balanceBeforePaise, [...(pending.get(t.balanceBeforePaise) ?? []), t]);
  cur = 0;
  for (let i = 0; i < txns.length; i++) {
    const next = pending.get(cur)?.shift();
    if (!next) return false;
    cur = next.balanceAfterPaise;
  }
  return cur === balance;
}

/**
 * Nightly reconciliation (TRD §6.5): every wallet balance equals the sum of its ledger and the entries chain;
 * every transfer has one debit and one equal credit; every wallet recharge has its RECHARGE entry (and REFUND
 * when reversed). A failing wallet is frozen and counted for the alert.
 */
export async function reconcileWallets(db: Db) {
  const problems = new Map<string, string>();
  const flag = (walletId: string, why: string) => {
    if (!problems.has(walletId)) problems.set(walletId, why);
  };
  for await (const w of wallets(db).find({}, { projection: { balancePaise: 1 } })) {
    const txns = await walletTxns(db)
      .find({ walletId: w._id }, { sort: { createdAt: 1, _id: 1 } })
      .toArray();
    const sum = txns.reduce((a, t) => a + signed(t), 0);
    if (sum !== w.balancePaise) flag(w._id.toHexString(), `balance ${w.balancePaise} ≠ ledger ${sum}`);
    else if (!chainOk(txns, w.balancePaise)) flag(w._id.toHexString(), 'ledger before/after chain is broken');
  }
  for await (const t of walletTransfers(db).find({})) {
    const legs = await walletTxns(db).find({ referenceId: t._id }).toArray();
    const debit = legs.filter((l) => l.direction === 'debit');
    const credit = legs.filter((l) => l.direction === 'credit');
    if (
      debit.length !== 1 ||
      credit.length !== 1 ||
      debit[0]!.amountPaise !== t.amountPaise ||
      credit[0]!.amountPaise !== t.amountPaise
    ) {
      flag(t.fromWalletId.toHexString(), `transfer ${t._id.toHexString()} legs do not match`);
      flag(t.toWalletId.toHexString(), `transfer ${t._id.toHexString()} legs do not match`);
    }
  }
  for await (const r of recharges(db).find({ walletId: { $ne: null } })) {
    const legs = await walletTxns(db).find({ referenceId: r._id }).toArray();
    const rc = legs.filter((l) => l.type === 'RECHARGE');
    const rf = legs.filter((l) => l.type === 'REFUND');
    const ok =
      rc.length === 1 &&
      rc[0]!.amountPaise === r.amountPaise &&
      (r.status === 'REVERSED' ? rf.length === 1 && rf[0]!.amountPaise === r.amountPaise : rf.length === 0);
    if (!ok) flag(r.walletId!.toHexString(), `recharge ${r._id.toHexString()} entries do not match`);
  }
  const now = new Date();
  for (const [id, why] of problems) {
    await wallets(db).updateOne(
      { _id: new ObjectId(id) },
      { $set: { frozen: true, frozenReason: why, updatedAt: now } },
    );
  }
  const frozen = await wallets(db).countDocuments({ frozen: true });
  return { checked: await wallets(db).estimatedDocumentCount(), mismatches: problems.size, frozen };
}

export type { WalletDoc };
