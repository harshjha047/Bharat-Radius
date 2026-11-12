'use client';
import { useQuery } from '@tanstack/react-query';
import { AlertOctagon, AlertTriangle, Info, TrendingUp } from 'lucide-react';
import Link from 'next/link';
import { memo } from 'react';
import { Card } from '@/components/ui/card';
import { ErrorState, Stat } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { api, unwrap, type ApiData } from '@/lib/api';
import { cn, fmtNum, fmtRupees0 } from '@/lib/utils';

export type Insights = ApiData<'/api/v1/reports/insights'>;
export type InsightKpi = Insights['kpis'][number];
export type InsightAlert = Insights['alerts'][number];

export const insightsQuery = (from: string, to: string) => ({
  queryKey: ['reports', 'insights', from, to] as const,
  queryFn: () => unwrap(api.GET('/api/v1/reports/insights', { params: { query: { from, to } } })),
  staleTime: 60_000,
});

export function useInsights(from: string, to: string, enabled = true) {
  return useQuery({ ...insightsQuery(from, to), enabled: enabled && !!from && !!to && from <= to });
}

export function fmtKpi(k: Pick<InsightKpi, 'kind'>, v: number | null): string {
  if (v === null) return '—';
  if (k.kind === 'money') return fmtRupees0(v);
  if (k.kind === 'pct') return `${(v * 100).toFixed(1)}%`;
  return fmtNum(v);
}

/** "+12% vs previous" coloured by whether the move is good news. */
export function changeHint(k: InsightKpi): { hint?: string; tone?: 'success' | 'danger' } {
  if (k.change === null) return k.previous === null ? {} : { hint: `previous ${fmtKpi(k, k.previous)}` };
  const unit = k.kind === 'pct' ? ' pts' : '%';
  const abs = Math.abs(k.change);
  if (abs < 0.5) return { hint: 'flat vs previous period' };
  const good = k.change > 0 === k.higherIsBetter;
  return {
    hint: `${k.change > 0 ? '+' : '−'}${abs >= 10 ? abs.toFixed(0) : abs.toFixed(1)}${unit} vs previous period`,
    tone: good ? 'success' : 'danger',
  };
}

const SEVERITY = {
  critical: { icon: AlertOctagon, cls: 'bg-danger-bg text-danger-text', label: 'Critical' },
  warning: { icon: AlertTriangle, cls: 'bg-warning-bg text-warning-text', label: 'Warning' },
  info: { icon: Info, cls: 'bg-info-bg text-info-text', label: 'Info' },
  positive: { icon: TrendingUp, cls: 'bg-success-bg text-success-text', label: 'Good news' },
} as const;

export const AlertList = memo(function AlertList({
  alerts,
  limit,
}: {
  alerts: InsightAlert[];
  limit?: number;
}) {
  const shown = limit ? alerts.slice(0, limit) : alerts;
  if (!shown.length) return <p className="text-sm text-muted-foreground">Nothing needs attention.</p>;
  return (
    <ul className="space-y-2">
      {shown.map((a, i) => {
        const s = SEVERITY[a.severity];
        const Icon = s.icon;
        return (
          <li key={`${a.code}-${i}`} className="flex gap-3 rounded-xl border p-3">
            <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', s.cls)}>
              <Icon className="size-4" aria-label={s.label} />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-bold text-foreground">{a.title}</p>
              <p className="text-[13px] text-muted-foreground">{a.detail}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
});

export const KpiGrid = memo(function KpiGrid({ kpis }: { kpis: InsightKpi[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
      {kpis.map((k) => {
        const c = changeHint(k);
        return (
          <Stat
            key={k.key}
            label={k.label}
            value={fmtKpi(k, k.value)}
            {...(c.hint ? { hint: c.hint } : {})}
            {...(c.tone ? { hintTone: c.tone } : {})}
          />
        );
      })}
    </div>
  );
});

export function KpiGridSkeleton({ n = 8 }: { n?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4" aria-busy>
      {Array.from({ length: n }, (_, i) => (
        <Skeleton key={i} className="h-[104px] rounded-2xl" />
      ))}
    </div>
  );
}

const DASH_KPIS = ['netRevenue', 'collected', 'renewalRate', 'outstanding'];

/** Dashboard card: the summary sentences, four headline figures and the top alerts for the last 30 days. */
export function InsightsCard({ from, to }: { from: string; to: string }) {
  const q = useInsights(from, to);
  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-center gap-3">
        <h2 className="mr-auto text-base font-bold">Financial insights, last 30 days</h2>
        <Link href="/admin/insights" className="text-[13px] font-bold">
          Details
        </Link>
      </div>
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data ? (
        <div className="space-y-3" aria-busy>
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-2/3" />
          <KpiGridSkeleton n={4} />
        </div>
      ) : (
        <>
          <p className="text-sm text-body">{q.data.narrative.slice(0, 3).join(' ')}</p>
          <KpiGrid kpis={q.data.kpis.filter((k) => DASH_KPIS.includes(k.key))} />
          <AlertList alerts={q.data.alerts.filter((a) => a.severity !== 'info')} limit={3} />
        </>
      )}
    </Card>
  );
}
