import { Badge } from '@/components/ui/badge';
import type { Reseller, Subscriber } from '@/lib/queries';

export function SubscriberState({
  s,
}: {
  s: Pick<Subscriber, 'status' | 'radiusState' | 'suspendReason' | 'planId'>;
}) {
  if (s.status === 'suspended')
    return (
      <Badge tone="warning" title={s.suspendReason ?? undefined}>
        Suspended
      </Badge>
    );
  if (s.status === 'disabled') return <Badge tone="neutral">Disabled</Badge>;
  if (s.radiusState === 'expired')
    return s.planId ? (
      <Badge tone="danger">Expired</Badge>
    ) : (
      <Badge tone="warning" title="No plan: gets the expired-user speed and the pay page">
        No plan
      </Badge>
    );
  if (s.radiusState === 'fup') return <Badge tone="info">FUP speed</Badge>;
  return <Badge tone="success">Active</Badge>;
}

export function SyncState({ s }: { s: Pick<Subscriber, 'syncStatus'> }) {
  if (s.syncStatus === 'synced') return null;
  return s.syncStatus === 'error' ? (
    <Badge tone="danger" title="Not yet on the RADIUS server; retrying">
      Sync error
    </Badge>
  ) : (
    <Badge tone="neutral" title="Being sent to the RADIUS server">
      Syncing
    </Badge>
  );
}

export function ResellerState({ r }: { r: Pick<Reseller, 'status' | 'suspendReason' | 'blockedBy'> }) {
  if (r.status === 'suspended')
    return (
      <Badge tone="danger" title={r.suspendReason ?? undefined}>
        Suspended
      </Badge>
    );
  if (r.blockedBy)
    return (
      <Badge tone="warning" title={`${r.blockedBy.name} (${r.blockedBy.code}) is suspended`}>
        Blocked above
      </Badge>
    );
  return <Badge tone="success">Active</Badge>;
}
