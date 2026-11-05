'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, KeyRound, MoreHorizontal, Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { RouterForm } from '@/components/router-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/dropdown';
import { ConfirmDialog, ErrorState, PageHeader, SecretBox } from '@/components/ui/misc';
import { api, unwrap } from '@/lib/api';
import { useCan } from '@/lib/auth';
import type { Nas } from '@/lib/queries';
import { relTime } from '@/lib/utils';

type Confirm = { kind: 'rotate' | 'delete' | 'disable'; nas: Nas } | null;

export default function RoutersPage() {
  const can = useCan();
  const qc = useQueryClient();
  const write = can('nas.write');
  const [editing, setEditing] = useState<Nas | 'new' | null>(null);
  const [secret, setSecret] = useState<{ nas: Nas; value: string; fresh: boolean } | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);

  const list = useQuery({
    queryKey: ['nas', 'all'],
    queryFn: () => unwrap(api.GET('/api/v1/nas', { params: { query: { limit: 200 } } })),
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
      else toast.success('Saved. FreeRADIUS picks it up within 30 seconds.');
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
          n.status === 'disabled' ? 'Disabled. RADIUS stops answering it within 30 s.' : 'Enabled.',
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
        description="MikroTik routers that send logins to RADIUS. A router must be here before its customers can connect."
        actions={
          write ? (
            <Button onClick={() => setEditing('new')}>
              <Plus /> Add router
            </Button>
          ) : null
        }
      />
      {list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <DataTable
          caption="Routers"
          loading={list.isLoading}
          rows={list.data?.items}
          rowKey={(n) => n.id}
          empty="No routers yet."
          columns={[
            { key: 'name', header: 'Router', cell: (n) => n.name },
            { key: 'ip', header: 'IP', cell: (n) => <span className="font-mono text-xs">{n.ip}</span> },
            { key: 'pop', header: 'POP', cell: (n) => n.location.popName ?? '—', hideOnMobile: true },
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
            ...(write
              ? [
                  {
                    key: 'actions',
                    header: '',
                    className: 'text-right',
                    cell: (n: Nas) => (
                      <Menu>
                        <MenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label={`Actions for ${n.name}`}>
                            <MoreHorizontal />
                          </Button>
                        </MenuTrigger>
                        <MenuContent>
                          <MenuItem onSelect={() => setEditing(n)}>
                            <Pencil /> Edit
                          </MenuItem>
                          <MenuItem onSelect={() => reveal.mutate(n)}>
                            <Eye /> Show RADIUS secret
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
                        </MenuContent>
                      </Menu>
                    ),
                  },
                ]
              : []),
          ]}
        />
      )}

      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent
          wide
          title={editing === 'new' ? 'Add router' : `Edit ${(editing as Nas | null)?.name ?? ''}`}
        >
          {editing !== null ? (
            <RouterForm
              key={editing === 'new' ? 'new' : editing.id}
              nas={editing === 'new' ? undefined : editing}
              submitting={save.isPending}
              onSubmit={(b) => save.mutateAsync(b)}
              onCancel={() => setEditing(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={!!secret} onOpenChange={(o) => !o && setSecret(null)}>
        <DialogContent
          title={secret?.fresh ? 'Router ready' : 'RADIUS secret'}
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
                    <code>srcAddress</code> to <code>{secret.nas.ip}</code>.
                  </li>
                  <li>
                    Upload it to the router and run <code>/import file-name=setup.rsc</code>.
                  </li>
                  <li>RADIUS accepts the router within 30 seconds.</li>
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
        description="RADIUS stops answering this router within 30 seconds. New logins through it fail."
        confirmLabel="Disable"
        destructive
        loading={patch.isPending}
        onConfirm={() => confirm && patch.mutate({ n: confirm.nas, body: { status: 'disabled' } })}
      />
      <ConfirmDialog
        open={confirm?.kind === 'delete'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Delete ${confirm?.nas.name ?? ''}?`}
        description="RADIUS stops answering this router within 30 seconds. Session history stays."
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={() => confirm && remove.mutate(confirm.nas)}
      />
    </>
  );
}
