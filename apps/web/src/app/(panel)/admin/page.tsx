'use client';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ChevronRight, LifeBuoy, Plus, Search, Server, UserPlus, Users } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBar } from '@/components/ui/card';
import { ErrorState, Stat } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { api, unwrap, type ApiData } from '@/lib/api';
import { useCan, useMe } from '@/lib/auth';
import { usePlans, type Nas } from '@/lib/queries';
import { cn, fmtNum, fmtRupees, fmtRupees0, relTime } from '@/lib/utils';

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

      <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
        {can('sessions.read') ? (
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
        {can('billing.read') && staff ? (
          billing.isLoading ? (
            <>
              <KpiSkeleton />
              <KpiSkeleton />
            </>
          ) : b ? (
            <>
              <KpiLink href="/admin/recharges">
                <Stat
                  dot="teal"
                  label="Today’s recharges"
                  value={fmtRupees0(b.today.rechargePaise)}
                  hint={`${fmtNum(b.today.recharges)} recharges`}
                />
              </KpiLink>
              <KpiLink href="/admin/invoices">
                <Stat
                  dot="danger"
                  label="Unpaid"
                  value={fmtRupees0(b.unpaid.balancePaise)}
                  hint={`${fmtNum(b.unpaid.count)} invoices · ${fmtNum(b.unpaid.overdue)} overdue`}
                  {...(b.unpaid.overdue ? { hintTone: 'danger' as const } : {})}
                />
              </KpiLink>
            </>
          ) : null
        ) : null}
        {can('tickets.read') ? (
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
        {can('nas.read') ? (
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
        {can('plans.read') ? (
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

      <div className="flex flex-wrap gap-3">
        {can('sessions.read') || can('nas.read') ? (
          <Card className="min-w-0 flex-[3_1_480px] overflow-hidden">
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

        {can('billing.read') && staff && b ? (
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

      <footer className="flex flex-wrap justify-between gap-2 pt-2 font-mono text-[11px] text-muted-foreground">
        <span>All times IST · online figures refresh every 30 s</span>
      </footer>
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
      <header className="flex flex-col gap-0.5">
        <h1 className="text-[26px] font-extrabold tracking-[-0.03em]">Namaste, {name}</h1>
        <span className="font-mono text-xs text-muted-foreground">
          {wallet?.owner?.code ? `${wallet.owner.code} · ` : ''}
          {istStamp.format(new Date())}
        </span>
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
            </span>
          </div>
          {wallet.canViewLedger ? (
            <Link
              href="/admin/wallets"
              className="text-sm font-bold text-warning-text hover:text-warning-text"
            >
              See ledger
            </Link>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-3">
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
                  <Link href="/admin/wallets">Wallet ledger</Link>
                </Button>
              ) : null}
            </div>
          )}
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
      </div>

      {wallet && wallet.children > 0 ? (
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
    </div>
  );
}
