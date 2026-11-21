'use client';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  BarChart3,
  ChevronRight,
  Handshake,
  LifeBuoy,
  RefreshCw,
  Search,
  Server,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo } from 'react';
import { arrange, DashboardConfig, useDashboardPrefs, type WidgetDef } from '@/components/dashboard-config';
import {
  ExpiringCard,
  NetworkRow,
  RenewalsCard,
  RenewalsSection,
  SubscriberStatusCard,
  useExpiring,
} from '@/components/dashboard-widgets';
import { NotificationBell, ResellerNetwork, type Notice } from '@/components/reseller-dashboard';
import { GlanceGrid, glanceWidget, isGlanceId, useGlanceCards } from '@/components/at-a-glance';
import { InsightsCard } from '@/components/financial-insights';
import { NasStatistics } from '@/components/router-live';
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

const KpiLink = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <Link href={href} className="rounded-2xl text-inherit hover:text-inherit [&>div]:hover:border-input">
    {children}
  </Link>
);

type Tone = 'neutral' | 'success' | 'warning' | 'danger';
/** Small secondary figure: label left, number right. */
function Pill({
  href,
  label,
  value,
  tone = 'neutral',
  loading,
}: {
  href: string;
  label: string;
  value: React.ReactNode;
  tone?: Tone;
  loading?: boolean;
}) {
  return (
    <Link
      href={href}
      className="flex min-w-0 items-center gap-3 rounded-xl border bg-card px-3.5 py-2.5 text-inherit hover:border-input hover:text-inherit"
    >
      <span
        className={cn(
          'size-2 shrink-0 rounded-full',
          tone === 'danger'
            ? 'bg-danger-text'
            : tone === 'warning'
              ? 'bg-warning'
              : tone === 'success'
                ? 'bg-success'
                : 'bg-muted-foreground/40',
        )}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate text-[13px] text-body">{label}</span>
      {loading ? (
        <Skeleton className="h-4 w-10" />
      ) : (
        <span className="text-sm font-bold text-foreground tabular-nums">{value}</span>
      )}
    </Link>
  );
}

interface Attention {
  key: string;
  href: string;
  text: string;
  tone: 'danger' | 'warning';
}

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
  const glance = useGlanceCards('staff');
  const rejects = useQuery({
    queryKey: ['auth-log', 'summary', 'dashboard'],
    queryFn: () => unwrap(api.GET('/api/v1/radius/auth-log/summary')),
    enabled: staff && can('sessions.read') && shown('kpi-rejects'),
    refetchInterval: 60_000,
  });
  const problems = useQuery({
    queryKey: ['radius', 'router-problems'],
    queryFn: () => unwrap(api.GET('/api/v1/radius/router-problems')),
    enabled: staff && can('nas.read'),
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

  const routers = useMemo(() => nas.data?.items ?? [], [nas.data]);
  const rows = useMemo(() => {
    const onlineByIp = new Map((summary.data?.byNas ?? []).map((n) => [n.nasIp, n.online]));
    return routers
      .map((r) => {
        const online = onlineByIp.get(r.ip) ?? 0;
        return { r, online, h: health(r, online) };
      })
      .sort((a, b) => HEALTH_ORDER[a.h] - HEALTH_ORDER[b.h] || b.online - a.online);
  }, [routers, summary.data]);
  const silent = rows.filter((x) => x.h === 'silent');
  const up = rows.filter((x) => x.h === 'up').length;
  const b = billing.data;
  const collectedPct = b && b.month.invoicedPaise > 0 ? b.month.collectedPaise / b.month.invoicedPaise : null;

  if (!staff && me.data)
    return <ResellerHome name={me.data.user.name} wallet={wallet.data} loading={wallet.isLoading} />;

  const attention: Attention[] = [
    silent.length > 0 && {
      key: 'silent',
      href: '/admin/routers',
      tone: 'danger' as const,
      text:
        silent.length === 1
          ? `${silent[0]!.r.name} silent since ${relTime(silent[0]!.r.lastSeenAt)}`
          : `${silent.length} routers not reporting`,
    },
    (problems.data?.problems ?? 0) > 0 && {
      key: 'secret',
      href: '/admin/radius-log?tab=routers',
      tone: 'danger' as const,
      text: `${plural(problems.data!.problems, 'router')} with a Radius secret problem`,
    },
    !!b?.unpaid.overdue && {
      key: 'overdue',
      href: '/admin/invoices',
      tone: 'warning' as const,
      text: `${plural(b.unpaid.overdue, 'invoice')} overdue`,
    },
    !!(b && (b.wallets.low || b.wallets.frozen)) && {
      key: 'wallets',
      href: '/admin/wallets',
      tone: 'warning' as const,
      text: [
        b!.wallets.low && plural(b!.wallets.low, 'low partner wallet'),
        b!.wallets.frozen && plural(b!.wallets.frozen, 'frozen partner wallet'),
      ]
        .filter(Boolean)
        .join(' · '),
    },
    !!tickets.data?.unassigned && {
      key: 'tickets',
      href: '/admin/tickets',
      tone: 'warning' as const,
      text: `${plural(tickets.data.unassigned, 'ticket')} unassigned`,
    },
    !!b?.sms.failed24h && {
      key: 'sms',
      href: '/admin/settings',
      tone: 'warning' as const,
      text: `${b.sms.failed24h} SMS failed in 24 h`,
    },
  ].filter((a): a is Attention => !!a);

  const widgets: WidgetDef[] = [
    { id: 'attention', label: 'Needs attention' },
    ...glance.map(glanceWidget),
    { id: 'actions', label: 'Quick actions' },
    can('subscribers.read') && { id: 'renewals', label: 'Renewals and status' },
    can('subscribers.read') && { id: 'expiring', label: 'Expiring soon list' },
    (can('sessions.read') || can('nas.read')) && { id: 'routers', label: 'Routers' },
    can('billing.read') && { id: 'month', label: 'This month' },
    can('sessions.read') && { id: 'kpi-rejects', label: 'Login rejects (24 h)' },
    can('tickets.read') && { id: 'kpi-tickets', label: 'Open tickets' },
    can('nas.read') && { id: 'kpi-routers', label: 'Routers count' },
    can('plans.read') && { id: 'kpi-plans', label: 'Plans' },
    can('nas.read') && { id: 'nas-stats', label: 'NAS statistics (live ports)' },
    can('sessions.read') && { id: 'network', label: 'Network charts' },
    can('reports.view') && { id: 'insights', label: 'Financial insights' },
    can('reports.view') && { id: 'trends', label: 'Revenue and plan trends' },
  ].filter((w): w is WidgetDef => !!w);

  const glanceShown = glance.filter((g) => prefs.isShown(g));

  const pills = [
    can('sessions.read') && shown('kpi-rejects') && (
      <Pill
        key="rejects"
        href="/admin/radius-log?result=reject"
        label="Login rejects · 24 h"
        loading={rejects.isLoading}
        value={fmtNum(rejects.data?.rejected ?? 0)}
        tone={rejects.data?.rejected ? 'warning' : 'success'}
      />
    ),
    can('tickets.read') && shown('kpi-tickets') && (
      <Pill
        key="tickets"
        href="/admin/tickets"
        label="Open tickets"
        loading={tickets.isLoading}
        value={tickets.data ? fmtNum(tickets.data.open + tickets.data.in_progress) : '—'}
        tone={tickets.data?.unassigned ? 'warning' : 'neutral'}
      />
    ),
    can('nas.read') && shown('kpi-routers') && (
      <Pill
        key="routers"
        href="/admin/routers"
        label="Routers with users"
        loading={nas.isLoading}
        value={`${up} / ${routers.length}`}
        tone={silent.length ? 'danger' : 'success'}
      />
    ),
    can('plans.read') && shown('kpi-plans') && (
      <Pill
        key="plans"
        href="/admin/plans"
        label="Active plans"
        loading={plansLoading}
        value={plans.filter((p) => p.status === 'active').length}
      />
    ),
  ].filter(Boolean);

  const actions = [
    can('subscribers.write') && { href: '/admin/subscribers/new', icon: UserPlus, t: 'Add subscriber' },
    can('recharges.create') && { href: '/admin/subscribers?status=expired', icon: RefreshCw, t: 'Recharge' },
    can('resellers.write') && { href: '/admin/resellers', icon: Handshake, t: 'Partners' },
    can('nas.write') && { href: '/admin/routers', icon: Server, t: 'Add router' },
    can('tickets.write') && { href: '/admin/tickets', icon: LifeBuoy, t: 'Tickets' },
    can('reports.view') && { href: '/admin/reports', icon: BarChart3, t: 'Reports' },
  ].filter(Boolean) as { href: string; icon: LucideIcon; t: string }[];

  const side =
    ((can('sessions.read') || can('nas.read')) && shown('routers')) ||
    (can('subscribers.read') && shown('expiring')) ||
    (can('billing.read') && !!b && shown('month'));

  return (
    <div className="flex flex-col gap-5">
      <DashboardBackdrop />
      <header className="flex flex-wrap items-center gap-3">
        <div className="mr-auto flex flex-col gap-0.5">
          <span className="font-mono text-xs text-muted-foreground">{istStamp.format(new Date())}</span>
          <h1 className="text-[26px] font-extrabold tracking-[-0.03em]">
            {greeting()}, {me.data?.user.name.split(' ')[0]}
          </h1>
        </div>
        {can('subscribers.read') ? (
          <form
            role="search"
            className="flex h-10 w-full items-center gap-2 rounded-xl border bg-card px-3 focus-within:border-primary sm:w-[300px]"
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
            <kbd className="hidden rounded border px-1.5 font-mono text-[10px] text-muted-foreground sm:inline">
              ↵
            </kbd>
          </form>
        ) : null}
        <DashboardConfig widgets={widgets} hidden={prefs.hidden} onSave={prefs.save} saving={prefs.saving} />
      </header>

      {shown('attention') && attention.length ? (
        <section aria-label="Needs attention" className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1.5 pr-1 text-[13px] font-bold text-foreground">
            <AlertTriangle className="size-4 text-danger-text" aria-hidden />
            Needs attention
          </span>
          {attention.map((a) => (
            <Link
              key={a.key}
              href={a.href}
              className={cn(
                'rounded-full px-3 py-1.5 text-[13px] font-semibold',
                a.tone === 'danger'
                  ? 'bg-danger-bg text-danger-text hover:text-danger-text'
                  : 'bg-warning-bg text-warning-text hover:text-warning-text',
              )}
            >
              {a.text}
            </Link>
          ))}
        </section>
      ) : null}

      {glanceShown.length ? (
        <GlanceGrid>
          {glanceShown.map((g) => (
            <div key={g.id} className="min-w-0">
              {g.render()}
            </div>
          ))}
        </GlanceGrid>
      ) : null}

      {pills.length || (shown('actions') && actions.length) ? (
        <div className="flex flex-col gap-3">
          {pills.length ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">{pills}</div>
          ) : null}
          {shown('actions') && actions.length ? (
            <nav aria-label="Quick actions" className="flex flex-wrap gap-2">
              {actions.map((a) => (
                <Button key={a.href + a.t} variant="outline" asChild>
                  <Link href={a.href}>
                    <a.icon /> {a.t}
                  </Link>
                </Button>
              ))}
            </nav>
          ) : null}
        </div>
      ) : null}

      <div className={cn('grid grid-cols-1 gap-4', side && 'xl:grid-cols-12')}>
        <div className={cn('flex min-w-0 flex-col gap-4', side && 'xl:col-span-8')}>
          {can('subscribers.read') && shown('renewals') ? <RenewalsSection /> : null}
          {can('reports.view') && shown('trends') ? <TrendsRow /> : null}
          {can('sessions.read') && shown('network') ? <NetworkRow /> : null}
        </div>

        {side ? (
          <aside className="flex min-w-0 flex-col gap-4 xl:col-span-4 xl:self-start">
            {(can('sessions.read') || can('nas.read')) && shown('routers') ? (
              <RoutersCard
                rows={rows}
                up={up}
                loading={nas.isLoading || summary.isLoading}
                error={summary.isError ? summary.error : null}
                onRetry={() => void summary.refetch()}
              />
            ) : null}
            {can('billing.read') && b && shown('month') ? (
              <MonthCard b={b} collectedPct={collectedPct} />
            ) : null}
            {can('subscribers.read') && shown('expiring') ? (
              <ExpiringCard limit={6} compact className="flex-none" />
            ) : null}
          </aside>
        ) : null}
      </div>

      {can('nas.read') && shown('nas-stats') ? <NasStatistics routers={routers} /> : null}
      {can('reports.view') && shown('insights') ? <InsightsCard from={istDay(29)} to={istDay()} /> : null}

      <footer className="flex flex-wrap justify-between gap-2 pt-2 font-mono text-[11px] text-muted-foreground">
        <span>All times IST · online figures refresh every 30 s, charts every 5 min</span>
      </footer>
    </div>
  );
}

const HEALTH_ORDER: Record<RouterHealth, number> = { silent: 0, up: 1, quiet: 2, disabled: 3 };
const ROUTERS_SHOWN = 6;

const greeting = () => {
  const h = Number(
    new Intl.DateTimeFormat('en-IN', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Kolkata' }).format(
      new Date(),
    ),
  );
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};

type RouterRow = { r: Nas; online: number; h: RouterHealth };

function RoutersCard({
  rows,
  up,
  loading,
  error,
  onRetry,
}: {
  rows: RouterRow[];
  up: number;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const totalOnline = rows.reduce((n, x) => n + x.online, 0);
  return (
    <Card className="overflow-hidden">
      <CardBar>
        <h2 className="mr-auto text-base font-bold">Routers</h2>
        {rows.length ? (
          <span className="text-[13px] text-muted-foreground">
            {up} of {rows.length} serving
          </span>
        ) : null}
        <Link href="/admin/routers" className="text-[13px] font-bold">
          All
        </Link>
      </CardBar>
      {error ? (
        <div className="p-4">
          <ErrorState error={error} onRetry={onRetry} />
        </div>
      ) : loading ? (
        <div className="divide-y divide-divider">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 px-5 py-3">
              <Skeleton className="size-8 rounded-[10px]" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-2 w-full" />
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
          {rows.slice(0, ROUTERS_SHOWN).map(({ r, online, h }) => (
            <li key={r.id}>
              <Link
                href={`/admin/sessions?nas=${encodeURIComponent(r.ip)}`}
                className="flex items-center gap-3 px-5 py-3 text-inherit hover:bg-subtle hover:text-inherit"
              >
                <span
                  className={cn('grid size-8 shrink-0 place-items-center rounded-[10px]', HEALTH[h].tile)}
                >
                  <Server className="size-4" strokeWidth={1.8} aria-hidden />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span className="flex items-baseline gap-2">
                    <span className="truncate text-sm font-semibold text-foreground">{r.name}</span>
                    <span className="ml-auto shrink-0 text-xs text-body tabular-nums">
                      {h === 'silent' ? HEALTH[h].label : `${fmtNum(online)} online`}
                    </span>
                  </span>
                  <span className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                    <span
                      className={cn(
                        'block h-full rounded-full',
                        h === 'silent'
                          ? 'bg-danger-text'
                          : h === 'up'
                            ? 'bg-primary'
                            : 'bg-muted-foreground/30',
                      )}
                      style={{
                        width: `${h === 'silent' ? 100 : totalOnline ? Math.max(2, (online / totalOnline) * 100) : 0}%`,
                      }}
                    />
                  </span>
                </span>
              </Link>
            </li>
          ))}
          {rows.length > ROUTERS_SHOWN ? (
            <li>
              <Link
                href="/admin/routers"
                className="block px-5 py-2.5 text-center text-[13px] font-semibold text-muted-foreground hover:bg-subtle"
              >
                {rows.length - ROUTERS_SHOWN} more
              </Link>
            </li>
          ) : null}
        </ul>
      )}
    </Card>
  );
}

type BillingSummary = ApiData<'/api/v1/billing/summary'>;

function MonthCard({ b, collectedPct }: { b: BillingSummary; collectedPct: number | null }) {
  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-baseline gap-2">
        <h2 className="mr-auto text-base font-bold">This month</h2>
        <span className="text-[13px] text-muted-foreground">{fmtNum(b.month.recharges)} recharges</span>
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
      <div className="grid grid-cols-2 gap-3 border-t pt-4 text-[13px]">
        <Link href="/admin/wallets" className="flex flex-col text-inherit hover:text-inherit">
          <span className="text-muted-foreground">Partner wallets</span>
          <span className="font-bold text-foreground tabular-nums">
            {fmtRupees0(b.wallets.resellerBalancePaise)}
          </span>
        </Link>
        <div className="flex flex-col">
          <span className="text-muted-foreground">SMS queue</span>
          <span className="font-bold text-foreground tabular-nums">{fmtNum(b.sms.queued)} queued</span>
        </div>
      </div>
    </Card>
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

/** White at the top fading to #F7F7F5 by a third of the page, behind the dashboard. */
const DashboardBackdrop = () => (
  <div
    aria-hidden
    className="pointer-events-none fixed inset-0 -z-10 bg-[linear-gradient(180deg,#FFFFFF_0%,#F7F7F5_33%,#F7F7F5_100%)]"
  />
);

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
  const glance = useGlanceCards('reseller', { data: wallet, isLoading: loading, isError: false });
  // Users who arranged their dashboard before the cards existed get them on top, not at the end.
  const order =
    prefs.order.length && !prefs.order.some(isGlanceId)
      ? [...glance.map((g) => g.id), ...prefs.order]
      : prefs.order;
  const ledgerHref = wallet ? `/admin/wallets/${wallet.id}` : '/admin/wallets';

  // Default order and visibility. Wallet, quick actions and sub-resellers already live in the
  // sidebar, so they start switched off; each user can switch them back on and reorder everything.
  const widgets: WidgetDef[] = [
    ...glance.map(glanceWidget),
    can('subscribers.read') && { id: 'r-renewals', label: 'Renewals' },
    can('subscribers.read') && { id: 'r-status', label: 'Subscriber status' },
    (can('sessions.read') || can('nas.read')) && {
      id: 'r-network',
      label: 'My network (online, routers, logins, live log)',
    },
    wallet?.canViewLedger && { id: 'r-recharges', label: 'Recharges per day' },
    can('subscribers.read') && { id: 'r-expiring', label: 'Expiring soon list' },
    { id: 'r-wallet', label: 'Wallet balance', defaultHidden: true },
    { id: 'r-actions', label: 'Quick actions', defaultHidden: true },
    wallet &&
      wallet.children > 0 && { id: 'r-children', label: 'Sub-resellers and customers', defaultHidden: true },
  ].filter((w): w is WidgetDef => !!w);

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

  const notices: Notice[] = [];
  if (wallet && (wallet.state === 'empty' || wallet.state === 'frozen' || wallet.state === 'low')) {
    const week = expiring.data?.total
      ? ` ${expiring.data.total === 1 ? '1 customer expires' : `${fmtNum(expiring.data.total)} customers expire`} in the next 7 days.`
      : '';
    notices.push({
      id: 'wallet',
      tone: wallet.state === 'low' ? 'warning' : 'danger',
      title:
        wallet.state === 'frozen'
          ? 'Wallet is frozen'
          : wallet.state === 'empty'
            ? 'Wallet is empty'
            : `Wallet is low: ${fmtRupees(wallet.balancePaise)} left`,
      body:
        wallet.state === 'frozen'
          ? (wallet.frozenReason ?? 'Contact your provider.')
          : wallet.state === 'empty'
            ? `Customer recharges are blocked.${week}`
            : `Ask your provider to top up so recharges keep going through.${week}`,
      ...(wallet.canViewLedger ? { href: ledgerHref, hrefLabel: 'See ledger' } : {}),
    });
  }

  const render: Record<string, () => React.ReactNode> = {
    ...Object.fromEntries(glance.map((g) => [g.id, g.render])),
    'r-renewals': () => <RenewalsCard />,
    'r-status': () => <SubscriberStatusCard />,
    'r-network': () => <ResellerNetwork />,
    'r-expiring': () => <ExpiringCard limit={5} compact />,
    'r-recharges': () => (
      <Card className="flex min-w-0 flex-col gap-3.5 p-5">
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
    ),
    'r-wallet': () => (
      <Card className="flex min-w-0 flex-col gap-4 p-[22px]">
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
                <span className="inline-block w-3.5 border-t-2 border-dashed border-chart-2" aria-hidden />
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
    ),
    'r-actions': () => (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
    ),
    'r-children': () =>
      wallet ? (
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
      ) : null,
  };
  const shownWidgets = prefs.loaded ? arrange(widgets, order).filter(prefs.isShown) : [];
  // Consecutive stat cards share one grid; every other widget is its own block.
  const blocks: { key: string; ids: string[]; grid: boolean }[] = [];
  for (const w of shownWidgets) {
    const grid = isGlanceId(w.id);
    const last = blocks[blocks.length - 1];
    if (grid && last?.grid) last.ids.push(w.id);
    else blocks.push({ key: w.id, ids: [w.id], grid });
  }

  return (
    <div className="flex flex-col gap-4">
      <DashboardBackdrop />
      <header className="flex flex-wrap items-end gap-3">
        <div className="mr-auto flex flex-col gap-0.5">
          <span className="font-mono text-xs text-muted-foreground">
            {wallet?.owner?.code ? `${wallet.owner.code} · ` : ''}
            {istStamp.format(new Date())}
          </span>
          <h1 className="text-[26px] font-extrabold tracking-[-0.03em]">Namaste, {name}</h1>
        </div>
        <NotificationBell notices={notices} />
        <DashboardConfig
          widgets={widgets}
          hidden={prefs.hidden}
          order={order}
          arranged={prefs.arranged}
          sortable
          onSave={prefs.save}
          saving={prefs.saving}
        />
        {can('subscribers.write') ? (
          <Button asChild>
            <Link href="/admin/subscribers/new">
              <UserPlus /> Add customer
            </Link>
          </Button>
        ) : null}
      </header>

      {!prefs.loaded ? (
        <div className="flex flex-col gap-4" aria-busy>
          <Skeleton className="h-[150px] rounded-2xl" />
          <Skeleton className="h-[150px] rounded-2xl" />
        </div>
      ) : shownWidgets.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          Everything is switched off. Use Customise to choose what the dashboard shows.
        </Card>
      ) : (
        blocks.map((b) =>
          b.grid ? (
            <GlanceGrid key={b.key}>
              {b.ids.map((id) => (
                <div key={id} className="min-w-0">
                  {render[id]?.()}
                </div>
              ))}
            </GlanceGrid>
          ) : (
            <div key={b.key}>{render[b.key]?.()}</div>
          ),
        )
      )}
    </div>
  );
}
