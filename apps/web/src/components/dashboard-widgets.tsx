'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Phone, Zap } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBar } from '@/components/ui/card';
import { SegmentedList, SegmentedTrigger, Tabs } from '@/components/ui/tabs';
import { ErrorState } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { api, unwrap, type ApiData } from '@/lib/api';
import { usePlans } from '@/lib/queries';
import { cn, fmtBps, fmtBytes, fmtNum, fmtRupees0, plural } from '@/lib/utils';

const ChartSkeleton = () => <Skeleton className="h-[220px] w-full rounded-xl" />;
const OnlineChart = dynamic(() => import('@/components/network-charts').then((m) => m.OnlineChart), {
  ssr: false,
  loading: ChartSkeleton,
});
const LoginsChart = dynamic(() => import('@/components/network-charts').then((m) => m.LoginsChart), {
  ssr: false,
  loading: ChartSkeleton,
});

const Swatch = ({ className }: { className: string }) => (
  <span className={cn('inline-block size-2.5 rounded-[3px] align-middle', className)} aria-hidden />
);

/** Online users over 24 h vs last week, and RADIUS logins vs rejects per hour. */
export function NetworkRow() {
  const q = useQuery({
    queryKey: ['sessions', 'activity'],
    queryFn: () => unwrap(api.GET('/api/v1/sessions/activity')),
    refetchInterval: 5 * 60_000,
  });
  const hours = q.data?.hours ?? [];
  const logins = hours.reduce((n, h) => n + h.accepted, 0);
  const rejects = hours.reduce((n, h) => n + h.rejected, 0);
  const rate = logins + rejects > 0 ? (rejects / (logins + rejects)) * 100 : null;

  return (
    <div className="flex flex-wrap gap-3">
      <Card className="flex min-w-0 flex-[3_1_480px] flex-col gap-3.5 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="mr-auto text-base font-bold">Online users, last 24 h</h2>
          <span className="flex items-center gap-1.5 text-xs text-body">
            <span className="inline-block h-0.5 w-3.5 bg-chart-1" aria-hidden />
            Today
          </span>
          <span className="flex items-center gap-1.5 text-xs text-body">
            <span className="inline-block w-3.5 border-t-2 border-dashed border-chart-2" aria-hidden />
            Same time last week
          </span>
        </div>
        {q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : q.isLoading ? (
          <ChartSkeleton />
        ) : q.data?.points.length ? (
          <OnlineChart points={q.data.points} />
        ) : (
          <p className="py-16 text-center text-sm text-muted-foreground">
            No sessions yet. The chart fills in as routers send accounting.
          </p>
        )}
      </Card>

      <Card className="flex min-w-0 flex-[2_1_340px] flex-col gap-3.5 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="mr-auto text-base font-bold">Logins vs rejects per hour</h2>
          {rate !== null ? (
            <span className="font-mono text-[11px] text-muted-foreground">
              reject rate {rate.toFixed(1)}%
            </span>
          ) : null}
        </div>
        {q.isError ? null : q.isLoading ? (
          <ChartSkeleton />
        ) : (
          <>
            <LoginsChart hours={hours} />
            <div className="flex flex-wrap gap-4 text-xs text-body">
              <span className="flex items-center gap-1.5">
                <Swatch className="bg-chart-1" />
                Logins {fmtNum(logins)}
              </span>
              <span className="flex items-center gap-1.5">
                <Swatch className="bg-[repeating-linear-gradient(45deg,var(--chart-2)_0_2px,#F6C894_2px_4px)]" />
                Rejects {fmtNum(rejects)}
              </span>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

type Expiring = ApiData<'/api/v1/subscribers/expiring'>;
type ExpiringSub = Expiring['items'][number];

const istDay = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
const shortDate = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Asia/Kolkata',
});
function whenLabel(iso: string) {
  const days = Math.round(
    (Date.parse(`${istDay(new Date(iso))}T00:00:00Z`) - Date.parse(`${istDay(new Date())}T00:00:00Z`)) /
      86_400_000,
  );
  return {
    when: days <= 0 ? 'Today' : days === 1 ? 'Tomorrow' : `In ${days} days`,
    urgent: days <= 1,
    date: shortDate.format(new Date(iso)),
  };
}

export type ExpiryWindow = 'today' | 'tomorrow' | '7d';

export function useExpiring(days: number, limit: number, window?: ExpiryWindow) {
  return useQuery({
    queryKey: ['subscribers', 'expiring', days, limit, window ?? null],
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/subscribers/expiring', {
          params: { query: { days, limit, ...(window ? { window } : {}) } },
        }),
      ),
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
}

export function useSubscriberSummary() {
  return useQuery({
    queryKey: ['subscribers', 'summary'],
    queryFn: () => unwrap(api.GET('/api/v1/subscribers/summary')),
    refetchInterval: 60_000,
  });
}

function RechargeLink({ s, price, compact }: { s: ExpiringSub; price: number | null; compact?: boolean }) {
  return (
    <Button variant="outline" size={compact ? 'sm' : 'default'} asChild className="shrink-0">
      <Link href={`/admin/subscribers/${s.id}`}>
        <Zap aria-hidden />
        Recharge{price !== null ? ` ${fmtRupees0(price)}` : ''}
      </Link>
    </Button>
  );
}

/** Prepaid customers whose validity runs out soon, soonest first; `tabs` adds Today / Tomorrow / 7 days. */
export function ExpiringCard({
  limit = 6,
  className,
  compact,
  tabs,
}: {
  limit?: number;
  className?: string;
  /** Narrow card: a one-line list instead of the table. */
  compact?: boolean;
  tabs?: boolean;
}) {
  const summary = useSubscriberSummary();
  const [picked, setPicked] = useState<ExpiryWindow | null>(null);
  const counts = summary.data
    ? {
        today: summary.data.expiringToday,
        tomorrow: summary.data.expiringTomorrow,
        '7d': summary.data.expiring7d,
      }
    : null;
  // Open on Today, unless nobody expires today.
  const win: ExpiryWindow | undefined = tabs ? (picked ?? (counts?.today === 0 ? '7d' : 'today')) : undefined;
  const q = useExpiring(7, limit, win);
  const { byId } = usePlans();
  const items = q.data?.items ?? [];
  const empty = {
    today: 'Nobody expires later today.',
    tomorrow: 'Nobody expires tomorrow.',
    '7d': 'No prepaid customer expires in the next 7 days.',
  };
  return (
    <Card className={cn('min-w-0 flex-[3_1_480px] overflow-hidden', className)}>
      <CardBar className="flex-wrap">
        <h2 className="mr-auto text-base font-bold">{tabs ? 'Expiring this week' : 'Expiring soon'}</h2>
        {tabs ? (
          <Tabs value={win} onValueChange={(v) => setPicked(v as ExpiryWindow)}>
            <SegmentedList aria-label="When">
              {(
                [
                  ['today', 'Today'],
                  ['tomorrow', 'Tomorrow'],
                  ['7d', '7 days'],
                ] as const
              ).map(([v, l]) => (
                <SegmentedTrigger key={v} value={v}>
                  {l}
                  {counts ? <span className="ml-1 tabular-nums opacity-70">{fmtNum(counts[v])}</span> : null}
                </SegmentedTrigger>
              ))}
            </SegmentedList>
          </Tabs>
        ) : q.data ? (
          <span className="text-[13px] text-muted-foreground">{fmtNum(q.data.total)} in the next 7 days</span>
        ) : null}
        {q.data && q.data.total > items.length ? (
          <Link
            href={tabs ? `/admin/subscribers?expiry=${win}` : '/admin/subscribers/expiring'}
            className="text-[13px] font-bold"
          >
            View all {fmtNum(q.data.total)}
          </Link>
        ) : null}
      </CardBar>
      {q.isError ? (
        <div className="p-4">
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        </div>
      ) : q.isLoading ? (
        <div className="divide-y divide-divider">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 px-5 py-3">
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-40" />
                <Skeleton className="h-3 w-28" />
              </div>
              <Skeleton className="h-9 w-32 rounded-[10px]" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-muted-foreground">{empty[win ?? '7d']}</p>
      ) : (
        <ExpiringRows items={items} byId={byId} compact={compact} />
      )}
    </Card>
  );
}

export function ExpiringRows({
  items,
  byId,
  compact,
}: {
  items: ExpiringSub[];
  byId: ReadonlyMap<string, { name: string; pricePaise: number }>;
  compact?: boolean;
}) {
  if (compact)
    return (
      <ul className="divide-y divide-divider">
        {items.map((s) => {
          const plan = s.planId ? byId.get(s.planId) : undefined;
          const w = whenLabel(s.expiresAt!);
          return (
            <li key={s.id} className="flex items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <Link
                  href={`/admin/subscribers/${s.id}`}
                  className="block truncate text-sm font-semibold text-foreground hover:text-primary"
                >
                  {s.name}
                </Link>
                <div className="truncate text-xs text-muted-foreground">
                  <span className="font-mono">{s.customerNo}</span> ·{' '}
                  <span className={cn(w.urgent && 'font-semibold text-danger-text')}>{w.when}</span>
                </div>
              </div>
              <RechargeLink s={s} price={plan?.pricePaise ?? null} compact />
            </li>
          );
        })}
      </ul>
    );
  return (
    <>
      {/* Desktop: table */}
      <div className="overflow-x-auto max-sm:hidden">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="bg-subtle text-left">
              <th className="eyebrow px-5 py-2 font-medium">Subscriber</th>
              <th className="eyebrow px-2 py-2 font-medium">Plan</th>
              <th className="eyebrow px-2 py-2 font-medium">Expires</th>
              <th className="px-5 py-2">
                <span className="sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((s) => {
              const plan = s.planId ? byId.get(s.planId) : undefined;
              const w = whenLabel(s.expiresAt!);
              return (
                <tr key={s.id} className="border-t border-divider">
                  <td className="px-5 py-2.5">
                    <Link
                      href={`/admin/subscribers/${s.id}`}
                      className="font-semibold text-foreground hover:text-primary"
                    >
                      {s.name}
                    </Link>
                    <div className="font-mono text-xs text-muted-foreground">
                      {s.customerNo} · {s.phone}
                    </div>
                  </td>
                  <td className="px-2 py-2.5 whitespace-nowrap text-body">{plan?.name ?? '—'}</td>
                  <td className="px-2 py-2.5 whitespace-nowrap">
                    <div className={cn('font-semibold', w.urgent ? 'text-danger-text' : 'text-foreground')}>
                      {w.when}
                    </div>
                    <div className="text-xs text-muted-foreground">{w.date}</div>
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    <RechargeLink s={s} price={plan?.pricePaise ?? null} compact />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {/* Phone: cards with Call + Recharge */}
      <ul className="divide-y divide-divider sm:hidden">
        {items.map((s) => {
          const plan = s.planId ? byId.get(s.planId) : undefined;
          const w = whenLabel(s.expiresAt!);
          return (
            <li key={s.id} className="flex flex-col gap-2.5 px-4 py-3.5">
              <div className="flex justify-between gap-2">
                <div className="min-w-0">
                  <Link href={`/admin/subscribers/${s.id}`} className="font-bold text-foreground">
                    {s.name}
                  </Link>
                  <div className="truncate font-mono text-xs text-muted-foreground">
                    {s.customerNo}
                    {plan ? ` · ${plan.name}` : ''}
                  </div>
                </div>
                <div className="text-right">
                  <div
                    className={cn('text-[13px] font-bold', w.urgent ? 'text-danger-text' : 'text-foreground')}
                  >
                    {w.when}
                  </div>
                  <div className="text-xs text-muted-foreground">{w.date}</div>
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" asChild className="flex-1">
                  <a href={`tel:${s.phone}`}>
                    <Phone aria-hidden /> Call
                  </a>
                </Button>
                <Button asChild className="flex-[2]">
                  <Link href={`/admin/subscribers/${s.id}`}>
                    <Zap aria-hidden /> Recharge{plan ? ` ${fmtRupees0(plan.pricePaise)}` : ''}
                  </Link>
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

const UsageChart = dynamic(() => import('@/components/network-charts').then((m) => m.UsageChart), {
  ssr: false,
  loading: ChartSkeleton,
});

/** Data used per day for 30 days (download vs upload), with totals; resellers see their customers only. */
export function UsageChartCard() {
  const traffic = useQuery({
    queryKey: ['sessions', 'traffic'],
    queryFn: () => unwrap(api.GET('/api/v1/sessions/traffic')),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
  const days = traffic.data?.days ?? [];
  const down = days.reduce((n, d) => n + d.downBytes, 0);
  const up = days.reduce((n, d) => n + d.upBytes, 0);
  return (
    <Card className="flex min-w-0 flex-col gap-3.5 p-5">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="mr-auto text-base font-bold">Data usage, last 30 days</h2>
        {traffic.data ? (
          <span className="flex gap-4 text-[13px] text-body">
            <span className="flex items-center gap-1.5">
              <Swatch className="bg-[#4C86F0]" /> Download {fmtBytes(down)}
            </span>
            <span className="flex items-center gap-1.5">
              <Swatch className="bg-[#3AA570]" /> Upload {fmtBytes(up)}
            </span>
          </span>
        ) : null}
      </div>
      {traffic.isError ? (
        <ErrorState error={traffic.error} onRetry={() => void traffic.refetch()} />
      ) : traffic.isLoading ? (
        <ChartSkeleton />
      ) : down + up === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">
          No data used in the last 30 days yet. Usage is added every 15 minutes.
        </p>
      ) : (
        <UsageChart days={days} />
      )}
    </Card>
  );
}

type SpeedPoint = { at: string; rx: number; tx: number };

const LiveSpeedChart = dynamic(() => import('@/components/network-charts').then((m) => m.LiveSpeedChart), {
  ssr: false,
  loading: () => <Skeleton className="h-[200px] w-full rounded-xl" />,
});

/** Points kept in the browser: 5 minutes at one every 3 s. */
const SPEED_POINTS = 100;

/** Live download / upload across monitored router ports, as a rolling line (polls every 3 s while visible). */
export function LiveSpeedCard() {
  const qc = useQueryClient();
  // Each poll appends one point to the series kept in the query cache (no state updates in effects).
  const speed = useQuery({
    queryKey: ['network', 'live-speed'],
    queryFn: async () => {
      const d = await unwrap(api.GET('/api/v1/network/live-speed'));
      const prev = qc.getQueryData<{ points: SpeedPoint[] }>(['network', 'live-speed'])?.points ?? [];
      const points =
        !d.routers.length || prev.at(-1)?.at === d.at
          ? prev
          : [...prev, { at: d.at, rx: d.rxBps, tx: d.txBps }].slice(-SPEED_POINTS);
      return { ...d, points };
    },
    refetchInterval: 3_000,
    refetchIntervalInBackground: false,
  });
  const d = speed.data;
  const points = d?.points ?? [];
  const down = d?.routers.filter((r) => !r.ok) ?? [];
  return (
    <Card className="flex min-w-0 flex-col gap-3.5 p-5">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
        <div className="mr-auto flex flex-col gap-0.5">
          <h2 className="flex items-center gap-2 text-base font-bold">
            Live network speed
            {d?.routers.length ? (
              <span className="relative flex size-2" aria-hidden>
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60 motion-reduce:animate-none" />
                <span className="relative inline-flex size-2 rounded-full bg-success" />
              </span>
            ) : null}
          </h2>
          <span className="text-[13px] text-muted-foreground">
            {d?.routers.length
              ? `Monitored ports on ${plural(d.routers.length, 'router')} · updates every 3 s`
              : 'Monitored router ports'}
          </span>
        </div>
        {d?.routers.length ? (
          <dl className="flex gap-6">
            <div className="flex flex-col">
              <dt className="flex items-center gap-1.5 text-xs text-body">
                <Swatch className="bg-[#4C86F0]" /> Download
              </dt>
              <dd className="text-xl font-extrabold tracking-[-0.02em] text-foreground tabular-nums">
                {fmtBps(d.rxBps)}
              </dd>
            </div>
            <div className="flex flex-col">
              <dt className="flex items-center gap-1.5 text-xs text-body">
                <Swatch className="bg-[#3AA570]" /> Upload
              </dt>
              <dd className="text-xl font-extrabold tracking-[-0.02em] text-foreground tabular-nums">
                {fmtBps(d.txBps)}
              </dd>
            </div>
          </dl>
        ) : null}
      </div>
      {speed.isError ? (
        <ErrorState error={speed.error} onRetry={() => void speed.refetch()} />
      ) : speed.isLoading ? (
        <Skeleton className="h-[200px] w-full rounded-xl" />
      ) : !d?.routers.length ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          No router has live graphs yet. Open a router under{' '}
          <Link href="/admin/routers" className="font-semibold">
            Routers
          </Link>
          , add its API login and choose the ports to watch (usually the uplink).
        </p>
      ) : (
        <>
          {points.length < 2 ? (
            <Skeleton className="h-[200px] w-full rounded-xl" />
          ) : (
            <LiveSpeedChart points={points} />
          )}
          {down.length ? (
            <p className="text-xs text-warning-text">
              Not answering: {down.map((r) => r.name).join(', ')}. Their speed is left out.
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}
