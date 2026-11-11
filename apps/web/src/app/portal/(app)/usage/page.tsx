'use client';
import { useQuery } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import { portalKeys } from '@/components/portal';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { ErrorState, Stat } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { api, unwrap } from '@/lib/api';
import { fmtBytes, fmtDateTime } from '@/lib/utils';

const UsageChart = dynamic(() => import('@/components/usage-chart'), {
  ssr: false,
  loading: () => <Skeleton className="h-64 w-full" />,
});

export default function PortalUsage() {
  const usage = useQuery({
    queryKey: portalKeys.usage,
    queryFn: () => unwrap(api.GET('/api/v1/portal/usage')),
  });
  const sessions = useQuery({
    queryKey: portalKeys.sessions,
    queryFn: () => unwrap(api.GET('/api/v1/portal/sessions')),
  });
  if (usage.isError) return <ErrorState error={usage.error} onRetry={() => void usage.refetch()} />;
  const days = usage.data?.days ?? [];
  const down = days.reduce((n, d) => n + d.downloadBytes, 0);
  const up = days.reduce((n, d) => n + d.uploadBytes, 0);
  const cycle = usage.data?.cycle;

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Downloaded (31 days)" value={usage.isLoading ? '…' : fmtBytes(down)} />
        <Stat label="Uploaded (31 days)" value={usage.isLoading ? '…' : fmtBytes(up)} />
      </div>
      {cycle ? (
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Data this cycle</CardTitle>
            {cycle.fupActive ? <Badge tone="warning">Reduced speed</Badge> : null}
          </CardHeader>
          <CardContent className="space-y-2">
            <div
              className="h-2 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={cycle.capBytes}
              aria-valuenow={cycle.usedBytes}
            >
              <div
                className="h-full bg-primary"
                style={{ width: `${Math.min(100, (cycle.usedBytes / cycle.capBytes) * 100)}%` }}
              />
            </div>
            <p className="text-sm text-muted-foreground">
              {fmtBytes(cycle.usedBytes)} of {fmtBytes(cycle.capBytes)}
            </p>
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Daily usage</CardTitle>
        </CardHeader>
        <CardContent>
          {usage.isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : days.length ? (
            <UsageChart days={days} />
          ) : (
            <p className="text-sm text-muted-foreground">No usage recorded yet.</p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Recent connections</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            caption="Recent connections"
            rows={sessions.data?.items}
            loading={sessions.isLoading}
            rowKey={(r) => r.start}
            empty="No connections yet."
            columns={[
              {
                key: 'start',
                header: 'Connected',
                cell: (r) => (
                  <span className="flex items-center gap-2">
                    {fmtDateTime(r.start)}
                    {r.online ? <Badge tone="success">Online</Badge> : null}
                  </span>
                ),
              },
              { key: 'stop', header: 'Ended', cell: (r) => (r.stop ? fmtDateTime(r.stop) : '—') },
              { key: 'down', header: 'Download', cell: (r) => fmtBytes(r.downloadBytes) },
              { key: 'up', header: 'Upload', cell: (r) => fmtBytes(r.uploadBytes), hideOnMobile: true },
            ]}
          />
        </CardContent>
      </Card>
    </>
  );
}
