'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  ArrowLeft,
  ArrowUpDown,
  BarChart3,
  Building2,
  ChevronsUpDown,
  Eye,
  FileText,
  Handshake,
  IndianRupee,
  LayoutDashboard,
  LifeBuoy,
  Lightbulb,
  LogOut,
  MonitorCog,
  Menu as MenuIcon,
  Network,
  Package,
  Radio,
  RefreshCw,
  Router,
  ScrollText,
  Settings,
  ShieldCheck,
  Telescope,
  UserCog,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { clearViewAs, currentViewAs, leaveViewAs } from '@/lib/view-as';
import { useEffect, useState, type ReactNode } from 'react';
import { BrandMark, PoweredByDiv } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Dialog as D } from 'radix-ui';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/ui/dropdown';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError, onSignedOut, unwrap } from '@/lib/api';
import { useMe, type Me, type Permission } from '@/lib/auth';
import { activeSidebarUpdate } from '@/lib/sidebar-update';
import { cn, fmtNum, fmtRupees } from '@/lib/utils';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  any?: Permission[];
  /** Shown greyed out with a "Coming soon" tag; not a link yet. */
  soon?: true;
}
interface NavGroup {
  label: string;
  icon: LucideIcon;
  items: NavItem[];
}

const STAFF_NAV: NavGroup[] = [
  {
    label: '',
    icon: LayoutDashboard,
    items: [
      {
        href: '/admin',
        label: 'Dashboard',
        icon: LayoutDashboard,
        any: ['sessions.read', 'subscribers.read'],
      },
    ],
  },
  {
    label: 'Partners',
    icon: Handshake,
    items: [{ href: '/admin/resellers', label: 'Resellers', icon: Network, any: ['resellers.read'] }],
  },
  {
    label: 'Customers',
    icon: Users,
    items: [
      { href: '/admin/subscribers', label: 'Subscribers', icon: Users, any: ['subscribers.read'] },
      { href: '/admin/sessions', label: 'Online now', icon: Radio, any: ['sessions.read'] },
      { href: '/admin/plans', label: 'Plans', icon: Package, any: ['plans.read'] },
    ],
  },
  {
    label: 'Billing',
    icon: IndianRupee,
    items: [
      { href: '/admin/wallets', label: 'Wallets', icon: Wallet, any: ['billing.read'] },
      { href: '/admin/recharges', label: 'Recharges', icon: RefreshCw, any: ['billing.read'] },
      { href: '/admin/invoices', label: 'Invoices', icon: FileText, any: ['billing.read'] },
      { href: '/admin/payments', label: 'Payments', icon: IndianRupee, any: ['billing.read'] },
    ],
  },
  {
    label: 'Network',
    icon: Router,
    items: [
      { href: '/admin/routers', label: 'Routers', icon: Router, any: ['nas.read'] },
      { href: '/admin/radius-log', label: 'RADIUS log', icon: Activity, any: ['sessions.read'] },
      { href: '/admin/tr069', label: 'TR-069', icon: MonitorCog, any: ['nas.read'], soon: true },
    ],
  },
  {
    label: 'Drishti',
    icon: Telescope,
    items: [
      { href: '/admin/insights', label: 'Insights', icon: Lightbulb, any: ['reports.view'] },
      { href: '/admin/reports', label: 'Reports', icon: BarChart3, any: ['reports.view'] },
    ],
  },
  {
    label: 'Support',
    icon: LifeBuoy,
    items: [{ href: '/admin/tickets', label: 'Tickets', icon: LifeBuoy, any: ['tickets.read'] }],
  },
  {
    label: 'System',
    icon: Settings,
    items: [
      {
        href: '/admin/import',
        label: 'Import & export',
        icon: ArrowUpDown,
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
    icon: Building2,
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
      items: g.items
        .filter((i) => !i.any || i.any.some((p) => me.permissions.includes(p)))
        // A reseller's resellers are its sub-resellers.
        .map((i) =>
          me.user.type === 'reseller' && i.href === '/admin/resellers' ? { ...i, label: 'Sub-resellers' } : i,
        ),
    }))
    .filter((g) => g.items.length > 0);

const areaLabel = (me: Me) =>
  me.user.type === 'superadmin' ? 'Platform' : me.user.type === 'reseller' ? 'Reseller' : 'Admin';

type BadgeTone = 'plain' | 'success' | 'warning' | 'danger';
interface NavBadge {
  text: string;
  tone: BadgeTone;
  /** Read out instead of the bare text ("4 of 5 have low wallets"). */
  label?: string;
}
const BADGE_TONE: Record<BadgeTone, string> = {
  plain: 'text-[#6B6772]',
  success: 'text-[#1E7A4A]',
  warning: 'text-[#B45309]',
  danger: 'text-[#B42335]',
};

/**
 * Small live numbers beside menu items, coloured by status instead of dots: green live, orange
 * needs attention, red blocked, grey plain totals. Shares query keys with the dashboard.
 */
function useNavBadges(me: Me | undefined): Record<string, NavBadge> {
  const has = (p: Permission) => !!me?.permissions.includes(p);
  const reseller = me?.user.type === 'reseller';
  const subs = useQuery({
    queryKey: ['subscribers', 'summary'],
    queryFn: () => unwrap(api.GET('/api/v1/subscribers/summary')),
    enabled: has('subscribers.read'),
    staleTime: 60_000,
  });
  const sessions = useQuery({
    queryKey: ['sessions', 'summary'],
    queryFn: () => unwrap(api.GET('/api/v1/sessions/summary')),
    enabled: has('sessions.read'),
    staleTime: 30_000,
  });
  const plans = useQuery({
    queryKey: ['plans', 'all'],
    queryFn: () => unwrap(api.GET('/api/v1/plans', { params: { query: { limit: 200 } } })),
    enabled: has('plans.read'),
    staleTime: 5 * 60_000,
  });
  const tickets = useQuery({
    queryKey: ['tickets', 'counts'],
    queryFn: () => unwrap(api.GET('/api/v1/tickets/counts')),
    enabled: has('tickets.read'),
    staleTime: 60_000,
  });
  const wallet = useQuery({
    queryKey: ['wallet', 'mine'],
    queryFn: () => unwrap(api.GET('/api/v1/wallets/mine')),
    enabled: reseller && has('billing.read'),
    staleTime: 30_000,
  });
  const b: Record<string, NavBadge> = {};
  if (subs.data) {
    const n = subs.data.total;
    b['/admin/subscribers'] = { text: fmtNum(n), tone: 'plain', label: `${fmtNum(n)} subscribers` };
  }
  if (sessions.data) {
    const n = sessions.data.online;
    b['/admin/sessions'] = { text: fmtNum(n), tone: n ? 'success' : 'plain', label: `${n} online` };
  }
  if (plans.data) {
    const n = plans.data.items.length;
    b['/admin/plans'] = { text: fmtNum(n), tone: 'plain', label: `${fmtNum(n)} plans` };
  }
  if (tickets.data) {
    const open = tickets.data.open + tickets.data.in_progress;
    b['/admin/tickets'] = {
      text: fmtNum(open),
      tone: open ? 'warning' : 'plain',
      label: `${open} open tickets`,
    };
  }
  const w = wallet.data;
  if (w) {
    const bad = w.state === 'empty' || w.state === 'frozen' || w.balancePaise < 0;
    const amount = fmtRupees(Math.abs(w.balancePaise));
    b['/admin/wallets'] = {
      text: fmtRupees(w.balancePaise),
      tone: bad ? 'danger' : w.state === 'low' ? 'warning' : 'plain',
      label: `Balance ${w.balancePaise < 0 ? 'minus ' : ''}${amount}${w.state === 'normal' ? '' : `, ${w.state}`}`,
    };
    if (w.children > 0) {
      b['/admin/resellers'] = {
        text: fmtNum(w.children),
        tone: 'plain',
        label: `${fmtNum(w.children)} resellers`,
      };
    }
  }
  return b;
}

function Count({ badge }: { badge: NavBadge | undefined }) {
  if (!badge) return null;
  return (
    <span
      className={cn('shrink-0 font-mono text-[11.5px] font-medium tabular-nums', BADGE_TONE[badge.tone])}
      {...(badge.label ? { 'aria-label': badge.label } : {})}
    >
      {badge.text}
    </span>
  );
}

const isActive = (href: string, path: string) =>
  href === '/admin' ? path === '/admin' : path === href || path.startsWith(`${href}/`);

const ITEM =
  'flex h-9 items-center gap-3 rounded-[9px] px-3 text-sm font-medium text-[#3A3640] transition-colors duration-200 hover:bg-[#F4F2EF] hover:text-[#16131A] focus-visible:shadow-[0_0_0_2px_#3A3640] focus-visible:outline-none motion-reduce:transition-none';
const ITEM_ACTIVE = 'bg-[#F1EFEC] font-semibold text-[#16131A] hover:bg-[#F1EFEC]';

/** Every section always expanded: heading, then its pages with icon and live count. */
function NavLinks({
  groups,
  badges,
  onNavigate,
}: {
  groups: NavGroup[];
  badges: Record<string, NavBadge>;
  onNavigate?: () => void;
}) {
  const path = usePathname();
  return (
    <nav
      aria-label="Main"
      className="relative -mx-1 flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-1 pb-6 [mask-image:linear-gradient(180deg,#000_calc(100%-24px),transparent)]"
    >
      {groups.map((g) => {
        const id = g.label ? `nav-${g.label.toLowerCase()}` : undefined;
        return (
          <section key={g.label || 'home'} aria-labelledby={id} className="flex flex-col gap-0.5">
            {g.label ? (
              <h2
                id={id}
                className="px-3 pb-1.5 text-[11px] leading-[15px] font-semibold tracking-[0.08em] text-[#6B6772] uppercase"
              >
                {g.label}
              </h2>
            ) : null}
            {g.items.map((i) => {
              if (i.soon)
                return (
                  <span
                    key={i.href}
                    aria-disabled="true"
                    className={cn(
                      ITEM,
                      'cursor-not-allowed text-[#6B6772] hover:bg-transparent hover:text-[#6B6772]',
                    )}
                  >
                    <i.icon className="size-4 shrink-0" strokeWidth={1.8} aria-hidden />
                    <span className="flex-1 truncate">{i.label}</span>
                    <span className="shrink-0 rounded-full bg-[#F1EFEC] px-2 py-0.5 text-[10.5px] leading-4 font-semibold text-[#6B6772]">
                      Coming soon
                    </span>
                  </span>
                );
              const active = isActive(i.href, path);
              return (
                <Link
                  key={i.href}
                  href={i.href}
                  onClick={onNavigate}
                  aria-current={active ? 'page' : undefined}
                  className={cn(ITEM, i.href === '/admin' && 'h-[38px]', active && ITEM_ACTIVE)}
                >
                  <i.icon className="size-4 shrink-0" strokeWidth={1.8} aria-hidden />
                  <span className="flex-1 truncate">{i.label}</span>
                  <Count badge={badges[i.href]} />
                </Link>
              );
            })}
          </section>
        );
      })}
    </nav>
  );
}

const Brand = ({ me }: { me: Me | undefined }) => {
  const b = me?.branding;
  return (
    <div className="relative flex h-9 shrink-0 items-center gap-2.5 px-3">
      {b?.logoUrl ? (
        <img src={b.logoUrl} alt="" className="h-7 w-auto max-w-24 object-contain" />
      ) : (
        <BrandMark className="h-7" />
      )}
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-[15px] leading-[17px] font-bold tracking-[-0.01em] text-[#16131A]">
          {b?.name ?? 'Bharat Radius'}
        </span>
        <span className="truncate font-mono text-[10px] leading-3 tracking-[0.1em] text-[#6B6772] uppercase">
          {me ? areaLabel(me) : '\u00a0'}
        </span>
      </div>
    </div>
  );
};

/** Announcement or ad above the user card; renders nothing at all when none is active. */
function UpdatesSlot() {
  const [broken, setBroken] = useState(false);
  const u = activeSidebarUpdate();
  if (!u) return null;
  return (
    <aside aria-label="Updates" className="flex flex-col gap-1.5">
      <p className="px-1 text-[10.5px] font-semibold tracking-[0.08em] text-[#8B8792] uppercase">Updates</p>
      <a
        href={u.href}
        target="_blank"
        rel="noopener"
        className="block aspect-[4/3] w-full overflow-hidden rounded-xl focus-visible:shadow-[0_0_0_2px_#3A3640] focus-visible:outline-none"
      >
        {broken ? (
          <span className="grid size-full place-items-center rounded-xl border border-dashed border-[#D9D6DE] bg-[#F7F7F5] px-3 text-center text-xs text-[#6B6772]">
            {u.alt}
          </span>
        ) : (
          <img
            src={u.imageUrl}
            alt={u.alt}
            className="size-full object-cover"
            onError={() => setBroken(true)}
          />
        )}
      </a>
    </aside>
  );
}

function Sidebar({ me, onNavigate }: { me: Me | undefined; onNavigate?: () => void }) {
  const badges = useNavBadges(me);
  return (
    <div className="relative flex h-full flex-col gap-[22px] bg-white px-3.5 pt-5 pb-4">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-1/4 bg-[linear-gradient(180deg,rgba(255,255,255,0)_0%,#FFFFFF_92%)]"
      />
      <Brand me={me} />
      {me ? (
        <NavLinks groups={visible(me)} badges={badges} onNavigate={onNavigate} />
      ) : (
        <div className="relative flex-1 space-y-2">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-9" />
          ))}
        </div>
      )}
      <div className="relative flex shrink-0 flex-col gap-2.5 pt-1.5">
        <UpdatesSlot />
        {me ? <UserMenu me={me} /> : null}
        <PoweredByDiv />
      </div>
    </div>
  );
}

function UserMenu({ me }: { me: Me }) {
  const router = useRouter();
  const qc = useQueryClient();
  const contact = me.user.email ?? me.user.phone ?? '';
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
          aria-label={`Account: ${me.user.name}${contact ? `, ${contact}` : ''}`}
          className="flex w-full items-center gap-2.5 rounded-xl bg-white px-2.5 py-2 text-left shadow-[0_1px_2px_rgba(17,24,39,.10),0_4px_12px_-4px_rgba(17,24,39,.18)] transition-colors duration-200 hover:bg-[#F4F2EF] focus-visible:shadow-[0_0_0_2px_#3A3640] focus-visible:outline-none motion-reduce:transition-none"
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[#F1EFEC] text-[13px] font-semibold text-[#3A3640]">
            {(me.user.name.trim()[0] ?? '?').toUpperCase()}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[13px] leading-4 font-semibold text-[#16131A]">
              {me.user.name}
            </span>
            <span className="truncate text-[11.5px] text-[#6B6772]">{contact}</span>
          </span>
          <ChevronsUpDown className="size-[15px] shrink-0 text-[#8B8792]" aria-hidden />
        </button>
      </MenuTrigger>
      <MenuContent align="start" side="top">
        <MenuLabel>{contact}</MenuLabel>
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
  // A panel opened with "Open panel" that is no longer allowed (reseller deleted, rights changed): back to own panel.
  useEffect(() => {
    if ((status === 403 || status === 404) && currentViewAs()) {
      clearViewAs();
      void qc.resetQueries();
    }
  }, [status, qc]);
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
    <div className="min-h-dvh lg:grid lg:grid-cols-[264px_1fr]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-xl focus:bg-card focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <aside className="sticky top-0 hidden h-dvh border-r border-[#ECEAEF] lg:block">
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
                className="fixed inset-y-0 left-0 z-50 w-[264px] border-r border-[#ECEAEF] lg:hidden"
                aria-describedby={undefined}
              >
                <D.Title className="sr-only">Menu</D.Title>
                <Sidebar me={me.data} onNavigate={() => setOpen(false)} />
              </D.Content>
            </D.Portal>
          </D.Root>
          {me.data?.branding?.logoUrl ? (
            <img src={me.data.branding.logoUrl} alt="" className="h-6 w-auto max-w-20 object-contain" />
          ) : (
            <BrandMark className="h-6" />
          )}
          <span className="flex-1 truncate text-base font-extrabold text-foreground">
            {me.data?.branding?.name ?? 'Bharat Radius'}
          </span>
        </header>
        {me.data?.viewAs ? (
          <div
            role="status"
            className="sticky top-0 z-20 flex flex-wrap items-center gap-2 bg-[linear-gradient(180deg,#e3d8f6_0%,#eee8f8_45%,var(--background)_100%)] px-4 py-2 text-[13px] text-body sm:px-8"
          >
            <span className="mr-auto flex min-w-0 items-center gap-2">
              <Eye className="size-[15px] shrink-0" aria-hidden />
              <span className="sr-only">Viewing</span>
              <span className="truncate">
                {me.data.viewAs.name} ({me.data.viewAs.code}) · {me.data.viewAs.byName}
              </span>
            </span>
            <Button
              size="sm"
              variant="outline"
              className="border-input bg-card/70 text-body hover:bg-card"
              onClick={() => {
                leaveViewAs();
                qc.clear();
                router.push('/admin');
              }}
            >
              <ArrowLeft /> Back to Admin
            </Button>
          </div>
        ) : null}
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
