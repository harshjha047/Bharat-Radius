'use client';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { SubscriberState, SyncState } from '@/components/status';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { Input, Select } from '@/components/ui/input';
import { ErrorState, PageHeader } from '@/components/ui/misc';
import { useDebounced } from '@/hooks/use-debounced';
import { api, unwrap } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { usePlans } from '@/lib/queries';
import { fmtDate } from '@/lib/utils';

type Status = 'active' | 'suspended' | 'disabled' | 'expired';

function SubscribersList() {
  const router = useRouter();
  const params = useSearchParams();
  const can = useCan();
  const { plans, byId } = usePlans();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [status, setStatus] = useState<Status | ''>((params.get('status') as Status | null) ?? '');
  const [planId, setPlanId] = useState(params.get('plan') ?? '');
  const dq = useDebounced(q.trim(), 300);

  // Keep filters in the URL so Back and shared links return to the same list.
  useEffect(() => {
    const s = new URLSearchParams();
    if (dq) s.set('q', dq);
    if (status) s.set('status', status);
    if (planId) s.set('plan', planId);
    const next = s.toString();
    if (next !== params.toString())
      router.replace(`/admin/subscribers${next ? `?${next}` : ''}`, { scroll: false });
  }, [dq, status, planId, params, router]);

  const list = useInfiniteQuery({
    queryKey: ['subscribers', { q: dq, status, planId }],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/v1/subscribers', {
          params: {
            query: {
              limit: 50,
              ...(dq ? { q: dq } : {}),
              ...(status ? { status } : {}),
              ...(planId ? { planId } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    placeholderData: (prev) => prev,
  });
  const rows = list.data?.pages.flatMap((p) => p.items);

  return (
    <>
      <PageHeader
        title="Subscribers"
        actions={
          can('subscribers.write') ? (
            <Button asChild>
              <Link href="/admin/subscribers/new">
                <Plus /> New subscriber
              </Link>
            </Button>
          ) : null
        }
      />
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="pl-9"
            placeholder="Name, username, phone or customer no."
            aria-label="Search subscribers"
            maxLength={64}
          />
        </div>
        <Select
          value={status}
          onChange={(e) => setStatus(e.target.value as Status | '')}
          aria-label="Status"
          className="sm:w-40"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="expired">Expired</option>
          <option value="suspended">Suspended</option>
          <option value="disabled">Disabled</option>
        </Select>
        <Select
          value={planId}
          onChange={(e) => setPlanId(e.target.value)}
          aria-label="Plan"
          className="sm:w-48"
        >
          <option value="">All plans</option>
          {plans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </div>
      {list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <DataTable
          caption="Subscribers"
          loading={list.isLoading}
          rows={rows}
          rowKey={(s) => s.id}
          onRowClick={(s) => router.push(`/admin/subscribers/${s.id}`)}
          hasMore={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
          empty={dq || status || planId ? 'No subscriber matches these filters.' : 'No subscribers yet.'}
          columns={[
            {
              key: 'name',
              header: 'Subscriber',
              cell: (s) => (
                <div className="min-w-0">
                  <Link
                    href={`/admin/subscribers/${s.id}`}
                    className="font-medium hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {s.name}
                  </Link>
                  <div className="text-xs text-muted-foreground">#{s.customerNo}</div>
                </div>
              ),
            },
            {
              key: 'username',
              header: 'Username',
              cell: (s) => <span className="font-mono text-xs">{s.username}</span>,
            },
            { key: 'phone', header: 'Phone', cell: (s) => s.phone, hideOnMobile: true },
            {
              key: 'plan',
              header: 'Plan',
              cell: (s) => (s.planId ? (byId.get(s.planId)?.name ?? '…') : '—'),
            },
            {
              key: 'state',
              header: 'Status',
              cell: (s) => (
                <span className="flex flex-wrap justify-end gap-1 sm:justify-start">
                  <SubscriberState s={s} />
                  <SyncState s={s} />
                </span>
              ),
            },
            { key: 'expires', header: 'Expires', cell: (s) => fmtDate(s.expiresAt) },
          ]}
        />
      )}
    </>
  );
}

export default function SubscribersPage() {
  return (
    <Suspense>
      <SubscribersList />
    </Suspense>
  );
}
