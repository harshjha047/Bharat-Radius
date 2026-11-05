'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { AuthCard } from '@/components/auth-card';
import { TotpSetup } from '@/components/totp-setup';
import { Button } from '@/components/ui/button';
import { api, unwrap } from '@/lib/api';
import { ME_KEY } from '@/lib/auth';

/** Required enrolment: ISP Admin and super-admin roles cannot do anything else until 2FA is on. */
export default function Setup2faPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [error, setError] = useState<string>();
  const setup = useQuery({
    queryKey: ['2fa-setup'],
    queryFn: () => unwrap(api.POST('/api/v1/auth/2fa/setup')),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  const enable = useMutation({
    meta: { silent: true },
    mutationFn: (code: string) => unwrap(api.POST('/api/v1/auth/2fa/enable', { body: { code } })),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ME_KEY });
      router.replace('/admin');
    },
    onError: (e) => setError(e.message),
  });
  const logout = () =>
    void api.POST('/api/v1/auth/logout').finally(() => {
      qc.clear();
      router.replace('/login');
    });

  return (
    <AuthCard
      title="Turn on two-factor sign-in"
      description="Your role requires a code from an authenticator app (Google Authenticator, Microsoft Authenticator, Authy)."
    >
      {setup.isError ? (
        <div className="space-y-3 text-sm">
          <p>Your session has ended. Sign in again.</p>
          <Button className="w-full" onClick={() => router.replace('/login')}>
            Sign in
          </Button>
        </div>
      ) : (
        <TotpSetup
          setup={setup.data}
          loading={enable.isPending}
          error={error}
          onSubmit={(e: FormEvent<HTMLFormElement>, code: string) => {
            e.preventDefault();
            setError(undefined);
            enable.mutate(code);
          }}
        />
      )}
      <Button variant="link" size="sm" className="mt-2 w-full" onClick={logout}>
        Sign out
      </Button>
    </AuthCard>
  );
}
