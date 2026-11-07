'use client';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { DataTable } from '@/components/ui/data-table';
import { Input } from '@/components/ui/input';
import { ErrorState, PageHeader, Stat } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { api, unwrap } from '@/lib/api';
import { useCan, useMe } from '@/lib/auth';
import { usePlans } from '@/lib/queries';
import { fmtNum, fmtRupees } from '@/lib/utils';

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
  });
  const routers = nas.data?.items ?? [];
  const onlineByIp = new Map((summary.data?.byNas ?? []).map((n) => [n.nasIp, n.online]));

  return (
    <>
      <PageHeader
        title={`Hello, ${me.data?.user.name.split(' ')[0] ?? ''}`}
        description="Your network right now."
      />
      {can('subscribers.read') ? (
        <form
          role="search"
          className="relative mb-6 max-w-xl"
          onSubmit={(e) => {
            e.preventDefault();
            const q = String(new FormData(e.currentTarget).get('q') ?? '').trim();
            router.push(`/admin/subscribers${q ? `?q=${encodeURIComponent(q)}` : ''}`);
          }}
        >
          <Search
            className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground"
            aria-hidden
          />
          <Input
            name="q"
            className="h-10 pl-9"
            placeholder="Find a subscriber: name, username, phone or customer no."
            aria-label="Find a subscriber"
          />
        </form>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {can('billing.read') && !staff ? (
          wallet.isLoading ? (
            <Skeleton className="h-24" />
          ) : wallet.data ? (
            <Link href="/admin/wallets" className="rounded-lg focus-visible:ring-2 focus-visible:ring-ring">
              <Stat
                label="Wallet balance"
                value={fmtRupees(wallet.data.balancePaise)}
                hint={
                  wallet.data.state === 'normal'
                    ? `${fmtNum(wallet.data.customers)} customers`
                    : wallet.data.state === 'empty'
                      ? 'Empty: recharges blocked'
                      : 'Low balance'
                }
              />
            </Link>
          ) : null
        ) : null}
        {can('billing.read') && staff ? (
          billing.isLoading ? (
            <Skeleton className="h-24" />
          ) : billing.data ? (
            <Link href="/admin/recharges" className="rounded-lg focus-visible:ring-2 focus-visible:ring-ring">
              <Stat
                label="Recharges today"
                value={fmtNum(billing.data.today.recharges)}
                hint={`${fmtRupees(billing.data.unpaid.balancePaise)} unpaid · ${billing.data.unpaid.overdue} overdue`}
              />
            </Link>
          ) : null
        ) : null}
        {can('sessions.read') ? (
          summary.isLoading ? (
            <Skeleton className="h-24" />
          ) : (
            <Stat
              label="Online now"
              value={fmtNum(summary.data?.online ?? 0)}
              hint={summary.data?.stale ? `${summary.data.stale} not reporting` : 'All sessions reporting'}
            />
          )
        ) : null}
        {can('nas.read') ? (
          nas.isLoading ? (
            <Skeleton className="h-24" />
          ) : (
            <Stat
              label="Routers"
              value={routers.length}
              hint={`${routers.filter((r) => r.status === 'active').length} active`}
            />
          )
        ) : null}
        {can('plans.read') ? (
          plansLoading ? (
            <Skeleton className="h-24" />
          ) : (
            <Stat label="Plans" value={plans.filter((p) => p.status === 'active').length} hint="active" />
          )
        ) : null}
      </div>

      {can('sessions.read') ? (
        <section className="mt-8 space-y-3" aria-labelledby="by-router">
          <div className="flex items-center justify-between">
            <h2 id="by-router" className="text-base font-semibold">
              Online by router
            </h2>
            <Link href="/admin/sessions" className="text-sm text-primary hover:underline">
              All sessions
            </Link>
          </div>
          {summary.isError ? (
            <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
          ) : (
            <DataTable
              caption="Online sessions by router"
              loading={summary.isLoading}
              rows={summary.data?.byNas}
              rowKey={(r) => r.nasIp}
              onRowClick={(r) => router.push(`/admin/sessions?nas=${encodeURIComponent(r.nasIp)}`)}
              empty={
                routers.length
                  ? 'Nobody is online yet.'
                  : 'No routers yet. Add one under Routers so subscribers can connect.'
              }
              columns={[
                { key: 'name', header: 'Router', cell: (r) => r.nasName ?? r.nasIp },
                {
                  key: 'ip',
                  header: 'IP',
                  cell: (r) => <span className="font-mono text-xs">{r.nasIp}</span>,
                },
                {
                  key: 'online',
                  header: 'Online',
                  className: 'text-right',
                  cell: (r) => (
                    <span className="tabular-nums">{fmtNum(onlineByIp.get(r.nasIp) ?? r.online)}</span>
                  ),
                },
              ]}
            />
          )}
        </section>
      ) : null}
    </>
  );
}
