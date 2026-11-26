'use client';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Ban,
  ChevronRight,
  LogIn,
  MoreHorizontal,
  MoveRight,
  Pencil,
  PlayCircle,
  Plus,
  Trash2,
  UserPlus,
} from 'lucide-react';
import Link from 'next/link';
import { enterViewAs } from '@/lib/view-as';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from '@/lib/toast';
import { AuditChanges, actionLabel } from '@/components/audit-changes';
import { ResellerBranding } from '@/components/branding';
import { ResellerLogins, ResellerRates, ResellerWallet } from '@/components/reseller-billing';
import { ResellerForm } from '@/components/reseller-form';
import { ResellerPicker, type ResellerRef } from '@/components/reseller-picker';
import { PageSkeleton } from '@/components/shell';
import { ResellerState, SubscriberState } from '@/components/status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { Dialog, DialogContent, dialogActions } from '@/components/ui/dialog';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/dropdown';
import { Checkbox, Input } from '@/components/ui/input';
import { ConfirmDialog, ErrorState, Field, KeyValue, PageHeader, Stat } from '@/components/ui/misc';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, unwrap } from '@/lib/api';
import { useCan, useMe } from '@/lib/auth';
import type { ResellerDetail, Subscriber } from '@/lib/queries';
import { fmtDate, fmtDateTime, fmtNum, fmtRupees, relTime } from '@/lib/utils';

type Action = 'edit' | 'add' | 'suspend' | 'activate' | 'move' | 'delete' | null;

export default function ResellerPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const r = useQuery({
    queryKey: ['reseller', id],
    queryFn: () => unwrap(api.GET('/api/v1/resellers/{id}', { params: { path: { id } } })),
  });
  if (r.isLoading) return <PageSkeleton />;
  if (r.isError) return <ErrorState error={r.error} onRetry={() => void r.refetch()} />;
  const d = r.data!;

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {d.name} <ResellerState r={d} />
          </span>
        }
        description={
          <nav aria-label="Reseller path" className="flex flex-wrap items-center gap-1">
            <Link href="/admin/resellers" className="hover:underline">
              Resellers
            </Link>
            {d.path.map((x) => (
              <span key={x.id} className="flex items-center gap-1">
                <ChevronRight className="size-3" aria-hidden />
                <Link href={`/admin/resellers/${x.id}`} className="hover:underline">
                  {x.name}
                </Link>
              </span>
            ))}
            <ChevronRight className="size-3" aria-hidden />
            <span>
              {d.code} · level {d.level}
            </span>
          </nav>
        }
        actions={can('resellers.write') ? <Actions d={d} /> : null}
      />
      {d.blockedBy ? (
        <p
          role="status"
          className="mb-4 rounded-xl border border-[#f5d9a8] bg-warning-bg text-warning-text font-semibold px-3 py-2 text-sm"
        >
          {d.blockedBy.name} ({d.blockedBy.code}) above this reseller is suspended, so this branch cannot sign
          in or recharge.
        </p>
      ) : null}
      <div className="mb-5 grid grid-cols-3 gap-3">
        <Stat label="Sub-resellers" value={fmtNum(d.counts.subResellers)} />
        <Stat label="Own customers" value={fmtNum(d.counts.directCustomers)} />
        <Stat label="Customers in branch" value={fmtNum(d.counts.totalCustomers)} />
      </div>
      <Tabs defaultValue="children">
        <TabsList>
          <TabsTrigger value="children">Sub-resellers</TabsTrigger>
          {can('subscribers.read') ? <TabsTrigger value="customers">Customers</TabsTrigger> : null}
          {can('billing.read') ? <TabsTrigger value="wallet">Wallet</TabsTrigger> : null}
          <TabsTrigger value="rates">Prices</TabsTrigger>
          {can('users.read') ? <TabsTrigger value="logins">Sign-ins</TabsTrigger> : null}
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="branding">Branding</TabsTrigger>
          {can('audit.view') ? <TabsTrigger value="history">History</TabsTrigger> : null}
        </TabsList>
        <TabsContent value="children">
          <Children id={id} />
        </TabsContent>
        <TabsContent value="customers">
          <Customers d={d} />
        </TabsContent>
        <TabsContent value="wallet">
          <ResellerWallet walletId={d.walletId} />
        </TabsContent>
        <TabsContent value="rates">
          <ResellerRates resellerId={id} />
        </TabsContent>
        <TabsContent value="logins">
          <ResellerLogins resellerId={id} />
        </TabsContent>
        <TabsContent value="details">
          <Details d={d} />
        </TabsContent>
        <TabsContent value="branding">
          <ResellerBranding resellerId={id} />
        </TabsContent>
        <TabsContent value="history">
          <History id={id} />
        </TabsContent>
      </Tabs>
    </>
  );
}

function Actions({ d }: { d: ResellerDetail }) {
  const router = useRouter();
  const qc = useQueryClient();
  const me = useMe();
  const staff = me.data?.user.type !== 'reseller';
  const self = me.data?.user.resellerId === d.id;
  const [open, setOpen] = useState<Action>(null);
  const [reason, setReason] = useState('');
  const [target, setTarget] = useState<ResellerRef | null>(null);
  const [toTop, setToTop] = useState(false);
  const path = { params: { path: { id: d.id } } };
  const done = (msg: string) => (next?: ResellerDetail) => {
    if (next) qc.setQueryData(['reseller', d.id], next);
    void qc.invalidateQueries({ queryKey: ['resellers'] });
    void qc.invalidateQueries({ queryKey: ['reseller'] });
    setOpen(null);
    toast.success(msg);
  };

  const edit = useMutation({
    meta: { silent: true },
    mutationFn: (body: Record<string, unknown>) =>
      unwrap(api.PATCH('/api/v1/resellers/{id}', { ...path, body: body as never })),
    onSuccess: (n) => done('Saved.')(n),
  });
  const add = useMutation({
    meta: { silent: true },
    mutationFn: (body: Record<string, unknown>) =>
      unwrap(api.POST('/api/v1/resellers', { body: { ...body, parentId: d.id } as never })),
    onSuccess: (n) => {
      done(
        `${n.name} added as ${n.code}.${n.owner ? ` Owner signs in as ${n.owner.email ?? n.owner.phone}.` : ''}`,
      )();
      router.push(`/admin/resellers/${n.id}`);
    },
  });
  const suspend = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/resellers/{id}/suspend', {
          ...path,
          body: reason.trim() ? { reason: reason.trim() } : {},
        }),
      ),
    onSuccess: (n) => done('Suspended. Its branch cannot sign in or recharge; customers stay online.')(n),
  });
  const activate = useMutation({
    mutationFn: () => unwrap(api.POST('/api/v1/resellers/{id}/activate', path)),
    onSuccess: (n) => done('Active again.')(n),
  });
  const move = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/resellers/{id}/move', { ...path, body: { parentId: toTop ? null : target!.id } }),
      ),
    onSuccess: (n) => done('Moved with everything below it.')(n),
  });
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE('/api/v1/resellers/{id}', path)),
    onSuccess: () => {
      done('Deleted.')();
      router.replace(d.parentId ? `/admin/resellers/${d.parentId}` : '/admin/resellers');
    },
  });

  if (self) return null;
  const empty = !d.counts.subResellers && !d.counts.directCustomers;
  const open_ = d.status === 'active' && !d.blockedBy;
  return (
    <>
      {!self ? (
        <Button
          onClick={() => {
            enterViewAs({ id: d.id, code: d.code, name: d.name });
            qc.clear();
            router.push('/admin');
          }}
        >
          <LogIn /> Open panel
        </Button>
      ) : null}
      <Button variant="outline" onClick={() => setOpen('edit')}>
        <Pencil /> Edit
      </Button>
      {open_ && d.canCreateSubResellers ? (
        <Button variant="outline" onClick={() => setOpen('add')}>
          <Plus /> Sub-reseller
        </Button>
      ) : null}
      {open_ ? (
        <Button variant="outline" asChild>
          <Link href={`/admin/subscribers/new?reseller=${d.id}`}>
            <UserPlus /> Customer
          </Link>
        </Button>
      ) : null}
      <Menu>
        <MenuTrigger asChild>
          <Button variant="outline" size="icon" aria-label="More actions">
            <MoreHorizontal />
          </Button>
        </MenuTrigger>
        <MenuContent>
          <MenuItem onSelect={() => setOpen('move')}>
            <MoveRight /> Move
          </MenuItem>
          {d.status === 'active' ? (
            <MenuItem onSelect={() => setOpen('suspend')}>
              <Ban /> Suspend
            </MenuItem>
          ) : (
            <MenuItem onSelect={() => setOpen('activate')}>
              <PlayCircle /> Activate
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem destructive disabled={!empty} onSelect={() => setOpen('delete')}>
            <Trash2 /> Delete{empty ? '' : ' (empty it first)'}
          </MenuItem>
        </MenuContent>
      </Menu>

      <Dialog open={open === 'edit' || open === 'add'} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent wide title={open === 'add' ? `Add a sub-reseller under ${d.name}` : `Edit ${d.name}`}>
          {open === 'edit' ? (
            <ResellerForm
              reseller={d}
              staff={staff}
              submitting={edit.isPending}
              onSubmit={(b) => edit.mutateAsync(b)}
              onCancel={() => setOpen(null)}
            />
          ) : open === 'add' ? (
            <ResellerForm
              staff={staff}
              submitting={add.isPending}
              onSubmit={(b) => add.mutateAsync(b)}
              onCancel={() => setOpen(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={open === 'suspend'}
        onOpenChange={(o) => setOpen(o ? 'suspend' : null)}
        title={`Suspend ${d.name}?`}
        description="It and every reseller below it cannot sign in or recharge until activated. Customers stay online."
        confirmLabel="Suspend"
        destructive
        loading={suspend.isPending}
        onConfirm={() => suspend.mutate()}
      >
        <Field label="Reason (optional)" htmlFor="r-reason">
          <Input id="r-reason" maxLength={60} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </ConfirmDialog>
      <ConfirmDialog
        open={open === 'activate'}
        onOpenChange={(o) => setOpen(o ? 'activate' : null)}
        title={`Activate ${d.name}?`}
        confirmLabel="Activate"
        loading={activate.isPending}
        onConfirm={() => activate.mutate()}
      />
      <ConfirmDialog
        open={open === 'delete'}
        onOpenChange={(o) => setOpen(o ? 'delete' : null)}
        title={`Delete ${d.name}?`}
        description="Its sign-ins are disabled. History is kept."
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
      <Dialog open={open === 'move'} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent
          title={`Move ${d.name}`}
          description={`Moves it with its ${fmtNum(d.counts.subResellers)} sub-reseller(s) and ${fmtNum(d.counts.totalCustomers)} customer(s).`}
        >
          <div className="space-y-3">
            <Field label="New parent" htmlFor="r-move">
              {toTop ? (
                <p className="text-sm text-muted-foreground">Directly under the ISP</p>
              ) : (
                <ResellerPicker
                  id="r-move"
                  value={target}
                  onChange={setTarget}
                  exclude={d.id}
                  noneLabel="Choose"
                />
              )}
            </Field>
            {staff ? (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={toTop} onChange={(e) => setToTop(e.target.checked)} /> Move to the top
                level
              </label>
            ) : null}
          </div>
          <div className={dialogActions}>
            <Button variant="outline" onClick={() => setOpen(null)}>
              Cancel
            </Button>
            <Button loading={move.isPending} disabled={!toTop && !target} onClick={() => move.mutate()}>
              Move
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Children({ id }: { id: string }) {
  const router = useRouter();
  const q = useInfiniteQuery({
    queryKey: ['resellers', { parent: id, q: '' }],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/v1/resellers', {
          params: { query: { parentId: id, limit: 50, ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <DataTable
      caption="Sub-resellers"
      loading={q.isLoading}
      rows={q.data?.pages.flatMap((p) => p.items)}
      rowKey={(r) => r.id}
      onRowClick={(r) => router.push(`/admin/resellers/${r.id}`)}
      hasMore={q.hasNextPage}
      loadingMore={q.isFetchingNextPage}
      onLoadMore={() => void q.fetchNextPage()}
      empty="No sub-resellers."
      columns={[
        {
          key: 'name',
          header: 'Reseller',
          cell: (r) => (
            <div>
              <span className="font-medium">{r.name}</span>
              <div className="text-xs text-muted-foreground">{r.code}</div>
            </div>
          ),
        },
        { key: 'owner', header: 'Owner', cell: (r) => r.ownerName, hideOnMobile: true },
        { key: 'subs', header: 'Sub-resellers', cell: (r) => fmtNum(r.counts.subResellers) },
        { key: 'customers', header: 'Customers', cell: (r) => fmtNum(r.counts.totalCustomers) },
        { key: 'status', header: 'Status', cell: (r) => <ResellerState r={r} /> },
      ]}
    />
  );
}

function Customers({ d }: { d: ResellerDetail }) {
  const router = useRouter();
  const [branch, setBranch] = useState(false);
  const q = useInfiniteQuery({
    queryKey: ['subscribers', { reseller: d.id, branch }],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/v1/subscribers', {
          params: {
            query: {
              limit: 50,
              ...(branch ? { under: d.id } : { resellerId: d.id }),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    placeholderData: (prev) => prev,
  });
  return (
    <div className="space-y-3">
      {d.counts.subResellers ? (
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox checked={branch} onChange={(e) => setBranch(e.target.checked)} /> Include customers of
          sub-resellers
        </label>
      ) : null}
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <DataTable
          caption="Customers"
          loading={q.isLoading}
          rows={q.data?.pages.flatMap((p) => p.items)}
          rowKey={(s) => s.id}
          onRowClick={(s) => router.push(`/admin/subscribers/${s.id}`)}
          hasMore={q.hasNextPage}
          loadingMore={q.isFetchingNextPage}
          onLoadMore={() => void q.fetchNextPage()}
          empty="No customers."
          columns={[
            {
              key: 'name',
              header: 'Subscriber',
              cell: (s) => (
                <div>
                  <span className="font-medium">{s.name}</span>
                  <div className="text-xs text-muted-foreground">#{s.customerNo}</div>
                </div>
              ),
            },
            {
              key: 'username',
              header: 'Username',
              cell: (s) => <span className="font-mono text-xs">{s.username}</span>,
            },
            ...(branch
              ? [{ key: 'reseller', header: 'Reseller', cell: (s: Subscriber) => s.reseller?.name ?? '—' }]
              : []),
            { key: 'state', header: 'Status', cell: (s) => <SubscriberState s={s} /> },
            { key: 'expires', header: 'Expires', cell: (s) => fmtDate(s.expiresAt) },
          ]}
        />
      )}
    </div>
  );
}

function Details({ d }: { d: ResellerDetail }) {
  const a = d.address;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Account</CardTitle>
      </CardHeader>
      <CardContent>
        <KeyValue
          items={[
            ['Owner', d.ownerName],
            [
              'Mobile',
              d.phone ? (
                <a href={`tel:${d.phone}`} className="text-primary hover:underline">
                  {d.phone}
                </a>
              ) : null,
            ],
            ['Email', d.email],
            ['GSTIN', d.gstin],
            [
              'Address',
              a ? [a.line1, a.city, a.district, a.state, a.pincode].filter(Boolean).join(', ') : null,
            ],
            [
              'Credit limit',
              d.creditLimitPaise ? fmtRupees(d.creditLimitPaise) : 'None (wallet cannot go below zero)',
            ],
            ['Sub-resellers', d.canCreateSubResellers ? 'May add its own' : <Badge>Not allowed</Badge>],
            ['Suspended because', d.status === 'suspended' ? (d.suspendReason ?? '—') : null],
            ['Updated', fmtDateTime(d.updatedAt)],
          ]}
        />
      </CardContent>
    </Card>
  );
}

function History({ id }: { id: string }) {
  const q = useInfiniteQuery({
    queryKey: ['audit', { entityId: id }],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/v1/audit', {
          params: {
            query: {
              entityType: 'reseller',
              entityId: id,
              limit: 50,
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <DataTable
      caption="Change history"
      loading={q.isLoading}
      rows={q.data?.pages.flatMap((p) => p.items)}
      rowKey={(r) => r.id}
      hasMore={q.hasNextPage}
      loadingMore={q.isFetchingNextPage}
      onLoadMore={() => void q.fetchNextPage()}
      empty="No changes recorded."
      columns={[
        { key: 'at', header: 'When', cell: (r) => <span title={fmtDateTime(r.at)}>{relTime(r.at)}</span> },
        { key: 'who', header: 'Who', cell: (r) => r.actor.name },
        { key: 'what', header: 'What', cell: (r) => actionLabel(r.action) },
        {
          key: 'changes',
          header: 'Changes',
          cell: (r) => <AuditChanges before={r.before} after={r.after} />,
        },
      ]}
    />
  );
}
