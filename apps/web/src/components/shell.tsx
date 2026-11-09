'use client';
import { useQueryClient } from '@tanstack/react-query';
import {
  Building2,
  FileSpreadsheet,
  Gauge,
  LogOut,
  Menu as MenuIcon,
  IndianRupee,
  Network,
  ReceiptText,
  RefreshCw,
  Wallet,
  Package,
  Radio,
  Router,
  ScrollText,
  Settings,
  ShieldCheck,
  UserCog,
  Users,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog as D } from 'radix-ui';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/ui/dropdown';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError, onSignedOut } from '@/lib/api';
import { useMe, type Me, type Permission } from '@/lib/auth';
import { cn } from '@/lib/utils';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  any?: Permission[];
}

const STAFF_NAV: NavItem[] = [
  { href: '/admin', label: 'Dashboard', icon: Gauge, any: ['sessions.read', 'subscribers.read'] },
  { href: '/admin/subscribers', label: 'Subscribers', icon: Users, any: ['subscribers.read'] },
  { href: '/admin/sessions', label: 'Online now', icon: Radio, any: ['sessions.read'] },
  { href: '/admin/resellers', label: 'Resellers', icon: Network, any: ['resellers.read'] },
  { href: '/admin/wallets', label: 'Wallets', icon: Wallet, any: ['billing.read'] },
  { href: '/admin/recharges', label: 'Recharges', icon: RefreshCw, any: ['billing.read'] },
  { href: '/admin/invoices', label: 'Invoices', icon: ReceiptText, any: ['billing.read'] },
  { href: '/admin/payments', label: 'Payments', icon: IndianRupee, any: ['billing.read'] },
  { href: '/admin/plans', label: 'Plans', icon: Package, any: ['plans.read'] },
  { href: '/admin/routers', label: 'Routers', icon: Router, any: ['nas.read'] },
  {
    href: '/admin/import',
    label: 'Import & export',
    icon: FileSpreadsheet,
    any: ['imports.run', 'subscribers.export'],
  },
  { href: '/admin/users', label: 'Staff & roles', icon: UserCog, any: ['users.read'] },
  { href: '/admin/audit', label: 'Audit log', icon: ScrollText, any: ['audit.view'] },
  { href: '/admin/settings', label: 'ISP settings', icon: Settings, any: ['tenant.settings'] },
];
const SUPER_NAV: NavItem[] = [
  { href: '/super/tenants', label: 'ISPs', icon: Building2 },
  { href: '/admin/audit', label: 'Audit log', icon: ScrollText },
];

const visible = (me: Me) =>
  (me.user.type === 'superadmin' ? SUPER_NAV : STAFF_NAV).filter(
    (i) => !i.any || i.any.some((p) => me.permissions.includes(p)),
  );

function NavLinks({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5 p-2">
      {items.map((i) => {
        const active = i.href === '/admin' ? path === '/admin' : path.startsWith(i.href);
        return (
          <Link
            key={i.href}
            href={i.href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm text-sidebar-foreground/80 hover:bg-sidebar-active hover:text-sidebar-foreground',
              active && 'bg-sidebar-active font-medium text-sidebar-foreground',
            )}
          >
            <i.icon className="size-4 shrink-0" aria-hidden />
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}

const Brand = () => (
  <div className="flex h-14 items-center gap-2 px-4 font-semibold text-sidebar-foreground">
    <span className="grid size-7 place-items-center rounded-md bg-primary text-xs text-primary-foreground">
      BR
    </span>
    BharatRadius
  </div>
);

function UserMenu({ me }: { me: Me }) {
  const router = useRouter();
  const qc = useQueryClient();
  const signOut = () =>
    void api.POST('/api/v1/auth/logout').finally(() => {
      qc.clear();
      router.replace('/login');
    });
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="ghost" className="gap-2 px-2" aria-label="Account menu">
          <span className="grid size-7 place-items-center rounded-full bg-accent text-xs font-semibold text-accent-foreground">
            {me.user.name.slice(0, 1).toUpperCase()}
          </span>
          <span className="hidden max-w-40 truncate text-sm sm:inline">{me.user.name}</span>
        </Button>
      </MenuTrigger>
      <MenuContent>
        <MenuLabel>{me.user.email ?? me.user.phone}</MenuLabel>
        <MenuSeparator />
        <MenuItem onSelect={() => router.push('/account')}>
          <ShieldCheck /> My account
        </MenuItem>
        <MenuItem onSelect={signOut}>
          <LogOut /> Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const qc = useQueryClient();
  const me = useMe();
  const [open, setOpen] = useState(false);

  useEffect(
    () =>
      onSignedOut(() => {
        qc.clear();
        router.replace(`/login?next=${encodeURIComponent(path)}`);
      }),
    [qc, router, path],
  );

  const status = me.error instanceof ApiError ? me.error.status : null;
  const enrol = me.data?.mfa === 'enroll';
  const isSuper = me.data?.user.type === 'superadmin';
  const wrongArea =
    me.data && (isSuper ? path.startsWith('/admin') && path !== '/admin/audit' : path.startsWith('/super'));
  useEffect(() => {
    if (status === 401) router.replace(`/login?next=${encodeURIComponent(path)}`);
    else if (enrol) router.replace('/setup-2fa');
    else if (wrongArea) router.replace(isSuper ? '/super/tenants' : '/admin');
  }, [status, enrol, wrongArea, isSuper, router, path]);

  if (me.isError && status !== 401) {
    return (
      <div className="grid min-h-dvh place-items-center p-6 text-center text-sm">
        <div className="space-y-3">
          <p>Cannot reach the server.</p>
          <Button variant="outline" onClick={() => void me.refetch()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  const items = me.data ? visible(me.data) : [];
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_1fr]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <aside className="sticky top-0 hidden h-dvh flex-col bg-sidebar lg:flex">
        <Brand />
        {me.data ? (
          <NavLinks items={items} />
        ) : (
          <div className="space-y-2 p-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-8 bg-sidebar-active" />
            ))}
          </div>
        )}
      </aside>
      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/90 px-3 backdrop-blur sm:px-6">
          <D.Root open={open} onOpenChange={setOpen}>
            <D.Trigger asChild>
              <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open menu">
                <MenuIcon />
              </Button>
            </D.Trigger>
            <D.Portal>
              <D.Overlay className="fixed inset-0 z-40 bg-black/50 lg:hidden" />
              <D.Content
                className="fixed inset-y-0 left-0 z-50 w-64 bg-sidebar lg:hidden"
                aria-describedby={undefined}
              >
                <D.Title className="sr-only">Menu</D.Title>
                <Brand />
                <NavLinks items={items} onNavigate={() => setOpen(false)} />
              </D.Content>
            </D.Portal>
          </D.Root>
          <span className="font-semibold lg:hidden">BharatRadius</span>
          <div className="flex-1" />
          {me.data ? <UserMenu me={me.data} /> : <Skeleton className="h-8 w-28" />}
        </header>
        <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-3 py-5 sm:px-6 sm:py-6">
          {me.data && !enrol && !wrongArea ? children : <PageSkeleton />}
        </main>
      </div>
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div className="space-y-4" aria-busy>
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-4 w-72" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
