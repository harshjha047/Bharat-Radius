'use client';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Plus, Search, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { SubscriberState, SyncState } from '@/components/status';
import { Tag } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { Select } from '@/components/ui/input';
import { ErrorState, PageHeader } from '@/components/ui/misc';
import { useDebounced } from '@/hooks/use-debounced';
import { api, unwrap } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { usePlans, type Subscriber } from '@/lib/queries';
import { cn, daysUntil, fmtDate } from '@/lib/utils';

type Status = 'active' | 'suspended' | 'disabled' | 'expired';
type Expiry = 'today' | 'tomorrow' | '7d' | 'expired-month';
const EXPIRY: [Expiry, string][] = [
  ['today', 'Expiring today'],
  ['tomorrow', 'Expiring tomorrow'],
  ['7d', 'Expiring in 7 days'],
  ['expired-month', 'Expired this month'],
];
const isExpiry = (v: string | null): v is Expiry => EXPIRY.some(([k]) => k === v);
const CHIPS: [Status | '', string][] = [
  ['', 'All'],
  ['active', 'Active'],
  ['expired', 'Expired'],
  ['suspended', 'Suspended'],
  ['disabled', 'Disabled'],
];

function Expiry({ s }: { s: Subscriber }) {
  const days = daysUntil(s.expiresAt);
  if (days === null) return <span className="text-muted-foreground">—</span>;
  return (
    <span
      className={cn(
        'whitespace-nowrap tabular-nums',
        days <= 0
          ? 'font-bold text-danger-text'
          : days <= 3
            ? 'font-bold text-warning-text'
            : 'text-foreground',
      )}
    >
      {fmtDate(s.expiresAt)}
    </span>
  );
}

const expiredRow = (s: Subscriber) => {
  const days = daysUntil(s.expiresAt);
  return s.status === 'active' && days !== null && days <= 0
    ? 'bg-danger-bg/50 hover:bg-danger-bg'
    : undefined;
};

function SubscribersList() {
  const router = useRouter();
  const params = useSearchParams();
  const can = useCan();
  const { plans, byId } = usePlans();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [status, setStatus] = useState<Status | ''>((params.get('status') as Status | null) ?? '');
  const [planId, setPlanId] = useState(params.get('plan') ?? '');
  const [expiry, setExpiryRaw] = useState<Expiry | ''>(
    isExpiry(params.get('expiry')) ? (params.get('expiry') as Expiry) : '',
  );
  // An expiry window already means "active, by validity", so it and the status chips exclude each other.
  const setExpiry = (v: Expiry | '') => {
    setExpiryRaw(v);
    if (v) setStatus('');
  };
  const pickStatus = (v: Status | '') => {
    setStatus(v);
    if (v) setExpiryRaw('');
  };
  // Set by dashboard cards (KYC not verified, static IP); shown as a removable chip.
  const [kyc, setKyc] = useState(params.get('kyc') === 'unverified' ? 'unverified' : '');
  const [staticIp, setStaticIp] = useState(params.get('staticIp') === 'yes' ? 'yes' : '');
  const dq = useDebounced(q.trim(), 300);

  // Keep filters in the URL so Back and shared links return to the same list.
  useEffect(() => {
    const s = new URLSearchParams();
    if (dq) s.set('q', dq);
    if (status) s.set('status', status);
    if (planId) s.set('plan', planId);
    if (expiry) s.set('expiry', expiry);
    if (kyc) s.set('kyc', kyc);
    if (staticIp) s.set('staticIp', staticIp);
    const next = s.toString();
    if (next !== params.toString())
      router.replace(`/admin/subscribers${next ? `?${next}` : ''}`, { scroll: false });
  }, [dq, status, planId, expiry, kyc, staticIp, params, router]);

  const list = useInfiniteQuery({
    queryKey: ['subscribers', { q: dq, status, planId, expiry, kyc, staticIp }],
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
              ...(expiry ? { expiry } : {}),
              ...(kyc ? { kyc: 'unverified' as const } : {}),
              ...(staticIp ? { staticIp: 'yes' as const } : {}),
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
      <div
        role="group"
        aria-label="Status"
        className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0"
      >
        {CHIPS.map(([v, label]) => (
          <button
            key={v}
            type="button"
            aria-pressed={status === v && !expiry}
            onClick={() => pickStatus(v)}
            className={cn(
              'h-9 shrink-0 rounded-full border border-input bg-card px-3.5 text-[13px] font-semibold text-foreground hover:bg-subtle',
              status === v && !expiry && 'border-primary bg-primary text-primary-foreground hover:bg-primary',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3.5">
          <label className="flex h-10 flex-[1_1_260px] items-center gap-2 rounded-xl border border-input px-3 focus-within:border-primary">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:shadow-none"
              placeholder="Name, C-number, username, phone"
              aria-label="Search subscribers"
              maxLength={64}
            />
          </label>
          <Select
            value={planId}
            onChange={(e) => setPlanId(e.target.value)}
            aria-label="Plan"
            className={cn('min-w-44 sm:w-auto', planId && 'border-accent-border bg-accent font-semibold')}
          >
            <option value="">Plan: Any</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <Select
            value={expiry}
            onChange={(e) => setExpiry(e.target.value as Expiry | '')}
            aria-label="Expiry"
            className={cn('min-w-44 sm:w-auto', expiry && 'border-accent-border bg-accent font-semibold')}
          >
            <option value="">Expiry: Any</option>
            {EXPIRY.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
          {[
            kyc && { label: 'KYC not verified', clear: () => setKyc('') },
            staticIp && { label: 'Has a static IP', clear: () => setStaticIp('') },
          ]
            .filter((c): c is { label: string; clear: () => void } => !!c)
            .map((c) => (
              <Button
                key={c.label}
                variant="outline"
                onClick={c.clear}
                aria-label={`Remove filter: ${c.label}`}
              >
                {c.label} <X />
              </Button>
            ))}
          {q || status || planId || expiry || kyc || staticIp ? (
            <Button
              variant="ghost"
              onClick={() => {
                setQ('');
                setStatus('');
                setPlanId('');
                setExpiryRaw('');
                setKyc('');
                setStaticIp('');
              }}
            >
              Clear
            </Button>
          ) : null}
        </div>
        {list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <DataTable
            bare
            caption="Subscribers"
            loading={list.isLoading}
            rows={rows}
            rowKey={(s) => s.id}
            onRowClick={(s) => router.push(`/admin/subscribers/${s.id}`)}
            rowClassName={expiredRow}
            hasMore={list.hasNextPage}
            loadingMore={list.isFetchingNextPage}
            onLoadMore={() => void list.fetchNextPage()}
            empty={
              dq || status || planId || expiry
                ? 'No subscriber matches these filters.'
                : 'No subscribers yet.'
            }
            columns={[
              {
                key: 'name',
                header: 'Subscriber',
                cell: (s) => (
                  <div className="flex min-w-0 flex-col">
                    <Link
                      href={`/admin/subscribers/${s.id}`}
                      className="font-semibold text-foreground hover:text-primary"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {s.name}
                    </Link>
                    <span className="font-mono text-xs text-muted-foreground">
                      {s.customerNo} · {s.username}
                    </span>
                  </div>
                ),
              },
              {
                key: 'plan',
                header: 'Plan',
                cell: (s) => (
                  <span className="whitespace-nowrap">
                    {s.planId ? (byId.get(s.planId)?.name ?? '…') : '—'}
                  </span>
                ),
              },
              ...(can('resellers.read')
                ? [
                    {
                      key: 'reseller',
                      header: 'Reseller',
                      cell: (s: Subscriber) => (
                        <Tag mono title={s.reseller?.name}>
                          {s.reseller ? (s.reseller.code ?? s.reseller.name) : 'Direct'}
                        </Tag>
                      ),
                      hideOnMobile: true,
                    },
                  ]
                : []),
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
              { key: 'expires', header: 'Valid until', cell: (s) => <Expiry s={s} /> },
              {
                key: 'phone',
                header: 'Phone',
                cell: (s) => <span className="whitespace-nowrap tabular-nums">{s.phone}</span>,
                hideOnMobile: true,
              },
            ]}
          />
        )}
      </Card>
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
