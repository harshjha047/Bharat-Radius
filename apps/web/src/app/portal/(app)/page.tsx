'use client';
import { useQuery } from '@tanstack/react-query';
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
import { fmtBytes, fmtDate, fmtKbps, fmtRupees } from '@/lib/utils';

const speed = (p: PortalPlan) => `${fmtKbps(p.downloadKbps)} / ${fmtKbps(p.uploadKbps)}`;

export default function PortalHome() {
  const me = usePortalMe();
  if (me.isLoading) return <HomeSkeleton />;
  if (me.isError) return <ErrorState error={me.error} onRetry={() => void me.refetch()} />;
  const m = me.data!;
  return (
    <>
      <StatusCard me={m} />
      {m.duePaise > 0 ? <Dues me={m} /> : null}
      {m.billingType === 'prepaid' ? <Plans me={m} /> : <PostpaidPlan me={m} />}
    </>
  );
}

function HomeSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-56 w-full" />
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

function StatusCard({ me }: { me: PortalMe }) {
  const st = connectionState(me);
  const pay = usePortalPay();
  const canRenew = me.billingType === 'prepaid' && !!me.plan && me.gateways.length > 0;
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <CardTitle className="truncate">{me.plan?.name ?? 'No plan'}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {me.plan ? speed(me.plan) : 'Ask your provider to set a plan.'}
            {me.plan?.dataCapBytes ? ` · ${fmtBytes(me.plan.dataCapBytes)} data` : ''}
          </p>
        </div>
        <Badge tone={st.tone}>{st.label}</Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm">{st.detail}</p>
        {me.billingType === 'prepaid' && me.plan ? (
          me.gateways.length ? (
            <Button
              className="w-full sm:w-auto"
              size="lg"
              loading={pay.isPending}
              disabled={!canRenew}
              onClick={() => pay.mutate({ planId: me.plan!.id })}
            >
              Recharge {fmtRupees(me.plan.pricePaise)}
            </Button>
          ) : (
            <NoGateway me={me} />
          )
        ) : null}
      </CardContent>
    </Card>
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
    <Card>
      <CardHeader>
        <CardTitle>Amount due {fmtRupees(me.duePaise)}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {inv.isLoading ? <Skeleton className="h-12 w-full" /> : null}
        {due.map((i) => (
          <div key={i.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
            <div className="text-sm">
              <p className="font-medium">{i.number}</p>
              <p className="text-muted-foreground">
                Due {fmtDate(i.dueDate)}
                {i.status === 'overdue' ? ' · overdue' : ''}
              </p>
            </div>
            {me.gateways.length ? (
              <Button
                size="sm"
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
  const others = (plans.data?.items ?? []).filter((p) => !p.current);
  if (!plans.isLoading && !others.length) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Change plan</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2 sm:grid-cols-2">
        {plans.isLoading ? <Skeleton className="h-20 w-full sm:col-span-2" /> : null}
        {others.map((p) => (
          <button
            key={p.id}
            type="button"
            disabled={!me.gateways.length}
            onClick={() => setPick(p)}
            className="rounded-md border bg-card p-3 text-left hover:bg-muted disabled:opacity-60"
          >
            <p className="font-medium">{p.name}</p>
            <p className="text-sm text-muted-foreground">
              {speed(p)} · {p.validityDays} days
              {p.dataCapBytes ? ` · ${fmtBytes(p.dataCapBytes)}` : ''}
            </p>
            <p className="mt-1 text-sm font-semibold">{fmtRupees(p.pricePaise)}</p>
          </button>
        ))}
      </CardContent>
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
    </Card>
  );
}

function PostpaidPlan({ me }: { me: PortalMe }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Monthly billing</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        Your invoice is issued on the 1st of each month. To change your plan, contact {me.isp.name}
        {me.isp.phone ? ` on ${me.isp.phone}` : ''}.
      </CardContent>
    </Card>
  );
}
