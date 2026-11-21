'use client';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { WidgetDef } from '@/components/dashboard-config';
import { useSubscriberSummary } from '@/components/dashboard-widgets';
import { StatCard, StatCardSkeleton, type StatCardProps } from '@/components/stat-card';
import { api, unwrap, type ApiData } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { fmtNum, fmtRupees } from '@/lib/utils';

export interface GlanceCard {
  id: string;
  label: string;
  defaultHidden?: boolean;
  render: () => ReactNode;
}

type MyWallet = ApiData<'/api/v1/wallets/mine'>;
type Q = { isLoading: boolean; isError: boolean };

/** Skeleton while loading; on error the card stays, with a muted "—", still a link. */
function card(q: Q, p: StatCardProps) {
  if (q.isLoading) return <StatCardSkeleton />;
  if (!q.isError) return <StatCard {...p} />;
  return <StatCard label={p.label} value="—" href={p.href} />;
}

const walletTone = (w: MyWallet | undefined): StatCardProps['tone'] =>
  !w
    ? 'plain'
    : w.state === 'empty' || w.state === 'frozen' || w.balancePaise < 0
      ? 'danger'
      : w.state === 'low'
        ? 'warning'
        : 'plain';

/**
 * "At a glance" cards, one Customise entry each. Resellers get the 8-card set (ids `r-stat-*`);
 * staff get the same subscriber cards plus admin extras (ids `stat-*`, extras start hidden).
 * Sparklines and trends wait for per-day history; until then the cards show value and change line only.
 */
export function useGlanceCards(
  kind: 'reseller' | 'staff',
  wallet?: { data: MyWallet | undefined } & Q,
): GlanceCard[] {
  const can = useCan();
  const p = kind === 'reseller' ? 'r-stat-' : 'stat-';
  const subsOk = can('subscribers.read');
  const subs = useSubscriberSummary();
  const sessions = useQuery({
    queryKey: ['sessions', 'summary'],
    queryFn: () => unwrap(api.GET('/api/v1/sessions/summary')),
    enabled: can('sessions.read'),
    refetchInterval: 30_000,
  });
  const tickets = useQuery({
    queryKey: ['tickets', 'counts'],
    queryFn: () => unwrap(api.GET('/api/v1/tickets/counts')),
    enabled: kind === 'staff' && can('tickets.read'),
    staleTime: 60_000,
  });
  const billing = useQuery({
    queryKey: ['billing', 'summary'],
    queryFn: () => unwrap(api.GET('/api/v1/billing/summary')),
    enabled: kind === 'staff' && can('billing.read'),
    refetchInterval: 60_000,
  });
  const s = subs.data;
  const renew = (paise: number | undefined) =>
    paise ? { today: fmtRupees(paise), todayLabel: 'to renew' } : {};

  const cards: (GlanceCard | false)[] = [
    subsOk && {
      id: `${p}total`,
      label: 'Total subscribers',
      render: () =>
        card(subs, {
          label: 'Total subscribers',
          value: fmtNum(s?.total ?? 0),
          tone: 'plain',
          href: '/admin/subscribers',
        }),
    },
    can('sessions.read') && {
      id: `${p}online`,
      label: 'Online now',
      render: () =>
        card(sessions, {
          label: 'Online now',
          value: fmtNum(sessions.data?.online ?? 0),
          tone: 'success',
          href: '/admin/sessions',
        }),
    },
    subsOk && {
      id: `${p}active`,
      label: 'Active subscribers',
      render: () =>
        card(subs, {
          label: 'Active subscribers',
          value: fmtNum(s?.active ?? 0),
          tone: 'success',
          href: '/admin/subscribers?status=active',
        }),
    },
    subsOk && {
      id: `${p}expired`,
      label: 'Expired subscribers',
      render: () =>
        card(subs, {
          label: 'Expired subscribers',
          value: fmtNum(s?.expired ?? 0),
          tone: 'danger',
          href: '/admin/subscribers?status=expired',
        }),
    },
    subsOk && {
      id: `${p}today`,
      label: 'Expiring today',
      render: () =>
        card(subs, {
          label: 'Expiring today',
          value: fmtNum(s?.expiringToday ?? 0),
          tone: 'warning',
          ...renew(s?.renewPaise.today),
          href: '/admin/subscribers?expiry=today',
        }),
    },
    subsOk && {
      id: `${p}tomorrow`,
      label: 'Expiring tomorrow',
      render: () =>
        card(subs, {
          label: 'Expiring tomorrow',
          value: fmtNum(s?.expiringTomorrow ?? 0),
          tone: 'warning',
          ...renew(s?.renewPaise.tomorrow),
          href: '/admin/subscribers?expiry=tomorrow',
        }),
    },
    subsOk && {
      id: `${p}7d`,
      label: 'Next 7 days',
      render: () =>
        card(subs, {
          label: 'Next 7 days',
          value: fmtNum(s?.expiring7d ?? 0),
          tone: 'info',
          ...renew(s?.renewPaise.next7d),
          href: '/admin/subscribers?expiry=7d',
        }),
    },
    kind === 'reseller' &&
      !!wallet &&
      can('billing.read') && {
        id: `${p}wallet`,
        label: 'Wallet balance',
        render: () =>
          card(wallet, {
            label: 'Wallet balance',
            value: fmtRupees(wallet.data?.balancePaise ?? 0),
            tone: walletTone(wallet.data),
            href: wallet.data?.canViewLedger ? `/admin/wallets/${wallet.data.id}` : '/admin/wallets',
          }),
      },
    kind === 'staff' &&
      can('tickets.read') && {
        id: `${p}tickets`,
        label: 'Open tickets',
        defaultHidden: true,
        render: () =>
          card(tickets, {
            label: 'Open tickets',
            value: fmtNum(tickets.data ? tickets.data.open + tickets.data.in_progress : 0),
            tone: 'warning',
            href: '/admin/tickets',
          }),
      },
    kind === 'staff' &&
      can('billing.read') && {
        id: `${p}unpaid`,
        label: 'Total unpaid amount',
        defaultHidden: true,
        render: () =>
          card(billing, {
            label: 'Total unpaid amount',
            value: fmtRupees(billing.data?.unpaid.balancePaise ?? 0),
            tone: 'danger',
            ...(billing.data?.unpaid.count
              ? { today: fmtNum(billing.data.unpaid.count), todayLabel: 'invoices' }
              : {}),
            href: '/admin/invoices',
          }),
      },
    kind === 'staff' &&
      can('billing.read') && {
        id: `${p}recharges`,
        label: "Today's recharges",
        render: () =>
          card(billing, {
            label: 'Today’s recharges',
            value: fmtRupees(billing.data?.today.rechargePaise ?? 0),
            tone: 'success',
            ...(billing.data?.today.recharges
              ? { today: fmtNum(billing.data.today.recharges), todayLabel: 'recharges' }
              : {}),
            href: '/admin/recharges',
          }),
      },
  ];
  return cards.filter((c): c is GlanceCard => !!c);
}

/** Customise entry for a card. */
export const glanceWidget = (g: GlanceCard): WidgetDef =>
  g.defaultHidden ? { id: g.id, label: g.label, defaultHidden: true } : { id: g.id, label: g.label };

export const isGlanceId = (id: string) => id.startsWith('stat-') || id.startsWith('r-stat-');

/** 4 per row when the content is ≥ 996px wide, 2 from 492px, else 1 (container-based, so the sidebar never squeezes cards under 240px). */
export function GlanceGrid({ children }: { children: ReactNode }) {
  return (
    <section aria-label="At a glance" className="@container">
      <div className="grid grid-cols-1 gap-3 @min-[492px]:grid-cols-2 @min-[996px]:grid-cols-4">
        {children}
      </div>
    </section>
  );
}
