import type { CoaReason, OutboxDoc, SubscriberDoc } from './types.js';

/** What RADIUS answers for this subscriber right now (radius_reply / radius_check). */
export type RadiusState = 'blocked' | 'expired' | 'fup' | 'active';

type Shape = Pick<SubscriberDoc, 'status' | 'planId' | 'expiresAt' | 'fup' | 'network'>;

export function radiusState(s: Shape, now = new Date()): RadiusState {
  if (s.status !== 'active') return 'blocked';
  if (!s.planId || (s.expiresAt && s.expiresAt <= now)) return 'expired';
  return s.fup?.active ? 'fup' : 'active';
}

/**
 * Which CoA a change needs for a user who may be online (TRD §6.4):
 * - leaving service (suspend/disable/delete), moving between expired/fup/active (address lists), or a new static
 *   IP / MAC lock → Disconnect: the router re-dials and gets a fresh, correct reply;
 * - a different plan in the same state → CoA with the new rate, no reconnect.
 */
export function coaFor(
  before: Shape | null,
  after: Shape & { status: SubscriberDoc['status'] },
): OutboxDoc['coa'] {
  const d = (reason: CoaReason) => ({ action: 'disconnect' as const, reason });
  if (!before) return undefined;
  if (after.status === 'deleted') return d('delete');
  const b = radiusState(before);
  const a = radiusState(after);
  if (a === 'blocked') return b === 'blocked' ? undefined : d('suspend');
  if (b === 'blocked') return undefined;
  if (a !== b) return d(a === 'fup' || b === 'fup' ? 'fup' : 'renewal');
  if (
    before.network.staticIp !== after.network.staticIp ||
    before.network.macLock !== after.network.macLock
  ) {
    return d('network');
  }
  if (before.planId?.toHexString() !== after.planId?.toHexString())
    return { action: 'update', reason: 'plan_change' };
  return undefined;
}
