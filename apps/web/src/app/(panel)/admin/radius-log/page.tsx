'use client';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Download, Maximize2, Minimize2, Pause, Play, Search, Square } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';
import { ErrorState, KeyValue, PageHeader } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useDebounced } from '@/hooks/use-debounced';
import { api, unwrap, type ApiData } from '@/lib/api';
import { useCan, useMe } from '@/lib/auth';
import { cn, fmtDate, fmtDateTime } from '@/lib/utils';

type Entry = ApiData<'/api/v1/radius/auth-log'>['items'][number];
type TailEvent = ApiData<'/api/v1/radius/tail'>['events'][number];

const RANGES = { '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000, '31d': 31 * 86_400_000 } as const;
type Range = keyof typeof RANGES;

function useRouters() {
  return useQuery({
    queryKey: ['nas', 'all'],
    queryFn: () => unwrap(api.GET('/api/v1/nas', { params: { query: { limit: 200 } } })),
    staleTime: 5 * 60_000,
  });
}

function AuthLog() {
  const params = useSearchParams();
  const [q, setQ] = useState(params.get('user') ?? '');
  const [result, setResult] = useState<'' | 'accept' | 'reject'>(
    params.get('result') === 'reject' ? 'reject' : '',
  );
  const [reason, setReason] = useState('');
  const [nasIp, setNasIp] = useState('');
  const [range, setRange] = useState<Range>('24h');
  // Window start fixed per choice, so pages and refetches see the same window until the user changes it.
  const [from, setFrom] = useState(() => new Date(Date.now() - RANGES['24h']).toISOString());
  const [auto, setAuto] = useState(true);
  const [why, setWhy] = useState<Entry | null>(null);
  const dq = useDebounced(q.trim(), 300);
  const routers = useRouters();
  const summary = useQuery({
    queryKey: ['auth-log', 'summary', from],
    queryFn: () => unwrap(api.GET('/api/v1/radius/auth-log/summary', { params: { query: { from } } })),
    refetchInterval: auto ? 30_000 : false,
    placeholderData: keepPreviousData,
  });
  const list = useInfiniteQuery({
    queryKey: ['auth-log', { dq, result, reason, nasIp, from }],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/v1/radius/auth-log', {
          params: {
            query: {
              from,
              limit: 100,
              ...(dq ? { q: dq } : {}),
              ...(result ? { result } : {}),
              ...(reason ? { reason } : {}),
              ...(nasIp ? { nasIp } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    refetchInterval: auto ? 30_000 : false,
  });
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items), [list.data]);
  const columns = useMemo<Column<Entry>[]>(
    () => [
      {
        key: 'at',
        header: 'Time',
        cell: (r) => <span className="whitespace-nowrap">{fmtDateTime(r.at)}</span>,
      },
      {
        key: 'user',
        header: 'Username',
        cell: (r) =>
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
          ),
      },
      {
        key: 'result',
        header: 'Result',
        cell: (r) =>
          r.accepted ? <Badge tone="success">Accept</Badge> : <Badge tone="danger">Reject</Badge>,
      },
      { key: 'reason', header: 'Reason', cell: (r) => r.reason ?? '—' },
      { key: 'nas', header: 'Router', cell: (r) => r.nasName ?? r.nasIp, hideOnMobile: true },
      {
        key: 'mac',
        header: 'MAC',
        cell: (r) => <span className="font-mono text-xs">{r.mac ?? '—'}</span>,
        hideOnMobile: true,
      },
      {
        key: 'why',
        header: '',
        cell: (r) => (
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              setWhy(r);
            }}
          >
            Why?
          </Button>
        ),
        className: 'text-right',
      },
    ],
    [],
  );
  const s = summary.data;
  return (
    <>
      <div className="mb-3 flex flex-wrap gap-2 text-sm">
        {s ? (
          <>
            <Badge tone="success">{s.accepted} accepted</Badge>
            <Badge tone="danger">{s.rejected} rejected</Badge>
          </>
        ) : (
          <Skeleton className="h-6 w-48" />
        )}
      </div>
      <div className="mb-4 grid gap-2 sm:grid-cols-[1fr_auto_auto_auto_auto_auto]">
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            className="pl-9"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Username or MAC (starts with)"
            aria-label="Search the auth log"
          />
        </div>
        <Select
          value={result}
          onChange={(e) => setResult(e.target.value as typeof result)}
          aria-label="Result"
        >
          <option value="">Accept + Reject</option>
          <option value="accept">Accepted</option>
          <option value="reject">Rejected</option>
        </Select>
        <Select
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          aria-label="Reason"
          className="sm:w-52"
        >
          <option value="">All reasons</option>
          {s?.reasons.map((r) => (
            <option key={`${r.reason}-${r.accepted}`} value={r.reason}>
              {r.reason} ({r.count})
            </option>
          ))}
        </Select>
        <Select
          value={nasIp}
          onChange={(e) => setNasIp(e.target.value)}
          aria-label="Router"
          className="sm:w-44"
        >
          <option value="">All routers</option>
          {routers.data?.items.map((n) =>
            n.ip ? (
              <option key={n.id} value={n.ip}>
                {n.name}
              </option>
            ) : null,
          )}
        </Select>
        <Select
          value={range}
          onChange={(e) => {
            const r = e.target.value as Range;
            setRange(r);
            setFrom(new Date(Date.now() - RANGES[r]).toISOString());
          }}
          aria-label="Period"
        >
          <option value="1h">Last hour</option>
          <option value="24h">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
          <option value="31d">Last 31 days</option>
        </Select>
        <label className="flex items-center gap-2 text-sm whitespace-nowrap">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          Auto-refresh
        </label>
      </div>
      {list.error ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={list.isPending}
          onRowClick={setWhy}
          hasMore={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
          empty="No login attempts in this period."
          caption="RADIUS login attempts"
        />
      )}
      <WhyDialog entry={why} onClose={() => setWhy(null)} />
    </>
  );
}

function WhyDialog({ entry, onClose }: { entry: Entry | null; onClose: () => void }) {
  const why = useQuery({
    queryKey: ['auth-log', 'why', entry?.id],
    queryFn: () => unwrap(api.GET('/api/v1/radius/auth-log/why', { params: { query: { id: entry!.id } } })),
    enabled: !!entry,
    staleTime: 60_000,
  });
  const w = why.data;
  return (
    <Dialog open={!!entry} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={w?.title ?? 'Why?'}
        description={entry ? `${entry.username} · ${fmtDateTime(entry.at)}` : undefined}
      >
        {why.error ? <ErrorState error={why.error} onRetry={() => void why.refetch()} /> : null}
        {!w && !why.error ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : null}
        {w ? (
          <div className="space-y-4 text-sm">
            {w.routerHint ? (
              <p className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-warning-text">
                <span className="font-semibold">Router problem: </span>
                {w.routerHint}
              </p>
            ) : null}
            <p>{w.explanation}</p>
            <p className="rounded-xl bg-muted p-3">
              <span className="font-semibold">Fix: </span>
              {w.fix}
            </p>
            {w.similar.length ? (
              <div>
                <p className="mb-1 font-semibold">Similar usernames</p>
                <ul className="space-y-1">
                  {w.similar.map((x) => (
                    <li key={x.username} className="font-mono text-xs">
                      {x.subscriberId ? (
                        <Link href={`/admin/subscribers/${x.subscriberId}`} className="hover:underline">
                          {x.username}
                        </Link>
                      ) : (
                        x.username
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <details>
              <summary className="cursor-pointer font-semibold">Technical details</summary>
              <div className="mt-2">
                <KeyValue
                  items={[
                    [
                      'Username sent',
                      <span key="u" className="font-mono">
                        {w.entry.username}
                      </span>,
                    ],
                    ['Result', w.entry.accepted ? 'Access-Accept' : 'Access-Reject'],
                    ['Reason logged', w.entry.reason ?? '—'],
                    ['Router', `${w.entry.nasName ?? 'Unknown'} (${w.entry.nasIp})`],
                    ['MAC', w.entry.mac ?? '—'],
                    ['In the database', w.subscriber ? `Yes · ${w.subscriber.status}` : 'No'],
                    ...(w.subscriber
                      ? ([
                          ['Plan', w.subscriber.plan ?? 'None'],
                          ['Valid until', fmtDate(w.subscriber.expiresAt)],
                          ['MAC lock', w.subscriber.macLock ?? 'Off'],
                        ] as [string, string][])
                      : []),
                    ['Last 24 h', `${w.last24h.accepted} accepted · ${w.last24h.rejected} rejected`],
                  ]}
                />
              </div>
            </details>
            <div className="flex flex-wrap justify-end gap-2">
              {w.subscriber ? (
                <Button variant="outline" asChild>
                  <Link href={`/admin/subscribers/${w.subscriber.id}`}>Open subscriber</Link>
                </Button>
              ) : null}
              <Button variant="outline" asChild>
                <Link href={`/admin/radius-log?tab=live&user=${encodeURIComponent(w.entry.username)}`}>
                  Live log for this user
                </Link>
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

const MAX_LINES = 2000;
const EMPTY: TailEvent[] = [];
const TYPE_TONE: Record<TailEvent['type'], string> = {
  accept: 'text-emerald-400',
  reject: 'text-red-400',
  start: 'text-sky-400',
  stop: 'text-amber-300',
};

function LiveLog() {
  const params = useSearchParams();
  const [state, setState] = useState<'running' | 'paused' | 'stopped'>('running');
  const [user, setUser] = useState(params.get('user') ?? '');
  const [text, setText] = useState('');
  const [type, setType] = useState<'all' | 'auth' | 'acct'>('all');
  const [full, setFull] = useState(false);
  const [buf, setBuf] = useState<{ key: string; lines: TailEvent[] }>({ key: '', lines: [] });
  const [error, setError] = useState<string | null>(null);
  const du = useDebounced(user.trim(), 400);
  const dt = useDebounced(text.trim().toLowerCase(), 200);
  const cursor = useRef<string | undefined>(undefined);
  const seen = useRef(new Set<string>());
  const box = useRef<HTMLDivElement>(null);
  // A new user/type filter starts a new stream; lines of the old one are dropped.
  const streamKey = `${du}|${type}`;
  const lines = buf.key === streamKey ? buf.lines : EMPTY;

  useEffect(() => {
    if (state !== 'running') return;
    let stop = false;
    if (buf.key !== streamKey) {
      cursor.current = undefined;
      seen.current = new Set();
    }
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (document.visibilityState === 'visible') {
        try {
          const r = await unwrap(
            api.GET('/api/v1/radius/tail', {
              params: {
                query: {
                  type,
                  ...(du ? { user: du } : {}),
                  ...(cursor.current ? { after: cursor.current } : {}),
                },
              },
            }),
          );
          if (stop) return;
          const fresh = r.events.filter((e) => !seen.current.has(e.id));
          for (const e of fresh) seen.current.add(e.id);
          // Next poll from the newest event (ids dedupe the overlap), else from the server's clock minus a margin.
          cursor.current = fresh.length
            ? fresh[fresh.length - 1]!.at
            : new Date(new Date(r.now).getTime() - 5_000).toISOString();
          if (seen.current.size > MAX_LINES * 2) seen.current = new Set(fresh.map((e) => e.id));
          if (fresh.length)
            setBuf((b) => ({
              key: streamKey,
              lines: [...(b.key === streamKey ? b.lines : []), ...fresh].slice(-MAX_LINES),
            }));
          setError(null);
        } catch (e) {
          if (!stop) setError(e instanceof Error ? e.message : 'Could not load the log');
        }
      }
      if (!stop) timer = setTimeout(() => void tick(), 2000);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
    // buf.key is read only to decide whether this run continues the current stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, du, type, streamKey]);

  const shown = useMemo(
    () =>
      dt
        ? lines.filter((l) =>
            `${l.username} ${l.nasIp} ${l.detail ?? ''} ${l.type}`.toLowerCase().includes(dt),
          )
        : lines,
    [lines, dt],
  );

  useEffect(() => {
    const el = box.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [shown]);

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setFull(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full]);

  const download = () => {
    const body = shown
      .map((l) => `${l.at}\t${l.type.toUpperCase()}\t${l.username}\t${l.nasIp}\t${l.detail ?? ''}`)
      .join('\n');
    const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `radius-log-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={cn(full && 'fixed inset-0 z-50 flex flex-col bg-background p-4')}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {state === 'running' ? (
          <Button variant="outline" onClick={() => setState('paused')}>
            <Pause /> Pause
          </Button>
        ) : (
          <Button onClick={() => setState('running')}>
            <Play /> {state === 'stopped' ? 'Start' : 'Resume'}
          </Button>
        )}
        <Button
          variant="outline"
          disabled={state === 'stopped'}
          onClick={() => {
            setState('stopped');
            setBuf({ key: '', lines: [] });
          }}
        >
          <Square /> Stop
        </Button>
        <Input
          value={user}
          onChange={(e) => setUser(e.target.value)}
          placeholder="This user only"
          aria-label="Username"
          className="w-44"
        />
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Filter text"
          aria-label="Filter text"
          className="w-40"
        />
        <Select
          value={type}
          onChange={(e) => setType(e.target.value as typeof type)}
          aria-label="Type"
          className="w-36"
        >
          <option value="all">Auth + accounting</option>
          <option value="auth">Auth only</option>
          <option value="acct">Accounting only</option>
        </Select>
        <span className="ml-auto flex items-center gap-2">
          <Badge tone={state === 'running' ? 'success' : 'neutral'}>
            {state === 'running' ? 'Live' : state === 'paused' ? 'Paused' : 'Stopped'}
          </Badge>
          <Button
            variant="ghost"
            size="icon"
            onClick={download}
            aria-label="Download"
            disabled={!shown.length}
          >
            <Download />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setFull((f) => !f)}
            aria-label={full ? 'Exit full screen' : 'Full screen'}
          >
            {full ? <Minimize2 /> : <Maximize2 />}
          </Button>
        </span>
      </div>
      {error ? <p className="mb-2 text-sm text-destructive">{error}</p> : null}
      <div
        ref={box}
        className={cn(
          'overflow-auto rounded-xl bg-[#14111a] p-3 font-mono text-xs leading-5 text-zinc-200',
          full ? 'flex-1' : 'h-[60vh]',
        )}
        role="log"
        aria-live="off"
      >
        {shown.length ? (
          shown.map((l) => (
            <div key={l.id} className="whitespace-pre-wrap">
              <span className="text-zinc-500">{fmtDateTime(l.at)}</span>{' '}
              <span className={cn('inline-block w-14 font-semibold', TYPE_TONE[l.type])}>
                {l.type.toUpperCase()}
              </span>{' '}
              <span>{l.username}</span> <span className="text-zinc-500">@ {l.nasIp}</span>
              {l.detail ? <span className="text-zinc-400"> · {l.detail}</span> : null}
            </div>
          ))
        ) : (
          <p className="text-zinc-500">
            {state === 'running' ? 'Waiting for RADIUS events…' : 'Press Start to follow RADIUS events.'}
          </p>
        )}
      </div>
    </div>
  );
}

const PROBLEM_TEXT = {
  bad_secret: 'wrong RADIUS secret on the router',
  suspect_secret: 'customers fail with “wrong password”: RADIUS secret probably wrong',
  silent: 'no login attempts in 24 h',
} as const;

/** F-17: routers whose packets RADIUS cannot use, at the top of the log. */
function RouterProblemsBanner({ onOpen }: { onOpen: () => void }) {
  const can = useCan();
  const q = useQuery({
    queryKey: ['radius', 'router-problems'],
    queryFn: () => unwrap(api.GET('/api/v1/radius/router-problems')),
    refetchInterval: 60_000,
    enabled: can('nas.read'),
  });
  const bad =
    q.data?.routers.filter((r) => r.problem === 'bad_secret' || r.problem === 'suspect_secret') ?? [];
  if (!bad.length) return null;
  return (
    <div
      className="mb-3 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-warning-text"
      role="status"
    >
      <p className="font-semibold">Router problem{bad.length > 1 ? 's' : ''}</p>
      <ul className="mt-1 space-y-0.5">
        {bad.map((r) => (
          <li key={r.nasIp}>
            {r.name} ({r.nasIp}): {PROBLEM_TEXT[r.problem!]}
            {r.badSecret
              ? ` · ${r.badSecret.packets}+ packets, last ${fmtDateTime(r.badSecret.lastSeen)}`
              : ''}
          </li>
        ))}
      </ul>
      <button type="button" className="mt-1 underline" onClick={onOpen}>
        Open router checks
      </button>
    </div>
  );
}

const KIND_TEXT = {
  unknown_client: 'reached RADIUS, but this address is not a router in the panel',
  firewall_block: 'blocked by the firewall (address not on the router allow-list)',
  bad_secret: 'reached RADIUS with the wrong secret',
} as const;

function RouterChecks() {
  const can = useCan();
  const me = useMe();
  const problems = useQuery({
    queryKey: ['radius', 'router-problems'],
    queryFn: () => unwrap(api.GET('/api/v1/radius/router-problems')),
    refetchInterval: 60_000,
    enabled: can('nas.read'),
  });
  const [ip, setIp] = useState('');
  const [asked, setAsked] = useState('');
  const check = useQuery({
    queryKey: ['radius', 'address', asked],
    queryFn: () => unwrap(api.GET('/api/v1/radius/address-check', { params: { query: { ip: asked } } })),
    enabled: !!asked,
  });
  const superAdmin = me.data?.user.type === 'superadmin';
  const unknown = useQuery({
    queryKey: ['radius', 'unknown'],
    queryFn: () => unwrap(api.GET('/api/v1/radius/unknown-clients')),
    enabled: superAdmin,
  });
  if (!can('nas.read')) return <p className="text-sm text-muted-foreground">Needs the routers permission.</p>;
  const c = check.data;
  return (
    <div className="space-y-6">
      {problems.isError ? (
        <ErrorState error={problems.error} onRetry={() => void problems.refetch()} />
      ) : null}
      <DataTable
        caption="RADIUS health per router"
        loading={problems.isLoading}
        rows={problems.data?.routers}
        rowKey={(r) => r.nasIp}
        empty="No routers yet."
        columns={[
          {
            key: 'r',
            header: 'Router',
            cell: (r) => (
              <span>
                <span className="font-medium">{r.name}</span>
                <span className="block font-mono text-xs text-muted-foreground">{r.nasIp}</span>
              </span>
            ),
          },
          {
            key: 'last',
            header: 'Last login attempt',
            cell: (r) => (r.lastAuthAt ? fmtDateTime(r.lastAuthAt) : '—'),
          },
          {
            key: 'n',
            header: '24 h',
            className: 'tabular-nums',
            cell: (r) => `${r.accepted24h} ok · ${r.rejected24h} rejected`,
          },
          {
            key: 'p',
            header: 'Status',
            cell: (r) =>
              r.problem ? (
                <Badge tone={r.problem === 'silent' ? 'neutral' : 'warning'}>{PROBLEM_TEXT[r.problem]}</Badge>
              ) : (
                <Badge tone="success">OK</Badge>
              ),
          },
        ]}
      />
      <div className="rounded-xl border p-4">
        <p className="font-semibold">Router not reaching RADIUS?</p>
        <p className="mb-3 text-sm text-muted-foreground">
          Enter the public address the router sends from. You see what arrived from it in the last 7 days.
        </p>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setAsked(ip.trim());
          }}
        >
          <Input
            aria-label="Router address"
            className="w-56 font-mono"
            placeholder="e.g. 103.109.222.166"
            value={ip}
            onChange={(e) => setIp(e.target.value)}
          />
          <Button type="submit" variant="outline" loading={check.isFetching} disabled={!ip.trim()}>
            Check
          </Button>
        </form>
        {check.error ? (
          <p className="mt-2 text-sm text-destructive">{(check.error as Error).message}</p>
        ) : null}
        {c ? (
          <div className="mt-3 space-y-2 text-sm">
            <p className="font-medium">{c.verdict}</p>
            {c.events.length ? (
              <ul className="space-y-0.5 text-muted-foreground">
                {c.events.map((e) => (
                  <li key={`${e.kind}-${e.port}`}>
                    Port {e.port}: {KIND_TEXT[e.kind]} · {e.packets}+ packets · last {fmtDateTime(e.lastSeen)}
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Routers must send to {c.radius.host ?? 'this server'} · auth {c.radius.authPort} · accounting{' '}
              {c.radius.acctPort}.
            </p>
          </div>
        ) : null}
      </div>
      {superAdmin ? (
        <DataTable
          caption="Addresses sending RADIUS that are no ISP's router (24 h)"
          loading={unknown.isLoading}
          rows={unknown.data?.items}
          rowKey={(r) => `${r.ip}-${r.kind}-${r.port}`}
          empty="None."
          columns={[
            { key: 'ip', header: 'Address', cell: (r) => <span className="font-mono">{r.ip}</span> },
            { key: 'k', header: 'What happened', cell: (r) => KIND_TEXT[r.kind] },
            { key: 'port', header: 'Port', cell: (r) => r.port },
            { key: 'n', header: 'Packets', cell: (r) => `${r.packets}+` },
            { key: 'at', header: 'Last', cell: (r) => fmtDateTime(r.lastSeen) },
          ]}
        />
      ) : null}
    </div>
  );
}

function RadiusLogPage() {
  const params = useSearchParams();
  const router = useRouter();
  const t = params.get('tab');
  const tab = t === 'live' || t === 'routers' ? t : 'auth';
  return (
    <>
      <PageHeader
        title="RADIUS log"
        description="Every login attempt with the reason, and a live view of RADIUS."
      />
      <Tabs
        value={tab}
        onValueChange={(v) =>
          router.replace(v === 'auth' ? '/admin/radius-log' : `/admin/radius-log?tab=${v}`)
        }
      >
        <TabsList>
          <TabsTrigger value="auth">Auth log</TabsTrigger>
          <TabsTrigger value="live">Live</TabsTrigger>
          <TabsTrigger value="routers">Routers</TabsTrigger>
        </TabsList>
        <TabsContent value="auth">
          <RouterProblemsBanner onOpen={() => router.replace('/admin/radius-log?tab=routers')} />
          <AuthLog />
        </TabsContent>
        <TabsContent value="routers">
          <RouterChecks />
        </TabsContent>
        <TabsContent value="live">
          <LiveLog />
        </TabsContent>
      </Tabs>
    </>
  );
}

export default function Page() {
  return (
    <Suspense>
      <RadiusLogPage />
    </Suspense>
  );
}
