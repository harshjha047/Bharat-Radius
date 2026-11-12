'use client';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Zap } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import {
  connectionState,
  portalKeys,
  usePortalMe,
  usePortalPay,
  type PortalMe,
  type PortalPlan,
} from '@/components/portal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog, ErrorState } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { api, unwrap } from '@/lib/api';
import { cn, daysUntil, fmtBytes, fmtDate, fmtKbps, fmtRupees } from '@/lib/utils';

const speed = (p: PortalPlan) => `${fmtKbps(p.downloadKbps)} / ${fmtKbps(p.uploadKbps)}`;

export default function PortalHome() {
  const me = usePortalMe();
  if (me.isLoading) return <HomeSkeleton />;
  if (me.isError) return <ErrorState error={me.error} onRetry={() => void me.refetch()} />;
  const m = me.data!;
  return (
    <>
      <h1 className="text-[30px] font-extrabold tracking-[-0.03em] max-sm:hidden">
        Namaste, {m.name.split(' ')[0]}
      </h1>
      <div className="flex flex-col gap-3.5 lg:flex-row lg:items-stretch lg:gap-4">
        <StatusCard me={m} />
        <Tiles me={m} />
      </div>
      {m.duePaise > 0 ? <Dues me={m} /> : null}
      {m.billingType === 'prepaid' ? <Plans me={m} /> : <PostpaidPlan />}
    </>
  );
}

function HomeSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-[420px] w-full rounded-3xl" />
      <div className="grid grid-cols-2 gap-3">
        <Skeleton className="h-28 rounded-[20px]" />
        <Skeleton className="h-28 rounded-[20px]" />
      </div>
    </div>
  );
}

function NoGateway({ me }: { me: PortalMe }) {
  return (
    <p className="text-sm text-muted-foreground">
      Online payment is not available yet. Pay {me.isp.name}
      {me.isp.phone ? ` (${me.isp.phone})` : ''} or your local partner.
    </p>
  );
}

/** Days-left ring: the share of the plan's validity still remaining. */
function DaysRing({ days, of }: { days: number; of: number }) {
  const pct = Math.max(0, Math.min(100, (days / Math.max(of, 1)) * 100));
  return (
    <div
      role="img"
      aria-label={`${days} of ${of} days left`}
      className="relative size-[196px] shrink-0 rounded-full sm:col-start-1! sm:row-span-6 sm:row-start-1 sm:size-[180px]"
      style={{ background: `conic-gradient(var(--primary) 0 ${pct}%, var(--accent) ${pct}% 100%)` }}
    >
      <div className="absolute inset-4 flex flex-col items-center justify-center rounded-full bg-card">
        <span className="text-[60px] leading-none font-extrabold tracking-[-0.04em] text-foreground tabular-nums">
          {days}
        </span>
        <span className="text-base font-semibold">{days === 1 ? 'day left' : 'days left'}</span>
      </div>
    </div>
  );
}

function StatusCard({ me }: { me: PortalMe }) {
  const st = connectionState(me);
  const pay = usePortalPay();
  const canRenew = me.billingType === 'prepaid' && !!me.plan && me.gateways.length > 0;
  const days = me.billingType === 'prepaid' ? daysUntil(me.expiresAt) : null;
  return (
    <section className="flex flex-col items-center gap-3.5 rounded-3xl border bg-card px-5 py-[22px] text-center sm:grid sm:grid-cols-[auto_minmax(0,1fr)] sm:content-center sm:items-center sm:justify-items-start sm:gap-x-7 sm:rounded-[20px] sm:p-7 sm:text-left sm:*:col-start-2 lg:flex-[2_1_0]">
      <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
        <h2 className="text-[22px] font-extrabold tracking-[-0.02em] sm:text-[26px] sm:tracking-[-0.03em]">
          {me.plan?.name ?? 'No plan'}
        </h2>
        <Badge tone={st.tone} className="h-[26px] text-[13px] font-bold">
          {st.label}
        </Badge>
      </div>
      <p className="-mt-1.5 text-[15px] sm:mt-0 sm:text-base">
        {me.plan ? speed(me.plan) : 'Ask your provider to set a plan.'}
        {me.plan
          ? ` · ${me.plan.dataCapBytes ? `${fmtBytes(me.plan.dataCapBytes)} data` : 'Unlimited data'}`
          : ''}
      </p>
      {days !== null && days > 0 && me.plan ? <DaysRing days={days} of={me.plan.validityDays} /> : null}
      <p className={cn('text-base', st.tone === 'danger' && 'font-semibold text-danger-text')}>
        {me.billingType === 'prepaid' && me.expiresAt && !me.expired && me.status === 'active' ? (
          <>
            Valid until <strong className="text-foreground">{fmtDate(me.expiresAt)}</strong>
          </>
        ) : (
          st.detail
        )}
      </p>
      {me.billingType === 'prepaid' && me.plan ? (
        me.gateways.length ? (
          <>
            <Button
              variant="brand"
              className="h-[60px] w-full text-[19px] sm:h-14 sm:w-auto sm:px-8 sm:text-lg [&_svg]:size-5"
              loading={pay.isPending}
              disabled={!canRenew}
              onClick={() => pay.mutate({ planId: me.plan!.id })}
            >
              {pay.isPending ? null : <Zap strokeWidth={2.2} aria-hidden />}
              Recharge {fmtRupees(me.plan.pricePaise)}
            </Button>
            <p className="text-sm text-muted-foreground">Pay with UPI, card or net banking</p>
          </>
        ) : (
          <NoGateway me={me} />
        )
      ) : null}
    </section>
  );
}

function Tiles({ me }: { me: PortalMe }) {
  const usage = useQuery({
    queryKey: portalKeys.usage,
    queryFn: () => unwrap(api.GET('/api/v1/portal/usage')),
  });
  const cycle = usage.data?.cycle;
  const used = cycle?.usedBytes ?? usage.data?.days.reduce((a, d) => a + d.downloadBytes + d.uploadBytes, 0);
  return (
    <div className="grid grid-cols-2 gap-3 lg:flex-[1_1_0] lg:grid-cols-1 lg:gap-4">
      <Link
        href="/portal/bills"
        className="flex flex-col gap-1 rounded-[20px] border bg-card p-4 text-inherit hover:border-input hover:text-inherit"
      >
        <span className="text-sm font-semibold text-body">Amount due</span>
        <span className="text-[26px] font-extrabold text-foreground tabular-nums">
          {fmtRupees(me.duePaise)}
        </span>
        <span
          className={cn(
            'text-[13px] font-semibold',
            me.duePaise > 0 ? 'text-danger-text' : 'text-success-text',
          )}
        >
          {me.duePaise > 0
            ? `${me.dueInvoices} bill${me.dueInvoices === 1 ? '' : 's'} to pay`
            : 'Nothing to pay'}
        </span>
      </Link>
      <Link
        href="/portal/usage"
        className="flex flex-col gap-1 rounded-[20px] border bg-card p-4 text-inherit hover:border-input hover:text-inherit"
      >
        <span className="text-sm font-semibold text-body">Data used</span>
        {usage.isLoading ? (
          <Skeleton className="my-1.5 h-7 w-24" />
        ) : (
          <span className="text-[26px] font-extrabold text-foreground tabular-nums">
            {fmtBytes(used ?? 0)}
          </span>
        )}
        <span className="text-[13px] text-muted-foreground">
          {cycle?.start ? `since ${fmtDate(cycle.start)}` : 'last 31 days'}
        </span>
      </Link>
      <Link
        href="/portal/support"
        className="col-span-2 flex min-h-14 lg:col-span-1 items-center gap-3 rounded-[20px] bg-info-bg px-4 py-3.5 text-info-text hover:text-info-text"
      >
        <span className="flex-1 text-[15px] font-semibold">Internet not working? Report a problem</span>
        <ChevronRight className="size-[18px]" aria-hidden />
      </Link>
    </div>
  );
}

function Dues({ me }: { me: PortalMe }) {
  const pay = usePortalPay();
  const inv = useQuery({
    queryKey: [...portalKeys.invoices, 'due'],
    queryFn: () => unwrap(api.GET('/api/v1/portal/invoices', { params: { query: { limit: 20 } } })),
  });
  const due = (inv.data?.items ?? []).filter((i) => i.balancePaise > 0 && i.status !== 'cancelled');
  return (
    <Card className="rounded-[20px]">
      <CardHeader>
        <CardTitle className="text-lg font-extrabold">Amount due {fmtRupees(me.duePaise)}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {inv.isLoading ? <Skeleton className="h-12 w-full" /> : null}
        {due.map((i) => (
          <div
            key={i.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border p-3.5"
          >
            <div className="text-sm">
              <p className="font-medium">{i.number}</p>
              <p className="text-muted-foreground">
                Due {fmtDate(i.dueDate)}
                {i.status === 'overdue' ? ' · overdue' : ''}
              </p>
            </div>
            {me.gateways.length ? (
              <Button
                className="h-11"
                loading={pay.isPending && pay.variables?.invoiceId === i.id}
                onClick={() => pay.mutate({ invoiceId: i.id })}
              >
                Pay {fmtRupees(i.balancePaise)}
              </Button>
            ) : null}
          </div>
        ))}
        {!me.gateways.length ? <NoGateway me={me} /> : null}
      </CardContent>
    </Card>
  );
}

function Plans({ me }: { me: PortalMe }) {
  const pay = usePortalPay();
  const [pick, setPick] = useState<PortalPlan | null>(null);
  const plans = useQuery({
    queryKey: portalKeys.plans,
    queryFn: () => unwrap(api.GET('/api/v1/portal/plans')),
  });
  const items = plans.data?.items ?? [];
  if (!plans.isLoading && !items.some((p) => !p.current)) return null;
  return (
    <section className="flex flex-col gap-3" aria-labelledby="change-plan">
      <h2 id="change-plan" className="mt-2 text-xl font-extrabold">
        Change plan
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {plans.isLoading
          ? Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-20 w-full rounded-[20px]" />)
          : null}
        {items.map((p) => (
          <div
            key={p.id}
            className={cn(
              'flex items-center gap-3.5 rounded-[20px] border bg-card px-[18px] py-4 lg:flex-col lg:items-stretch lg:p-[22px]',
              p.current && 'border-2 border-primary',
            )}
          >
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[17px] font-extrabold text-foreground">{fmtKbps(p.downloadKbps)}</span>
                {p.current ? (
                  <span className="inline-flex h-[22px] items-center rounded-full bg-accent px-2 text-xs font-bold text-primary">
                    Your plan
                  </span>
                ) : null}
              </div>
              <span className="truncate text-sm text-body">
                {p.name} · {p.validityDays} days
                {p.dataCapBytes ? ` · ${fmtBytes(p.dataCapBytes)}` : ''}
              </span>
            </div>
            <div className="flex flex-col items-end gap-1.5 lg:items-stretch">
              <span className="text-[17px] font-extrabold text-foreground tabular-nums">
                {fmtRupees(p.pricePaise)}
              </span>
              {!p.current ? (
                <Button
                  variant="outline"
                  className="h-11 border-[1.5px] border-primary font-bold text-primary"
                  disabled={!me.gateways.length}
                  onClick={() => setPick(p)}
                >
                  Choose
                </Button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      <ConfirmDialog
        open={!!pick}
        onOpenChange={(o) => !o && setPick(null)}
        title={pick ? `Switch to ${pick.name}?` : ''}
        description={
          pick
            ? `You pay ${fmtRupees(pick.pricePaise)}. As soon as the payment completes your connection moves to ` +
              `${speed(pick)} and ${pick.validityDays} days are added to your validity.`
            : ''
        }
        confirmLabel="Pay and switch"
        loading={pay.isPending}
        onConfirm={() => pick && pay.mutate({ planId: pick.id })}
      />
    </section>
  );
}

function PostpaidPlan() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Monthly billing</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-muted-foreground">
        <p>Your invoice is issued on the 1st of each month.</p>
        <Button variant="outline" asChild>
          <Link href="/portal/support?category=plan_change">Request a plan change</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
