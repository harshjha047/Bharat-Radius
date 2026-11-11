'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { AuthCard } from '@/components/auth-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/misc';
import { api, ApiError, unwrap } from '@/lib/api';

export default function PortalLoginPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
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

  return (
    <AuthCard
      title="My account"
      description="Sign in with the username and password of your internet connection."
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Username or customer no." htmlFor="login">
          <Input
            id="login"
            name="login"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            minLength={3}
            autoFocus
          />
        </Field>
        <Field
          label="Password"
          htmlFor="password"
          hint="Your PPPoE password, unless you set a portal password."
        >
          <Input id="password" name="password" type="password" autoComplete="current-password" required />
        </Field>
        {error ? (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-danger-text">
            {error}
          </p>
        ) : null}
        <Button type="submit" className="w-full" loading={login.isPending}>
          Sign in
        </Button>
      </form>
    </AuthCard>
  );
}
