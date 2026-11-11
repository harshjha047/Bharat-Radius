'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileText, Gauge, Home, LogOut, UserRound } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { usePortalMe } from '@/components/portal';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, onPortalSignedOut, unwrap } from '@/lib/api';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/portal', label: 'Home', icon: Home },
  { href: '/portal/usage', label: 'Usage', icon: Gauge },
  { href: '/portal/bills', label: 'Bills', icon: FileText },
  { href: '/portal/account', label: 'Account', icon: UserRound },
] as const;

export default function PortalLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const qc = useQueryClient();
  const me = usePortalMe();

  useEffect(
    () =>
      onPortalSignedOut(() => {
        qc.removeQueries({ queryKey: ['portal'] });
        router.replace('/portal/login');
      }),
    [qc, router],
  );

  const logout = useMutation({
    mutationFn: () => unwrap(api.POST('/api/v1/portal/auth/logout')),
    onSettled: () => {
      qc.removeQueries({ queryKey: ['portal'] });
      router.replace('/portal/login');
    },
  });

  return (
    <div className="min-h-dvh bg-muted/40 pb-20 sm:pb-0">
      <header className="sticky top-0 z-30 border-b bg-card">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between gap-3 px-4">
          <div className="min-w-0">
            {me.data ? (
              <>
                <p className="truncate text-sm font-semibold">{me.data.isp.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {me.data.name} · {me.data.customerNo}
                </p>
              </>
            ) : (
              <Skeleton className="h-8 w-40" />
            )}
          </div>
          <nav className="hidden gap-1 sm:flex" aria-label="Portal">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm hover:bg-muted',
                  path === n.href && 'bg-muted font-medium',
                )}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Sign out"
            loading={logout.isPending}
            onClick={() => logout.mutate()}
          >
            <LogOut />
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-3xl space-y-4 px-4 py-5">{children}</main>
      <nav
        aria-label="Portal"
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t bg-card sm:hidden"
      >
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            className={cn(
              'flex flex-col items-center gap-0.5 py-2 text-xs text-muted-foreground',
              path === n.href && 'font-medium text-foreground',
            )}
          >
            <n.icon className="size-5" aria-hidden />
            {n.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
