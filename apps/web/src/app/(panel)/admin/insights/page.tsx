'use client';
import { Download } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from '@/lib/toast';
import {
  AlertList,
  KpiGrid,
  KpiGridSkeleton,
  useInsights,
  type Insights,
} from '@/components/financial-insights';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { ErrorState, PageHeader, Stat } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { useDebounced } from '@/hooks/use-debounced';
import { download } from '@/lib/api';
import { periodPresets } from '@/lib/periods';
import { cn, fmtDay, fmtNum, fmtRupees0 } from '@/lib/utils';

const RevenueChart = dynamic(() => import('@/components/revenue-chart'), {
  ssr: false,
  loading: () => <Skeleton className="h-[220px] w-full rounded-xl" />,
});

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <Card className="flex min-w-0 flex-col gap-3.5 p-5">
      <div>
        <CardTitle>{title}</CardTitle>
        {hint ? <p className="text-[13px] text-muted-foreground">{hint}</p> : null}
      </div>
      {children}
    </Card>
  );
}

function SimpleTable({
  head,
  rows,
  empty = 'No data for this period.',
}: {
  head: string[];
  rows: React.ReactNode[][];
  empty?: string;
}) {
  return (
    <div className="-mx-5 overflow-x-auto">
      <table className="w-full min-w-[28rem] text-sm tabular-nums">
        <thead>
          <tr className="bg-subtle">
            {head.map((h, i) => (
              <th
                key={h}
                scope="col"
                className={cn(
                  'eyebrow px-3.5 py-2.5 font-medium tracking-[0.08em] whitespace-nowrap',
                  i ? 'text-right' : 'pl-5 text-left',
                )}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((r, j) => (
              <tr key={j} className="border-t border-divider">
                {r.map((c, i) => (
                  <td
                    key={i}
                    className={
                      i ? 'px-3.5 py-2.5 text-right' : 'py-2.5 pr-3.5 pl-5 font-semibold text-foreground'
                    }
                  >
                    {c}
                  </td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={head.length} className="py-8 text-center text-muted-foreground">
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

const pct = (x: number | null, d = 0) => (x === null ? '—' : `${x.toFixed(d)}%`);

function Ageing({ data }: { data: Insights }) {
  const total = data.ageing.reduce((s, a) => s + a.amountPaise, 0);
  if (!total) return <p className="text-sm text-muted-foreground">No money is owed on open invoices.</p>;
  const tone = ['bg-chart-4', 'bg-chart-3', 'bg-warning', 'bg-chart-1', 'bg-destructive'];
  return (
    <ul className="space-y-2.5">
      {data.ageing.map((a, i) => (
        <li key={a.key} className="space-y-1">
          <div className="flex justify-between text-[13px]">
            <span className="font-semibold text-foreground">{a.label}</span>
            <span className="tabular-nums">
              {fmtRupees0(a.amountPaise)} · {fmtNum(a.invoices)} inv.
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className={cn('h-full rounded-full', tone[i])}
              style={{ width: `${(a.amountPaise / total) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function InsightsPage() {
  const [ranges] = useState(periodPresets);
  const [range, setRange] = useState<[string, string]>(ranges['Last 30 days']!);
  const [from, to] = useDebounced(range, 400);
  const q = useInsights(from, to);
  const [busy, setBusy] = useState<'xlsx' | 'pdf' | null>(null);
  const d = q.data;

  const chart = useMemo(
    () =>
      d?.daily.map((x) => ({ day: x.day, billedPaise: x.netPaise, collectedPaise: x.collectedPaise })) ?? [],
    [d],
  );

  const get = (format: 'xlsx' | 'pdf') => {
    setBusy(format);
    download(
      `/api/v1/reports/financial/download?from=${from}&to=${to}&format=${format}`,
      `financial-insights-${from}-to-${to}.${format}`,
    )
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Download failed'))
      .finally(() => setBusy(null));
  };

  return (
    <>
      <PageHeader
        title="Financial insights"
        description={
          d
            ? `Compared with ${fmtDay(d.previous.from)} – ${fmtDay(d.previous.to)}. Revenue is before GST.`
            : 'Compared with the previous period of the same length. Revenue is before GST.'
        }
        actions={
          <>
            <Button variant="outline" onClick={() => get('xlsx')} loading={busy === 'xlsx'} disabled={!d}>
              <Download /> Excel
            </Button>
            <Button variant="outline" onClick={() => get('pdf')} loading={busy === 'pdf'} disabled={!d}>
              <Download /> PDF
            </Button>
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select
          aria-label="Period"
          className="w-48"
          value={Object.entries(ranges).find(([, v]) => v[0] === range[0] && v[1] === range[1])?.[0] ?? ''}
          onChange={(e) => e.target.value && setRange(ranges[e.target.value]!)}
        >
          <option value="">Custom</option>
          {Object.keys(ranges).map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </Select>
        <Input
          type="date"
          aria-label="From"
          value={range[0]}
          onChange={(e) => setRange([e.target.value, range[1]])}
          className="w-40"
        />
        <Input
          type="date"
          aria-label="To"
          value={range[1]}
          onChange={(e) => setRange([range[0], e.target.value])}
          className="w-40"
        />
      </div>

      {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}

      <div className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
          <Section title="What the numbers say">
            {d ? (
              <ul className="list-disc space-y-1.5 pl-5 text-sm text-body">
                {d.narrative.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            ) : (
              <div className="space-y-2" aria-busy>
                {Array.from({ length: 5 }, (_, i) => (
                  <Skeleton key={i} className="h-4 w-full" />
                ))}
              </div>
            )}
          </Section>
          <Section title="Needs attention">
            {d ? (
              <AlertList alerts={d.alerts} />
            ) : (
              <div className="space-y-2" aria-busy>
                {Array.from({ length: 3 }, (_, i) => (
                  <Skeleton key={i} className="h-16 w-full rounded-xl" />
                ))}
              </div>
            )}
          </Section>
        </div>

        {d ? <KpiGrid kpis={d.kpis} /> : <KpiGridSkeleton n={12} />}

        <Section
          title="Net revenue and collections by day"
          hint={
            d?.anomalies.length
              ? `Unusual days: ${d.anomalies
                  .slice(0, 4)
                  .map((a) => `${fmtDay(a.day)} (${a.kind === 'spike' ? 'spike' : 'dip'})`)
                  .join(', ')}`
              : 'Revenue is invoices less credit notes, before GST.'
          }
        >
          {d ? (
            <RevenueChart days={chart} billedName="Net revenue" label="Daily net revenue and collections" />
          ) : (
            <Skeleton className="h-[220px] w-full rounded-xl" />
          )}
        </Section>

        <div className="grid gap-4 lg:grid-cols-2">
          <Section title="Receivables ageing" hint="Open invoices by days past the due date, as of now.">
            {d ? <Ageing data={d} /> : <Skeleton className="h-40 w-full" />}
          </Section>
          <Section title="Largest overdue balances">
            {d ? (
              <SimpleTable
                head={['Subscriber', 'Invoices', 'Oldest', 'Owed']}
                empty="No overdue balances."
                rows={d.defaulters.map((x) => [
                  <Link key="n" href={`/admin/subscribers/${x.subscriberId}`} className="hover:underline">
                    {x.name}
                    {x.customerNo ? (
                      <span className="ml-1.5 font-mono text-xs text-muted-foreground">{x.customerNo}</span>
                    ) : null}
                  </Link>,
                  fmtNum(x.invoices),
                  `${fmtNum(x.daysOverdue)} d`,
                  fmtRupees0(x.balancePaise),
                ])}
              />
            ) : (
              <Skeleton className="h-40 w-full" />
            )}
          </Section>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Section
            title="Reseller margin"
            hint="Customer price before GST minus what the reseller's wallet paid."
          >
            {d ? (
              <SimpleTable
                head={['Reseller', 'Recharges', 'Customer value', 'Margin', 'Margin %']}
                empty="No reseller recharges in this period."
                rows={d.resellers.map((r) => [
                  <span key="r">
                    {r.reseller} <span className="text-xs text-muted-foreground">{r.level}</span>
                  </span>,
                  fmtNum(r.recharges),
                  fmtRupees0(r.customerPaise),
                  fmtRupees0(r.marginPaise),
                  pct(r.marginPct, 1),
                ])}
              />
            ) : (
              <Skeleton className="h-40 w-full" />
            )}
          </Section>
          <Section title="Recharge revenue by plan" hint="Before GST.">
            {d ? (
              <SimpleTable
                head={['Plan', 'Recharges', 'Revenue', 'Average', 'Share']}
                rows={d.plans.map((p) => [
                  p.plan,
                  fmtNum(p.recharges),
                  fmtRupees0(p.revenuePaise),
                  fmtRupees0(p.avgPaise),
                  pct(p.share * 100),
                ])}
              />
            ) : (
              <Skeleton className="h-40 w-full" />
            )}
          </Section>
        </div>

        <Section
          title="Next 30 days"
          hint={
            d
              ? `Prepaid renewals due at plan price × ${Math.round(d.forecast.renewalRateUsed * 100)}% renewal rate, plus postpaid.`
              : undefined
          }
        >
          {d ? (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Expected revenue" value={fmtRupees0(d.forecast.next30Paise)} dot="primary" />
              <Stat
                label="Renewals due"
                value={fmtRupees0(d.forecast.renewalsDuePaise)}
                hint={`${fmtNum(d.forecast.renewalsDueCount)} subscribers`}
              />
              <Stat label="Postpaid per month" value={fmtRupees0(d.forecast.postpaidMonthlyPaise)} />
              <Stat label="Run-rate, active base" value={fmtRupees0(d.forecast.mrrPaise)} hint="per month" />
            </div>
          ) : (
            <KpiGridSkeleton n={4} />
          )}
        </Section>
      </div>
    </>
  );
}
