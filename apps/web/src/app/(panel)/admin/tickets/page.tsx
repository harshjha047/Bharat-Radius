'use client';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState, type FormEvent } from 'react';
import { CATEGORY_LABEL, PriorityBadge, TicketStatusBadge, type Ticket } from '@/components/tickets';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { Dialog, DialogContent, dialogActions } from '@/components/ui/dialog';
import { Input, Select, Textarea } from '@/components/ui/input';
import { ErrorState, Field, PageHeader } from '@/components/ui/misc';
import { useDebounced } from '@/hooks/use-debounced';
import { api, fieldErrors, unwrap } from '@/lib/api';
import { useCan, useMe } from '@/lib/auth';
import { cn, relTime } from '@/lib/utils';

type View = 'active' | 'mine' | 'unassigned' | 'resolved' | 'closed' | 'all';

const VIEWS: [View, string][] = [
  ['active', 'Active'],
  ['mine', 'Assigned to me'],
  ['unassigned', 'Unassigned'],
  ['resolved', 'Resolved'],
  ['closed', 'Closed'],
  ['all', 'All'],
];

function TicketsList() {
  const router = useRouter();
  const params = useSearchParams();
  const can = useCan();
  const subscriberId = params.get('subscriber') ?? undefined;
  const [view, setView] = useState<View>(subscriberId ? 'all' : 'active');
  const [category, setCategory] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 300);
  const [creating, setCreating] = useState(params.get('new') === '1');

  const query = useMemo(() => {
    const o: Record<string, string> = {};
    if (view === 'active' || view === 'mine' || view === 'unassigned') o.status = 'active';
    if (view === 'resolved' || view === 'closed') o.status = view;
    if (view === 'mine') o.assignee = 'me';
    if (view === 'unassigned') o.assignee = 'none';
    if (category) o.category = category;
    if (subscriberId) o.subscriberId = subscriberId;
    if (/^T?\d{1,8}$/i.test(dq)) o.q = dq;
    return o;
  }, [view, category, subscriberId, dq]);

  const counts = useQuery({
    queryKey: ['tickets', 'counts'],
    queryFn: () => unwrap(api.GET('/api/v1/tickets/counts')),
    refetchInterval: 60_000,
  });
  const list = useInfiniteQuery({
    queryKey: ['tickets', query],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/v1/tickets', {
          params: { query: { ...query, limit: 50, ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    refetchInterval: 60_000,
  });

  const c = counts.data;
  const badge = (v: View) =>
    !c
      ? ''
      : v === 'active'
        ? c.open + c.in_progress + c.waiting_customer
        : v === 'mine'
          ? c.mine
          : v === 'unassigned'
            ? c.unassigned
            : v === 'resolved'
              ? c.resolved
              : '';

  return (
    <>
      <PageHeader
        title="Tickets"
        description={subscriberId ? 'Tickets for one customer.' : 'Customer issues and their status.'}
        actions={
          can('tickets.write') ? (
            <Button onClick={() => setCreating(true)}>
              <Plus /> New ticket
            </Button>
          ) : null
        }
      />
      <Card className="overflow-hidden">
        <div className="flex flex-col gap-2.5 border-b p-3 lg:flex-row lg:items-center">
          <div
            role="tablist"
            aria-label="Ticket views"
            className="flex gap-0.5 overflow-x-auto rounded-xl bg-muted p-1 lg:mr-auto"
          >
            {VIEWS.map(([v, label]) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                onClick={() => setView(v)}
                className={cn(
                  'h-8 shrink-0 rounded-[9px] px-3 text-[13px] font-medium whitespace-nowrap text-body',
                  view === v && 'bg-card font-bold text-foreground shadow-[0_1px_2px_rgba(36,23,42,0.08)]',
                )}
              >
                {label}
                {badge(v) !== '' ? <span className="ml-1 tabular-nums opacity-80">{badge(v)}</span> : null}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <label className="flex h-10 flex-[1_1_180px] items-center gap-2 rounded-xl border border-input bg-card px-3 focus-within:border-primary lg:w-52 lg:flex-none">
              <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <input
                type="search"
                aria-label="Ticket number"
                placeholder="T000123"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:shadow-none"
              />
            </label>
            <Select
              aria-label="Category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-48 max-sm:flex-1"
            >
              <option value="">All categories</option>
              {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </div>
        </div>
        {list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <DataTable
            bare
            caption="Tickets"
            rows={list.data?.pages.flatMap((p) => p.items)}
            loading={list.isLoading}
            rowKey={(t) => t.id}
            onRowClick={(t) => router.push(`/admin/tickets/${t.id}`)}
            hasMore={list.hasNextPage}
            loadingMore={list.isFetchingNextPage}
            onLoadMore={() => void list.fetchNextPage()}
            empty="No tickets here."
            columns={[
              {
                key: 'subject',
                header: 'Ticket',
                cell: (t) => (
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground">{t.number}</span>
                      <PriorityBadge priority={t.priority} />
                    </span>
                    <span className="truncate font-bold text-foreground">{t.subject}</span>
                    <span className="text-xs text-muted-foreground">{CATEGORY_LABEL[t.category]}</span>
                  </span>
                ),
              },
              {
                key: 'customer',
                header: 'Customer',
                cell: (t) =>
                  t.subscriber ? (
                    <span className="flex flex-col">
                      <span className="font-semibold">{t.subscriber.name}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {t.subscriber.customerNo}
                      </span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Internal</span>
                  ),
              },
              { key: 'status', header: 'Status', cell: (t) => <TicketStatusBadge status={t.status} /> },
              {
                key: 'assignee',
                header: 'Assigned',
                cell: (t) => t.assignee?.name ?? <span className="text-muted-foreground">—</span>,
                hideOnMobile: true,
              },
              { key: 'activity', header: 'Last activity', cell: (t) => relTime(t.lastActivityAt) },
            ]}
          />
        )}
      </Card>
      {creating ? (
        <NewTicketDialog
          subscriberId={subscriberId}
          onClose={() => setCreating(false)}
          onCreated={(t) => router.push(`/admin/tickets/${t.id}`)}
        />
      ) : null}
    </>
  );
}

function NewTicketDialog({
  subscriberId,
  onClose,
  onCreated,
}: {
  subscriberId?: string;
  onClose: () => void;
  onCreated: (t: Ticket) => void;
}) {
  const qc = useQueryClient();
  const me = useMe();
  const reseller = !!me.data?.user.resellerId;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [who, setWho] = useState('');
  const dwho = useDebounced(who.trim(), 300);
  const [picked, setPicked] = useState<{ id: string; label: string } | null>(null);
  const sub = useQuery({
    queryKey: ['subscriber', subscriberId],
    queryFn: () => unwrap(api.GET('/api/v1/subscribers/{id}', { params: { path: { id: subscriberId! } } })),
    enabled: !!subscriberId,
  });
  const search = useQuery({
    queryKey: ['subscribers', { q: dwho, limit: 8 }],
    queryFn: () => unwrap(api.GET('/api/v1/subscribers', { params: { query: { q: dwho, limit: 8 } } })),
    enabled: !subscriberId && !picked && dwho.length >= 2,
  });
  const target = subscriberId
    ? sub.data
      ? { id: sub.data.id, label: `${sub.data.name} · ${sub.data.customerNo}` }
      : null
    : picked;

  const create = useMutation({
    meta: { silent: true },
    mutationFn: (b: {
      subscriberId?: string;
      subject: string;
      category: string;
      priority: string;
      body: string;
    }) => unwrap(api.POST('/api/v1/tickets', { body: b as never })),
    onSuccess: (t) => {
      void qc.invalidateQueries({ queryKey: ['tickets'] });
      onCreated(t);
    },
    onError: (e) => setErrors({ body: e instanceof Error ? e.message : 'Failed', ...fieldErrors(e) }),
  });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setErrors({});
    create.mutate({
      ...(target ? { subscriberId: target.id } : {}),
      subject: String(f.get('subject')),
      category: String(f.get('category')),
      priority: String(f.get('priority')),
      body: String(f.get('body')),
    });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="New ticket" wide>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field
            label="Customer"
            htmlFor="who"
            error={errors.subscriberId}
            hint={reseller ? undefined : 'Leave empty for an internal ticket.'}
          >
            {target ? (
              <div className="flex h-9 items-center justify-between rounded-xl border bg-subtle px-3 text-sm">
                {target.label}
                {!subscriberId ? (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setPicked(null)}>
                    Change
                  </Button>
                ) : null}
              </div>
            ) : (
              <div className="relative">
                <Input
                  id="who"
                  type="search"
                  placeholder="Name, username, phone or customer no."
                  value={who}
                  onChange={(e) => setWho(e.target.value)}
                />
                {search.data?.items.length ? (
                  <ul className="absolute z-50 mt-1 w-full rounded-xl border bg-card p-1 shadow-[0_6px_16px_rgba(36,23,42,0.10)]">
                    {search.data.items.map((s) => (
                      <li key={s.id}>
                        <button
                          type="button"
                          className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-subtle"
                          onClick={() => setPicked({ id: s.id, label: `${s.name} · ${s.customerNo}` })}
                        >
                          {s.name} <span className="text-muted-foreground">· {s.customerNo}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )}
          </Field>
          <Field label="Subject" htmlFor="subject" error={errors.subject}>
            <Input id="subject" name="subject" required maxLength={160} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Category" htmlFor="category">
              <Select id="category" name="category" defaultValue="no_internet">
                {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Priority" htmlFor="priority">
              <Select id="priority" name="priority" defaultValue="normal">
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </Select>
            </Field>
          </div>
          <Field label="Details" htmlFor="body" error={errors.body}>
            <Textarea id="body" name="body" rows={4} required maxLength={4000} />
          </Field>
          <div className={dialogActions}>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Open ticket
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function TicketsPage() {
  return (
    <Suspense>
      <TicketsList />
    </Suspense>
  );
}
