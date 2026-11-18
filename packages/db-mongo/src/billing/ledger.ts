import { ObjectId, type ClientSession, type Db } from 'mongodb';
import type { ResellerDoc, TenantDoc } from '../types.js';
import { DEFAULT_BILLING, MoneyError, insufficient } from './money.js';
import type { WalletDoc, WalletTransferDoc, WalletTxnDoc, WalletTxnType, TopupRequestDoc } from './types.js';

type Totals = keyof WalletDoc['totals'];
const TOTAL_FOR: Record<WalletTxnType, Partial<Record<'credit' | 'debit', Totals>>> = {
  TOPUP: { credit: 'receivedPaise', debit: 'allocatedPaise' },
  ALLOCATE: { debit: 'allocatedPaise' },
  RECHARGE: { debit: 'rechargedPaise' },
  REFUND: { credit: 'refundedPaise' },
  ADJUSTMENT: {},
};

export const wallets = (db: Db) => db.collection<WalletDoc>('wallets');
export const walletTxns = (db: Db) => db.collection<WalletTxnDoc>('wallet_txns');
export const walletTransfers = (db: Db) => db.collection<WalletTransferDoc>('wallet_transfers');
export const topupRequests = (db: Db) => db.collection<TopupRequestDoc>('topup_requests');

const lowBalanceOf = async (db: Db, tenantId: ObjectId, session?: ClientSession) =>
  (
    await db
      .collection<TenantDoc & { billing?: { lowBalancePaise?: number } }>('tenants')
      .findOne({ _id: tenantId }, { projection: { billing: 1 }, ...(session ? { session } : {}) })
  )?.billing?.lowBalancePaise ?? DEFAULT_BILLING.lowBalancePaise;

/** The ISP's Master wallet, created on first use. */
export async function ensureMasterWallet(
  db: Db,
  tenantId: ObjectId,
  session?: ClientSession,
): Promise<WalletDoc> {
  const now = new Date();
  const w = await wallets(db).findOneAndUpdate(
    { ownerId: tenantId },
    {
      $setOnInsert: {
        _id: new ObjectId(),
        tenantId,
        ownerType: 'tenant',
        ownerId: tenantId,
        walletType: 'MASTER',
        parentWalletId: null,
        balancePaise: 0,
        creditLimitPaise: 0,
        lowBalanceThresholdPaise: 0,
        isActive: true,
        frozen: false,
        totals: { receivedPaise: 0, allocatedPaise: 0, rechargedPaise: 0, refundedPaise: 0 },
        version: 0,
        createdAt: now,
        updatedAt: now,
      },
    },
    { upsert: true, returnDocument: 'after', ...(session ? { session } : {}) },
  );
  return w!;
}

/** A reseller's wallet under its parent's (Master for level 1), created with the reseller. */
export async function createResellerWallet(
  db: Db,
  r: Pick<ResellerDoc, '_id' | 'tenantId' | 'parentId' | 'level' | 'creditLimitPaise'>,
  session?: ClientSession,
): Promise<WalletDoc> {
  const parent = r.parentId
    ? await wallets(db).findOne({ ownerId: r.parentId, tenantId: r.tenantId }, session ? { session } : {})
    : await ensureMasterWallet(db, r.tenantId, session);
  if (!parent) throw new MoneyError(409, 'CONFLICT', 'The parent reseller has no wallet');
  const now = new Date();
  const w = await wallets(db).findOneAndUpdate(
    { ownerId: r._id },
    {
      $setOnInsert: {
        _id: new ObjectId(),
        tenantId: r.tenantId,
        ownerType: 'reseller',
        ownerId: r._id,
        walletType: `L${r.level}`,
        parentWalletId: parent._id,
        balancePaise: 0,
        creditLimitPaise: r.creditLimitPaise,
        lowBalanceThresholdPaise: await lowBalanceOf(db, r.tenantId, session),
        isActive: true,
        frozen: false,
        totals: { receivedPaise: 0, allocatedPaise: 0, rechargedPaise: 0, refundedPaise: 0 },
        version: 0,
        createdAt: now,
        updatedAt: now,
      },
    },
    { upsert: true, returnDocument: 'after', ...(session ? { session } : {}) },
  );
  return w!;
}

export interface Movement {
  tenantId: ObjectId;
  walletId: ObjectId;
  /** Signed: + credit, − debit. Never 0. */
  deltaPaise: number;
  type: WalletTxnType;
  referenceId: ObjectId;
  description: string;
  actor: string;
  fromWalletId?: ObjectId | null;
  toWalletId?: ObjectId | null;
  /** Debits only: refuse when the balance would drop below −creditLimit. Off for Master. */
  checkBalance?: boolean;
}

/**
 * One wallet movement inside the caller's transaction: a conditional `$inc` (balance check in the filter, so two
 * concurrent debits can never both pass — the second hits a write conflict and re-runs) plus its ledger entry
 * with before/after balances. Throws `Insufficient Wallet Balance` with nothing changed.
 */
export async function move(db: Db, session: ClientSession, m: Movement): Promise<WalletTxnDoc> {
  if (!Number.isSafeInteger(m.deltaPaise) || m.deltaPaise === 0) {
    throw new MoneyError(400, 'VALIDATION_FAILED', 'Amount must be a whole number of paise above zero');
  }
  const debit = m.deltaPaise < 0;
  const amount = Math.abs(m.deltaPaise);
  const total = TOTAL_FOR[m.type][debit ? 'debit' : 'credit'];
  const filter: Record<string, unknown> = {
    _id: m.walletId,
    tenantId: m.tenantId,
    isActive: true,
    frozen: false,
  };
  if (debit && m.checkBalance !== false) {
    filter.$expr = { $gte: [{ $add: ['$balancePaise', '$creditLimitPaise'] }, amount] };
  }
  const now = new Date();
  const after = await wallets(db).findOneAndUpdate(
    filter,
    {
      $inc: { balancePaise: m.deltaPaise, version: 1, ...(total ? { [`totals.${total}`]: amount } : {}) },
      $set: { updatedAt: now },
    },
    { returnDocument: 'after', session },
  );
  if (!after) {
    const w = await wallets(db).findOne({ _id: m.walletId, tenantId: m.tenantId }, { session });
    if (!w) throw new MoneyError(404, 'NOT_FOUND', 'Wallet not found');
    if (w.frozen)
      throw new MoneyError(409, 'WALLET_FROZEN', 'This wallet is frozen pending a reconciliation check');
    if (!w.isActive) throw new MoneyError(409, 'WALLET_INACTIVE', 'This wallet is inactive');
    throw insufficient();
  }
  const txn: WalletTxnDoc = {
    _id: new ObjectId(),
    tenantId: m.tenantId,
    walletId: m.walletId,
    fromWalletId: m.fromWalletId ?? (debit ? m.walletId : null),
    toWalletId: m.toWalletId ?? (debit ? null : m.walletId),
    type: m.type,
    direction: debit ? 'debit' : 'credit',
    amountPaise: amount,
    balanceBeforePaise: after.balancePaise - m.deltaPaise,
    balanceAfterPaise: after.balancePaise,
    referenceId: m.referenceId,
    description: m.description,
    createdAt: now,
    createdBy: m.actor,
  };
  await walletTxns(db).insertOne(txn, { session });
  return txn;
}

export interface TransferInput {
  tenantId: ObjectId;
  from: WalletDoc;
  to: WalletDoc;
  amountPaise: number;
  idempotencyKey: string;
  actor: string;
  receivedVia?: WalletTransferDoc['receivedVia'];
  reference?: string;
  note?: string;
}

/**
 * Master → L1 top-up or parent → child allocation (accounts team §11), all in the caller's transaction:
 * sender debit (balance-checked unless Master) + receiver credit + transfer record. A repeated idempotency key
 * returns the first transfer without moving money again.
 */
export async function transfer(db: Db, session: ClientSession, t: TransferInput) {
  const existing = await walletTransfers(db).findOne({ idempotencyKey: t.idempotencyKey }, { session });
  if (existing) {
    if (
      !existing.tenantId.equals(t.tenantId) ||
      !existing.toWalletId.equals(t.to._id) ||
      existing.amountPaise !== t.amountPaise
    ) {
      throw new MoneyError(409, 'CONFLICT', 'This idempotency key was already used for a different transfer');
    }
    return { transfer: existing, replayed: true };
  }
  if (!t.to.parentWalletId?.equals(t.from._id)) {
    throw new MoneyError(
      400,
      'VALIDATION_FAILED',
      'Money can only move to a wallet directly below the sender',
    );
  }
  const master = t.from.walletType === 'MASTER';
  const id = new ObjectId();
  const label = master ? 'Top-up from ISP' : 'Allocation from parent';
  const note = t.note ? ` — ${t.note}` : '';
  await move(db, session, {
    tenantId: t.tenantId,
    walletId: t.from._id,
    deltaPaise: -t.amountPaise,
    type: master ? 'TOPUP' : 'ALLOCATE',
    referenceId: id,
    description: `${master ? 'Top-up' : 'Allocation'} to ${t.to.walletType}${note}`,
    actor: t.actor,
    fromWalletId: t.from._id,
    toWalletId: t.to._id,
    checkBalance: !master,
  });
  await move(db, session, {
    tenantId: t.tenantId,
    walletId: t.to._id,
    deltaPaise: t.amountPaise,
    type: 'TOPUP',
    referenceId: id,
    description: `${label}${note}`,
    actor: t.actor,
    fromWalletId: t.from._id,
    toWalletId: t.to._id,
  });
  const doc: WalletTransferDoc = {
    _id: id,
    tenantId: t.tenantId,
    fromWalletId: t.from._id,
    toWalletId: t.to._id,
    amountPaise: t.amountPaise,
    status: 'SUCCESS',
    ...(t.receivedVia ? { receivedVia: t.receivedVia } : {}),
    ...(t.reference ? { reference: t.reference } : {}),
    ...(t.note ? { note: t.note } : {}),
    idempotencyKey: t.idempotencyKey,
    createdAt: new Date(),
    createdBy: t.actor,
  };
  await walletTransfers(db).insertOne(doc, { session });
  return { transfer: doc, replayed: false };
}
