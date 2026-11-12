'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { portalKeys, usePortalMe } from '@/components/portal';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ErrorState, Field, KeyValue } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { api, fieldErrors, unwrap } from '@/lib/api';

export default function PortalAccount() {
  const me = usePortalMe();
  if (me.isLoading) return <Skeleton className="h-64 w-full" />;
  if (me.isError) return <ErrorState error={me.error} onRetry={() => void me.refetch()} />;
  const m = me.data!;
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>My details</CardTitle>
        </CardHeader>
        <CardContent>
          <KeyValue
            items={[
              ['Name', m.name],
              ['Customer no.', m.customerNo],
              ['Username', m.username],
              ['Phone', m.phone],
              ['Email', m.email],
              ['City', m.city],
              ['Billing', m.billingType === 'prepaid' ? 'Prepaid' : 'Monthly (postpaid)'],
            ]}
          />
          <p className="mt-4 text-sm text-muted-foreground">
            To change these details, contact {m.isp.name}
            {m.isp.phone ? ` on ${m.isp.phone}` : ''}
            {m.isp.email ? ` or ${m.isp.email}` : ''}.
          </p>
        </CardContent>
      </Card>
      <PasswordCard hasPortalPassword={m.hasPortalPassword} />
      <SignOut />
    </>
  );
}

function SignOut() {
  const router = useRouter();
  const qc = useQueryClient();
  const logout = useMutation({
    mutationFn: () => unwrap(api.POST('/api/v1/portal/auth/logout')),
    onSettled: () => {
      qc.removeQueries({ queryKey: ['portal'] });
      router.replace('/portal/login');
    },
  });
  return (
    <Button
      variant="destructive-outline"
      size="lg"
      className="w-full rounded-[14px]"
      loading={logout.isPending}
      onClick={() => logout.mutate()}
    >
      {logout.isPending ? null : <LogOut />}
      Sign out
    </Button>
  );
}

function PasswordCard({ hasPortalPassword }: { hasPortalPassword: boolean }) {
  const qc = useQueryClient();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    meta: { silent: true },
    mutationFn: (b: { currentPassword: string; newPassword: string }) =>
      unwrap(api.POST('/api/v1/portal/password', { body: b })),
    onSuccess: () => {
      toast.success('Password saved. Other devices were signed out.');
      void qc.invalidateQueries({ queryKey: portalKeys.me });
    },
    onError: (e) => {
      const f = fieldErrors(e);
      setErrors(Object.keys(f).length ? f : { newPassword: e instanceof Error ? e.message : 'Failed' });
    },
  });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const next = String(f.get('newPassword'));
    if (next !== String(f.get('confirm'))) return setErrors({ confirm: 'Does not match' });
    setErrors({});
    save.mutate(
      { currentPassword: String(f.get('currentPassword')), newPassword: next },
      { onSuccess: () => form.reset() },
    );
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{hasPortalPassword ? 'Change portal password' : 'Set a portal password'}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <p className="text-sm text-muted-foreground">
            {hasPortalPassword
              ? 'Used only for this website. Your internet (PPPoE) password does not change.'
              : 'You are signed in with your internet (PPPoE) password. Set a separate one for this website; ' +
                'your internet connection keeps working as before.'}
          </p>
          <Field
            label={hasPortalPassword ? 'Current portal password' : 'Internet (PPPoE) password'}
            htmlFor="currentPassword"
            error={errors.currentPassword}
          >
            <Input
              id="currentPassword"
              name="currentPassword"
              type="password"
              required
              autoComplete="current-password"
            />
          </Field>
          <Field
            label="New password"
            htmlFor="newPassword"
            error={errors.newPassword}
            hint="At least 8 characters."
          >
            <Input
              id="newPassword"
              name="newPassword"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
            />
          </Field>
          <Field label="Repeat new password" htmlFor="confirm" error={errors.confirm}>
            <Input id="confirm" name="confirm" type="password" required autoComplete="new-password" />
          </Field>
          <Button type="submit" loading={save.isPending}>
            Save password
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
