import { Badge } from '@/components/ui/badge';
import type { Reseller, Subscriber } from '@/lib/queries';

export function SubscriberState({ s }: { s: Pick<Subscriber, 'status' | 'radiusState' | 'suspendReason'> }) {
  if (s.status === 'suspended')
    return (
      <Badge tone="danger" title={s.suspendReason ?? undefined}>
        Suspended
      </Badge>
    );
  if (s.status === 'disabled') return <Badge tone="danger">Disabled</Badge>;
  if (s.radiusState === 'expired') return <Badge tone="warning">Expired</Badge>;
  if (s.radiusState === 'fup') return <Badge tone="warning">FUP speed</Badge>;
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
