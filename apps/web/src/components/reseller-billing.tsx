'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Plus } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { TopUpDialog, WalletStateBadge, toPaise } from '@/components/billing';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { Dialog, DialogContent, dialogActions } from '@/components/ui/dialog';
import { Checkbox, Input, Select } from '@/components/ui/input';
import { ErrorState, Field, Stat } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError, unwrap } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { fmtDateTime, fmtNum, fmtRupees, grossPaise } from '@/lib/utils';

export function ResellerWallet({ walletId }: { walletId: string | null }) {
  const [topUp, setTopUp] = useState(false);
  const w = useQuery({
    queryKey: ['wallet', walletId],
    queryFn: () => unwrap(api.GET('/api/v1/wallets/{id}', { params: { path: { id: walletId! } } })),
    enabled: !!walletId,
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2,
  });
  if (!walletId) return <p className="text-sm text-muted-foreground">No wallet.</p>;
  if (w.isLoading) return <Skeleton className="h-28" />;
  if (w.error instanceof ApiError && w.error.status === 404) {
    return (
      <p className="text-sm text-muted-foreground">
        You see the wallets of resellers directly below you only.
      </p>
    );
  }
  if (w.isError) return <ErrorState error={w.error} onRetry={() => void w.refetch()} />;
  const d = w.data!;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <WalletStateBadge state={d.state} />
        <div className="ml-auto flex gap-2">
          {d.canTopUp && d.state !== 'frozen' ? (
            <Button onClick={() => setTopUp(true)}>Send money</Button>
          ) : null}
          <Button variant="outline" asChild>
            <Link href={`/admin/wallets/${d.id}`}>
              Wallet page <ArrowUpRight />
            </Link>
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Balance"
          value={fmtRupees(d.balancePaise)}
          hint={`Low at ${fmtRupees(d.lowBalanceThresholdPaise)}`}
        />
        <Stat label="Received" value={fmtRupees(d.totals.receivedPaise)} />
        <Stat
          label="Recharges"
          value={fmtRupees(d.totals.rechargedPaise - d.totals.refundedPaise)}
          hint={d.totals.refundedPaise ? `${fmtRupees(d.totals.refundedPaise)} refunded` : undefined}
        />
        <Stat
          label="Sent down"
          value={fmtRupees(d.totals.allocatedPaise)}
          hint={`${fmtNum(d.children)} below`}
        />
      </div>
      <TopUpDialog wallet={d} open={topUp} onOpenChange={setTopUp} />
    </div>
  );
}

interface RateEdit {
  walletPrice: string;
  customerPrice: string;
  active: boolean;
}

/** Parent (or staff) sets the wallet price and what may be sold; the reseller sets its own customer price. */
export function ResellerRates({ resellerId }: { resellerId: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['rates', resellerId],
    queryFn: () => unwrap(api.GET('/api/v1/resellers/{id}/rates', { params: { path: { id: resellerId } } })),
  });
  const [edits, setEdits] = useState<Record<string, RateEdit>>({});
  const save = useMutation({
    meta: { silent: true },
    mutationFn: (
      rates: { planId: string; walletPricePaise?: number; customerPricePaise?: number; active?: boolean }[],
    ) =>
      unwrap(
        api.PUT('/api/v1/resellers/{id}/rates', { params: { path: { id: resellerId } }, body: { rates } }),
      ),
    onSuccess: (n) => {
      qc.setQueryData(['rates', resellerId], n);
      setEdits({});
      toast.success('Prices saved.');
    },
  });
  const rows = useMemo(() => q.data?.items ?? [], [q.data]);
  const value = (planId: string): RateEdit => {
    const r = rows.find((x) => x.planId === planId)!;
    return (
      edits[planId] ?? {
        walletPrice: String(r.walletPricePaise / 100),
        customerPrice: String(r.customerPricePaise / 100),
        active: r.active,
      }
    );
  };
  const changes = useMemo(() => {
    const out: {
      planId: string;
      walletPricePaise?: number;
      customerPricePaise?: number;
      active?: boolean;
    }[] = [];
    for (const [planId, e] of Object.entries(edits)) {
      const r = rows.find((x) => x.planId === planId);
      if (!r) continue;
      const c: (typeof out)[number] = { planId };
      const wp = toPaise(e.walletPrice);
      const cp = toPaise(e.customerPrice);
      if (q.data?.canSetWalletPrices && wp !== null && wp !== r.walletPricePaise) c.walletPricePaise = wp;
      if (q.data?.canSetWalletPrices && e.active !== r.active) c.active = e.active;
      if (q.data?.canSetCustomerPrices && cp !== null && cp !== r.customerPricePaise)
        c.customerPricePaise = cp;
      if (Object.keys(c).length > 1) out.push(c);
    }
    return out;
  }, [edits, rows, q.data]);
  const invalid = Object.values(edits).some(
    (e) => toPaise(e.walletPrice) === null || toPaise(e.customerPrice) === null,
  );
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const set = (planId: string, patch: Partial<RateEdit>) =>
    setEdits((x) => ({ ...x, [planId]: { ...value(planId), ...patch } }));
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Wallet price: debited from this reseller’s wallet per recharge (set by the level above; defaults to
        the plan price). Customer price: what this reseller charges, before GST.
      </p>
      <DataTable
        caption="Plan prices"
        loading={q.isLoading}
        rows={rows}
        rowKey={(r) => r.planId}
        empty="No active plans."
        columns={[
          {
            key: 'plan',
            header: 'Plan',
            cell: (r) => (
              <div>
                <span className="font-medium">{r.planName}</span>
                <div className="text-xs text-muted-foreground">
                  MRP {fmtRupees(r.planPricePaise)} + {r.gstRatePercent}% GST
                </div>
              </div>
            ),
          },
          {
            key: 'wallet',
            header: 'Wallet price (₹)',
            cell: (r) =>
              q.data?.canSetWalletPrices ? (
                <Input
                  aria-label={`Wallet price for ${r.planName}`}
                  inputMode="decimal"
                  className="w-28"
                  value={value(r.planId).walletPrice}
                  onChange={(e) => set(r.planId, { walletPrice: e.target.value })}
                />
              ) : (
                fmtRupees(r.walletPricePaise)
              ),
          },
          {
            key: 'customer',
            header: 'Customer price (₹)',
            cell: (r) =>
              q.data?.canSetCustomerPrices ? (
                <div>
                  <Input
                    aria-label={`Customer price for ${r.planName}`}
                    inputMode="decimal"
                    className="w-28"
                    value={value(r.planId).customerPrice}
                    onChange={(e) => set(r.planId, { customerPrice: e.target.value })}
                  />
                  <span className="text-xs text-muted-foreground">
                    {(() => {
                      const p = toPaise(value(r.planId).customerPrice);
                      return p !== null ? `${fmtRupees(grossPaise(p, r.gstRatePercent))} with GST` : '';
                    })()}
                  </span>
                </div>
              ) : (
                fmtRupees(r.customerPricePaise)
              ),
          },
          {
            key: 'sell',
            header: 'May sell',
            cell: (r) =>
              q.data?.canSetWalletPrices ? (
                <Checkbox
                  aria-label={`May sell ${r.planName}`}
                  checked={value(r.planId).active}
                  onChange={(e) => set(r.planId, { active: e.target.checked })}
                />
              ) : r.active ? (
                <Badge tone="success">Yes</Badge>
              ) : (
                <Badge>No</Badge>
              ),
          },
        ]}
      />
      {q.data?.canSetWalletPrices || q.data?.canSetCustomerPrices ? (
        <div className="flex items-center justify-end gap-2">
          {save.error ? (
            <span className="text-sm text-destructive">{(save.error as Error).message}</span>
          ) : null}
          <Button variant="outline" disabled={!Object.keys(edits).length} onClick={() => setEdits({})}>
            Reset
          </Button>
          <Button
            loading={save.isPending}
            disabled={!changes.length || invalid}
            onClick={() => save.mutate(changes)}
          >
            Save {changes.length ? `(${changes.length})` : ''}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Reseller panel sign-ins for this reseller (reseller roles only). */
export function ResellerLogins({ resellerId }: { resellerId: string }) {
  const can = useCan();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', email: '', password: '', roleId: '' });
  const users = useQuery({
    queryKey: ['users', { resellerId }],
    queryFn: () => unwrap(api.GET('/api/v1/users', { params: { query: { resellerId, limit: 100 } } })),
  });
  const roles = useQuery({
    queryKey: ['roles'],
    queryFn: () => unwrap(api.GET('/api/v1/roles')),
    enabled: adding,
  });
  const resellerRoles = (roles.data ?? []).filter((r) => r.scope === 'reseller');
  const create = useMutation({
    meta: { silent: true },
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/users', {
          body: {
            name: form.name.trim(),
            ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
            ...(form.email.trim() ? { email: form.email.trim() } : {}),
            password: form.password,
            roleIds: [form.roleId || resellerRoles[0]!.id],
            resellerId,
          },
        }),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['users'] });
      toast.success('Sign-in created. Share the password privately.');
      setAdding(false);
      setForm({ name: '', phone: '', email: '', password: '', roleId: '' });
    },
  });
  if (users.isError) return <ErrorState error={users.error} onRetry={() => void users.refetch()} />;
  return (
    <div className="space-y-3">
      {can('users.write') ? (
        <div className="flex justify-end">
          <Button onClick={() => setAdding(true)}>
            <Plus /> Add sign-in
          </Button>
        </div>
      ) : null}
      <DataTable
        caption="Sign-ins"
        loading={users.isLoading}
        rows={users.data?.items}
        rowKey={(u) => u.id}
        empty="No sign-ins yet. Add one so the reseller can use the panel."
        columns={[
          { key: 'name', header: 'Name', cell: (u) => u.name },
          { key: 'login', header: 'Sign in with', cell: (u) => u.phone ?? u.email ?? '—' },
          {
            key: 'status',
            header: 'Status',
            cell: (u) => <Badge tone={u.status === 'active' ? 'success' : 'danger'}>{u.status}</Badge>,
          },
          {
            key: 'last',
            header: 'Last sign-in',
            cell: (u) => (u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : 'Never'),
            hideOnMobile: true,
          },
        ]}
      />
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent
          title="Add a reseller sign-in"
          description="They sign in at the same address as staff and see only their branch."
        >
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <Field label="Name" htmlFor="ru-name">
              <Input
                id="ru-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Mobile" htmlFor="ru-phone">
                <Input
                  id="ru-phone"
                  inputMode="tel"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                />
              </Field>
              <Field label="Email" htmlFor="ru-email">
                <Input
                  id="ru-email"
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </Field>
            </div>
            <Field label="Password" htmlFor="ru-pw" hint="At least 10 characters.">
              <Input
                id="ru-pw"
                type="password"
                autoComplete="new-password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </Field>
            <Field label="Role" htmlFor="ru-role">
              <Select
                id="ru-role"
                value={form.roleId}
                onChange={(e) => setForm({ ...form, roleId: e.target.value })}
              >
                {resellerRoles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </Field>
            {create.error ? (
              <p className="text-sm text-destructive">{(create.error as Error).message}</p>
            ) : null}
            <div className={dialogActions}>
              <Button type="button" variant="outline" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                loading={create.isPending}
                disabled={
                  !form.name.trim() ||
                  (!form.phone.trim() && !form.email.trim()) ||
                  form.password.length < 10 ||
                  !resellerRoles.length
                }
              >
                Create
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
