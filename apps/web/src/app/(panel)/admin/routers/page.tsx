'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Eye,
  KeyRound,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  ScrollText,
  Trash2,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from '@/lib/toast';
import { RouterForm } from '@/components/router-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/dropdown';
import { ConfirmDialog, ErrorState, PageHeader, SecretBox } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { api, unwrap } from '@/lib/api';
import { useCan, useMe } from '@/lib/auth';
import type { Nas } from '@/lib/queries';
import { relTime } from '@/lib/utils';

type Confirm = { kind: 'rotate' | 'delete' | 'disable'; nas: Nas } | null;
type Target = { instance: 'production' | 'staging'; host: string | null; authPort: number; acctPort: number };

/** Where routers must send Radius: the panel writes to one instance, and its ports differ (1812 vs 11812). */
function RadiusTarget({ t }: { t: Target | undefined }) {
  if (!t) return <Skeleton className="h-5 w-80" />;
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      <span>Radius for these routers:</span>
      <span className="font-mono text-xs text-foreground">
        {t.host ?? 'this server'} · auth {t.authPort}/udp · acct {t.acctPort}/udp
      </span>
      <Badge tone={t.instance === 'production' ? 'success' : 'warning'}>
        {t.instance === 'production' ? 'Production' : 'Staging'}
      </Badge>
    </p>
  );
}

export default function RoutersPage() {
  const can = useCan();
  const qc = useQueryClient();
  const router = useRouter();
  const write = can('nas.write');
  const reseller = useMe().data?.user.type === 'reseller';
  const logs = (n: Nas) => router.push(`/admin/radius-log?nas=${encodeURIComponent(n.ip)}`);
  const [editing, setEditing] = useState<Nas | 'new' | null>(null);
  const [secret, setSecret] = useState<{ nas: Nas; value: string; fresh: boolean } | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);

  const list = useQuery({
    queryKey: ['nas', 'all'],
    queryFn: () => unwrap(api.GET('/api/v1/nas', { params: { query: { limit: 200 } } })),
    // A new or edited router shows "Syncing" until the worker has written it to Radius (normally ~1 s).
    refetchInterval: (q) =>
      q.state.data?.items.some((n) => n.status === 'active' && n.radiusId == null) ? 2000 : false,
  });
  const target = useQuery({
    queryKey: ['radius-target'],
    queryFn: () => unwrap(api.GET('/api/v1/nas/radius-target')),
    staleTime: Infinity,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['nas'] });
  const path = (n: Nas) => ({ params: { path: { id: n.id } } });

  const save = useMutation({
    meta: { silent: true },
    mutationFn: (body: Record<string, unknown>) =>
      editing === 'new'
        ? unwrap(api.POST('/api/v1/nas', { body: body as never }))
        : unwrap(api.PATCH('/api/v1/nas/{id}', { ...path(editing as Nas), body: body as never })),
    onSuccess: (n) => {
      void refresh();
      setEditing(null);
      if (n.radiusSecret) setSecret({ nas: n, value: n.radiusSecret, fresh: true });
      else toast.success('Saved. The Radius engine picks it up within 30 seconds.');
    },
  });
  const patch = useMutation({
    mutationFn: ({ n, body }: { n: Nas; body: { status?: 'active' | 'disabled'; rotateSecret?: true } }) =>
      unwrap(api.PATCH('/api/v1/nas/{id}', { ...path(n), body })),
    onSuccess: (n) => {
      void refresh();
      setConfirm(null);
      if (n.radiusSecret) setSecret({ nas: n, value: n.radiusSecret, fresh: true });
      else
        toast.success(
          n.status === 'disabled' ? 'Disabled. Radius stops answering it within 30 s.' : 'Enabled.',
        );
    },
  });
  const remove = useMutation({
    mutationFn: (n: Nas) => unwrap(api.DELETE('/api/v1/nas/{id}', path(n))),
    onSuccess: () => {
      void refresh();
      setConfirm(null);
      toast.success('Router deleted. Its IP can be used again.');
    },
  });
  const reveal = useMutation({
    mutationFn: (n: Nas) => unwrap(api.GET('/api/v1/nas/{id}/secret', path(n))).then((r) => ({ n, r })),
    onSuccess: ({ n, r }) => setSecret({ nas: n, value: r.radiusSecret, fresh: false }),
  });

  return (
    <>
      <PageHeader
        title="Routers"
        description={
          reseller
            ? 'Routers you added, and the ISP routers your customers connect through. Add your own MikroTik here.'
            : 'MikroTik routers that send logins to Radius. A router must be here before its customers can connect.'
        }
        actions={
          write ? (
            <Button onClick={() => setEditing('new')}>
              <Plus /> Add router
            </Button>
          ) : null
        }
      />
      <div className="mb-4">
        <RadiusTarget t={target.data} />
      </div>
      {list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <DataTable
          caption="Routers"
          loading={list.isLoading}
          rows={list.data?.items}
          rowKey={(n) => n.id}
          onRowClick={(n) => router.push(`/admin/routers/${n.id}`)}
          empty={
            reseller
              ? 'No routers yet. Add your own, or they appear once your customers connect.'
              : 'No routers yet.'
          }
          columns={[
            {
              key: 'name',
              header: 'Router',
              cell: (n) => (
                <span className="flex items-center gap-2">
                  {n.name}
                  {n.apiEnabled ? (
                    <Activity className="size-3.5 text-primary" aria-label="Live graphs on" />
                  ) : null}
                </span>
              ),
            },
            { key: 'ip', header: 'IP', cell: (n) => <span className="font-mono text-xs">{n.ip}</span> },
            { key: 'pop', header: 'POP', cell: (n) => n.location.popName ?? '—', hideOnMobile: true },
            {
              key: 'owner',
              header: reseller ? 'Access' : 'Owner',
              hideOnMobile: true,
              cell: (n) =>
                reseller ? (
                  n.canManage ? (
                    <Badge tone="success">Yours</Badge>
                  ) : (
                    <Badge title="Your customers connect through this ISP router">ISP · your customers</Badge>
                  )
                ) : n.owner ? (
                  <span className="text-[13px]">
                    {n.owner.name}{' '}
                    <span className="font-mono text-xs text-muted-foreground">{n.owner.code}</span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">ISP</span>
                ),
            },
            {
              key: 'ros',
              header: 'RouterOS',
              cell: (n) => (n.routerOsVersion ? `v${n.routerOsVersion}` : '—'),
              hideOnMobile: true,
            },
            {
              key: 'status',
              header: 'Status',
              cell: (n) =>
                n.status === 'disabled' ? (
                  <Badge tone="danger">Disabled</Badge>
                ) : n.radiusId == null ? (
                  <Badge title="Waiting for the sync worker">Syncing</Badge>
                ) : (
                  <Badge tone="success">Active</Badge>
                ),
            },
            { key: 'seen', header: 'Last heard', cell: (n) => relTime(n.lastSeenAt) },
            {
              key: 'actions',
              header: '',
              className: 'text-right',
              cell: (n: Nas) => (
                // Menu items render in a portal; their clicks still bubble to the row through React.
                <div onClick={(e) => e.stopPropagation()}>
                  <Menu>
                    <MenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label={`Actions for ${n.name}`}>
                        <MoreHorizontal />
                      </Button>
                    </MenuTrigger>
                    <MenuContent>
                      <MenuItem onSelect={() => logs(n)}>
                        <ScrollText /> View logs
                      </MenuItem>
                      {write && n.canManage ? (
                        <>
                          <MenuSeparator />
                          <MenuItem onSelect={() => setEditing(n)}>
                            <Pencil /> Edit
                          </MenuItem>
                          <MenuItem onSelect={() => reveal.mutate(n)}>
                            <Eye /> Show Radius secret
                          </MenuItem>
                          <MenuItem onSelect={() => setConfirm({ kind: 'rotate', nas: n })}>
                            <KeyRound /> New secret
                          </MenuItem>
                          {n.status === 'active' ? (
                            <MenuItem onSelect={() => setConfirm({ kind: 'disable', nas: n })}>
                              <Pause /> Disable
                            </MenuItem>
                          ) : (
                            <MenuItem onSelect={() => patch.mutate({ n, body: { status: 'active' } })}>
                              <Play /> Enable
                            </MenuItem>
                          )}
                          <MenuSeparator />
                          <MenuItem destructive onSelect={() => setConfirm({ kind: 'delete', nas: n })}>
                            <Trash2 /> Delete
                          </MenuItem>
                        </>
                      ) : null}
                    </MenuContent>
                  </Menu>
                </div>
              ),
            },
          ]}
        />
      )}

      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent
          wide
          title={editing === 'new' ? 'Add router' : `Edit ${(editing as Nas | null)?.name ?? ''}`}
        >
          {editing !== null ? (
            <>
              <div className="mb-4">
                <RadiusTarget t={target.data} />
              </div>
              <RouterForm
                key={editing === 'new' ? 'new' : editing.id}
                nas={editing === 'new' ? undefined : editing}
                submitting={save.isPending}
                onSubmit={(b) => save.mutateAsync(b)}
                onCancel={() => setEditing(null)}
              />
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={!!secret} onOpenChange={(o) => !o && setSecret(null)}>
        <DialogContent
          title={secret?.fresh ? 'Router ready' : 'Radius secret'}
          description={
            secret?.fresh
              ? 'Copy the secret now; it is not shown again.'
              : 'This view is recorded in the audit log.'
          }
        >
          {secret ? (
            <div className="space-y-4 text-sm">
              <SecretBox label={`Secret for ${secret.nas.name}`} value={secret.value} />
              {secret.fresh ? (
                <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                  <li>
                    In <code>setup.rsc</code> set <code>radiusSecret</code> to this secret and{' '}
                    <code>srcAddress</code> to <code>{secret.nas.ip}</code>
                    {target.data ? (
                      <>
                        , <code>radiusIp</code> to{' '}
                        <code>{target.data.host ?? 'this server’s public IP'}</code>, <code>authPort</code> to{' '}
                        <code>{target.data.authPort}</code> and <code>acctPort</code> to{' '}
                        <code>{target.data.acctPort}</code>
                      </>
                    ) : null}
                    .
                  </li>
                  <li>
                    Upload it to the router and run <code>/import file-name=setup.rsc</code>.
                  </li>
                  <li>Radius accepts the router within 30 seconds.</li>
                </ol>
              ) : null}
              <Button className="w-full" onClick={() => setSecret(null)}>
                Done
              </Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirm?.kind === 'rotate'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Generate a new secret?"
        description="Logins from this router fail until the new secret is set on it."
        confirmLabel="New secret"
        destructive
        loading={patch.isPending}
        onConfirm={() => confirm && patch.mutate({ n: confirm.nas, body: { rotateSecret: true } })}
      />
      <ConfirmDialog
        open={confirm?.kind === 'disable'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Disable ${confirm?.nas.name ?? ''}?`}
        description="Radius stops answering this router within 30 seconds. New logins through it fail."
        confirmLabel="Disable"
        destructive
        loading={patch.isPending}
        onConfirm={() => confirm && patch.mutate({ n: confirm.nas, body: { status: 'disabled' } })}
      />
      <ConfirmDialog
        open={confirm?.kind === 'delete'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Delete ${confirm?.nas.name ?? ''}?`}
        description="Radius stops answering this router within 30 seconds. Session history stays."
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={() => confirm && remove.mutate(confirm.nas)}
      />
    </>
  );
}
