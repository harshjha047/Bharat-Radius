'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { AuthCard, FormError, SessionCheck } from '@/components/auth-card';
import { Button } from '@/components/ui/button';
import { Input, PasswordInput } from '@/components/ui/input';
import { Field } from '@/components/ui/misc';
import { api, ApiError, unwrap } from '@/lib/api';
import { useSignedIn } from '@/lib/session';

export default function PortalLoginPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  // Already signed in to the portal: go straight to the customer's home.
  const session = useSignedIn('customer');
  useEffect(() => {
    if (session.confirmed) router.replace('/portal');
  }, [session.confirmed, router]);
  const login = useMutation({
    meta: { silent: true },
    mutationFn: (b: { login: string; password: string }) =>
      unwrap(api.POST('/api/v1/portal/auth/login', { body: b })),
    onSuccess: () => {
      qc.removeQueries({ queryKey: ['portal'] });
      router.replace('/portal');
    },
    onError: (e) =>
      setError(
        e instanceof ApiError && e.status === 429
          ? 'Too many attempts. Wait 15 minutes and try again.'
          : e instanceof Error
            ? e.message
            : 'Sign-in failed',
      ),
  });

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const f = new FormData(e.currentTarget);
    login.mutate({ login: String(f.get('login')).trim(), password: String(f.get('password')) });
  };

  if (session.confirmed || (session.optimistic && session.checking)) return <SessionCheck />;

  return (
    <AuthCard audience="customer" title="Log in" description="Use the details on your welcome SMS.">
      <form onSubmit={submit} className="space-y-5 [&_label]:text-[15px]">
        <Field
          label="Username or customer number"
          htmlFor="login"
          hint="Looks like C000123, or the username you chose"
        >
          <Input
            id="login"
            name="login"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            minLength={3}
            autoFocus
            className="h-[52px] text-base font-medium"
          />
        </Field>
        <Field
          label="Password"
          htmlFor="password"
          hint="Your PPPoE password, unless you set a portal password."
        >
          <PasswordInput
            id="password"
            name="password"
            autoComplete="current-password"
            required
            className="h-[52px] text-base font-medium"
          />
        </Field>
        {error ? <FormError>{error}</FormError> : null}
        <Button type="submit" size="xl" loading={login.isPending}>
          Log in
        </Button>
      </form>
    </AuthCard>
  );
}
