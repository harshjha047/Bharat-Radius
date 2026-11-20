'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  ArrowLeft,
  BarChart3,
  Building2,
  ChevronDown,
  Eye,
  FileSpreadsheet,
  Handshake,
  IndianRupee,
  LayoutDashboard,
  LifeBuoy,
  Lightbulb,
  LogOut,
  Menu as MenuIcon,
  Network,
  Package,
  Radio,
  ReceiptText,
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
import { BrandMark, PoweredBy } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Dialog as D } from 'radix-ui';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/ui/dropdown';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError, onSignedOut, unwrap } from '@/lib/api';
import { useMe, type Me, type Permission } from '@/lib/auth';
import { cn, fmtNum, fmtRupees } from '@/lib/utils';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  any?: Permission[];
}
interface NavGroup {
  label: string;
  icon: LucideIcon;
  items: NavItem[];
}

const STAFF_NAV: NavGroup[] = [
  {
    label: 'Dashboard',
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
    items: [{ href: '/admin/resellers', label: 'Partners', icon: Network, any: ['resellers.read'] }],
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
      { href: '/admin/wallets', label: 'Wallet', icon: Wallet, any: ['billing.read'] },
      { href: '/admin/recharges', label: 'Recharge', icon: RefreshCw, any: ['billing.read'] },
      { href: '/admin/invoices', label: 'Invoice', icon: ReceiptText, any: ['billing.read'] },
      { href: '/admin/payments', label: 'Payment', icon: IndianRupee, any: ['billing.read'] },
    ],
  },
  {
    label: 'Network',
    icon: Router,
    items: [
      { href: '/admin/routers', label: 'Routers', icon: Router, any: ['nas.read'] },
      { href: '/admin/radius-log', label: 'RADIUS log', icon: Activity, any: ['sessions.read'] },
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
    items: [{ href: '/admin/tickets', label: 'Support', icon: LifeBuoy, any: ['tickets.read'] }],
  },
  {
    label: 'System',
    icon: Settings,
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
      items: g.items.filter((i) => !i.any || i.any.some((p) => me.permissions.includes(p))),
    }))
    .filter((g) => g.items.length > 0);

const areaLabel = (me: Me) =>
  me.user.type === 'superadmin' ? 'Platform' : me.user.type === 'reseller' ? 'Reseller' : 'Admin';

type BadgeTone = 'plain' | 'success' | 'warning' | 'danger' | 'info';
interface NavBadge {
  text: string;
  tone: BadgeTone;
  /** Read out instead of the bare text ("4 of 5 have low wallets"). */
  label?: string;
}
const BADGE_TONE: Record<BadgeTone, string> = {
  plain: 'text-muted-foreground',
  success: 'text-success-text',
  warning: 'text-warning-text',
  danger: 'text-danger-text',
  info: 'text-info-text',
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
  if (subs.data) b['/admin/subscribers'] = { text: fmtNum(subs.data.total), tone: 'plain' };
  if (sessions.data) {
    const n = sessions.data.online;
    b['/admin/sessions'] = { text: fmtNum(n), tone: n ? 'success' : 'plain', label: `${n} online` };
  }
  if (plans.data) b['/admin/plans'] = { text: fmtNum(plans.data.items.length), tone: 'plain' };
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
    const bad = w.state === 'empty' || w.state === 'frozen';
    b['/admin/wallets'] = {
      text: fmtRupees(w.balancePaise),
      tone: bad ? 'danger' : w.state === 'low' ? 'warning' : 'plain',
      label: `Balance ${fmtRupees(w.balancePaise)}${w.state === 'normal' ? '' : `, ${w.state}`}`,
    };
    if (w.children > 0) {
      b['/admin/resellers'] = w.lowChildren
        ? {
            text: `${w.lowChildren} low`,
            tone: 'warning',
            label: `${w.lowChildren} of ${w.children} have low wallets`,
          }
        : { text: fmtNum(w.children), tone: 'plain' };
    }
  }
  return b;
}

function Count({ badge }: { badge: NavBadge | undefined }) {
  if (!badge) return null;
  return (
    <span
      className={cn('shrink-0 font-mono text-xs font-medium tabular-nums', BADGE_TONE[badge.tone])}
      {...(badge.label ? { 'aria-label': badge.label } : {})}
    >
      {badge.text}
    </span>
  );
}

const isActive = (href: string, path: string) =>
  href === '/admin' ? path === '/admin' : path === href || path.startsWith(`${href}/`);

const LINK =
  'flex h-9 items-center gap-2.5 rounded-[10px] px-2.5 text-sm font-medium text-sidebar-foreground hover:bg-subtle hover:text-foreground';
const LINK_ACTIVE =
  'bg-sidebar-active font-bold text-sidebar-active-foreground hover:bg-sidebar-active hover:text-sidebar-active-foreground';

/** One link per section; sections with several pages fold open, the one holding the current page stays open. */
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
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  return (
    <nav aria-label="Main" className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3.5">
      {groups.map((g) => {
        const only = g.items.length === 1 ? g.items[0]! : null;
        if (only) {
          const active = isActive(only.href, path);
          return (
            <Link
              key={g.label}
              href={only.href}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              className={cn(LINK, active && LINK_ACTIVE)}
            >
              <g.icon className="size-[18px] shrink-0" strokeWidth={1.8} aria-hidden />
              <span className="flex-1 truncate">{g.label}</span>
              <Count badge={badges[only.href]} />
            </Link>
          );
        }
        const holdsActive = g.items.some((i) => isActive(i.href, path));
        const open = toggled[g.label] ?? holdsActive;
        // Folded sections still surface a problem inside them (an empty wallet, open tickets).
        const urgent = open
          ? undefined
          : g.items
              .map((i) => badges[i.href])
              .find((x) => x && (x.tone === 'danger' || x.tone === 'warning'));
        const id = `nav-${g.label.toLowerCase()}`;
        return (
          <div key={g.label} className="flex flex-col">
            <button
              type="button"
              aria-expanded={open}
              aria-controls={id}
              onClick={() => setToggled((t) => ({ ...t, [g.label]: !open }))}
              className={cn(LINK, 'w-full text-left', holdsActive && !open && 'text-foreground')}
            >
              <g.icon className="size-[18px] shrink-0" strokeWidth={1.8} aria-hidden />
              <span className="flex-1 truncate">{g.label}</span>
              <Count badge={urgent} />
              <ChevronDown
                className={cn('size-4 shrink-0 transition-transform duration-200', open && 'rotate-180')}
                aria-hidden
              />
            </button>
            <div
              id={id}
              hidden={!open}
              className="ml-[19px] flex flex-col gap-0.5 border-l border-divider py-0.5 pl-2.5"
            >
              {g.items.map((i) => {
                const active = isActive(i.href, path);
                return (
                  <Link
                    key={i.href}
                    href={i.href}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={cn(LINK, 'h-8 text-[13px]', active && LINK_ACTIVE)}
                  >
                    <span className="flex-1 truncate">{i.label}</span>
                    <Count badge={badges[i.href]} />
                  </Link>
                );
              })}
            </div>
          </div>
        );
      })}
    </nav>
  );
}

/** Reseller panels show the reseller's own name and logo (F-8); "Powered by" stays at the bottom. */
const Brand = ({ me }: { me: Me | undefined }) => {
  const b = me?.branding;
  return (
    <div className="flex items-center gap-2.5 px-5 pt-5">
      {b?.logoUrl ? (
        <img src={b.logoUrl} alt="" className="h-9 w-auto max-w-24 object-contain" />
      ) : (
        <BrandMark />
      )}
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-base font-extrabold tracking-[-0.03em] text-foreground">
          {b?.name ?? 'BharatRadius'}
        </span>
        <span className="eyebrow truncate text-[10px]">{me ? areaLabel(me) : '\u00a0'}</span>
      </div>
    </div>
  );
};

function Sidebar({ me, onNavigate }: { me: Me | undefined; onNavigate?: () => void }) {
  // A reseller's wallet balance sits on its Wallet menu item, coloured by state: always in view.
  const badges = useNavBadges(me);
  return (
    <div className="flex h-full flex-col gap-[18px] bg-sidebar pb-4">
      <Brand me={me} />
      {me ? (
        <NavLinks groups={visible(me)} badges={badges} onNavigate={onNavigate} />
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
          {me.data?.branding?.logoUrl ? (
            <img src={me.data.branding.logoUrl} alt="" className="h-6 w-auto max-w-20 object-contain" />
          ) : (
            <BrandMark className="h-6" />
          )}
          <span className="flex-1 truncate text-base font-extrabold text-foreground">
            {me.data?.branding?.name ?? 'BharatRadius'}
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
