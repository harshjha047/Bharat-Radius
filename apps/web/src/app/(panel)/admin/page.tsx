'use client';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ChevronRight, LifeBuoy, Plus, Search, Server, UserPlus, Users } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { DashboardConfig, useDashboardPrefs, type WidgetDef } from '@/components/dashboard-config';
import {
  ExpiringCard,
  NetworkRow,
  RenewalsSection,
  useExpiring,
  useSubscriberSummary,
} from '@/components/dashboard-widgets';
import { InsightsCard } from '@/components/financial-insights';
import { NasStatistics } from '@/components/router-live';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBar } from '@/components/ui/card';
import { ErrorState, Stat } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { api, unwrap, type ApiData } from '@/lib/api';
import { useCan, useMe } from '@/lib/auth';
import { usePlans, type Nas } from '@/lib/queries';
import { cn, fmtNum, fmtRupees, fmtRupees0, plural, relTime } from '@/lib/utils';

const STALE_MS = 15 * 60_000;
const istStamp = new Intl.DateTimeFormat('en-IN', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Asia/Kolkata',
});

type RouterHealth = 'up' | 'quiet' | 'silent' | 'disabled';
function health(r: Nas, online: number): RouterHealth {
  if (r.status === 'disabled') return 'disabled';
  if (online > 0) return 'up';
  if (r.lastSeenAt && Date.now() - new Date(r.lastSeenAt).getTime() > STALE_MS) return 'silent';
  return 'quiet';
}
const HEALTH = {
  up: { label: 'Up', tone: 'success', tile: 'bg-accent text-primary' },
  quiet: { label: 'No users', tone: 'neutral', tile: 'bg-muted text-body' },
  silent: { label: 'Not reporting', tone: 'danger', tile: 'bg-danger-bg text-danger-text' },
  disabled: { label: 'Disabled', tone: 'neutral', tile: 'bg-muted text-muted-foreground' },
} as const;

function KpiSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-2.5 rounded-2xl border bg-card p-[18px]">
      <Skeleton className="h-3 w-1/2" />
      <Skeleton className="h-7 w-2/3 rounded-lg" />
      <Skeleton className="h-3 w-2/5" />
    </div>
  );
}

const KpiLink = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <Link href={href} className="rounded-2xl text-inherit hover:text-inherit [&>div]:hover:border-input">
    {children}
  </Link>
);

export default function Dashboard() {
  const router = useRouter();
  const can = useCan();
  const me = useMe();
  const { plans, isLoading: plansLoading } = usePlans();
  const summary = useQuery({
    queryKey: ['sessions', 'summary'],
    queryFn: () => unwrap(api.GET('/api/v1/sessions/summary')),
    enabled: can('sessions.read'),
    refetchInterval: 30_000,
  });
  const nas = useQuery({
    queryKey: ['nas', 'all'],
    queryFn: () => unwrap(api.GET('/api/v1/nas', { params: { query: { limit: 200 } } })),
    enabled: can('nas.read'),
  });
  const tickets = useQuery({
    queryKey: ['tickets', 'counts'],
    queryFn: () => unwrap(api.GET('/api/v1/tickets/counts')),
    enabled: can('tickets.read'),
    staleTime: 60_000,
  });

  const staff = me.data?.user.type !== 'reseller';
  const prefs = useDashboardPrefs();
  const { shown } = prefs;
  const subs = useSubscriberSummary();
  const rejects = useQuery({
    queryKey: ['auth-log', 'summary', 'dashboard'],
    queryFn: () => unwrap(api.GET('/api/v1/radius/auth-log/summary')),
    enabled: staff && can('sessions.read') && shown('kpi-rejects'),
    refetchInterval: 60_000,
  });
  const wallet = useQuery({
    queryKey: ['wallet', 'mine'],
    queryFn: () => unwrap(api.GET('/api/v1/wallets/mine')),
    enabled: can('billing.read') && !staff,
  });
  const billing = useQuery({
    queryKey: ['billing', 'summary'],
    queryFn: () => unwrap(api.GET('/api/v1/billing/summary')),
    enabled: can('billing.read') && staff,
    refetchInterval: 60_000,
  });

  const routers = nas.data?.items ?? [];
  const onlineByIp = new Map((summary.data?.byNas ?? []).map((n) => [n.nasIp, n.online]));
  const rows = routers.map((r) => {
    const online = onlineByIp.get(r.ip) ?? 0;
    return { r, online, h: health(r, online) };
  });
  const silent = rows.filter((x) => x.h === 'silent');
  const up = rows.filter((x) => x.h === 'up').length;
  const b = billing.data;
  const collectedPct = b && b.month.invoicedPaise > 0 ? b.month.collectedPaise / b.month.invoicedPaise : null;

  if (!staff && me.data)
    return <ResellerHome name={me.data.user.name} wallet={wallet.data} loading={wallet.isLoading} />;

  const widgets: WidgetDef[] = [
    can('subscribers.read') && { id: 'renewals', label: 'Renewals and status' },
    can('subscribers.read') && { id: 'expiring', label: 'Expiring soon list' },
    (can('sessions.read') || can('nas.read')) && { id: 'routers', label: 'Routers' },
    can('billing.read') && !can('reports.view') && { id: 'month', label: 'This month' },
    can('sessions.read') && { id: 'kpi-online', label: 'Online now' },
    can('subscribers.read') && { id: 'kpi-pending', label: 'Pending recharge' },
    can('sessions.read') && { id: 'kpi-rejects', label: 'Login rejects (24 h)' },
    can('billing.read') && { id: 'kpi-recharges', label: 'Recharges (today / month)' },
    can('billing.read') && { id: 'kpi-unpaid', label: 'Unpaid invoices' },
    can('tickets.read') && { id: 'kpi-tickets', label: 'Open tickets' },
    can('nas.read') && { id: 'kpi-routers', label: 'Routers count' },
    can('plans.read') && { id: 'kpi-plans', label: 'Plans' },
    can('nas.read') && { id: 'nas-stats', label: 'NAS statistics (live ports)' },
    can('sessions.read') && { id: 'network', label: 'Network charts' },
    can('reports.view') && { id: 'insights', label: 'Financial insights' },
    can('reports.view') && { id: 'trends', label: 'Revenue and plan trends' },
  ].filter((w): w is WidgetDef => !!w);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-center gap-3">
        <div className="mr-auto flex flex-col gap-0.5">
          <h1 className="text-[26px] font-extrabold tracking-[-0.03em]">Dashboard</h1>
          <span className="font-mono text-xs text-muted-foreground">
            {istStamp.format(new Date())} · Hello, {me.data?.user.name.split(' ')[0]}
          </span>
        </div>
        {can('subscribers.read') ? (
          <form
            role="search"
            className="flex h-10 w-full items-center sm:w-[300px] gap-2 rounded-xl border bg-card px-3 focus-within:border-primary"
            onSubmit={(e) => {
              e.preventDefault();
              const q = String(new FormData(e.currentTarget).get('q') ?? '').trim();
              router.push(`/admin/subscribers${q ? `?q=${encodeURIComponent(q)}` : ''}`);
            }}
          >
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <input
              name="q"
              aria-label="Find a subscriber"
              placeholder="Name, C-number, phone, username"
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:shadow-none"
            />
          </form>
        ) : null}
        <DashboardConfig widgets={widgets} hidden={prefs.hidden} onSave={prefs.save} saving={prefs.saving} />
        {can('subscribers.write') ? (
          <Button asChild>
            <Link href="/admin/subscribers/new">
              <Plus /> Add subscriber
            </Link>
          </Button>
        ) : null}
      </header>

      {silent.length ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-[14px] bg-danger-bg px-4 py-3 text-danger-text"
        >
          <AlertTriangle className="size-[18px] shrink-0" aria-hidden />
          <span className="flex-1 text-sm font-semibold">
            {silent.length === 1
              ? `${silent[0]!.r.name} has not reported since ${relTime(silent[0]!.r.lastSeenAt)}.`
              : `${silent.length} routers have stopped reporting.`}
          </span>
          <Link href="/admin/routers" className="text-sm font-bold text-danger-text hover:text-danger-text">
            Open routers
          </Link>
        </div>
      ) : null}

      {can('subscribers.read') && shown('renewals') ? <RenewalsSection /> : null}

      <div className="flex flex-wrap gap-3 empty:hidden">
        {can('subscribers.read') && shown('expiring') ? (
          <ExpiringCard tabs className="flex-[3_1_480px]" />
        ) : null}

        {(can('sessions.read') || can('nas.read')) && shown('routers') ? (
          <Card className="min-w-0 flex-[2_1_380px] overflow-hidden">
            <CardBar>
              <h2 className="mr-auto text-base font-bold">Routers</h2>
              {routers.length ? (
                <span className="text-[13px] text-muted-foreground">
                  {up} of {routers.length} with users online
                </span>
              ) : null}
              <Link href="/admin/sessions" className="text-[13px] font-bold">
                All sessions
              </Link>
            </CardBar>
            {summary.isError ? (
              <div className="p-4">
                <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
              </div>
            ) : nas.isLoading || summary.isLoading ? (
              <div className="divide-y divide-divider">
                {Array.from({ length: 4 }, (_, i) => (
                  <div key={i} className="flex items-center gap-3 px-5 py-3">
                    <Skeleton className="size-9 rounded-[10px]" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-3.5 w-40" />
                      <Skeleton className="h-3 w-24" />
                    </div>
                  </div>
                ))}
              </div>
            ) : rows.length === 0 ? (
              <p className="px-5 py-10 text-center text-sm text-muted-foreground">
                No routers yet. Add one under Routers so subscribers can connect.
              </p>
            ) : (
              <ul className="divide-y divide-divider">
                {rows.map(({ r, online, h }) => (
                  <li key={r.id}>
                    <Link
                      href={`/admin/sessions?nas=${encodeURIComponent(r.ip)}`}
                      className="flex items-center gap-3 px-5 py-3 text-inherit hover:bg-subtle hover:text-inherit"
                    >
                      <span
                        className={cn(
                          'grid size-9 shrink-0 place-items-center rounded-[10px]',
                          HEALTH[h].tile,
                        )}
                      >
                        <Server className="size-[18px]" strokeWidth={1.8} aria-hidden />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-semibold text-foreground">
                          {r.name}
                          {r.location.popName ? `, ${r.location.popName}` : ''}
                        </span>
                        <span className="truncate font-mono text-xs text-muted-foreground">
                          {r.ip} · {r.lastSeenAt ? `seen ${relTime(r.lastSeenAt)}` : 'never seen'}
                        </span>
                      </span>
                      <span className="flex flex-col items-end gap-1">
                        <Badge tone={HEALTH[h].tone}>{HEALTH[h].label}</Badge>
                        <span className="text-xs text-body tabular-nums">{fmtNum(online)} online</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ) : null}

        {can('billing.read') && staff && b && !can('reports.view') && shown('month') ? (
          <Card className="flex min-w-0 flex-[2_1_340px] flex-col gap-4 p-5">
            <div>
              <h2 className="text-base font-bold">This month</h2>
              <p className="text-[13px] text-muted-foreground">{fmtNum(b.month.recharges)} recharges</p>
            </div>
            <dl className="grid grid-cols-2 gap-4">
              <div>
                <dt className="flex items-center gap-2 text-xs text-body">
                  <span className="size-2.5 rounded-[3px] bg-chart-1" aria-hidden />
                  Billed
                </dt>
                <dd className="mt-1 text-xl font-extrabold tracking-[-0.02em] text-foreground tabular-nums">
                  {fmtRupees0(b.month.invoicedPaise)}
                </dd>
              </div>
              <div>
                <dt className="flex items-center gap-2 text-xs text-body">
                  <span className="size-2.5 rounded-[3px] bg-chart-4" aria-hidden />
                  Collected
                </dt>
                <dd className="mt-1 text-xl font-extrabold tracking-[-0.02em] text-foreground tabular-nums">
                  {fmtRupees0(b.month.collectedPaise)}
                </dd>
              </div>
            </dl>
            {collectedPct !== null ? (
              <div className="space-y-1.5">
                <div
                  className="h-2.5 overflow-hidden rounded-full bg-accent"
                  role="meter"
                  aria-label="Collected of billed"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(collectedPct * 100)}
                >
                  <div
                    className="h-full rounded-full bg-chart-4"
                    style={{ width: `${Math.min(100, collectedPct * 100)}%` }}
                  />
                </div>
                <p className="text-xs font-semibold text-muted-foreground">
                  {(collectedPct * 100).toFixed(1)}% collected
                </p>
              </div>
            ) : null}
            <div className="mt-auto grid grid-cols-2 gap-3 border-t pt-4 text-[13px]">
              <Link href="/admin/wallets" className="flex flex-col text-inherit hover:text-inherit">
                <span className="text-muted-foreground">Reseller wallets</span>
                <span className="font-bold text-foreground tabular-nums">
                  {fmtRupees0(b.wallets.resellerBalancePaise)}
                </span>
                {b.wallets.low || b.wallets.frozen ? (
                  <span className="text-xs font-semibold text-warning-text">
                    {b.wallets.low} low · {b.wallets.frozen} frozen
                  </span>
                ) : null}
              </Link>
              <div className="flex flex-col">
                <span className="text-muted-foreground">SMS queue</span>
                <span className="font-bold text-foreground tabular-nums">{fmtNum(b.sms.queued)} queued</span>
                {b.sms.failed24h ? (
                  <span className="text-xs font-semibold text-danger-text">
                    {b.sms.failed24h} failed in 24 h
                  </span>
                ) : null}
              </div>
            </div>
          </Card>
        ) : null}
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3 empty:hidden">
        {can('sessions.read') && shown('kpi-online') ? (
          summary.isLoading ? (
            <KpiSkeleton />
          ) : (
            <KpiLink href="/admin/sessions">
              <Stat
                dot="success"
                label="Online now"
                value={fmtNum(summary.data?.online ?? 0)}
                hint={summary.data?.stale ? `${summary.data.stale} not reporting` : 'All sessions reporting'}
                {...(summary.data?.stale ? { hintTone: 'warning' as const } : {})}
              />
            </KpiLink>
          )
        ) : null}
        {can('billing.read') && !staff ? (
          wallet.isLoading ? (
            <KpiSkeleton />
          ) : wallet.data ? (
            <KpiLink href="/admin/wallets">
              <Stat
                dot={wallet.data.state === 'normal' ? 'teal' : 'warning'}
                label="Wallet balance"
                value={fmtRupees0(wallet.data.balancePaise)}
                hint={
                  wallet.data.state === 'normal'
                    ? `${fmtNum(wallet.data.customers)} customers`
                    : wallet.data.state === 'empty'
                      ? 'Empty: recharges blocked'
                      : 'Low balance'
                }
                {...(wallet.data.state !== 'normal' ? { hintTone: 'danger' as const } : {})}
              />
            </KpiLink>
          ) : null
        ) : null}
        {can('subscribers.read') && shown('kpi-pending') ? (
          subs.isLoading ? (
            <KpiSkeleton />
          ) : subs.data ? (
            <KpiLink href="/admin/subscribers?status=expired">
              <Stat
                dot="danger"
                label="Pending recharge"
                value={fmtNum(subs.data.expired)}
                hint={`${fmtNum(subs.data.expiredThisMonth)} expired this month`}
                {...(subs.data.expired ? { hintTone: 'danger' as const } : {})}
              />
            </KpiLink>
          ) : null
        ) : null}
        {can('sessions.read') && shown('kpi-rejects') ? (
          rejects.isLoading ? (
            <KpiSkeleton />
          ) : rejects.data ? (
            <KpiLink href="/admin/radius-log?result=reject">
              <Stat
                dot={rejects.data.rejected ? 'warning' : 'success'}
                label="Login rejects"
                value={fmtNum(rejects.data.rejected)}
                hint={`last 24 h · ${fmtNum(rejects.data.accepted)} accepted`}
              />
            </KpiLink>
          ) : null
        ) : null}
        {can('billing.read') && staff && (shown('kpi-recharges') || shown('kpi-unpaid')) ? (
          billing.isLoading ? (
            <KpiSkeleton />
          ) : b ? (
            <>
              {shown('kpi-recharges') ? (
                <KpiLink href="/admin/recharges">
                  <Stat
                    dot="teal"
                    label="Today’s recharges"
                    value={fmtRupees0(b.today.rechargePaise)}
                    hint={`${fmtNum(b.today.recharges)} today · ${fmtNum(b.month.recharges)} this month`}
                  />
                </KpiLink>
              ) : null}
              {shown('kpi-unpaid') ? (
                <KpiLink href="/admin/invoices">
                  <Stat
                    dot="danger"
                    label="Unpaid"
                    value={fmtRupees0(b.unpaid.balancePaise)}
                    hint={`${fmtNum(b.unpaid.count)} invoices · ${fmtNum(b.unpaid.overdue)} overdue`}
                    {...(b.unpaid.overdue ? { hintTone: 'danger' as const } : {})}
                  />
                </KpiLink>
              ) : null}
            </>
          ) : null
        ) : null}
        {can('tickets.read') && shown('kpi-tickets') ? (
          tickets.isLoading ? (
            <KpiSkeleton />
          ) : tickets.data ? (
            <KpiLink href="/admin/tickets">
              <Stat
                dot="info"
                label="Open tickets"
                value={fmtNum(tickets.data.open + tickets.data.in_progress)}
                hint={`${fmtNum(tickets.data.unassigned)} unassigned`}
                {...(tickets.data.unassigned ? { hintTone: 'danger' as const } : {})}
              />
            </KpiLink>
          ) : null
        ) : null}
        {can('nas.read') && shown('kpi-routers') ? (
          nas.isLoading ? (
            <KpiSkeleton />
          ) : (
            <KpiLink href="/admin/routers">
              <Stat
                dot={silent.length ? 'danger' : 'primary'}
                label="Routers"
                value={`${up} / ${routers.length}`}
                hint={silent.length ? `${silent.length} not reporting` : 'with users online'}
                {...(silent.length ? { hintTone: 'danger' as const } : {})}
              />
            </KpiLink>
          )
        ) : null}
        {can('plans.read') && shown('kpi-plans') ? (
          plansLoading ? (
            <KpiSkeleton />
          ) : (
            <KpiLink href="/admin/plans">
              <Stat
                dot="warning"
                label="Plans"
                value={plans.filter((p) => p.status === 'active').length}
                hint="active"
              />
            </KpiLink>
          )
        ) : null}
      </div>

      {can('nas.read') && shown('nas-stats') ? <NasStatistics routers={routers} /> : null}
      {can('sessions.read') && staff && shown('network') ? <NetworkRow /> : null}
      {can('reports.view') && shown('insights') ? <InsightsCard from={istDay(29)} to={istDay()} /> : null}
      {can('reports.view') && staff && shown('trends') ? <TrendsRow /> : null}

      <footer className="flex flex-wrap justify-between gap-2 pt-2 font-mono text-[11px] text-muted-foreground">
        <span>All times IST · online figures refresh every 30 s, charts every 5 min</span>
      </footer>
    </div>
  );
}

const BalanceChart = dynamic(() => import('@/components/network-charts').then((m) => m.BalanceChart), {
  ssr: false,
  loading: () => <Skeleton className="h-[150px] w-full rounded-xl" />,
});
const RechargesChart = dynamic(() => import('@/components/network-charts').then((m) => m.RechargesChart), {
  ssr: false,
  loading: () => <Skeleton className="h-[180px] w-full rounded-xl" />,
});
const RevenueChart = dynamic(() => import('@/components/revenue-chart'), {
  ssr: false,
  loading: () => <Skeleton className="h-[220px] w-full rounded-xl" />,
});

/** IST calendar day, `n` days ago, as YYYY-MM-DD. */
const istDay = (n = 0) => new Date(Date.now() + 330 * 60_000 - n * 86_400_000).toISOString().slice(0, 10);
const PLAN_COLORS = ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4', 'bg-chart-5', 'bg-chart-6'];
const PLAN_VARS = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6'];

type Report = ApiData<'/api/v1/reports/{name}'>;
const tableRows = (r: Report | undefined, title: string) =>
  (r?.tables.find((t) => t.title === title)?.rows ?? []) as Record<string, unknown>[];

/** Revenue vs collections (30 days) and subscribers by plan, both from the reports API. */
function TrendsRow() {
  const from = istDay(29);
  const to = istDay();
  const report = (name: 'revenue' | 'collections' | 'subscribers') => ({
    queryKey: ['reports', name, from, to],
    queryFn: () =>
      unwrap(api.GET('/api/v1/reports/{name}', { params: { path: { name }, query: { from, to } } })),
    staleTime: 5 * 60_000,
  });
  const revenue = useQuery(report('revenue'));
  const collections = useQuery(report('collections'));
  const subs = useQuery(report('subscribers'));

  const billed = new Map(tableRows(revenue.data, 'By day').map((r) => [String(r.day), Number(r.total) || 0]));
  const collected = new Map(
    tableRows(collections.data, 'By day and method').map((r) => [String(r.day), Number(r.total) || 0]),
  );
  const days = Array.from({ length: 30 }, (_, i) => {
    const day = istDay(29 - i);
    return { day, billedPaise: billed.get(day) ?? 0, collectedPaise: collected.get(day) ?? 0 };
  });
  const billedSum = days.reduce((n, d) => n + d.billedPaise, 0);
  const collectedSum = days.reduce((n, d) => n + d.collectedPaise, 0);

  const byPlan = tableRows(subs.data, 'By plan')
    .map((r) => ({ name: String(r.plan), n: Number(r.total) || 0 }))
    .filter((p) => p.n > 0)
    .sort((a, b) => b.n - a.n);
  const plans =
    byPlan.length > 6
      ? [...byPlan.slice(0, 5), { name: 'Other', n: byPlan.slice(5).reduce((s, p) => s + p.n, 0) }]
      : byPlan;
  const total = plans.reduce((s, p) => s + p.n, 0);
  const donut = plans
    .map((p, i) => {
      const start = (plans.slice(0, i).reduce((s, q) => s + q.n, 0) / total) * 100;
      const end = start + (p.n / total) * 100;
      return `var(${PLAN_VARS[i]}) ${start.toFixed(2)}% ${end.toFixed(2)}%`;
    })
    .join(', ');

  return (
    <div className="flex flex-wrap gap-3">
      <Card className="flex min-w-0 flex-[3_1_480px] flex-col gap-3.5 p-5">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
          <div className="mr-auto flex flex-col gap-0.5">
            <h2 className="text-base font-bold">Revenue and collections, last 30 days</h2>
            {revenue.data && collections.data ? (
              <p className="text-[13px] text-muted-foreground">
                Billed {fmtRupees0(billedSum)} · collected {fmtRupees0(collectedSum)}
                {billedSum > 0 ? ` (${((collectedSum / billedSum) * 100).toFixed(1)}%)` : ''}
              </p>
            ) : null}
          </div>
          <span className="flex items-center gap-1.5 text-xs text-body">
            <span className="size-2.5 rounded-[3px] bg-chart-1" aria-hidden />
            Revenue billed
          </span>
          <span className="flex items-center gap-1.5 text-xs text-body">
            <span className="size-2.5 rounded-[3px] bg-chart-4" aria-hidden />
            Collected
          </span>
        </div>
        {revenue.isError || collections.isError ? (
          <ErrorState
            error={revenue.error ?? collections.error}
            onRetry={() => {
              void revenue.refetch();
              void collections.refetch();
            }}
          />
        ) : revenue.isLoading || collections.isLoading ? (
          <Skeleton className="h-[220px] w-full rounded-xl" />
        ) : (
          <RevenueChart days={days} />
        )}
      </Card>

      <Card className="flex min-w-0 flex-[2_1_340px] flex-col gap-3.5 p-5">
        <div className="flex items-center gap-3">
          <h2 className="mr-auto text-base font-bold">Subscribers by plan</h2>
          <Link href="/admin/reports" className="text-[13px] font-bold">
            Report
          </Link>
        </div>
        {subs.isError ? (
          <ErrorState error={subs.error} onRetry={() => void subs.refetch()} />
        ) : subs.isLoading ? (
          <div className="flex items-center gap-6" aria-busy>
            <Skeleton className="size-[168px] rounded-full" />
            <div className="flex-1 space-y-2.5">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-3.5 w-full" />
              ))}
            </div>
          </div>
        ) : total === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">No subscribers yet.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-6">
            <div
              role="img"
              aria-label={`${fmtNum(total)} subscribers by plan`}
              className="relative size-[168px] shrink-0 rounded-full"
              style={{ background: `conic-gradient(${donut})` }}
            >
              <div className="absolute inset-[26px] flex flex-col items-center justify-center rounded-full bg-card">
                <span className="text-2xl font-extrabold tracking-[-0.03em] text-foreground tabular-nums">
                  {fmtNum(total)}
                </span>
                <span className="text-xs text-muted-foreground">subscribers</span>
              </div>
            </div>
            <ul className="flex min-w-40 flex-1 flex-col gap-2">
              {plans.map((p, i) => (
                <li key={p.name} className="flex items-center gap-2 text-[13px]">
                  <span className={cn('size-2.5 shrink-0 rounded-[3px]', PLAN_COLORS[i])} aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-body">{p.name}</span>
                  <span className="font-bold text-foreground tabular-nums">{fmtNum(p.n)}</span>
                  <span className="w-9 text-right text-muted-foreground tabular-nums">
                    {Math.round((p.n / total) * 100)}%
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
    </div>
  );
}

type MyWallet = ApiData<'/api/v1/wallets/mine'>;

function ResellerHome({
  name,
  wallet,
  loading,
}: {
  name: string;
  wallet: MyWallet | undefined;
  loading: boolean;
}) {
  const can = useCan();
  const low = wallet && (wallet.state === 'low' || wallet.state === 'empty' || wallet.state === 'frozen');
  const from = istDay(29);
  const report = useQuery({
    queryKey: ['wallet-report', wallet?.id, from, istDay()],
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/wallets/{id}/report', {
          params: { path: { id: wallet!.id }, query: { from, to: istDay() } },
        }),
      ),
    enabled: !!wallet?.canViewLedger,
    staleTime: 5 * 60_000,
  });
  const expiring = useExpiring(7, 5);
  const prefs = useDashboardPrefs();
  const { shown } = prefs;
  const widgets: WidgetDef[] = [
    { id: 'r-wallet', label: 'Wallet balance' },
    { id: 'r-actions', label: 'Quick actions' },
    can('subscribers.read') && { id: 'r-renewals', label: 'Renewals and status' },
    { id: 'r-children', label: 'Sub-resellers and customers' },
    { id: 'r-recharges', label: 'Recharges per day' },
    can('subscribers.read') && { id: 'r-expiring', label: 'Expiring soon list' },
  ].filter((w): w is WidgetDef => !!w);
  const ledgerHref = wallet ? `/admin/wallets/${wallet.id}` : '/admin/wallets';

  // End-of-day balances, worked back from today's balance through each day's credits and debits.
  const byDay = new Map((report.data?.rows ?? []).map((r) => [r.day, r]));
  const balanceDays: { day: string; balancePaise: number }[] = [];
  let bal = wallet?.balancePaise ?? 0;
  for (let i = 0; i < 30; i++) {
    const day = istDay(i);
    balanceDays.unshift({ day, balancePaise: bal });
    const r = byDay.get(day);
    if (r) bal -= r.creditsPaise - r.debitsPaise;
  }
  const rechargeDays = balanceDays.map(({ day }) => ({
    day,
    count: byDay.get(day)?.countByType.RECHARGE_debit ?? 0,
  }));
  const rechargeCount = rechargeDays.reduce((n, d) => n + d.count, 0);
  const rechargePaise = (report.data?.rows ?? []).reduce((n, r) => n + (r.byType.RECHARGE_debit ?? 0), 0);

  const actions = [
    can('subscribers.write') && {
      href: '/admin/subscribers/new',
      icon: UserPlus,
      t: 'Add a customer',
      s: 'New connection with plan and router login',
    },
    can('subscribers.read') && {
      href: '/admin/subscribers',
      icon: Users,
      t: 'My customers',
      s: wallet ? `${fmtNum(wallet.customers)} customers` : 'Search, recharge, suspend',
    },
    can('tickets.read') && {
      href: '/admin/tickets',
      icon: LifeBuoy,
      t: 'Tickets',
      s: 'Customer problems and replies',
    },
  ].filter(Boolean) as { href: string; icon: typeof Users; t: string; s: string }[];

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <div className="mr-auto flex flex-col gap-0.5">
          <h1 className="text-[26px] font-extrabold tracking-[-0.03em]">Namaste, {name}</h1>
          <span className="font-mono text-xs text-muted-foreground">
            {wallet?.owner?.code ? `${wallet.owner.code} · ` : ''}
            {istStamp.format(new Date())}
          </span>
        </div>
        <DashboardConfig widgets={widgets} hidden={prefs.hidden} onSave={prefs.save} saving={prefs.saving} />
      </header>

      {low ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-[14px] bg-warning-bg px-4 py-3.5 text-warning-text"
        >
          <AlertTriangle className="size-5 shrink-0" aria-hidden />
          <div className="flex min-w-60 flex-1 flex-col gap-0.5">
            <span className="text-sm font-bold">
              {wallet.state === 'frozen'
                ? 'Wallet is frozen'
                : wallet.state === 'empty'
                  ? 'Wallet is empty: recharges are blocked'
                  : `Wallet is low: ${fmtRupees(wallet.balancePaise)} left`}
            </span>
            <span className="text-[13px]">
              {wallet.state === 'frozen'
                ? (wallet.frozenReason ?? 'Contact your provider.')
                : 'Ask your provider to top up so customer recharges keep going through.'}
              {wallet.state !== 'frozen' && expiring.data?.total
                ? ` ${expiring.data.total === 1 ? '1 customer expires' : `${fmtNum(expiring.data.total)} customers expire`} this week.`
                : ''}
            </span>
          </div>
          {wallet.canViewLedger ? (
            <Link href={ledgerHref} className="text-sm font-bold text-warning-text hover:text-warning-text">
              See ledger
            </Link>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-3 empty:hidden">
        {shown('r-wallet') ? (
          <Card className="flex min-w-0 flex-[3_1_460px] flex-col gap-4 p-[22px]">
            {loading || !wallet ? (
              <div className="space-y-3" aria-busy>
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-11 w-56 rounded-lg" />
                <Skeleton className="h-3 w-72" />
              </div>
            ) : (
              <div className="flex flex-wrap items-start gap-4">
                <div className="mr-auto flex flex-col gap-1">
                  <span className="eyebrow">Wallet balance</span>
                  <span className="text-[44px] leading-[1.05] font-extrabold tracking-[-0.04em] text-foreground tabular-nums">
                    {fmtRupees(wallet.balancePaise)}
                  </span>
                  <span className="text-[13px] text-muted-foreground">
                    {wallet.creditLimitPaise ? `Credit limit ${fmtRupees(wallet.creditLimitPaise)} · ` : ''}
                    Low-balance alert at {fmtRupees(wallet.lowBalanceThresholdPaise)}
                  </span>
                </div>
                {wallet.canViewLedger ? (
                  <Button variant="outline" asChild>
                    <Link href={ledgerHref}>Wallet ledger</Link>
                  </Button>
                ) : null}
              </div>
            )}
            {wallet?.canViewLedger ? (
              report.isLoading ? (
                <Skeleton className="h-[150px] w-full rounded-xl" />
              ) : report.data ? (
                <div className="flex flex-col gap-1.5">
                  <BalanceChart days={balanceDays} lowPaise={wallet.lowBalanceThresholdPaise} />
                  <span className="flex items-center gap-1.5 text-xs text-body">
                    <span
                      className="inline-block w-3.5 border-t-2 border-dashed border-chart-2"
                      aria-hidden
                    />
                    Low-balance alert at {fmtRupees0(wallet.lowBalanceThresholdPaise)}
                  </span>
                </div>
              ) : null
            ) : null}
            {wallet ? (
              <dl className="mt-auto grid grid-cols-3 gap-3 border-t border-divider pt-4 text-[13px]">
                {(
                  [
                    ['Received', wallet.totals.receivedPaise],
                    ['Spent on recharges', wallet.totals.rechargedPaise],
                    ['Refunded', wallet.totals.refundedPaise],
                  ] as const
                ).map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="font-bold text-foreground tabular-nums">{fmtRupees0(v)}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </Card>
        ) : null}
        {shown('r-actions') ? (
          <div className="flex min-w-0 flex-[2_1_300px] flex-col gap-3">
            {actions.map((a) => (
              <Link
                key={a.href}
                href={a.href}
                className="flex flex-1 items-center gap-3.5 rounded-2xl border bg-card px-[18px] py-4 text-inherit hover:border-input hover:text-inherit"
              >
                <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-accent text-primary">
                  <a.icon className="size-5" strokeWidth={1.9} aria-hidden />
                </span>
                <span className="flex flex-1 flex-col">
                  <span className="text-[15px] font-bold text-foreground">{a.t}</span>
                  <span className="text-[13px] text-muted-foreground">{a.s}</span>
                </span>
                <ChevronRight className="size-[18px] text-muted-foreground" aria-hidden />
              </Link>
            ))}
          </div>
        ) : null}
      </div>

      {can('subscribers.read') && shown('r-renewals') ? <RenewalsSection /> : null}

      {wallet && wallet.children > 0 && shown('r-children') ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
          <KpiLink href="/admin/resellers">
            <Stat
              dot="primary"
              label="Sub-resellers"
              value={fmtNum(wallet.children)}
              hint={wallet.lowChildren ? `${wallet.lowChildren} with low wallets` : 'All wallets healthy'}
              {...(wallet.lowChildren ? { hintTone: 'warning' as const } : {})}
            />
          </KpiLink>
          <KpiLink href="/admin/subscribers">
            <Stat
              dot="success"
              label="Customers"
              value={fmtNum(wallet.customers)}
              hint="across your network"
            />
          </KpiLink>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-3 empty:hidden">
        {wallet?.canViewLedger && shown('r-recharges') ? (
          <Card className="flex min-w-0 flex-[3_1_480px] flex-col gap-3.5 p-5">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="mr-auto text-base font-bold">Recharges per day, last 30 days</h2>
              {report.data ? (
                <span className="text-[13px] text-muted-foreground">
                  {plural(rechargeCount, 'recharge')} · {fmtRupees(rechargePaise)}
                </span>
              ) : null}
            </div>
            {report.isError ? (
              <ErrorState error={report.error} onRetry={() => void report.refetch()} />
            ) : report.isLoading ? (
              <Skeleton className="h-[180px] w-full rounded-xl" />
            ) : (
              <RechargesChart days={rechargeDays} />
            )}
          </Card>
        ) : null}
        {can('subscribers.read') && shown('r-expiring') ? (
          <ExpiringCard limit={5} compact className="flex-[2_1_340px]" />
        ) : null}
      </div>
    </div>
  );
}
