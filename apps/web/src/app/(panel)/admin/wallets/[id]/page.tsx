'use client';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { TopUpDialog, WalletStateBadge, idem, toPaise, useIdemKey } from '@/components/billing';
import { PageSkeleton } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { Dialog, DialogContent, dialogActions } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';
import { ErrorState, Field, PageHeader, Stat } from '@/components/ui/misc';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, ApiError, unwrap } from '@/lib/api';
import { useCan, useMe } from '@/lib/auth';
import type { WalletDashboard } from '@/lib/queries';
import { fmtDateTime, fmtNum, fmtRupees, plural } from '@/lib/utils';

const TYPES = ['TOPUP', 'ALLOCATE', 'RECHARGE', 'REFUND', 'ADJUSTMENT'] as const;
const TYPE_LABEL: Record<(typeof TYPES)[number], string> = {
  TOPUP: 'Top-up',
  ALLOCATE: 'Allocation',
  RECHARGE: 'Recharge',
  REFUND: 'Refund',
  ADJUSTMENT: 'Adjustment',
};
const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const daysAgo = (n: number) =>
  new Date(Date.now() + 330 * 60_000 - n * 86_400_000).toISOString().slice(0, 10);

export default function WalletPage() {
  const { id } = useParams<{ id: string }>();
  const w = useQuery({
    queryKey: ['wallet', id],
    queryFn: () => unwrap(api.GET('/api/v1/wallets/{id}', { params: { path: { id } } })),
  });
  if (w.isLoading) return <PageSkeleton />;
  if (w.isError) return <ErrorState error={w.error} onRetry={() => void w.refetch()} />;
  const d = w.data!;
  const master = d.walletType === 'MASTER';
  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {master ? `${d.owner.name} — Master wallet` : d.owner.name} <WalletStateBadge state={d.state} />
          </span>
        }
        description={
          master ? (
            'Records what the ISP has issued to level-1 resellers.'
          ) : (
            <Link href={`/admin/resellers/${d.owner.id}`} className="hover:underline">
              {d.owner.code} · {d.walletType}
            </Link>
          )
        }
        actions={<Actions d={d} />}
      />
      {d.state === 'frozen' ? (
        <p
          role="alert"
          className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
        >
          Frozen by the nightly check: {d.frozenReason}. No money moves until ISP staff review and unfreeze
          it.
        </p>
      ) : null}
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {master ? (
          <Stat
            label="Issued to level 1"
            value={fmtRupees(d.totals.allocatedPaise)}
            hint={`${fmtNum(d.children)} resellers`}
          />
        ) : (
          <Stat
            label="Balance"
            value={fmtRupees(d.balancePaise)}
            hint={
              d.creditLimitPaise
                ? `Credit limit ${fmtRupees(d.creditLimitPaise)}`
                : `Low at ${fmtRupees(d.lowBalanceThresholdPaise)}`
            }
          />
        )}
        <Stat label="Received" value={fmtRupees(d.totals.receivedPaise)} />
        <Stat
          label="Recharges"
          value={fmtRupees(d.totals.rechargedPaise - d.totals.refundedPaise)}
          hint={
            d.totals.refundedPaise
              ? `${fmtRupees(d.totals.refundedPaise)} refunded · ${plural(d.customers, 'customer')}`
              : plural(d.customers, 'customer')
          }
        />
        <Stat
          label="Sent down"
          value={fmtRupees(d.totals.allocatedPaise)}
          hint={`${fmtNum(d.children)} below · ${d.lowChildren} low`}
        />
      </div>
      {d.canViewLedger ? (
        <Tabs defaultValue="ledger">
          <TabsList>
            <TabsTrigger value="ledger">Ledger</TabsTrigger>
            <TabsTrigger value="report">Date-wise report</TabsTrigger>
          </TabsList>
          <TabsContent value="ledger">
            <Ledger id={id} />
          </TabsContent>
          <TabsContent value="report">
            <Report id={id} />
          </TabsContent>
        </Tabs>
      ) : (
        <p className="text-sm text-muted-foreground">
          Only the owner and ISP staff see this wallet’s ledger.
        </p>
      )}
    </>
  );
}

function Actions({ d }: { d: WalletDashboard }) {
  const can = useCan();
  const qc = useQueryClient();
  const staff = useMe().data?.user.type !== 'reseller';
  const [open, setOpen] = useState<'topup' | 'adjust' | 'threshold' | null>(null);
  const [amount, setAmount] = useState('');
  const [sign, setSign] = useState<'+' | '-'>('+');
  const [reason, setReason] = useState('');
  const [key, newKey] = useIdemKey();
  const done = (msg: string) => {
    void qc.invalidateQueries({ queryKey: ['wallet'] });
    void qc.invalidateQueries({ queryKey: ['wallets'] });
    void qc.invalidateQueries({ queryKey: ['ledger', d.id] });
    toast.success(msg);
    setOpen(null);
    setAmount('');
    setReason('');
  };
  const paise = toPaise(amount);
  const adjust = useMutation({
    meta: { silent: true },
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/wallets/{id}/adjust', {
          params: { path: { id: d.id } },
          body: { amountPaise: sign === '-' ? -paise! : paise!, reason: reason.trim() },
          ...idem(key),
        }),
      ),
    onSuccess: () => done('Adjustment recorded.'),
  });
  const patch = useMutation({
    meta: { silent: true },
    mutationFn: (b: { lowBalanceThresholdPaise?: number; unfreeze?: true }) =>
      unwrap(api.PATCH('/api/v1/wallets/{id}', { params: { path: { id: d.id } }, body: b })),
    onSuccess: (_r, b) => done(b.unfreeze ? 'Unfrozen.' : 'Low-balance level saved.'),
  });
  const master = d.walletType === 'MASTER';
  return (
    <>
      {d.canTopUp && d.state !== 'frozen' ? (
        <Button onClick={() => setOpen('topup')}>{staff ? 'Top up' : 'Send money'}</Button>
      ) : null}
      {!master && (d.canTopUp || staff) && can('wallets.transfer') ? (
        <Button
          variant="outline"
          onClick={() => {
            setAmount(String(d.lowBalanceThresholdPaise / 100));
            setOpen('threshold');
          }}
        >
          Low-balance level
        </Button>
      ) : null}
      {staff && can('wallets.adjust') ? (
        <Button
          variant="outline"
          onClick={() => {
            newKey();
            setOpen('adjust');
          }}
        >
          Adjust
        </Button>
      ) : null}
      {staff && can('wallets.adjust') && d.state === 'frozen' ? (
        <Button
          variant="destructive"
          loading={patch.isPending}
          onClick={() => patch.mutate({ unfreeze: true })}
        >
          Unfreeze
        </Button>
      ) : null}
      <TopUpDialog wallet={d} open={open === 'topup'} onOpenChange={(o) => setOpen(o ? 'topup' : null)} />
      <Dialog open={open === 'adjust'} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent
          title="Manual adjustment"
          description="For corrections only. The reason is kept in the ledger and the audit log."
        >
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (paise) adjust.mutate();
            }}
          >
            <div className="grid grid-cols-[7rem_1fr] gap-3">
              <Field label="Direction" htmlFor="a-sign">
                <Select id="a-sign" value={sign} onChange={(e) => setSign(e.target.value as '+' | '-')}>
                  <option value="+">Credit +</option>
                  <option value="-">Debit −</option>
                </Select>
              </Field>
              <Field
                label="Amount (₹)"
                htmlFor="a-amount"
                error={amount && !paise ? 'Enter an amount' : undefined}
              >
                <Input
                  id="a-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </Field>
            </div>
            <Field
              label="Reason"
              htmlFor="a-reason"
              error={adjust.error instanceof ApiError ? adjust.error.message : undefined}
            >
              <Input
                id="a-reason"
                minLength={5}
                maxLength={200}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
            <div className={dialogActions}>
              <Button type="button" variant="outline" onClick={() => setOpen(null)}>
                Cancel
              </Button>
              <Button type="submit" loading={adjust.isPending} disabled={!paise || reason.trim().length < 5}>
                Record
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={open === 'threshold'} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent
          title="Low-balance level"
          description="A warning shows at or below this balance. Recharges stop only at zero."
        >
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (paise !== null) patch.mutate({ lowBalanceThresholdPaise: paise });
            }}
          >
            <Field
              label="Amount (₹)"
              htmlFor="th-amount"
              error={amount && paise === null ? 'Enter an amount' : undefined}
            >
              <Input
                id="th-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            <div className={dialogActions}>
              <Button type="button" variant="outline" onClick={() => setOpen(null)}>
                Cancel
              </Button>
              <Button type="submit" loading={patch.isPending} disabled={paise === null}>
                Save
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Ledger({ id }: { id: string }) {
  const [type, setType] = useState('');
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(today());
  const q = useInfiniteQuery({
    queryKey: ['ledger', id, type, from, to],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/v1/wallets/{id}/ledger', {
          params: {
            path: { id },
            query: {
              limit: 100,
              ...(type ? { type: type as (typeof TYPES)[number] } : {}),
              ...(from ? { from } : {}),
              ...(to ? { to } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    placeholderData: (prev) => prev,
  });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Select aria-label="Type" value={type} onChange={(e) => setType(e.target.value)} className="w-40">
          <option value="">All types</option>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </Select>
        <Input
          type="date"
          aria-label="From"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="w-40"
        />
        <Input
          type="date"
          aria-label="To"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="w-40"
        />
      </div>
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <DataTable
          caption="Ledger"
          loading={q.isLoading}
          rows={q.data?.pages.flatMap((p) => p.items)}
          rowKey={(t) => t.id}
          hasMore={q.hasNextPage}
          loadingMore={q.isFetchingNextPage}
          onLoadMore={() => void q.fetchNextPage()}
          empty="No entries in this period."
          columns={[
            { key: 'at', header: 'When', cell: (t) => fmtDateTime(t.createdAt) },
            { key: 'type', header: 'Type', cell: (t) => TYPE_LABEL[t.type] },
            { key: 'desc', header: 'Description', cell: (t) => t.description, hideOnMobile: true },
            {
              key: 'amt',
              header: 'Amount',
              className: 'text-right tabular-nums',
              cell: (t) => (
                <span className={t.direction === 'credit' ? 'text-success-text' : 'text-danger-text'}>
                  {t.direction === 'credit' ? '+' : '−'}
                  {fmtRupees(t.amountPaise)}
                </span>
              ),
            },
            {
              key: 'bal',
              header: 'Balance',
              cell: (t) => fmtRupees(t.balanceAfterPaise),
              className: 'text-right tabular-nums',
            },
          ]}
        />
      )}
    </div>
  );
}

function Report({ id }: { id: string }) {
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(today());
  const q = useQuery({
    queryKey: ['wallet-report', id, from, to],
    queryFn: () =>
      unwrap(api.GET('/api/v1/wallets/{id}/report', { params: { path: { id }, query: { from, to } } })),
    enabled: !!from && !!to,
    placeholderData: (prev) => prev,
  });
  const rows = q.data?.rows ?? [];
  const sum = (k: 'creditsPaise' | 'debitsPaise') => rows.reduce((a, r) => a + r[k], 0);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="date"
          aria-label="From"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="w-40"
        />
        <Input
          type="date"
          aria-label="To"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="w-40"
        />
        <span className="text-sm text-muted-foreground">
          Credits {fmtRupees(sum('creditsPaise'))} · Debits {fmtRupees(sum('debitsPaise'))}
        </span>
      </div>
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <DataTable
          caption="Date-wise wallet report"
          loading={q.isLoading}
          rows={rows}
          rowKey={(r) => r.day}
          empty="No movements in this period."
          columns={[
            { key: 'day', header: 'Day', cell: (r) => r.day },
            { key: 'n', header: 'Entries', cell: (r) => fmtNum(r.count), className: 'text-right' },
            {
              key: 'cr',
              header: 'Credits',
              cell: (r) => fmtRupees(r.creditsPaise),
              className: 'text-right tabular-nums',
            },
            {
              key: 'dr',
              header: 'Debits',
              cell: (r) => fmtRupees(r.debitsPaise),
              className: 'text-right tabular-nums',
            },
            {
              key: 'rc',
              header: 'Recharges',
              cell: (r) => fmtRupees(r.byType.RECHARGE_debit ?? 0),
              className: 'text-right tabular-nums',
              hideOnMobile: true,
            },
          ]}
        />
      )}
    </div>
  );
}
