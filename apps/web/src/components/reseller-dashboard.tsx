'use client';
import { useQuery } from '@tanstack/react-query';
import { Bell, Router as RouterIcon, Server } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Popover } from 'radix-ui';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { api, unwrap } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { cn, fmtNum } from '@/lib/utils';

const LoginsLineChart = dynamic(() => import('@/components/network-charts').then((m) => m.LoginsLineChart), {
  ssr: false,
  loading: () => <Skeleton className="h-[180px] w-full rounded-xl" />,
});

const LOGIN_DOT = { accepted: 'bg-[#3AA570]', rejected: 'bg-danger-text' } as const;

export interface Notice {
  id: string;
  tone: 'danger' | 'warning' | 'info';
  title: string;
  body: string;
  href?: string;
  hrefLabel?: string;
}

const NOTICE_DOT = { danger: 'bg-danger-text', warning: 'bg-warning', info: 'bg-info-text' } as const;

/**
 * Header bell: problems that need the reseller (empty or frozen wallet, ...). The count stays on
 * the bell for as long as the problem lasts, not until it is read.
 */
export function NotificationBell({ notices }: { notices: Notice[] }) {
  const n = notices.length;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="relative size-11"
          aria-label={n ? `Notifications, ${n} need attention` : 'Notifications'}
        >
          <Bell />
          {n ? (
            <span className="absolute -top-1.5 -right-1.5 grid h-[18px] min-w-[18px] place-items-center rounded-full border-2 border-background bg-danger-text px-1 text-[10px] font-bold text-white tabular-nums">
              {n}
            </span>
          ) : null}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          className="z-50 w-[min(360px,calc(100vw-24px))] overflow-hidden rounded-2xl border bg-card shadow-[0_18px_40px_-12px_rgba(36,23,42,0.22)]"
        >
          <div className="flex items-center justify-between border-b border-divider px-4 py-3">
            <span className="text-sm font-bold">Notifications</span>
            <span className="text-xs text-muted-foreground">{n ? `${n} need attention` : 'All clear'}</span>
          </div>
          {n ? (
            <ul className="divide-y divide-divider">
              {notices.map((x) => (
                <li key={x.id} className="flex gap-3 px-4 py-3.5">
                  <span
                    className={cn('mt-1.5 size-2 shrink-0 rounded-full', NOTICE_DOT[x.tone])}
                    aria-hidden
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="text-sm font-bold text-foreground">{x.title}</span>
                    <span className="text-[13px] leading-snug text-body">{x.body}</span>
                    {x.href ? (
                      <Popover.Close asChild>
                        <Link href={x.href} className="mt-0.5 text-[13px] font-bold">
                          {x.hrefLabel ?? 'Open'}
                        </Link>
                      </Popover.Close>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              Nothing needs you right now.
            </p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

const istClock = new Intl.DateTimeFormat('en-IN', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Asia/Kolkata',
});
const EVENT_TONE = {
  start: 'text-info-text',
  stop: 'text-warning-text',
  accept: 'text-success-text',
  reject: 'text-danger-text',
} as const;

/** Newest RADIUS events (auth + accounting) of this reseller's customers and routers. */
function LiveLog({ names }: { names: Map<string, string> }) {
  const q = useQuery({
    queryKey: ['radius', 'tail', 'dashboard'],
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/radius/tail', {
          params: { query: { after: new Date(Date.now() - 30 * 60_000).toISOString() } },
        }),
      ),
    refetchInterval: 10_000,
  });
  const events = [...(q.data?.events ?? [])].reverse().slice(0, 30);
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <h3 className="text-[13px] font-bold text-body">Live log</h3>
        <Link href="/admin/radius-log" className="text-xs font-semibold text-muted-foreground">
          Open full log
        </Link>
      </div>
      <div
        className="h-[196px] overflow-y-auto rounded-xl border border-divider bg-subtle py-1.5 font-mono text-[11.5px]"
        aria-live="polite"
        aria-label="Radius events, newest first"
      >
        {q.isError ? (
          <div className="p-3">
            <ErrorState error={q.error} onRetry={() => void q.refetch()} />
          </div>
        ) : q.isLoading ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-4" />
            ))}
          </div>
        ) : events.length === 0 ? (
          <p className="p-4 font-sans text-[13px] text-muted-foreground">
            No Radius events in the last 30 minutes.
          </p>
        ) : (
          <ul>
            {events.map((e) => (
              <li
                key={e.id}
                className="grid grid-cols-[38px_52px_minmax(0,1fr)_auto] items-center gap-2 px-3 py-[5px]"
                title={`${e.username} @ ${names.get(e.nasIp) ?? e.nasIp}${e.detail ? ` · ${e.detail}` : ''}`}
              >
                <span className="text-muted-foreground">{istClock.format(new Date(e.at))}</span>
                <span className={cn('font-semibold uppercase', EVENT_TONE[e.type])}>{e.type}</span>
                <span className="truncate text-foreground">{e.username}</span>
                <span className="max-w-[120px] truncate text-muted-foreground">{e.detail ?? ''}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Logins per hour for the last 24 h, with the period totals. */
function LoginsPanel() {
  const q = useQuery({
    queryKey: ['radius', 'auth-log', 'summary', '24h'],
    queryFn: () => unwrap(api.GET('/api/v1/radius/auth-log/summary')),
    refetchInterval: 5 * 60_000,
  });
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[13px] font-bold text-body">Logins</h3>
        <span className="rounded-lg border px-2.5 py-1 text-xs text-muted-foreground">Last 24 h</span>
      </div>
      <dl className="flex gap-8">
        {(['accepted', 'rejected'] as const).map((k) => (
          <div key={k} className="flex flex-col gap-1">
            <dt className="flex items-center gap-2 text-[11px] font-bold tracking-[0.06em] text-muted-foreground uppercase">
              {k}
              <span className={cn('h-[3px] w-3.5 rounded-full', LOGIN_DOT[k])} aria-hidden />
            </dt>
            <dd className="text-2xl leading-tight font-extrabold tracking-[-0.02em] text-foreground tabular-nums">
              {q.data ? fmtNum(q.data[k]) : <Skeleton className="h-7 w-12" />}
            </dd>
          </div>
        ))}
      </dl>
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.isLoading ? (
        <Skeleton className="h-[180px] w-full rounded-xl" />
      ) : (
        <LoginsLineChart hours={q.data?.byHour ?? []} />
      )}
    </div>
  );
}

/** Reseller: customers online, its routers, logins per hour and the live RADIUS log. */
export function ResellerNetwork() {
  const can = useCan();
  const logs = can('sessions.read');
  const summary = useQuery({
    queryKey: ['sessions', 'summary'],
    queryFn: () => unwrap(api.GET('/api/v1/sessions/summary')),
    enabled: logs,
    refetchInterval: 30_000,
  });
  const nas = useQuery({
    queryKey: ['nas', 'all'],
    queryFn: () => unwrap(api.GET('/api/v1/nas', { params: { query: { limit: 200 } } })),
    enabled: can('nas.read'),
  });
  const onlineByIp = new Map((summary.data?.byNas ?? []).map((n) => [n.nasIp, n.online]));
  const routers = (nas.data?.items ?? [])
    .map((r) => ({ r, online: onlineByIp.get(r.ip) ?? 0 }))
    .sort((a, b) => b.online - a.online);
  const names = new Map((nas.data?.items ?? []).map((r) => [r.ip, r.name]));
  const online = summary.data?.online ?? 0;

  return (
    <Card className="flex flex-col gap-1 px-2 pt-3 pb-2" aria-labelledby="network-h">
      <div className="flex items-center justify-between gap-4 pr-2 pl-4">
        <h2 id="network-h" className="text-[15px] font-bold">
          My network
        </h2>
        <div className="flex">
          {logs ? (
            <Link
              href="/admin/radius-log"
              className="rounded-lg px-3 py-2.5 text-[13px] font-medium text-muted-foreground"
            >
              Logs
            </Link>
          ) : null}
          {can('nas.read') ? (
            <Link
              href="/admin/routers"
              className="rounded-lg px-3 py-2.5 text-[13px] font-medium text-muted-foreground"
            >
              Routers
            </Link>
          ) : null}
        </div>
      </div>

      <div
        className={cn(
          'grid gap-0 divide-y divide-divider pb-2',
          logs ? 'lg:grid-cols-[220px_minmax(0,1fr)_minmax(0,360px)] lg:divide-x lg:divide-y-0' : '',
        )}
      >
        <div className="flex flex-col gap-4 px-4 py-3">
          {logs ? (
            <Link href="/admin/sessions" className="flex flex-col gap-1 text-inherit hover:text-inherit">
              <span className="text-[13px] text-muted-foreground">Customers online</span>
              {summary.isLoading ? (
                <Skeleton className="h-9 w-20 rounded-lg" />
              ) : (
                <span
                  className={cn(
                    'text-[34px] leading-none font-extrabold tracking-[-0.03em] tabular-nums',
                    online ? 'text-success-text' : 'text-muted-foreground',
                  )}
                >
                  {fmtNum(online)}
                </span>
              )}
              <span className="text-xs text-muted-foreground">Updates every 30 s</span>
            </Link>
          ) : null}
          {can('nas.read') ? (
            <div className={cn('flex flex-col gap-1', logs && 'border-t border-divider pt-3.5')}>
              <span className="pb-1 text-[13px] text-muted-foreground">Routers</span>
              {nas.isLoading ? (
                <Skeleton className="h-10" />
              ) : routers.length === 0 ? (
                <div className="flex flex-col items-start gap-2 text-[13px] text-muted-foreground">
                  <p>No routers yet. Add your own MikroTik, or routers appear once customers connect.</p>
                  {can('nas.write') ? (
                    <Button size="sm" variant="outline" asChild>
                      <Link href="/admin/routers">
                        <RouterIcon /> Add router
                      </Link>
                    </Button>
                  ) : null}
                </div>
              ) : (
                <ul className="-mx-2 flex flex-col">
                  {routers.slice(0, 5).map(({ r, online: n }) => (
                    <li key={r.id}>
                      <Link
                        href={`/admin/routers/${r.id}`}
                        className="flex min-h-11 items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-inherit hover:bg-subtle hover:text-inherit"
                      >
                        <Server className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-[13px] font-semibold text-foreground">{r.name}</span>
                          <span className="text-[11px] text-muted-foreground">
                            {r.canManage ? 'Yours' : 'ISP'}
                          </span>
                        </span>
                        <span
                          className={cn(
                            'font-mono text-xs font-medium tabular-nums',
                            n ? 'text-success-text' : 'text-muted-foreground',
                          )}
                          aria-label={`${n} online`}
                        >
                          {fmtNum(n)}
                        </span>
                      </Link>
                    </li>
                  ))}
                  {routers.length > 5 ? (
                    <li>
                      <Link href="/admin/routers" className="block px-2 py-1.5 text-xs font-semibold">
                        +{routers.length - 5} more
                      </Link>
                    </li>
                  ) : null}
                </ul>
              )}
            </div>
          ) : null}
        </div>
        {logs ? (
          <>
            <div className="px-5 py-3">
              <LoginsPanel />
            </div>
            <div className="px-5 py-3">
              <LiveLog names={names} />
            </div>
          </>
        ) : null}
      </div>
    </Card>
  );
}
