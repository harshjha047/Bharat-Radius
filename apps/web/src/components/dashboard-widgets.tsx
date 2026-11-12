'use client';
import { useQuery } from '@tanstack/react-query';
import { Phone, Zap } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardBar } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { api, unwrap, type ApiData } from '@/lib/api';
import { usePlans } from '@/lib/queries';
import { cn, fmtNum, fmtRupees0 } from '@/lib/utils';

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

export function useExpiring(days: number, limit: number) {
  return useQuery({
    queryKey: ['subscribers', 'expiring', days, limit],
    queryFn: () => unwrap(api.GET('/api/v1/subscribers/expiring', { params: { query: { days, limit } } })),
    staleTime: 60_000,
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

/** Prepaid customers whose validity runs out in the next 7 days, soonest first. */
export function ExpiringCard({
  limit = 6,
  className,
  compact,
}: {
  limit?: number;
  className?: string;
  /** Narrow card: a one-line list instead of the table. */
  compact?: boolean;
}) {
  const q = useExpiring(7, limit);
  const { byId } = usePlans();
  const items = q.data?.items ?? [];
  return (
    <Card className={cn('min-w-0 flex-[3_1_480px] overflow-hidden', className)}>
      <CardBar>
        <h2 className="mr-auto text-base font-bold">Expiring soon</h2>
        {q.data ? (
          <span className="text-[13px] text-muted-foreground">{fmtNum(q.data.total)} in the next 7 days</span>
        ) : null}
        {q.data && q.data.total > items.length ? (
          <Link href="/admin/subscribers/expiring" className="text-[13px] font-bold">
            View all
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
        <p className="px-5 py-10 text-center text-sm text-muted-foreground">
          No prepaid customer expires in the next 7 days.
        </p>
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
