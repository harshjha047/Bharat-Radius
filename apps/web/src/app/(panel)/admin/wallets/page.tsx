'use client';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ArrowUpRight } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { TopUpDialog, WalletStateBadge } from '@/components/billing';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { ErrorState, PageHeader, Stat } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, unwrap } from '@/lib/api';
import { useCan, useMe } from '@/lib/auth';
import type { Wallet } from '@/lib/queries';
import { fmtNum, fmtRupees } from '@/lib/utils';

type Filter = 'all' | 'low' | 'empty' | 'frozen';

export default function WalletsPage() {
  const router = useRouter();
  const can = useCan();
  const me = useMe();
  const staff = me.data?.user.type !== 'reseller';
  const [filter, setFilter] = useState<Filter>('all');
  const [topUp, setTopUp] = useState<Wallet | null>(null);

  const mine = useQuery({
    queryKey: ['wallet', 'mine'],
    queryFn: () => unwrap(api.GET('/api/v1/wallets/mine')),
  });
  const summary = useQuery({
    queryKey: ['billing', 'summary'],
    queryFn: () => unwrap(api.GET('/api/v1/billing/summary')),
    enabled: staff,
    refetchInterval: 60_000,
  });
  const list = useInfiniteQuery({
    queryKey: ['wallets', filter],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/v1/wallets', {
          params: {
            query: {
              limit: 50,
              ...(filter !== 'all' ? { state: filter } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    placeholderData: (prev) => prev,
  });
  const m = mine.data;
  const s = summary.data;
  const rows = list.data?.pages.flatMap((p) => p.items).filter((w) => w.walletType !== 'MASTER');

  return (
    <>
      <PageHeader
        title="Wallets"
        description={
          staff
            ? 'Money issued to resellers and what they hold.'
            : 'Your balance and your sub-resellers’ wallets.'
        }
        actions={
          m ? (
            <Button variant="outline" asChild>
              <Link href={`/admin/wallets/${m.id}`}>
                {staff ? 'Master ledger' : 'My ledger'} <ArrowUpRight />
              </Link>
            </Button>
          ) : null
        }
      />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {mine.isLoading ? (
          [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)
        ) : m && staff ? (
          <>
            <Stat
              label="Issued to level 1"
              value={fmtRupees(m.totals.allocatedPaise)}
              hint={`${fmtNum(m.children)} level-1 resellers`}
            />
            <Stat
              label="Held by resellers"
              value={s ? fmtRupees(s.wallets.resellerBalancePaise) : '—'}
              hint={s ? `${s.wallets.low} low · ${s.wallets.frozen} frozen` : undefined}
            />
            <Stat
              label="Recharges today"
              value={s ? fmtNum(s.today.recharges) : '—'}
              hint={s ? fmtRupees(s.today.rechargePaise) : undefined}
            />
            <Stat
              label="Unpaid invoices"
              value={s ? fmtNum(s.unpaid.count) : '—'}
              hint={s ? `${fmtRupees(s.unpaid.balancePaise)} · ${s.unpaid.overdue} overdue` : undefined}
            />
          </>
        ) : m ? (
          <>
            <Stat
              label="Balance"
              value={fmtRupees(m.balancePaise)}
              hint={<WalletStateBadge state={m.state} />}
            />
            <Stat label="Received" value={fmtRupees(m.totals.receivedPaise)} />
            <Stat
              label="Used for recharges"
              value={fmtRupees(m.totals.rechargedPaise)}
              hint={`${fmtNum(m.customers)} customers`}
            />
            <Stat
              label="Sent to sub-resellers"
              value={fmtRupees(m.totals.allocatedPaise)}
              hint={`${fmtNum(m.children)} sub-resellers · ${m.lowChildren} low`}
            />
          </>
        ) : null}
      </div>
      {mine.isError ? <ErrorState error={mine.error} onRetry={() => void mine.refetch()} /> : null}
      {m?.state === 'low' || m?.state === 'empty' ? (
        <p
          role="status"
          className="mb-4 rounded-xl border border-[#f5d9a8] bg-warning-bg text-warning-text font-semibold px-3 py-2 text-sm"
        >
          {m.state === 'empty'
            ? 'Your wallet is empty: recharges are blocked until you get a top-up.'
            : `Low balance: at or below ${fmtRupees(m.lowBalanceThresholdPaise)}.`}
        </p>
      ) : null}

      <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)} className="mb-3">
        <TabsList>
          <TabsTrigger value="all">{staff ? 'All resellers' : 'Sub-resellers'}</TabsTrigger>
          <TabsTrigger value="low">Low</TabsTrigger>
          <TabsTrigger value="empty">Empty</TabsTrigger>
          {staff ? <TabsTrigger value="frozen">Frozen</TabsTrigger> : null}
        </TabsList>
      </Tabs>
      {list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <DataTable
          caption="Wallet accounts"
          loading={list.isLoading}
          rows={rows}
          rowKey={(w) => w.id}
          onRowClick={(w) => router.push(`/admin/wallets/${w.id}`)}
          hasMore={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
          empty={filter === 'all' ? 'No reseller wallets yet.' : 'None.'}
          columns={[
            {
              key: 'owner',
              header: 'Reseller',
              cell: (w) => (
                <div>
                  <span className="font-medium">{w.owner.name}</span>
                  <div className="text-xs text-muted-foreground">
                    {w.owner.code} · {w.walletType}
                  </div>
                </div>
              ),
            },
            {
              key: 'bal',
              header: 'Balance',
              cell: (w) => fmtRupees(w.balancePaise),
              className: 'text-right tabular-nums',
            },
            {
              key: 'recv',
              header: 'Received',
              cell: (w) => fmtRupees(w.totals.receivedPaise),
              className: 'text-right tabular-nums',
              hideOnMobile: true,
            },
            {
              key: 'used',
              header: 'Recharges',
              cell: (w) => fmtRupees(w.totals.rechargedPaise),
              className: 'text-right tabular-nums',
              hideOnMobile: true,
            },
            { key: 'state', header: 'Status', cell: (w) => <WalletStateBadge state={w.state} /> },
            {
              key: 'act',
              header: '',
              cell: (w) =>
                can('wallets.transfer') && m && w.parentWalletId === m.id && w.state !== 'frozen' ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={(e) => {
                      e.stopPropagation();
                      setTopUp(w);
                    }}
                  >
                    {staff ? 'Top up' : 'Send'}
                  </Button>
                ) : null,
            },
          ]}
        />
      )}
      <TopUpDialog wallet={topUp} open={!!topUp} onOpenChange={(o) => !o && setTopUp(null)} />
    </>
  );
}
