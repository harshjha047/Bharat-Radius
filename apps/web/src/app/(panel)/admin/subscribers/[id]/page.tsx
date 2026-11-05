'use client';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Eye, MoreHorizontal, Pencil, PlayCircle, Trash2, Unplug } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { actionLabel, AuditChanges } from '@/components/audit-changes';
import { PageSkeleton } from '@/components/shell';
import { SubscriberState, SyncState } from '@/components/status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/dropdown';
import { Input } from '@/components/ui/input';
import {
  ConfirmDialog,
  ErrorState,
  Field,
  KeyValue,
  PageHeader,
  SecretBox,
  Stat,
} from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, unwrap } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { usePlans, type Subscriber } from '@/lib/queries';
import { fmtBytes, fmtDate, fmtDateTime, fmtDuration, fmtKbps, relTime } from '@/lib/utils';

const UsageChart = dynamic(() => import('@/components/usage-chart'), {
  ssr: false,
  loading: () => <Skeleton className="h-64 w-full" />,
});

type Action = 'kick' | 'suspend' | 'activate' | 'delete' | 'reveal' | null;

export default function SubscriberPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const sub = useQuery({
    queryKey: ['subscriber', id],
    queryFn: () => unwrap(api.GET('/api/v1/subscribers/{id}', { params: { path: { id } } })),
    // A just-saved change shows "Syncing" until the worker has written it to RADIUS.
    refetchInterval: (q) => (q.state.data?.syncStatus === 'pending' ? 2000 : false),
  });
  if (sub.isLoading) return <PageSkeleton />;
  if (sub.isError) return <ErrorState error={sub.error} onRetry={() => void sub.refetch()} />;
  const s = sub.data!;

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {s.name} <SubscriberState s={s} /> <SyncState s={s} />
          </span>
        }
        description={
          <>
            #{s.customerNo} · <span className="font-mono">{s.username}</span>
          </>
        }
        actions={<Actions s={s} />}
      />
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          {can('sessions.read') ? <TabsTrigger value="sessions">Sessions</TabsTrigger> : null}
          {can('sessions.read') ? <TabsTrigger value="auth">Login log</TabsTrigger> : null}
          <TabsTrigger value="usage">Usage</TabsTrigger>
          <TabsTrigger value="coa">Router actions</TabsTrigger>
          {can('audit.view') ? <TabsTrigger value="history">History</TabsTrigger> : null}
        </TabsList>
        <TabsContent value="overview">
          <Overview s={s} />
        </TabsContent>
        <TabsContent value="sessions">
          <Sessions id={id} />
        </TabsContent>
        <TabsContent value="auth">
          <AuthLog id={id} />
        </TabsContent>
        <TabsContent value="usage">
          <Usage id={id} />
        </TabsContent>
        <TabsContent value="coa">
          <CoaLog id={id} />
        </TabsContent>
        <TabsContent value="history">
          <History id={id} />
        </TabsContent>
      </Tabs>
    </>
  );
}

function Actions({ s }: { s: Subscriber }) {
  const can = useCan();
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState<Action>(null);
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState<string | null>(null);
  const path = { params: { path: { id: s.id } } };
  const done = (msg: string) => (next?: Subscriber) => {
    if (next) qc.setQueryData(['subscriber', s.id], next);
    void qc.invalidateQueries({ queryKey: ['subscribers'] });
    setOpen(null);
    toast.success(msg);
  };

  const kick = useMutation({
    mutationFn: () => unwrap(api.POST('/api/v1/subscribers/{id}/kick', path)),
    onSuccess: () => done('Disconnect sent. The router will reconnect them.')(),
  });
  const suspend = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/subscribers/{id}/suspend', {
          ...path,
          body: reason.trim() ? { reason: reason.trim() } : {},
        }),
      ),
    onSuccess: (n) => done('Suspended and disconnected.')(n),
  });
  const activate = useMutation({
    mutationFn: () => unwrap(api.POST('/api/v1/subscribers/{id}/activate', path)),
    onSuccess: (n) => done('Activated.')(n),
  });
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE('/api/v1/subscribers/{id}', path)),
    onSuccess: () => {
      done('Deleted. The username can be reused.')();
      router.replace('/admin/subscribers');
    },
  });
  const reveal = useMutation({
    mutationFn: () => unwrap(api.GET('/api/v1/subscribers/{id}/password', path)),
    onSuccess: (r) => {
      setPassword(r.pppoePassword);
      setOpen('reveal');
    },
  });

  const write = can('subscribers.write');
  return (
    <>
      {write ? (
        <Button variant="outline" asChild>
          <Link href={`/admin/subscribers/${s.id}/edit`}>
            <Pencil /> Edit
          </Link>
        </Button>
      ) : null}
      {can('subscribers.kick') ? (
        <Button variant="outline" onClick={() => setOpen('kick')}>
          <Unplug /> Kick
        </Button>
      ) : null}
      {write || can('subscribers.password.reveal') ? (
        <Menu>
          <MenuTrigger asChild>
            <Button variant="outline" size="icon" aria-label="More actions">
              <MoreHorizontal />
            </Button>
          </MenuTrigger>
          <MenuContent>
            {can('subscribers.password.reveal') ? (
              <MenuItem onSelect={() => reveal.mutate()}>
                <Eye /> Show PPPoE password
              </MenuItem>
            ) : null}
            {write && s.status === 'active' ? (
              <MenuItem onSelect={() => setOpen('suspend')}>
                <Ban /> Suspend
              </MenuItem>
            ) : null}
            {write && s.status !== 'active' ? (
              <MenuItem onSelect={() => setOpen('activate')}>
                <PlayCircle /> Activate
              </MenuItem>
            ) : null}
            {write ? (
              <>
                <MenuSeparator />
                <MenuItem destructive onSelect={() => setOpen('delete')}>
                  <Trash2 /> Delete
                </MenuItem>
              </>
            ) : null}
          </MenuContent>
        </Menu>
      ) : null}

      <ConfirmDialog
        open={open === 'kick'}
        onOpenChange={(o) => setOpen(o ? 'kick' : null)}
        title="Kick this session?"
        description="The router drops the connection; the customer's router dials again automatically."
        confirmLabel="Kick"
        loading={kick.isPending}
        onConfirm={() => kick.mutate()}
      />
      <ConfirmDialog
        open={open === 'suspend'}
        onOpenChange={(o) => setOpen(o ? 'suspend' : null)}
        title="Suspend this subscriber?"
        description="They are disconnected now and logins are refused until you activate them."
        confirmLabel="Suspend"
        destructive
        loading={suspend.isPending}
        onConfirm={() => suspend.mutate()}
      >
        <Field label="Reason (optional)" htmlFor="reason" hint="Shown to staff and in the login log.">
          <Input id="reason" maxLength={60} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </ConfirmDialog>
      <ConfirmDialog
        open={open === 'activate'}
        onOpenChange={(o) => setOpen(o ? 'activate' : null)}
        title="Activate this subscriber?"
        description="Logins are accepted again."
        confirmLabel="Activate"
        loading={activate.isPending}
        onConfirm={() => activate.mutate()}
      />
      <ConfirmDialog
        open={open === 'delete'}
        onOpenChange={(o) => setOpen(o ? 'delete' : null)}
        title={`Delete ${s.username}?`}
        description="They are disconnected and can no longer log in. History stays; the username and static IP become free."
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
      <Dialog
        open={open === 'reveal'}
        onOpenChange={(o) => {
          if (!o) {
            setOpen(null);
            setPassword(null);
          }
        }}
      >
        <DialogContent title="PPPoE password" description="This view is recorded in the audit log.">
          {password ? <SecretBox label={s.username} value={password} /> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function Overview({ s }: { s: Subscriber }) {
  const { byId } = usePlans();
  const plan = s.planId ? byId.get(s.planId) : undefined;
  const a = s.address as Record<string, string | undefined>;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Connection</CardTitle>
        </CardHeader>
        <CardContent>
          <KeyValue
            items={
              [
                [
                  'Plan',
                  plan ? `${plan.name} · ${fmtKbps(plan.downloadKbps)}/${fmtKbps(plan.uploadKbps)}` : '—',
                ],
                ['Valid until', fmtDate(s.expiresAt)],
                ['Billing', s.billingType === 'prepaid' ? 'Prepaid' : 'Postpaid'],
                ['FUP', s.fupActive ? <Badge tone="warning">At FUP speed</Badge> : 'Normal speed'],
                [
                  'Static IP',
                  s.network.staticIp ? <span className="font-mono">{s.network.staticIp}</span> : 'Pool',
                ],
                [
                  'MAC lock',
                  s.network.macLock ? <span className="font-mono">{s.network.macLock}</span> : 'Off',
                ],
                ['Simultaneous logins', s.network.simUse ?? (plan ? `${plan.simUse} (plan)` : '—')],
                ['POP', s.network.popName],
                ['Suspended because', s.status === 'suspended' ? (s.suspendReason ?? '—') : null],
              ].filter(([, v]) => v !== null) as [string, React.ReactNode][]
            }
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Customer</CardTitle>
        </CardHeader>
        <CardContent>
          <KeyValue
            items={[
              [
                'Mobile',
                <a key="p" href={`tel:${s.phone}`} className="text-primary hover:underline">
                  {s.phone}
                </a>,
              ],
              ['Other phone', s.altPhone],
              ['Email', s.email],
              ['GSTIN', s.gstin],
              [
                'Address',
                [a.line1, a.line2, a.city, a.district, a.state, a.pincode].filter(Boolean).join(', '),
              ],
              ['KYC', s.kycStatus],
              [
                'Tags',
                s.tags.length
                  ? s.tags.map((t) => (
                      <Badge key={t} className="mr-1">
                        {t}
                      </Badge>
                    ))
                  : null,
              ],
              ['Created', fmtDateTime(s.createdAt)],
            ]}
          />
          {s.notes ? (
            <p className="mt-4 rounded-md bg-muted p-3 text-sm whitespace-pre-wrap">{s.notes}</p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function Sessions({ id }: { id: string }) {
  const q = useInfiniteQuery({
    queryKey: ['subscriber', id, 'sessions'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/v1/subscribers/{id}/sessions', {
          params: { path: { id }, query: { limit: 50, ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <DataTable
      caption="Sessions"
      loading={q.isLoading}
      rows={q.data?.pages.flatMap((p) => p.items)}
      rowKey={(r) => r.id}
      hasMore={q.hasNextPage}
      loadingMore={q.isFetchingNextPage}
      onLoadMore={() => void q.fetchNextPage()}
      empty="No sessions in the last 90 days."
      columns={[
        { key: 'start', header: 'Started', cell: (r) => fmtDateTime(r.startedAt) },
        {
          key: 'end',
          header: 'Ended',
          cell: (r) =>
            r.stoppedAt ? (
              fmtDateTime(r.stoppedAt)
            ) : r.stale ? (
              <Badge tone="warning">Not reporting</Badge>
            ) : (
              <Badge tone="success">Online</Badge>
            ),
        },
        { key: 'dur', header: 'Duration', cell: (r) => fmtDuration(r.sessionSecs) },
        {
          key: 'ip',
          header: 'IP',
          cell: (r) => <span className="font-mono text-xs">{r.framedIp ?? '—'}</span>,
        },
        {
          key: 'mac',
          header: 'MAC',
          cell: (r) => <span className="font-mono text-xs">{r.mac ?? '—'}</span>,
          hideOnMobile: true,
        },
        { key: 'nas', header: 'Router', cell: (r) => r.nasName ?? r.nasIp, hideOnMobile: true },
        {
          key: 'data',
          header: 'Down / up',
          cell: (r) => `${fmtBytes(r.downloadBytes)} / ${fmtBytes(r.uploadBytes)}`,
        },
        { key: 'cause', header: 'Ended by', cell: (r) => r.terminateCause ?? '—', hideOnMobile: true },
      ]}
    />
  );
}

function AuthLog({ id }: { id: string }) {
  const q = useInfiniteQuery({
    queryKey: ['subscriber', id, 'auth-log'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/v1/subscribers/{id}/auth-log', {
          params: { path: { id }, query: { limit: 50, ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <DataTable
      caption="Login attempts"
      loading={q.isLoading}
      rows={q.data?.pages.flatMap((p) => p.items)}
      rowKey={(r) => `${r.at}-${r.nasIp}-${r.accepted}`}
      hasMore={q.hasNextPage}
      loadingMore={q.isFetchingNextPage}
      onLoadMore={() => void q.fetchNextPage()}
      empty="No login attempts in the last 90 days."
      columns={[
        { key: 'at', header: 'When', cell: (r) => fmtDateTime(r.at) },
        {
          key: 'result',
          header: 'Result',
          cell: (r) =>
            r.accepted ? <Badge tone="success">Accepted</Badge> : <Badge tone="danger">Rejected</Badge>,
        },
        { key: 'reason', header: 'Reason', cell: (r) => r.reason ?? '—' },
        { key: 'nas', header: 'Router', cell: (r) => <span className="font-mono text-xs">{r.nasIp}</span> },
        { key: 'mac', header: 'MAC', cell: (r) => <span className="font-mono text-xs">{r.mac ?? '—'}</span> },
      ]}
    />
  );
}

function Usage({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ['subscriber', id, 'usage'],
    queryFn: () => unwrap(api.GET('/api/v1/subscribers/{id}/usage', { params: { path: { id } } })),
  });
  if (q.isLoading) return <Skeleton className="h-80 w-full" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const { days, cycle } = q.data!;
  const down = days.reduce((a, d) => a + d.downloadBytes, 0);
  const up = days.reduce((a, d) => a + d.uploadBytes, 0);
  const pct =
    cycle && cycle.capBytes ? Math.min(100, Math.round((cycle.usedBytes / cycle.capBytes) * 100)) : null;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Downloaded" value={fmtBytes(down)} hint={`${days.length} days`} />
        <Stat label="Uploaded" value={fmtBytes(up)} />
        {cycle ? (
          <div className="col-span-2 rounded-lg border bg-card p-4">
            <p className="text-xs font-medium text-muted-foreground">
              This cycle{cycle.start ? ` (since ${fmtDate(cycle.start)})` : ''}
            </p>
            <p className="mt-1 text-lg font-semibold">
              {fmtBytes(cycle.usedBytes)}{' '}
              <span className="text-sm font-normal text-muted-foreground">of {fmtBytes(cycle.capBytes)}</span>
              {cycle.fupActive ? (
                <Badge tone="warning" className="ml-2">
                  FUP
                </Badge>
              ) : null}
            </p>
            <div
              className="mt-2 h-2 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuenow={pct ?? 0}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Data cap used"
            >
              <div
                className={pct && pct >= 100 ? 'h-full bg-warning' : 'h-full bg-primary'}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        ) : null}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Daily usage</CardTitle>
        </CardHeader>
        <CardContent>
          {days.length ? (
            <UsageChart days={days} />
          ) : (
            <p className="py-10 text-center text-sm text-muted-foreground">No usage yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const COA_RESULT: Record<string, readonly ['success' | 'warning' | 'danger' | 'neutral', string]> = {
  ack: ['success', 'Done'],
  nak: ['warning', 'Refused, disconnected instead'],
  timeout: ['danger', 'No answer'],
  skipped_offline: ['neutral', 'Not online'],
  error: ['danger', 'Failed'],
};

function CoaLog({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ['subscriber', id, 'coa'],
    queryFn: () => unwrap(api.GET('/api/v1/subscribers/{id}/coa-log', { params: { path: { id } } })),
  });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <DataTable
      caption="Messages sent to the router"
      loading={q.isLoading}
      rows={q.data}
      rowKey={(r) => `${r.at}-${r.type}-${r.nasIp}`}
      empty="Nothing sent to the router yet. Speed changes, suspends and kicks show here."
      columns={[
        { key: 'at', header: 'When', cell: (r) => fmtDateTime(r.at) },
        { key: 'type', header: 'Type', cell: (r) => (r.type === 'coa' ? 'Speed change' : 'Disconnect') },
        { key: 'reason', header: 'Why', cell: (r) => actionLabel(`x.${r.reason}`) },
        {
          key: 'result',
          header: 'Result',
          cell: (r) => {
            const [tone, label] = COA_RESULT[r.result] ?? (['danger', r.result] as const);
            return (
              <Badge tone={tone} title={r.errorCause ? `Error-Cause ${r.errorCause}` : undefined}>
                {label}
              </Badge>
            );
          },
        },
        { key: 'nas', header: 'Router', cell: (r) => <span className="font-mono text-xs">{r.nasIp}</span> },
        {
          key: 'ms',
          header: 'Time',
          cell: (r) => (r.latencyMs != null ? `${r.latencyMs} ms` : '—'),
          hideOnMobile: true,
        },
      ]}
    />
  );
}

function History({ id }: { id: string }) {
  const { byId } = usePlans();
  const q = useInfiniteQuery({
    queryKey: ['audit', { entityId: id }],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/v1/audit', {
          params: {
            query: {
              entityType: 'subscriber',
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
          cell: (r) => (
            <AuditChanges
              before={r.before}
              after={r.after}
              resolve={(k, v) => (k === 'planId' && typeof v === 'string' ? byId.get(v)?.name : undefined)}
            />
          ),
        },
      ]}
    />
  );
}
