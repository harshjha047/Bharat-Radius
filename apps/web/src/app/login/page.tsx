'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { AuthCard, FormError } from '@/components/auth-card';
import { Button } from '@/components/ui/button';
import { Input, PasswordInput } from '@/components/ui/input';
import { Field } from '@/components/ui/misc';
import { api, ApiError, unwrap } from '@/lib/api';
import { safeNext } from '@/lib/nav';
import { useSignedIn } from '@/lib/session';
import { SessionCheck } from '@/components/auth-card';

type Step = 'password' | 'code';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>('password');
  const [showTenant, setShowTenant] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = (status: 'ok' | 'mfa_required' | 'mfa_enroll_required') => {
    qc.clear();
    if (status === 'mfa_required') return setStep('code');
    if (status === 'mfa_enroll_required') return router.replace('/setup-2fa');
    router.replace(safeNext(params.get('next')));
  };
  const onError = (e: unknown) =>
    setError(
      e instanceof ApiError && e.status === 429
        ? 'Too many attempts. Wait a few minutes and try again.'
        : e instanceof Error
          ? e.message
          : 'Sign-in failed',
    );

  const login = useMutation({
    meta: { silent: true },
    mutationFn: (b: { login: string; password: string; tenant?: string }) =>
      unwrap(api.POST('/api/v1/auth/login', { body: b })),
    onSuccess: (r) => finish(r.status),
    onError,
  });
  const verify = useMutation({
    meta: { silent: true },
    mutationFn: (code: string) => unwrap(api.POST('/api/v1/auth/2fa/verify', { body: { code } })),
    onSuccess: (r) => finish(r.status),
    onError,
  });

  // Already signed in: go straight to the panel (or the page that sent them here).
  const session = useSignedIn('staff', login.isIdle && verify.isIdle);
  const next = params.get('next');
  useEffect(() => {
    if (session.confirmed) router.replace(safeNext(next, session.confirmed.href));
  }, [session.confirmed, next, router]);

  const submitPassword = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const f = new FormData(e.currentTarget);
    const tenant = String(f.get('tenant') ?? '')
      .trim()
      .toLowerCase();
    login.mutate({
      login: String(f.get('login')).trim(),
      password: String(f.get('password')),
      ...(tenant ? { tenant } : {}),
    });
  };
  const submitCode = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    verify.mutate(String(new FormData(e.currentTarget).get('code')).replace(/\s/g, ''));
  };

  if (session.confirmed || (session.optimistic && session.checking)) return <SessionCheck />;

  if (step === 'code') {
    return (
      <AuthCard title="Enter your 6-digit code" description="Open your authenticator app.">
        <form onSubmit={submitCode} className="space-y-4" noValidate>
          <Field label="Code" htmlFor="code" error={error ?? undefined}>
            <Input
              id="code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={7}
              required
              autoFocus
              className="text-center font-mono text-lg tracking-[0.4em]"
            />
          </Field>
          <Button type="submit" className="w-full" loading={verify.isPending}>
            Verify
          </Button>
          <Button type="button" variant="link" className="w-full" onClick={() => setStep('password')}>
            Use a different account
          </Button>
        </form>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Sign in" description="For staff, administrators and resellers.">
      <form onSubmit={submitPassword} className="space-y-4">
        <Field label="Email or phone" htmlFor="login">
          <Input id="login" name="login" autoComplete="username" required minLength={3} autoFocus />
        </Field>
        <Field label="Password" htmlFor="password">
          <PasswordInput id="password" name="password" autoComplete="current-password" required />
        </Field>
        {showTenant ? (
          <Field
            label="Organisation ID"
            htmlFor="tenant"
            hint="Only when signing in from another ISP's address."
          >
            <Input id="tenant" name="tenant" autoCapitalize="none" pattern="[a-z0-9][a-z0-9-]{1,39}" />
          </Field>
        ) : null}
        {error ? <FormError>{error}</FormError> : null}
        <Button type="submit" className="w-full" loading={login.isPending}>
          Sign in
        </Button>
        {!showTenant ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="w-full"
            onClick={() => setShowTenant(true)}
          >
            Sign in to a different organisation
          </Button>
        ) : null}
      </form>
    </AuthCard>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
