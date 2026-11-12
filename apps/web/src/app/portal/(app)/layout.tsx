'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleHelp, Gauge, Home, LogOut, ReceiptText } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { BrandMark, PoweredBy } from '@/components/brand';
import { usePortalMe } from '@/components/portal';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, onPortalSignedOut, unwrap } from '@/lib/api';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/portal', label: 'Home', icon: Home },
  { href: '/portal/usage', label: 'Usage', icon: Gauge },
  { href: '/portal/bills', label: 'Bills', icon: ReceiptText },
  { href: '/portal/support', label: 'Help', icon: CircleHelp },
] as const;

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

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

  const active = (href: string) => (href === '/portal' ? path === href : path.startsWith(href));
  return (
    <div className="min-h-dvh bg-background pb-24 sm:pb-0">
      <header className="sticky top-0 z-30 border-b bg-card">
        <div className="mx-auto flex h-[60px] max-w-3xl items-center gap-2.5 px-4">
          <BrandMark className="h-7" />
          <div className="min-w-0 flex-1">
            {me.data ? (
              <>
                <p className="truncate text-[17px] leading-tight font-extrabold text-foreground">
                  Namaste, {me.data.name.split(' ')[0]}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {me.data.isp.name} · {me.data.customerNo}
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
                aria-current={active(n.href) ? 'page' : undefined}
                className={cn(
                  'rounded-[10px] px-3 py-2 text-sm font-medium text-body hover:bg-subtle hover:text-foreground',
                  active(n.href) && 'bg-accent font-bold text-primary hover:bg-accent hover:text-primary',
                )}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <Link
            href="/portal/account"
            aria-label="Account"
            aria-current={path.startsWith('/portal/account') ? 'page' : undefined}
            className="grid size-11 shrink-0 place-items-center rounded-full bg-accent text-sm font-extrabold text-primary hover:text-primary"
          >
            {me.data ? initials(me.data.name) : null}
          </Link>
          <Button
            variant="ghost"
            size="icon"
            className="max-sm:hidden"
            aria-label="Sign out"
            loading={logout.isPending}
            onClick={() => logout.mutate()}
          >
            {logout.isPending ? null : <LogOut />}
          </Button>
        </div>
      </header>
      <main className="mx-auto flex max-w-3xl flex-col gap-3.5 px-4 py-4 sm:py-6">
        {children}
        <PoweredBy className="py-3 text-center" />
      </main>
      <nav
        aria-label="Portal"
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t bg-card px-2 pt-1.5 pb-[max(10px,env(safe-area-inset-bottom))] sm:hidden"
      >
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            aria-current={active(n.href) ? 'page' : undefined}
            className={cn(
              'flex min-h-[52px] flex-col items-center justify-center gap-1 rounded-xl text-xs font-medium text-muted-foreground hover:text-foreground',
              active(n.href) && 'font-bold text-primary hover:text-primary',
            )}
          >
            <span
              className={cn('grid h-7 w-14 place-items-center rounded-full', active(n.href) && 'bg-accent')}
            >
              <n.icon className="size-5" strokeWidth={1.8} aria-hidden />
            </span>
            {n.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
