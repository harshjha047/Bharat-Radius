import type { FastifyRequest } from 'fastify';
import { ObjectId, type ClientSession, type Db } from 'mongodb';
import { MoneyError, type ResellerDoc, type WalletDoc } from '@isp/db-mongo';
import type { AuthContext } from '../auth/context.js';
import { AppError, forbidden } from '../errors.js';

const KEY = /^[A-Za-z0-9_.:-]{8,100}$/;

/**
 * Idempotency-Key header (TRD §7), required on money POSTs; namespaced by tenant so keys from different ISPs
 * never collide. A repeat with the same key returns the first result and moves no money.
 */
export function idempotencyKey(req: FastifyRequest, ctx: AuthContext): string {
  const k = req.headers['idempotency-key'];
  if (typeof k !== 'string' || !KEY.test(k)) {
    throw new AppError(
      400,
      'VALIDATION_FAILED',
      'Send an Idempotency-Key header (8–100 letters, digits, . _ : -)',
    );
  }
  return `${ctx.tenantId?.toHexString() ?? 'platform'}:${k}`;
}

export const requireTenant = (ctx: AuthContext): ObjectId => {
  if (!ctx.tenantId) throw new AppError(400, 'VALIDATION_FAILED', 'Sign in as staff of an ISP');
  return ctx.tenantId;
};

export const selfReseller = (ctx: AuthContext): ObjectId | null =>
  ctx.scope.kind === 'branch' ? ctx.scope.resellerId : null;

export const assertStaff = (ctx: AuthContext, what: string) => {
  if (ctx.scope.kind === 'branch') throw forbidden(`Only ISP staff can ${what}`);
};

/** First non-active reseller in a chain (top first) → BRANCH_SUSPENDED: no new recharges in a suspended branch. */
export async function assertBranchOpen(
  db: Db,
  tenantId: ObjectId,
  chain: ObjectId[],
  session?: ClientSession,
) {
  if (!chain.length) return;
  const blocked = await db
    .collection<ResellerDoc>('resellers')
    .find(
      { _id: { $in: chain }, tenantId, status: { $ne: 'active' } },
      { projection: { code: 1, name: 1 }, ...(session ? { session } : {}) },
    )
    .toArray();
  if (blocked.length) {
    const order = new Map(chain.map((id, i) => [id.toHexString(), i]));
    blocked.sort((a, b) => order.get(a._id.toHexString())! - order.get(b._id.toHexString())!);
    throw new MoneyError(409, 'BRANCH_SUSPENDED', `${blocked[0]!.name} (${blocked[0]!.code}) is suspended`);
  }
}

export type WalletState = 'normal' | 'low' | 'empty' | 'frozen' | 'inactive';

export function walletState(w: WalletDoc): WalletState {
  if (w.frozen) return 'frozen';
  if (!w.isActive) return 'inactive';
  if (w.walletType === 'MASTER') return 'normal';
  if (w.balancePaise + w.creditLimitPaise <= 0) return 'empty';
  return w.balancePaise <= w.lowBalanceThresholdPaise ? 'low' : 'normal';
}

/** IST calendar day "YYYY-MM-DD" → UTC instants of its start / next day's start. */
export function istDayRange(from?: string, to?: string) {
  const at = (d: string) => new Date(`${d}T00:00:00+05:30`);
  const r: { $gte?: Date; $lt?: Date } = {};
  if (from) r.$gte = at(from);
  if (to) r.$lt = new Date(at(to).getTime() + 86_400_000);
  return Object.keys(r).length ? r : undefined;
}

export const oid = (s: string) => new ObjectId(s);
