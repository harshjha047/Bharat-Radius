'use client';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Pause, Pencil, Play, Plus, UserPlus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from '@/lib/toast';
import { TenantForm, type Tenant } from '@/components/tenant-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ConfirmDialog, ErrorState, Field, PageHeader } from '@/components/ui/misc';
import { useDebounced } from '@/hooks/use-debounced';
import { api, fieldErrors, unwrap } from '@/lib/api';
import { useRoles } from '@/lib/queries';

function AddAdmin({ tenant, onDone }: { tenant: Tenant; onDone: () => void }) {
  const { roles } = useRoles();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const admin = roles.find((r) => r.builtIn && r.name === 'ISP Admin');
  const create = useMutation({
    meta: { silent: true },
    mutationFn: (b: { name: string; email?: string; phone?: string; password: string }) =>
      unwrap(
        api.POST('/api/v1/users', { body: { ...b, tenantId: tenant.id, roleIds: admin ? [admin.id] : [] } }),
      ),
    onSuccess: () => {
      toast.success('Administrator created. They set up 2FA at first sign-in.');
      onDone();
    },
    onError: (e) => setErrors(Object.keys(fieldErrors(e)).length ? fieldErrors(e) : { name: e.message }),
  });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? '').trim();
    create.mutate({
      name: s('name'),
      password: String(f.get('password')),
      ...(s('email') ? { email: s('email') } : {}),
      ...(s('phone') ? { phone: s('phone') } : {}),
    });
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Name" htmlFor="aa-name" error={errors.name}>
        <Input id="aa-name" name="name" required />
      </Field>
      <Field label="Email" htmlFor="aa-email" error={errors.email}>
        <Input id="aa-email" name="email" type="email" />
      </Field>
      <Field label="Mobile" htmlFor="aa-phone" error={errors.phone}>
        <Input id="aa-phone" name="phone" type="tel" />
      </Field>
      <Field
        label="Temporary password"
        htmlFor="aa-pw"
        error={errors.password}
        hint="At least 10 characters."
      >
        <Input id="aa-pw" name="password" autoComplete="new-password" required minLength={10} />
      </Field>
      <Button type="submit" className="w-full" loading={create.isPending} disabled={!admin}>
        Create ISP administrator
      </Button>
    </form>
  );
}

export default function TenantsPage() {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 300);
  const [editing, setEditing] = useState<Tenant | 'new' | null>(null);
  const [adminFor, setAdminFor] = useState<Tenant | null>(null);
  const [toggling, setToggling] = useState<Tenant | null>(null);
  const list = useInfiniteQuery({
    queryKey: ['tenants', dq],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/v1/tenants', {
          params: {
            query: { limit: 100, ...(dq ? { q: dq } : {}), ...(pageParam ? { cursor: pageParam } : {}) },
          },
        }),
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    placeholderData: (prev) => prev,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['tenants'] });
  const save = useMutation({
    meta: { silent: true },
    mutationFn: (b: Record<string, unknown>) =>
      editing === 'new'
        ? unwrap(api.POST('/api/v1/tenants', { body: b as never }))
        : unwrap(
            api.PATCH('/api/v1/tenants/{id}', {
              params: { path: { id: (editing as Tenant).id } },
              body: b as never,
            }),
          ),
    onSuccess: (t) => {
      void refresh();
      const created = editing === 'new';
      setEditing(null);
      toast.success(created ? 'ISP created. Add its first administrator next.' : 'Saved.');
      if (created) setAdminFor(t);
    },
  });
  const toggle = useMutation({
    mutationFn: (t: Tenant) =>
      unwrap(
        api.PATCH('/api/v1/tenants/{id}', {
          params: { path: { id: t.id } },
          body: { status: t.status === 'active' ? 'suspended' : 'active' },
        }),
      ),
    onSuccess: (t) => {
      void refresh();
      setToggling(null);
      toast.success(t.status === 'suspended' ? 'ISP suspended.' : 'ISP active again.');
    },
  });

  return (
    <>
      <PageHeader
        title="ISPs"
        description="Every ISP on the platform. Their data is isolated from each other."
        actions={
          <Button onClick={() => setEditing('new')}>
            <Plus /> New ISP
          </Button>
        }
      />
      <Input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search by name or ID"
        aria-label="Search ISPs"
        className="mb-4 max-w-sm"
      />
      {list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <DataTable
          caption="ISPs"
          loading={list.isLoading}
          rows={list.data?.pages.flatMap((p) => p.items)}
          rowKey={(t) => t.id}
          hasMore={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
          columns={[
            {
              key: 'name',
              header: 'ISP',
              cell: (t) => (
                <div>
                  {t.name}
                  <div className="font-mono text-xs text-muted-foreground">{t.slug}</div>
                </div>
              ),
            },
            { key: 'domain', header: 'Panel domain', cell: (t) => t.domain ?? '—' },
            {
              key: 'state',
              header: 'State',
              cell: (t) => `${t.address.state} (${t.stateCode})`,
              hideOnMobile: true,
            },
            {
              key: 'status',
              header: 'Status',
              cell: (t) =>
                t.status === 'active' ? (
                  <Badge tone="success">Active</Badge>
                ) : (
                  <Badge tone="danger">{t.status}</Badge>
                ),
            },
            {
              key: 'actions',
              header: '',
              className: 'text-right whitespace-nowrap',
              cell: (t) => (
                <span className="inline-flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Edit ${t.name}`}
                    onClick={() => setEditing(t)}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Add administrator to ${t.name}`}
                    onClick={() => setAdminFor(t)}
                  >
                    <UserPlus />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t.status === 'active' ? `Suspend ${t.name}` : `Activate ${t.name}`}
                    onClick={() => setToggling(t)}
                  >
                    {t.status === 'active' ? <Pause /> : <Play />}
                  </Button>
                </span>
              ),
            },
          ]}
        />
      )}
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent
          wide
          title={editing === 'new' ? 'New ISP' : `Edit ${(editing as Tenant | null)?.name ?? ''}`}
        >
          {editing !== null ? (
            <TenantForm
              key={editing === 'new' ? 'new' : editing.id}
              tenant={editing === 'new' ? undefined : editing}
              mode={editing === 'new' ? 'create' : 'platform'}
              submitting={save.isPending}
              onSubmit={(b) => save.mutateAsync(b)}
              onCancel={() => setEditing(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog open={!!adminFor} onOpenChange={(o) => !o && setAdminFor(null)}>
        <DialogContent title={`Add administrator to ${adminFor?.name ?? ''}`}>
          {adminFor ? <AddAdmin tenant={adminFor} onDone={() => setAdminFor(null)} /> : null}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!toggling}
        onOpenChange={(o) => !o && setToggling(null)}
        title={
          toggling?.status === 'active' ? `Suspend ${toggling.name}?` : `Activate ${toggling?.name ?? ''}?`
        }
        description={
          toggling?.status === 'active'
            ? 'Their staff cannot sign in and every customer login is refused within 30 seconds.'
            : 'Their staff can sign in again.'
        }
        confirmLabel={toggling?.status === 'active' ? 'Suspend' : 'Activate'}
        destructive={toggling?.status === 'active'}
        loading={toggle.isPending}
        onConfirm={() => toggling && toggle.mutate(toggling)}
      />
    </>
  );
}
