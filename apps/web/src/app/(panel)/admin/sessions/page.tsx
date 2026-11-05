'use client';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { RefreshCw, Search, Unplug } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Input, Select } from '@/components/ui/input';
import { ConfirmDialog, ErrorState, Field, PageHeader } from '@/components/ui/misc';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useDebounced } from '@/hooks/use-debounced';
import { api, unwrap } from '@/lib/api';
import { useCan } from '@/lib/auth';
import type { Session } from '@/lib/queries';
import { fmtBytes, fmtDateTime, fmtDuration, relTime } from '@/lib/utils';

const who = (r: Session) =>
  r.subscriberId ? (
    <Link
      href={`/admin/subscribers/${r.subscriberId}`}
      className="font-mono text-xs hover:underline"
      onClick={(e) => e.stopPropagation()}
    >
      {r.username}
    </Link>
  ) : (
    <span className="font-mono text-xs">{r.username}</span>
  );

const baseColumns: Column<Session>[] = [
  { key: 'user', header: 'Username', cell: who },
  { key: 'ip', header: 'IP', cell: (r) => <span className="font-mono text-xs">{r.framedIp ?? '—'}</span> },
  {
    key: 'mac',
    header: 'MAC',
    cell: (r) => <span className="font-mono text-xs">{r.mac ?? '—'}</span>,
    hideOnMobile: true,
  },
  { key: 'nas', header: 'Router', cell: (r) => r.nasName ?? r.nasIp },
];

function Live() {
  const params = useSearchParams();
  const can = useCan();
  const [q, setQ] = useState('');
  const [nasIp, setNasIp] = useState(params.get('nas') ?? '');
  const [kick, setKick] = useState<Session | null>(null);
  const dq = useDebounced(q.trim(), 300);
  const summary = useQuery({
    queryKey: ['sessions', 'summary'],
    queryFn: () => unwrap(api.GET('/api/v1/sessions/summary')),
    refetchInterval: 30_000,
  });
  const live = useInfiniteQuery({
    queryKey: ['sessions', 'live', { q: dq, nasIp }],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/v1/sessions/live', {
          params: {
            query: {
              limit: 100,
              ...(dq ? { q: dq } : {}),
              ...(nasIp ? { nasIp } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    placeholderData: (prev) => prev,
    refetchInterval: 30_000,
  });
  const doKick = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.POST('/api/v1/subscribers/{id}/kick', { params: { path: { id } } })),
    onSuccess: () => {
      setKick(null);
      toast.success('Disconnect sent.');
      setTimeout(() => void live.refetch(), 3000);
    },
  });

  return (
    <>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            className="pl-9"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Username, IP or MAC (starts with)"
            aria-label="Search online sessions"
          />
        </div>
        <Select
          value={nasIp}
          onChange={(e) => setNasIp(e.target.value)}
          aria-label="Router"
          className="sm:w-56"
        >
          <option value="">All routers ({summary.data?.online ?? '…'})</option>
          {summary.data?.byNas.map((n) => (
            <option key={n.nasIp} value={n.nasIp}>
              {n.nasName ?? n.nasIp} ({n.online})
            </option>
          ))}
        </Select>
        <Button
          variant="outline"
          onClick={() => void live.refetch()}
          loading={live.isRefetching}
          aria-label="Refresh"
        >
          <RefreshCw /> <span className="sm:hidden">Refresh</span>
        </Button>
      </div>
      {live.isError ? (
        <ErrorState error={live.error} onRetry={() => void live.refetch()} />
      ) : (
        <DataTable
          caption="Online sessions"
          loading={live.isLoading}
          rows={live.data?.pages.flatMap((p) => p.items)}
          rowKey={(r) => r.id}
          hasMore={live.hasNextPage}
          loadingMore={live.isFetchingNextPage}
          onLoadMore={() => void live.fetchNextPage()}
          empty={dq || nasIp ? 'No online session matches.' : 'Nobody is online.'}
          columns={[
            ...baseColumns,
            {
              key: 'since',
              header: 'Online for',
              cell: (r) => (
                <span className="flex items-center gap-1" title={`Since ${fmtDateTime(r.startedAt)}`}>
                  {fmtDuration(r.sessionSecs)}
                  {r.stale ? (
                    <Badge tone="warning" title={`Last update ${relTime(r.updatedAt)}`}>
                      Not reporting
                    </Badge>
                  ) : null}
                </span>
              ),
            },
            {
              key: 'data',
              header: 'Down / up',
              cell: (r) => `${fmtBytes(r.downloadBytes)} / ${fmtBytes(r.uploadBytes)}`,
            },
            ...(can('subscribers.kick')
              ? [
                  {
                    key: 'kick',
                    header: '',
                    className: 'text-right',
                    cell: (r: Session) =>
                      r.subscriberId ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setKick(r)}
                          aria-label={`Kick ${r.username}`}
                        >
                          <Unplug /> Kick
                        </Button>
                      ) : null,
                  },
                ]
              : []),
          ]}
        />
      )}
      <ConfirmDialog
        open={!!kick}
        onOpenChange={(o) => !o && setKick(null)}
        title={`Kick ${kick?.username ?? ''}?`}
        description="The router drops the connection; the customer's router dials again automatically."
        confirmLabel="Kick"
        loading={doKick.isPending}
        onConfirm={() => kick?.subscriberId && doKick.mutate(kick.subscriberId)}
      />
    </>
  );
}

/** "Who had 100.64.3.7 at 21:40 on the 3rd?" — for complaints and police requests. */
function Lookup() {
  const [args, setArgs] = useState<{ ip: string; at: string } | null>(null);
  const q = useQuery({
    queryKey: ['sessions', 'lookup', args],
    queryFn: () => unwrap(api.GET('/api/v1/sessions/lookup', { params: { query: args! } })),
    enabled: !!args,
  });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setArgs({ ip: String(f.get('ip')).trim(), at: `${String(f.get('at'))}:00+05:30` });
  };
  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label="IP address" htmlFor="ip">
          <Input id="ip" name="ip" required inputMode="decimal" placeholder="e.g. 100.64.3.7" />
        </Field>
        <Field label="Date and time (IST)" htmlFor="at">
          <Input id="at" name="at" type="datetime-local" required />
        </Field>
        <Button type="submit" loading={q.isFetching}>
          Look up
        </Button>
      </form>
      {q.isError ? (
        <ErrorState error={q.error} />
      ) : args ? (
        <DataTable
          caption="Sessions that had this IP"
          loading={q.isLoading}
          rows={q.data}
          rowKey={(r) => r.id}
          empty="No session had this IP at that time."
          columns={[
            ...baseColumns,
            { key: 'start', header: 'From', cell: (r) => fmtDateTime(r.startedAt) },
            {
              key: 'end',
              header: 'To',
              cell: (r) => (r.stoppedAt ? fmtDateTime(r.stoppedAt) : 'Still online'),
            },
          ]}
        />
      ) : null}
    </div>
  );
}

export default function SessionsPage() {
  return (
    <>
      <PageHeader title="Sessions" description="Updates every 30 seconds." />
      <Tabs defaultValue="live">
        <TabsList>
          <TabsTrigger value="live">Online now</TabsTrigger>
          <TabsTrigger value="lookup">Who had an IP</TabsTrigger>
        </TabsList>
        <TabsContent value="live">
          <Suspense>
            <Live />
          </Suspense>
        </TabsContent>
        <TabsContent value="lookup">
          <Lookup />
        </TabsContent>
      </Tabs>
    </>
  );
}
