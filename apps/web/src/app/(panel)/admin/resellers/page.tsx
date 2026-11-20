'use client';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { toast } from '@/lib/toast';
import { ResellerForm } from '@/components/reseller-form';
import { ResellerState } from '@/components/status';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ErrorState, PageHeader } from '@/components/ui/misc';
import { useDebounced } from '@/hooks/use-debounced';
import { api, unwrap } from '@/lib/api';
import { useCan, useMe } from '@/lib/auth';
import { fmtNum, plural } from '@/lib/utils';

function ResellersList() {
  const router = useRouter();
  const params = useSearchParams();
  const can = useCan();
  const me = useMe();
  const qc = useQueryClient();
  const staff = me.data?.user.type !== 'reseller';
  // A reseller's own account is the root of what it can see.
  const parent = params.get('parent') ?? (staff ? null : (me.data?.user.resellerId ?? null));
  const [q, setQ] = useState(params.get('q') ?? '');
  const [adding, setAdding] = useState(false);
  const dq = useDebounced(q.trim(), 300);

  useEffect(() => {
    const s = new URLSearchParams();
    if (params.get('parent')) s.set('parent', params.get('parent')!);
    if (dq) s.set('q', dq);
    const next = s.toString();
    if (next !== params.toString())
      router.replace(`/admin/resellers${next ? `?${next}` : ''}`, { scroll: false });
  }, [dq, params, router]);

  const parentQ = useQuery({
    queryKey: ['reseller', parent],
    queryFn: () => unwrap(api.GET('/api/v1/resellers/{id}', { params: { path: { id: parent! } } })),
    enabled: !!parent,
  });
  const list = useInfiniteQuery({
    queryKey: ['resellers', { parent, q: dq }],
    initialPageParam: undefined as string | undefined,
    enabled: staff || !!parent,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/v1/resellers', {
          params: {
            query: {
              limit: 50,
              // Searching looks through every reseller in view, not just one level.
              ...(dq ? { q: dq } : { parentId: parent ?? 'none' }),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    placeholderData: (prev) => prev,
  });
  const create = useMutation({
    meta: { silent: true },
    mutationFn: (body: Record<string, unknown>) =>
      unwrap(
        api.POST('/api/v1/resellers', {
          body: { ...body, ...(parent ? { parentId: parent } : {}) } as never,
        }),
      ),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['resellers'] });
      if (parent) void qc.invalidateQueries({ queryKey: ['reseller', parent] });
      setAdding(false);
      toast.success(`${r.name} added as ${r.code}.`);
    },
  });

  const p = parentQ.data;
  const canAdd = can('resellers.write') && (!p || (p.status === 'active' && !p.blockedBy));
  const rows = list.data?.pages.flatMap((x) => x.items);
  return (
    <>
      <PageHeader
        title={p ? p.name : 'Resellers'}
        description={
          <nav aria-label="Reseller path" className="flex flex-wrap items-center gap-1">
            {staff ? (
              <Link href="/admin/resellers" className="hover:underline">
                All resellers
              </Link>
            ) : null}
            {p
              ? [...p.path, { id: p.id, code: p.code, name: p.name }].map((x, i, all) => (
                  <span key={x.id} className="flex items-center gap-1">
                    {staff || i > 0 ? <ChevronRight className="size-3" aria-hidden /> : null}
                    {i === all.length - 1 ? (
                      <Link href={`/admin/resellers/${x.id}`} className="hover:underline">
                        {x.code} details
                      </Link>
                    ) : (
                      <Link href={`/admin/resellers?parent=${x.id}`} className="hover:underline">
                        {x.name}
                      </Link>
                    )}
                  </span>
                ))
              : null}
          </nav>
        }
        actions={
          canAdd ? (
            <Button onClick={() => setAdding(true)}>
              <Plus /> {p ? 'Add sub-reseller' : 'New reseller'}
            </Button>
          ) : null
        }
      />
      <div className="relative mb-4">
        <Search
          className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="pl-9"
          placeholder="Code, business or owner name"
          aria-label="Search resellers"
          maxLength={64}
        />
      </div>
      {list.isError || parentQ.isError ? (
        <ErrorState
          error={list.error ?? parentQ.error}
          onRetry={() => void Promise.all([list.refetch(), parentQ.refetch()])}
        />
      ) : (
        <DataTable
          caption="Resellers"
          loading={list.isLoading || (!staff && me.isLoading)}
          rows={rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => router.push(`/admin/resellers/${r.id}`)}
          hasMore={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
          empty={dq ? 'No reseller matches.' : p ? 'No sub-resellers yet.' : 'No resellers yet.'}
          columns={[
            {
              key: 'name',
              header: 'Reseller',
              cell: (r) => (
                <div className="min-w-0">
                  <Link
                    href={`/admin/resellers/${r.id}`}
                    className="font-medium hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {r.name}
                  </Link>
                  <div className="text-xs text-muted-foreground">
                    {r.code}
                    {dq && r.level > 1 ? ` · level ${r.level}` : ''}
                  </div>
                </div>
              ),
            },
            { key: 'owner', header: 'Owner', cell: (r) => r.ownerName, hideOnMobile: true },
            { key: 'phone', header: 'Phone', cell: (r) => r.phone ?? '—', hideOnMobile: true },
            {
              key: 'subs',
              header: 'Sub-resellers',
              cell: (r) =>
                r.counts.subResellers ? (
                  <Link
                    href={`/admin/resellers?parent=${r.id}`}
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                    aria-label={`${plural(r.counts.subResellers, 'sub-reseller')} of ${r.name}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {fmtNum(r.counts.subResellers)} <ChevronRight className="size-3.5" aria-hidden />
                  </Link>
                ) : (
                  '—'
                ),
            },
            {
              key: 'customers',
              header: 'Customers',
              cell: (r) => (
                <span title={`${fmtNum(r.counts.directCustomers)} own, the rest below it`}>
                  {fmtNum(r.counts.totalCustomers)}
                </span>
              ),
            },
            { key: 'status', header: 'Status', cell: (r) => <ResellerState r={r} /> },
          ]}
        />
      )}
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent wide title={p ? `Add a sub-reseller under ${p.name}` : 'New reseller'}>
          {adding ? (
            <ResellerForm
              staff={staff}
              submitting={create.isPending}
              onSubmit={(b) => create.mutateAsync(b)}
              onCancel={() => setAdding(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function ResellersPage() {
  return (
    <Suspense>
      <ResellersList />
    </Suspense>
  );
}
