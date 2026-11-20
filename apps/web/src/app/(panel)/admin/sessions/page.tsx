'use client';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { RefreshCw, Search, Unplug } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { toast } from '@/lib/toast';
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

/** datetime-local gives HH:MM, or HH:MM:SS when seconds are typed. */
const withSeconds = (v: string) => (v.length === 16 ? `${v}:00` : v);

/**
 * "Who had 100.64.3.7 at 21:40 on the 3rd?" — for complaints and police requests. Sessions answer it for customers
 * with their own IP; the NAT logs answer it for customers behind NAT (needs the port; searches are audited).
 */
function Lookup() {
  const can = useCan();
  const nat = can('compliance.lookup');
  const [args, setArgs] = useState<{ ip: string; at: string; port?: number; windowMins: number } | null>(
    null,
  );
  const q = useQuery({
    queryKey: ['sessions', 'lookup', args],
    queryFn: () =>
      unwrap(api.GET('/api/v1/sessions/lookup', { params: { query: { ip: args!.ip, at: args!.at } } })),
    enabled: !!args,
  });
  const n = useQuery({
    queryKey: ['compliance', 'nat', args],
    queryFn: () => unwrap(api.GET('/api/v1/compliance/nat-lookup', { params: { query: args! } })),
    enabled: !!args && nat && !args.ip.includes(':'),
    retry: false,
  });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const port = String(f.get('port') ?? '').trim();
    setArgs({
      ip: String(f.get('ip')).trim(),
      at: `${withSeconds(String(f.get('at')))}+05:30`,
      windowMins: Number(f.get('window') ?? 5),
      ...(port ? { port: Number(port) } : {}),
    });
  };
  return (
    <div className="space-y-4">
      <form
        onSubmit={submit}
        className={`grid gap-3 sm:items-end ${nat ? 'sm:grid-cols-[1fr_7rem_1fr_8rem_auto]' : 'sm:grid-cols-[1fr_1fr_auto]'}`}
      >
        <Field label="IP address" htmlFor="ip">
          <Input id="ip" name="ip" required inputMode="decimal" placeholder="e.g. 203.0.113.9" />
        </Field>
        {nat ? (
          <Field label="Port" htmlFor="port" hint="Source port, if known">
            <Input id="port" name="port" inputMode="numeric" pattern="[0-9]*" placeholder="40001" />
          </Field>
        ) : null}
        <Field label="Date and time (IST)" htmlFor="at">
          <Input id="at" name="at" type="datetime-local" step={1} required />
        </Field>
        {nat ? (
          <Field label="Search ±" htmlFor="window">
            <Select id="window" name="window" defaultValue="5">
              <option value="1">1 min</option>
              <option value="5">5 min</option>
              <option value="15">15 min</option>
              <option value="60">60 min</option>
            </Select>
          </Field>
        ) : null}
        <Button type="submit" loading={q.isFetching || n.isFetching}>
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
      {args && nat ? (
        n.isError ? (
          <ErrorState error={n.error} />
        ) : n.data && !n.data.configured ? (
          <p className="text-sm text-muted-foreground">NAT log archive is not set up on this server yet.</p>
        ) : (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">NAT logs (customers behind NAT)</h3>
            <DataTable
              caption="Connections that went out as this public IP"
              loading={n.isLoading}
              rows={n.data?.hits}
              rowKey={(r) => `${r.at}-${r.router}-${r.privateIp}-${r.privatePort}-${r.publicPort}`}
              empty="No NAT log line for this IP in that window."
              columns={[
                { key: 'at', header: 'Time', cell: (r) => fmtDateTime(r.at) },
                {
                  key: 'who',
                  header: 'Customer',
                  cell: (r) =>
                    r.subscriber ? (
                      <Link href={`/admin/subscribers/${r.subscriber.id}`} className="underline">
                        {r.subscriber.name} · {r.subscriber.customerNo}
                      </Link>
                    ) : (
                      (r.username ?? <span className="text-muted-foreground">Unknown ({r.inInterface})</span>)
                    ),
                },
                {
                  key: 'pub',
                  header: 'Public',
                  cell: (r) => `${r.publicIp}${r.publicPort ? `:${r.publicPort}` : ''}`,
                },
                {
                  key: 'priv',
                  header: 'Private',
                  cell: (r) => `${r.privateIp}${r.privatePort ? `:${r.privatePort}` : ''}`,
                  hideOnMobile: true,
                },
                {
                  key: 'dest',
                  header: 'Destination',
                  cell: (r) => `${r.proto} ${r.destIp}${r.destPort ? `:${r.destPort}` : ''}`,
                  hideOnMobile: true,
                },
                {
                  key: 'router',
                  header: 'Router',
                  cell: (r) => r.routerName ?? r.router,
                  hideOnMobile: true,
                },
              ]}
            />
            {n.data ? (
              <p className="text-xs text-muted-foreground">
                Searched {n.data.filesScanned} file(s), {fmtBytes(n.data.bytesScanned)}
                {n.data.truncated ? ' · first 200 matches only, narrow the time or add the port' : ''}. This
                search is recorded in the audit log.
              </p>
            ) : null}
          </div>
        )
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
