import type { Db, Filter, ObjectId } from 'mongodb';
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

/**
 * Plans a reseller chain may not sell: a parent (or the ISP) switched them off for any reseller on the chain.
 * Plans with no rate row stay assigned (default on).
 */
export const unassignedPlanIds = async (db: Db, chain: readonly ObjectId[]): Promise<ObjectId[]> =>
  chain.length
    ? db
        .collection<ResellerRateDoc>('reseller_rates')
        .distinct('planId', { buyerId: { $in: [...chain] }, active: false })
    : [];
