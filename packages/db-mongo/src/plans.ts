import type { ClientSession, Db, Filter, ObjectId } from 'mongodb';
import type { ResellerRateDoc } from './billing/types.js';
import type { PlanDoc } from './types.js';

/**
 * Whether a customer whose reseller chain is `ancestors` (root first, owner last; [] for an ISP customer) may be
 * on `plan`. ISP plans: everyone. A reseller's own plan: only customers in that reseller's branch.
 */
export const planSellableIn = (plan: Pick<PlanDoc, 'resellerId'>, ancestors: readonly ObjectId[]): boolean =>
  !plan.resellerId || ancestors.some((a) => a.equals(plan.resellerId!));

/** Query form of `planSellableIn`. */
export const sellablePlans = (ancestors: readonly ObjectId[]): Filter<PlanDoc> =>
  ancestors.length
    ? { $or: [{ resellerId: { $exists: false } }, { resellerId: { $in: [...ancestors] } }] }
    : { resellerId: { $exists: false } };

export const NOT_SELLABLE = 'This plan belongs to another reseller and cannot be used for this customer';

export const NOT_ASSIGNED = 'This plan is not assigned to this customer’s reseller';

/** Resellers on `chain` (root first) that must have selected `plan`: all below its owner; all of them for an ISP plan. */
const selectors = (plan: Pick<PlanDoc, 'resellerId'>, chain: readonly ObjectId[]) =>
  chain.slice(plan.resellerId ? chain.findIndex((a) => a.equals(plan.resellerId!)) + 1 : 0);

/** planId → resellers of `chain` that selected it (an active rate row set by the level above). */
export type Selections = ReadonlyMap<string, ReadonlySet<string>>;

export async function planSelections(
  db: Db,
  chain: readonly ObjectId[],
  session?: ClientSession,
): Promise<Selections> {
  const out = new Map<string, Set<string>>();
  if (!chain.length) return out;
  const rows = await db
    .collection<ResellerRateDoc>('reseller_rates')
    .find(
      { buyerId: { $in: [...chain] }, active: true },
      { projection: { _id: 0, buyerId: 1, planId: 1 }, ...(session ? { session } : {}) },
    )
    .toArray();
  for (const r of rows) {
    const k = r.planId.toHexString();
    out.set(k, (out.get(k) ?? new Set()).add(r.buyerId.toHexString()));
  }
  return out;
}

/**
 * Opt-in: a reseller customer may be on a plan only if every reseller between the plan's owner and the customer's
 * reseller had it selected by the level above. ISP customers (empty chain) may use any ISP plan.
 */
export const planAssignedIn = (
  plan: Pick<PlanDoc, '_id' | 'resellerId'>,
  chain: readonly ObjectId[],
  sel: Selections,
): boolean => {
  if (!planSellableIn(plan, chain)) return false;
  const picked = sel.get(plan._id.toHexString());
  return selectors(plan, chain).every((r) => picked?.has(r.toHexString()));
};

export const isPlanAssigned = async (
  db: Db,
  plan: Pick<PlanDoc, '_id' | 'resellerId'>,
  chain: readonly ObjectId[],
  session?: ClientSession,
) => planAssignedIn(plan, chain, await planSelections(db, chain, session));

/** Ids of the plans of `tenantId` assigned to `chain` (query with `_id: { $in }`). */
export async function assignedPlanIds(db: Db, tenantId: ObjectId, chain: readonly ObjectId[]) {
  const [plans, sel] = await Promise.all([
    db
      .collection<PlanDoc>('plans')
      .find({ tenantId, ...sellablePlans(chain) }, { projection: { _id: 1, resellerId: 1 } })
      .toArray(),
    planSelections(db, chain),
  ]);
  return plans.filter((p) => planAssignedIn(p, chain, sel)).map((p) => p._id);
}
