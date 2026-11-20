'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  KeyRound,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  ShieldOff,
  Trash2,
  UserCheck,
  UserX,
} from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from '@/lib/toast';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { Dialog, DialogContent, dialogActions } from '@/components/ui/dialog';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/dropdown';
import { Checkbox, Input } from '@/components/ui/input';
import { ConfirmDialog, ErrorState, Field, PageHeader } from '@/components/ui/misc';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, unwrap, type ApiData } from '@/lib/api';
import { useCan, useMe, type Permission } from '@/lib/auth';
import { applyServerErrors, changedOnly } from '@/lib/forms';
import { PERMISSION_GROUPS } from '@/lib/permissions';
import { useRoles, type StaffUser } from '@/lib/queries';
import { relTime } from '@/lib/utils';

type Role = ApiData<'/api/v1/roles'>[number];

const userSchema = z
  .object({
    name: z.string().trim().min(1, 'Required').max(120),
    email: z.union([z.literal(''), z.email('Enter a valid email')]),
    phone: z.union([z.literal(''), z.string().regex(/^\+?[0-9][0-9\s-]{7,16}$/, 'Enter a phone number')]),
    password: z.string(),
    roleIds: z.array(z.string()),
  })
  .refine((v) => v.email || v.phone, {
    path: ['email'],
    message: 'Give an email or a phone to sign in with',
  });
type UserValues = z.infer<typeof userSchema>;

function UserForm({
  user,
  roles,
  submitting,
  onSubmit,
  onCancel,
}: {
  user?: StaffUser;
  roles: Role[];
  submitting: boolean;
  onSubmit: (b: Record<string, unknown>) => Promise<unknown>;
  onCancel: () => void;
}) {
  const editing = !!user;
  const initial: UserValues = {
    name: user?.name ?? '',
    email: user?.email ?? '',
    phone: user?.phone ?? '',
    password: '',
    roleIds: user?.roleIds ?? [],
  };
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<UserValues>({
    resolver: zodResolver(
      editing
        ? userSchema
        : userSchema.refine((v) => v.password.length >= 10, {
            path: ['password'],
            message: 'At least 10 characters',
          }),
    ),
    defaultValues: initial,
  });
  const body = (v: UserValues, edit: boolean) =>
    JSON.parse(
      JSON.stringify({
        name: v.name,
        email: v.email || (edit ? null : undefined),
        phone: v.phone || (edit ? null : undefined),
        roleIds: v.roleIds,
        ...(edit ? {} : { password: v.password }),
      }),
    ) as Record<string, unknown>;
  const submit = handleSubmit(async (v) => {
    const b = editing ? changedOnly(body(v, true), body(initial, true)) : body(v, false);
    if (editing && !Object.keys(b).length) return onCancel();
    try {
      await onSubmit(b);
    } catch (e) {
      applyServerErrors((p, o) => setError(p.split('.')[0] as keyof UserValues, o), e);
    }
  });
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <Field label="Name" htmlFor="u-name" error={errors.name?.message}>
        <Input id="u-name" {...register('name')} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Email" htmlFor="u-email" error={errors.email?.message}>
          <Input id="u-email" type="email" autoComplete="off" {...register('email')} />
        </Field>
        <Field label="Mobile" htmlFor="u-phone" error={errors.phone?.message}>
          <Input id="u-phone" type="tel" {...register('phone')} />
        </Field>
      </div>
      {!editing ? (
        <Field
          label="Temporary password"
          htmlFor="u-pw"
          error={errors.password?.message}
          hint="At least 10 characters. Ask them to change it after signing in."
        >
          <Input
            id="u-pw"
            type="text"
            autoComplete="new-password"
            spellCheck={false}
            {...register('password')}
          />
        </Field>
      ) : null}
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Roles</legend>
        {roles
          .filter((r) => r.scope === 'tenant')
          .map((r) => (
            <label key={r.id} className="flex items-center gap-2 text-sm">
              <Checkbox value={r.id} {...register('roleIds')} />
              {r.name}
              {r.requireMfa ? <Badge>needs 2FA</Badge> : null}
            </label>
          ))}
        {editing ? <p className="text-xs text-muted-foreground">Changing roles signs them out.</p> : null}
      </fieldset>
      <div className={dialogActions}>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={submitting}>
          {editing ? 'Save' : 'Create account'}
        </Button>
      </div>
    </form>
  );
}

type UserAction = { kind: 'disable' | 'enable' | 'unlock' | 'reset2fa' | 'password'; user: StaffUser } | null;

function Users() {
  const can = useCan();
  const me = useMe();
  const qc = useQueryClient();
  const write = can('users.write');
  const { roles, byId } = useRoles();
  const [editing, setEditing] = useState<StaffUser | 'new' | null>(null);
  const [action, setAction] = useState<UserAction>(null);
  const [newPassword, setNewPassword] = useState('');

  const list = useInfiniteQuery({
    queryKey: ['users'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/v1/users', {
          params: { query: { limit: 100, ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['users'] });
  const path = (u: StaffUser) => ({ params: { path: { id: u.id } } });

  const save = useMutation({
    meta: { silent: true },
    mutationFn: (b: Record<string, unknown>) =>
      editing === 'new'
        ? unwrap(api.POST('/api/v1/users', { body: b as never }))
        : unwrap(api.PATCH('/api/v1/users/{id}', { ...path(editing as StaffUser), body: b as never })),
    onSuccess: () => {
      void refresh();
      toast.success(editing === 'new' ? 'Account created.' : 'Saved.');
      setEditing(null);
    },
  });
  const act = useMutation({
    mutationFn: (a: NonNullable<UserAction>) => {
      const p = path(a.user);
      switch (a.kind) {
        case 'disable':
        case 'enable':
          return unwrap(
            api.PATCH('/api/v1/users/{id}', {
              ...p,
              body: { status: a.kind === 'disable' ? 'disabled' : 'active' },
            }),
          );
        case 'unlock':
          return unwrap(api.POST('/api/v1/users/{id}/unlock', p));
        case 'reset2fa':
          return unwrap(api.POST('/api/v1/users/{id}/reset-2fa', p));
        case 'password':
          return unwrap(api.POST('/api/v1/users/{id}/password', { ...p, body: { password: newPassword } }));
      }
    },
    onSuccess: (_u, a) => {
      void refresh();
      setAction(null);
      setNewPassword('');
      toast.success(
        {
          disable: 'Disabled and signed out.',
          enable: 'Enabled.',
          unlock: 'Unlocked.',
          reset2fa: '2FA removed. They set it up again at next sign-in.',
          password: 'Password set. They are signed out everywhere.',
        }[a.kind],
      );
    },
  });

  const confirmText: Record<NonNullable<UserAction>['kind'], [string, string, string, boolean]> = {
    disable: ['Disable this account?', 'They are signed out at once and cannot sign in.', 'Disable', true],
    enable: ['Enable this account?', 'They can sign in again.', 'Enable', false],
    unlock: ['Unlock sign-in?', 'Clears the lock after too many wrong passwords.', 'Unlock', false],
    reset2fa: [
      'Remove two-factor sign-in?',
      'For a lost phone. They are signed out and must set it up again.',
      'Remove 2FA',
      true,
    ],
    password: ['Set a new password', 'They are signed out everywhere.', 'Set password', true],
  };

  return (
    <>
      {write ? (
        <div className="mb-3 flex justify-end">
          <Button onClick={() => setEditing('new')}>
            <Plus /> New staff account
          </Button>
        </div>
      ) : null}
      {list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <DataTable
          caption="Staff accounts"
          loading={list.isLoading}
          rows={list.data?.pages.flatMap((p) => p.items)}
          rowKey={(u) => u.id}
          hasMore={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
          columns={[
            {
              key: 'name',
              header: 'Name',
              cell: (u) => (
                <div>
                  {u.name}
                  {u.id === me.data?.user.id ? <span className="text-muted-foreground"> (you)</span> : null}
                  <div className="text-xs text-muted-foreground">{u.email ?? u.phone}</div>
                </div>
              ),
            },
            {
              key: 'roles',
              header: 'Roles',
              cell: (u) => u.roleIds.map((r) => byId.get(r)?.name ?? '…').join(', ') || '—',
            },
            {
              key: 'status',
              header: 'Status',
              cell: (u) => (
                <span className="flex flex-wrap gap-1">
                  {u.status === 'active' ? (
                    <Badge tone="success">Active</Badge>
                  ) : u.status === 'locked' ? (
                    <Badge tone="warning">Locked</Badge>
                  ) : (
                    <Badge tone="danger">Disabled</Badge>
                  )}
                  {u.mfaEnabled ? <Badge tone="primary">2FA</Badge> : null}
                </span>
              ),
            },
            { key: 'last', header: 'Last sign-in', cell: (u) => relTime(u.lastLoginAt) },
            ...(write
              ? [
                  {
                    key: 'actions',
                    header: '',
                    className: 'text-right',
                    cell: (u: StaffUser) =>
                      u.id === me.data?.user.id ? null : (
                        <Menu>
                          <MenuTrigger asChild>
                            <Button variant="ghost" size="icon" aria-label={`Actions for ${u.name}`}>
                              <MoreHorizontal />
                            </Button>
                          </MenuTrigger>
                          <MenuContent>
                            <MenuItem onSelect={() => setEditing(u)}>
                              <Pencil /> Edit
                            </MenuItem>
                            <MenuItem onSelect={() => setAction({ kind: 'password', user: u })}>
                              <KeyRound /> Set new password
                            </MenuItem>
                            {u.status === 'locked' || u.lockedUntil ? (
                              <MenuItem onSelect={() => setAction({ kind: 'unlock', user: u })}>
                                <Lock /> Unlock
                              </MenuItem>
                            ) : null}
                            {u.mfaEnabled ? (
                              <MenuItem onSelect={() => setAction({ kind: 'reset2fa', user: u })}>
                                <ShieldOff /> Remove 2FA
                              </MenuItem>
                            ) : null}
                            <MenuSeparator />
                            {u.status === 'disabled' ? (
                              <MenuItem onSelect={() => setAction({ kind: 'enable', user: u })}>
                                <UserCheck /> Enable
                              </MenuItem>
                            ) : (
                              <MenuItem destructive onSelect={() => setAction({ kind: 'disable', user: u })}>
                                <UserX /> Disable
                              </MenuItem>
                            )}
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
          title={
            editing === 'new' ? 'New staff account' : `Edit ${(editing as StaffUser | null)?.name ?? ''}`
          }
        >
          {editing !== null ? (
            <UserForm
              key={editing === 'new' ? 'new' : editing.id}
              user={editing === 'new' ? undefined : editing}
              roles={roles}
              submitting={save.isPending}
              onSubmit={(b) => save.mutateAsync(b)}
              onCancel={() => setEditing(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      {action ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setAction(null)}
          title={confirmText[action.kind][0]}
          description={`${action.user.name}: ${confirmText[action.kind][1]}`}
          confirmLabel={confirmText[action.kind][2]}
          destructive={confirmText[action.kind][3]}
          loading={act.isPending}
          onConfirm={() => {
            if (action.kind === 'password' && newPassword.length < 10)
              return toast.error('At least 10 characters');
            act.mutate(action);
          }}
        >
          {action.kind === 'password' ? (
            <Field label="New password" htmlFor="np" hint="At least 10 characters.">
              <Input
                id="np"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </Field>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </>
  );
}

function RoleForm({
  role,
  submitting,
  onSubmit,
  onCancel,
}: {
  role?: Role;
  submitting: boolean;
  onSubmit: (b: Record<string, unknown>) => Promise<unknown>;
  onCancel: () => void;
}) {
  const readOnly = role?.builtIn ?? false;
  const [name, setName] = useState(role?.name ?? '');
  const [perms, setPerms] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const [mfa, setMfa] = useState(role?.requireMfa ?? false);
  const toggle = (p: Permission) =>
    setPerms((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });
  const submit = () => {
    if (!name.trim() || !perms.size) return toast.error('Give the role a name and at least one permission.');
    const full = { name: name.trim(), permissions: [...perms].sort(), requireMfa: mfa };
    const b = role
      ? changedOnly(full, {
          name: role.name,
          permissions: [...role.permissions].sort(),
          requireMfa: role.requireMfa,
        })
      : { ...full, scope: 'tenant' };
    if (role && !Object.keys(b).length) return onCancel();
    void onSubmit(b).catch(() => undefined);
  };
  return (
    <div className="space-y-4">
      <Field label="Name" htmlFor="r-name">
        <Input
          id="r-name"
          value={name}
          disabled={readOnly}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        {PERMISSION_GROUPS.map((g) => (
          <fieldset key={g.label} className="space-y-1.5">
            <legend className="mb-1 text-sm font-medium">{g.label}</legend>
            {g.items.map(([p, label]) => (
              <label key={p} className="flex items-center gap-2 text-sm">
                <Checkbox checked={perms.has(p)} disabled={readOnly} onChange={() => toggle(p)} />
                {label}
              </label>
            ))}
          </fieldset>
        ))}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={mfa} disabled={readOnly} onChange={(e) => setMfa(e.target.checked)} />
        Require two-factor sign-in
      </label>
      <div className={dialogActions}>
        <Button type="button" variant="outline" onClick={onCancel}>
          {readOnly ? 'Close' : 'Cancel'}
        </Button>
        {readOnly ? null : (
          <Button onClick={submit} loading={submitting}>
            {role ? 'Save role' : 'Create role'}
          </Button>
        )}
      </div>
    </div>
  );
}

function Roles() {
  const can = useCan();
  const qc = useQueryClient();
  const write = can('roles.write');
  const { roles, isLoading, isError, error, refetch } = useRoles();
  const [editing, setEditing] = useState<Role | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Role | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['roles'] });
  const save = useMutation({
    mutationFn: (b: Record<string, unknown>) =>
      editing === 'new'
        ? unwrap(api.POST('/api/v1/roles', { body: b as never }))
        : unwrap(
            api.PATCH('/api/v1/roles/{id}', {
              params: { path: { id: (editing as Role).id } },
              body: b as never,
            }),
          ),
    onSuccess: () => {
      void refresh();
      setEditing(null);
      toast.success('Role saved.');
    },
  });
  const remove = useMutation({
    mutationFn: (r: Role) => unwrap(api.DELETE('/api/v1/roles/{id}', { params: { path: { id: r.id } } })),
    onSuccess: () => {
      void refresh();
      setDeleting(null);
      toast.success('Role deleted.');
    },
  });
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;
  return (
    <>
      {write ? (
        <div className="mb-3 flex justify-end">
          <Button onClick={() => setEditing('new')}>
            <Plus /> New role
          </Button>
        </div>
      ) : null}
      <DataTable
        caption="Roles"
        loading={isLoading}
        rows={roles.filter((r) => r.scope === 'tenant')}
        rowKey={(r) => r.id}
        onRowClick={(r) => setEditing(r)}
        columns={[
          {
            key: 'name',
            header: 'Role',
            cell: (r) => (
              <span className="flex items-center gap-2">
                {r.name} {r.builtIn ? <Badge>Built-in</Badge> : null}
              </span>
            ),
          },
          { key: 'perms', header: 'Permissions', cell: (r) => r.permissions.length },
          { key: 'mfa', header: '2FA', cell: (r) => (r.requireMfa ? 'Required' : 'Optional') },
          ...(write
            ? [
                {
                  key: 'del',
                  header: '',
                  className: 'text-right',
                  cell: (r: Role) =>
                    r.builtIn ? null : (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete ${r.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleting(r);
                        }}
                      >
                        <Trash2 />
                      </Button>
                    ),
                },
              ]
            : []),
        ]}
      />
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent
          wide
          title={editing === 'new' ? 'New role' : ((editing as Role | null)?.name ?? '')}
          description={
            editing !== 'new' && editing?.builtIn
              ? 'Built-in roles cannot be changed. Create a custom role instead.'
              : undefined
          }
        >
          {editing !== null ? (
            <RoleForm
              key={editing === 'new' ? 'new' : editing.id}
              role={editing === 'new' ? undefined : editing}
              submitting={save.isPending}
              onSubmit={(b) => save.mutateAsync(b)}
              onCancel={() => setEditing(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.name ?? ''}?`}
        description="Only roles nobody has can be deleted."
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </>
  );
}

export default function UsersPage() {
  return (
    <>
      <PageHeader
        title="Staff & roles"
        description="Who can sign in to this panel, and what each role may do."
      />
      <Tabs defaultValue="users">
        <TabsList>
          <TabsTrigger value="users">Staff</TabsTrigger>
          <TabsTrigger value="roles">Roles</TabsTrigger>
        </TabsList>
        <TabsContent value="users">
          <Users />
        </TabsContent>
        <TabsContent value="roles">
          <Roles />
        </TabsContent>
      </Tabs>
    </>
  );
}
