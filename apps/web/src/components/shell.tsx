'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
  LifeBuoy,
  BarChart3,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { BrandMark, PoweredBy } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Dialog as D } from 'radix-ui';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/ui/dropdown';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError, onSignedOut, unwrap } from '@/lib/api';
import { useMe, type Me, type Permission } from '@/lib/auth';
import { cn, fmtRupees } from '@/lib/utils';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  any?: Permission[];
}
interface NavGroup {
  label: string;
  items: NavItem[];
}

const STAFF_NAV: NavGroup[] = [
  {
    label: 'Overview',
    items: [{ href: '/admin', label: 'Dashboard', icon: Gauge, any: ['sessions.read', 'subscribers.read'] }],
  },
  {
    label: 'Customers',
    items: [
      { href: '/admin/subscribers', label: 'Subscribers', icon: Users, any: ['subscribers.read'] },
      { href: '/admin/sessions', label: 'Online now', icon: Radio, any: ['sessions.read'] },
      { href: '/admin/plans', label: 'Plans', icon: Package, any: ['plans.read'] },
    ],
  },
  {
    label: 'Billing',
    items: [
      { href: '/admin/wallets', label: 'Wallets', icon: Wallet, any: ['billing.read'] },
      { href: '/admin/recharges', label: 'Recharges', icon: RefreshCw, any: ['billing.read'] },
      { href: '/admin/invoices', label: 'Invoices', icon: ReceiptText, any: ['billing.read'] },
      { href: '/admin/payments', label: 'Payments', icon: IndianRupee, any: ['billing.read'] },
      { href: '/admin/reports', label: 'Reports', icon: BarChart3, any: ['reports.view'] },
    ],
  },
  {
    label: 'Network',
    items: [{ href: '/admin/routers', label: 'Routers', icon: Router, any: ['nas.read'] }],
  },
  {
    label: 'Partners',
    items: [{ href: '/admin/resellers', label: 'Resellers', icon: Network, any: ['resellers.read'] }],
  },
  {
    label: 'Support',
    items: [{ href: '/admin/tickets', label: 'Tickets', icon: LifeBuoy, any: ['tickets.read'] }],
  },
  {
    label: 'System',
    items: [
      {
        href: '/admin/import',
        label: 'Import & export',
        icon: FileSpreadsheet,
        any: ['imports.run', 'subscribers.export'],
      },
      { href: '/admin/users', label: 'Staff & roles', icon: UserCog, any: ['users.read'] },
      { href: '/admin/audit', label: 'Audit log', icon: ScrollText, any: ['audit.view'] },
      { href: '/admin/settings', label: 'ISP settings', icon: Settings, any: ['tenant.settings'] },
    ],
  },
];
const SUPER_NAV: NavGroup[] = [
  {
    label: 'Platform',
    items: [
      { href: '/super/tenants', label: 'ISPs', icon: Building2 },
      { href: '/admin/audit', label: 'Audit log', icon: ScrollText },
    ],
  },
];

const visible = (me: Me) =>
  (me.user.type === 'superadmin' ? SUPER_NAV : STAFF_NAV)
    .map((g) => ({
      ...g,
      items: g.items.filter((i) => !i.any || i.any.some((p) => me.permissions.includes(p))),
    }))
    .filter((g) => g.items.length > 0);

const areaLabel = (me: Me) =>
  me.user.type === 'superadmin' ? 'Platform' : me.user.type === 'reseller' ? 'Reseller' : 'Admin';

function NavLinks({ groups, onNavigate }: { groups: NavGroup[]; onNavigate?: () => void }) {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-1 flex-col gap-3.5 overflow-y-auto px-3.5">
      {groups.map((g) => (
        <div key={g.label} className="flex flex-col gap-0.5">
          <span className="eyebrow px-2.5 pb-1 text-[10px] tracking-[0.12em]">{g.label}</span>
          {g.items.map((i) => {
            const active = i.href === '/admin' ? path === '/admin' : path.startsWith(i.href);
            return (
              <Link
                key={i.href}
                href={i.href}
                onClick={onNavigate}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex h-9 items-center gap-2.5 rounded-[10px] px-2.5 text-sm font-medium text-sidebar-foreground hover:bg-subtle hover:text-foreground',
                  active &&
                    'bg-sidebar-active font-bold text-sidebar-active-foreground hover:bg-sidebar-active hover:text-sidebar-active-foreground',
                )}
              >
                <i.icon className="size-[18px] shrink-0" strokeWidth={1.8} aria-hidden />
                <span className="flex-1 truncate">{i.label}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

const Brand = ({ me }: { me: Me | undefined }) => (
  <div className="flex items-center gap-2.5 px-5 pt-5">
    <BrandMark />
    <div className="flex min-w-0 flex-col">
      <span className="text-base font-extrabold tracking-[-0.03em] text-foreground">BharatRadius</span>
      <span className="eyebrow truncate text-[10px]">{me ? areaLabel(me) : '\u00a0'}</span>
    </div>
  </div>
);

/** Reseller's own wallet, always in view: they cannot recharge customers without it. */
function WalletCard() {
  const mine = useQuery({
    queryKey: ['wallet', 'mine'],
    queryFn: () => unwrap(api.GET('/api/v1/wallets/mine')),
    staleTime: 30_000,
  });
  const w = mine.data;
  return (
    <Link
      href="/admin/wallets"
      className="mx-3.5 flex flex-col gap-0.5 rounded-xl border px-3 py-2.5 text-inherit hover:bg-subtle hover:text-inherit"
    >
      <span className="eyebrow text-[10px]">Wallet</span>
      {w ? (
        <>
          <span className="text-lg font-extrabold tracking-[-0.02em] text-foreground tabular-nums">
            {fmtRupees(w.balancePaise)}
          </span>
          {w.state === 'low' || w.state === 'empty' || w.state === 'frozen' ? (
            <span
              className={cn(
                'text-xs font-semibold',
                w.state === 'low' ? 'text-warning-text' : 'text-danger-text',
              )}
            >
              {w.state === 'low' ? 'Low balance · top up soon' : w.state === 'empty' ? 'Empty' : 'Frozen'}
            </span>
          ) : null}
        </>
      ) : (
        <Skeleton className="my-1 h-5 w-24" />
      )}
    </Link>
  );
}

function Sidebar({ me, onNavigate }: { me: Me | undefined; onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col gap-[18px] bg-sidebar pb-4">
      <Brand me={me} />
      {me?.user.type === 'reseller' ? <WalletCard /> : null}
      {me ? (
        <NavLinks groups={visible(me)} onNavigate={onNavigate} />
      ) : (
        <div className="flex-1 space-y-2 px-3.5">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-9" />
          ))}
        </div>
      )}
      {me ? <UserMenu me={me} /> : null}
      <PoweredBy className="px-6" />
    </div>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

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
        <button
          type="button"
          aria-label="Account menu"
          className="mx-3.5 flex items-center gap-2.5 rounded-xl border-t px-2.5 pt-3 pb-1 text-left hover:bg-subtle"
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent text-xs font-bold text-accent-foreground">
            {initials(me.user.name)}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[13px] font-bold text-foreground">{me.user.name}</span>
            <span className="truncate text-xs text-muted-foreground">{me.user.email ?? me.user.phone}</span>
          </span>
        </button>
      </MenuTrigger>
      <MenuContent align="start" side="top">
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

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15.5rem_1fr]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-xl focus:bg-card focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <aside className="sticky top-0 hidden h-dvh border-r lg:block">
        <Sidebar me={me.data} />
      </aside>
      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-card px-2 lg:hidden">
          <D.Root open={open} onOpenChange={setOpen}>
            <D.Trigger asChild>
              <Button variant="ghost" size="icon" className="size-11 text-foreground" aria-label="Open menu">
                <MenuIcon className="size-5" />
              </Button>
            </D.Trigger>
            <D.Portal>
              <D.Overlay className="fixed inset-0 z-40 bg-[#24172a]/45 lg:hidden" />
              <D.Content
                className="fixed inset-y-0 left-0 z-50 w-64 border-r lg:hidden"
                aria-describedby={undefined}
              >
                <D.Title className="sr-only">Menu</D.Title>
                <Sidebar me={me.data} onNavigate={() => setOpen(false)} />
              </D.Content>
            </D.Portal>
          </D.Root>
          <BrandMark className="size-6 rounded-[7px] text-[9px]" />
          <span className="flex-1 text-base font-extrabold text-foreground">BharatRadius</span>
        </header>
        <main id="main" className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-5 sm:px-8 sm:py-6">
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
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-28 rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-64 w-full rounded-2xl" />
    </div>
  );
}
