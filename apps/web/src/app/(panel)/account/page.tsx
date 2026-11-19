'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { TotpSetup } from '@/components/totp-setup';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ConfirmDialog, Field, KeyValue, PageHeader } from '@/components/ui/misc';
import { api, fieldErrors, unwrap } from '@/lib/api';
import { ME_KEY, useMe } from '@/lib/auth';
import { ResellerBranding } from '@/components/branding';
import { useRoles } from '@/lib/queries';
import { fmtDateTime } from '@/lib/utils';

function PasswordCard() {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const change = useMutation({
    meta: { silent: true },
    mutationFn: (b: { currentPassword: string; newPassword: string }) =>
      unwrap(api.POST('/api/v1/auth/password', { body: b })),
    onSuccess: () => toast.success('Password changed. Other devices are signed out.'),
    onError: (e) => {
      const f = fieldErrors(e);
      if (Object.keys(f).length) setErrors(f);
      else setErrors({ currentPassword: e.message });
    },
  });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const next = String(f.get('newPassword'));
    if (next !== String(f.get('confirm'))) return setErrors({ confirm: 'The two new passwords differ' });
    if (next.length < 10) return setErrors({ newPassword: 'At least 10 characters' });
    setErrors({});
    change.mutate(
      { currentPassword: String(f.get('currentPassword')), newPassword: next },
      { onSuccess: () => form.reset() },
    );
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid max-w-md gap-4" noValidate>
          <input type="text" name="username" autoComplete="username" hidden readOnly />
          <Field label="Current password" htmlFor="cur" error={errors.currentPassword}>
            <Input id="cur" name="currentPassword" type="password" autoComplete="current-password" required />
          </Field>
          <Field
            label="New password"
            htmlFor="new"
            error={errors.newPassword}
            hint="At least 10 characters; a short sentence works well."
          >
            <Input id="new" name="newPassword" type="password" autoComplete="new-password" required />
          </Field>
          <Field label="New password again" htmlFor="confirm" error={errors.confirm}>
            <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
          </Field>
          <div>
            <Button type="submit" loading={change.isPending}>
              Change password
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function TwoFactorCard() {
  const qc = useQueryClient();
  const me = useMe();
  const [setupOpen, setSetupOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [disable, setDisable] = useState({ open: false, code: '', password: '' });
  const enabled = me.data?.user.mfaEnabled ?? false;
  const setup = useQuery({
    queryKey: ['2fa-setup', 'account'],
    queryFn: () => unwrap(api.POST('/api/v1/auth/2fa/setup')),
    enabled: setupOpen,
    staleTime: Infinity,
    gcTime: 0,
  });
  const done = () => void qc.invalidateQueries({ queryKey: ME_KEY });
  const enable = useMutation({
    meta: { silent: true },
    mutationFn: (code: string) => unwrap(api.POST('/api/v1/auth/2fa/enable', { body: { code } })),
    onSuccess: () => {
      setSetupOpen(false);
      done();
      toast.success('Two-factor sign-in is on.');
    },
    onError: (e) => setError(e.message),
  });
  const off = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/auth/2fa/disable', { body: { code: disable.code, password: disable.password } }),
      ),
    onSuccess: () => {
      setDisable({ open: false, code: '', password: '' });
      done();
      toast.success('Two-factor sign-in is off.');
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Two-factor sign-in {enabled ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}
        </CardTitle>
        <CardDescription>
          A code from your phone at every sign-in. Required for administrators.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {enabled ? (
          me.data?.requireMfa ? (
            <p className="text-sm text-muted-foreground">
              Your role requires it, so it cannot be turned off.
            </p>
          ) : (
            <Button variant="outline" onClick={() => setDisable((d) => ({ ...d, open: true }))}>
              Turn off
            </Button>
          )
        ) : setupOpen ? (
          <div className="max-w-sm">
            <TotpSetup
              setup={setup.data}
              loading={enable.isPending}
              error={error}
              onSubmit={(e, code) => {
                e.preventDefault();
                setError(undefined);
                enable.mutate(code);
              }}
            />
          </div>
        ) : (
          <Button onClick={() => setSetupOpen(true)}>Turn on</Button>
        )}
      </CardContent>
      <ConfirmDialog
        open={disable.open}
        onOpenChange={(o) => setDisable((d) => ({ ...d, open: o }))}
        title="Turn off two-factor sign-in?"
        confirmLabel="Turn off"
        destructive
        loading={off.isPending}
        onConfirm={() => off.mutate()}
      >
        <div className="space-y-3">
          <Field label="Current code" htmlFor="d-code">
            <Input
              id="d-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={disable.code}
              onChange={(e) => setDisable((d) => ({ ...d, code: e.target.value.trim() }))}
            />
          </Field>
          <Field label="Password" htmlFor="d-pw">
            <Input
              id="d-pw"
              type="password"
              autoComplete="current-password"
              value={disable.password}
              onChange={(e) => setDisable((d) => ({ ...d, password: e.target.value }))}
            />
          </Field>
        </div>
      </ConfirmDialog>
    </Card>
  );
}

export default function AccountPage() {
  const me = useMe();
  const router = useRouter();
  const qc = useQueryClient();
  const { byId } = useRoles(!!me.data?.permissions.includes('users.read'));
  const [confirm, setConfirm] = useState(false);
  const all = useMutation({
    mutationFn: () => unwrap(api.POST('/api/v1/auth/logout-all')),
    onSuccess: () => {
      qc.clear();
      router.replace('/login');
    },
  });
  const u = me.data!.user;
  return (
    <>
      <PageHeader title="My account" />
      <div className="space-y-5">
        {u.type === 'reseller' && u.resellerId && me.data!.permissions.includes('branding.manage') ? (
          <ResellerBranding resellerId={u.resellerId} />
        ) : null}
        <Card>
          <CardHeader>
            <CardTitle>{u.name}</CardTitle>
          </CardHeader>
          <CardContent>
            <KeyValue
              items={[
                ['Email', u.email],
                ['Mobile', u.phone],
                [
                  'Roles',
                  u.roleIds
                    .map((r) => byId.get(r)?.name)
                    .filter(Boolean)
                    .join(', ') || null,
                ],
                ['Last sign-in', fmtDateTime(u.lastLoginAt)],
              ]}
            />
          </CardContent>
        </Card>
        <PasswordCard />
        <TwoFactorCard />
        <Card>
          <CardHeader>
            <CardTitle>Sessions</CardTitle>
            <CardDescription>
              Lost a phone or used a shared computer? Sign out everywhere, including here.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => setConfirm(true)}>
              Sign out everywhere
            </Button>
          </CardContent>
        </Card>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Sign out everywhere?"
        description="Every device signed in to your account is signed out, including this one."
        confirmLabel="Sign out everywhere"
        destructive
        loading={all.isPending}
        onConfirm={() => all.mutate()}
      />
    </>
  );
}
