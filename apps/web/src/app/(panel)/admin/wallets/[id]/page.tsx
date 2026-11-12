'use client';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { ArrowDownLeft, Download, GitBranch, SlidersHorizontal, Undo2, Zap } from 'lucide-react';
import { TopUpDialog, WalletStateBadge, idem, toPaise, useIdemKey } from '@/components/billing';
import { PageSkeleton } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { Dialog, DialogContent, dialogActions } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';
import { ErrorState, Field, PageHeader, Stat } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import {
  SegmentedList,
  SegmentedTrigger,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import { api, ApiError, unwrap, type ApiData } from '@/lib/api';
import { useCan, useMe } from '@/lib/auth';
import type { WalletDashboard } from '@/lib/queries';
import { cn, fmtDateTime, fmtNum, fmtRupees, plural } from '@/lib/utils';

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
          className="mb-4 rounded-xl border border-danger-border bg-danger-bg text-danger-text px-3 py-2 text-sm"
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
            <Ledger id={id} balancePaise={d.balancePaise} lowPaise={d.lowBalanceThresholdPaise} />
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
  const [sign, setSign] = useState<'' | '+' | '-'>('');
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
            setSign('');
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
              if (paise && sign) adjust.mutate();
            }}
          >
            <div className="grid grid-cols-[7rem_1fr] gap-3">
              <Field label="Direction" htmlFor="a-sign">
                <Select id="a-sign" value={sign} onChange={(e) => setSign(e.target.value as '' | '+' | '-')}>
                  <option value="" disabled>
                    Choose
                  </option>
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
              <Button
                type="submit"
                loading={adjust.isPending}
                disabled={!paise || !sign || reason.trim().length < 5}
              >
                {paise && sign
                  ? `${sign === '-' ? 'Debit' : 'Credit'} ${fmtRupees(paise)} → ${fmtRupees(d.balancePaise + (sign === '-' ? -paise : paise))}`
                  : 'Record'}
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

type Txn = ApiData<'/api/v1/wallets/{id}/ledger'>['items'][number];
const TYPE_ICON = {
  TOPUP: ArrowDownLeft,
  ALLOCATE: GitBranch,
  RECHARGE: Zap,
  REFUND: Undo2,
  ADJUSTMENT: SlidersHorizontal,
};
const monthStart = () => `${today().slice(0, 8)}01`;
const csvCell = (v: string | number) =>
  /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);

function Ledger({ id, balancePaise, lowPaise }: { id: string; balancePaise: number; lowPaise: number }) {
  const [type, setType] = useState('');
  const [dir, setDir] = useState<'all' | 'credit' | 'debit'>('all');
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [exporting, setExporting] = useState(false);
  const query = (cursor?: string) => ({
    path: { id },
    query: {
      limit: 100,
      ...(type ? { type: type as (typeof TYPES)[number] } : {}),
      ...(dir !== 'all' ? { direction: dir } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(cursor ? { cursor } : {}),
    },
  });
  const q = useInfiniteQuery({
    queryKey: ['ledger', id, type, dir, from, to],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => unwrap(api.GET('/api/v1/wallets/{id}/ledger', { params: query(pageParam) })),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    placeholderData: (prev) => prev,
  });
  // Totals for the period, and everything after it, so opening and closing are exact whatever is loaded.
  const sums = useQuery({
    queryKey: ['wallet-report', id, from, today()],
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/wallets/{id}/report', { params: { path: { id }, query: { from, to: today() } } }),
      ),
    enabled: !!from,
    placeholderData: (prev) => prev,
  });
  const rows = sums.data?.rows ?? [];
  const inPeriod = rows.filter((r) => !to || r.day <= to);
  const credits = inPeriod.reduce((a, r) => a + r.creditsPaise, 0);
  const debits = inPeriod.reduce((a, r) => a + r.debitsPaise, 0);
  const after = rows.filter((r) => to && r.day > to).reduce((a, r) => a + r.creditsPaise - r.debitsPaise, 0);
  const closing = balancePaise - after;
  const opening = closing - (credits - debits);
  const n = (suffix: string) =>
    inPeriod.reduce(
      (a, r) => a + Object.entries(r.countByType).reduce((s, [k, v]) => s + (k.endsWith(suffix) ? v : 0), 0),
      0,
    );
  const recharges = inPeriod.reduce((a, r) => a + (r.countByType.RECHARGE_debit ?? 0), 0);
  const items = q.data?.pages.flatMap((p) => p.items);
  const complete = !q.hasNextPage && !type && dir === 'all';
  const fmtDay = (d: string) =>
    d
      ? new Date(`${d}T00:00:00+05:30`).toLocaleDateString('en-IN', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        })
      : '';

  async function exportCsv() {
    setExporting(true);
    try {
      const all: Txn[] = [];
      let cursor: string | undefined;
      do {
        const page = await unwrap(api.GET('/api/v1/wallets/{id}/ledger', { params: query(cursor) }));
        all.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor && all.length < 10_000);
      const lines = [
        ['Date', 'Type', 'Description', 'Reference', 'Debit', 'Credit', 'Balance'],
        ...all.map((t) => [
          fmtDateTime(t.createdAt),
          TYPE_LABEL[t.type],
          t.description,
          t.referenceId,
          t.direction === 'debit' ? (t.amountPaise / 100).toFixed(2) : '',
          t.direction === 'credit' ? (t.amountPaise / 100).toFixed(2) : '',
          (t.balanceAfterPaise / 100).toFixed(2),
        ]),
      ];
      const blob = new Blob([lines.map((l) => l.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `wallet-statement-${from}-to-${to}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not export the statement');
    } finally {
      setExporting(false);
    }
  }

  const tile = (k: string, v: string, sub: string, tone?: string) => (
    <div className="flex flex-col gap-1 rounded-2xl border bg-card p-[18px]">
      <span className="eyebrow">{k}</span>
      <span
        className={cn(
          'text-lg font-extrabold tracking-[-0.02em] whitespace-nowrap text-foreground tabular-nums sm:text-[22px]',
          tone,
        )}
      >
        {v}
      </span>
      <span className="text-xs text-muted-foreground">{sub}</span>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {sums.isLoading ? (
          [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[100px] rounded-2xl" />)
        ) : (
          <>
            {tile(`Opening, ${fmtDay(from)}`, fmtRupees(opening), 'Balance at the start of the period')}
            {tile(
              'Credits',
              `+${fmtRupees(credits)}`,
              `${fmtNum(n('_credit'))} ${n('_credit') === 1 ? 'entry' : 'entries'}: top-ups, refunds`,
              'text-success-text',
            )}
            {tile(
              'Debits',
              `−${fmtRupees(debits)}`,
              `${plural(recharges, 'recharge')} · ${plural(n('_debit') - recharges, 'other')}`,
              'text-danger-text',
            )}
            {to >= today()
              ? tile(
                  'Balance now',
                  fmtRupees(closing),
                  closing <= lowPaise
                    ? `Low · alert at ${fmtRupees(lowPaise)}`
                    : `Alert at ${fmtRupees(lowPaise)}`,
                )
              : tile(`Closing, ${fmtDay(to)}`, fmtRupees(closing), 'Balance at the end of the period')}
          </>
        )}
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
          <Tabs value={dir} onValueChange={(v) => setDir(v as typeof dir)}>
            <SegmentedList aria-label="Direction">
              <SegmentedTrigger value="all">All</SegmentedTrigger>
              <SegmentedTrigger value="credit">Credits</SegmentedTrigger>
              <SegmentedTrigger value="debit">Debits</SegmentedTrigger>
            </SegmentedList>
          </Tabs>
          <Select aria-label="Type" value={type} onChange={(e) => setType(e.target.value)} className="w-36">
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
            max={to}
            onChange={(e) => setFrom(e.target.value)}
            className="w-40"
          />
          <Input
            type="date"
            aria-label="To"
            value={to}
            min={from}
            max={today()}
            onChange={(e) => setTo(e.target.value)}
            className="w-40"
          />
          <Button variant="outline" className="ml-auto" loading={exporting} onClick={() => void exportCsv()}>
            <Download /> Export statement
          </Button>
        </div>
        {q.isError ? (
          <div className="p-4">
            <ErrorState error={q.error} onRetry={() => void q.refetch()} />
          </div>
        ) : (
          <DataTable
            bare
            caption="Wallet ledger"
            loading={q.isLoading}
            rows={items}
            rowKey={(t) => t.id}
            hasMore={q.hasNextPage}
            loadingMore={q.isFetchingNextPage}
            onLoadMore={() => void q.fetchNextPage()}
            empty="No entries in this period."
            columns={[
              {
                key: 'at',
                header: 'Date',
                cell: (t) => (
                  <span className="flex flex-col whitespace-nowrap">
                    <span className="font-semibold text-foreground">
                      {fmtDay(
                        new Date(new Date(t.createdAt).getTime() + 330 * 60_000).toISOString().slice(0, 10),
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(t.createdAt)
                        .toLocaleTimeString('en-IN', {
                          hour: 'numeric',
                          minute: '2-digit',
                          timeZone: 'Asia/Kolkata',
                        })
                        .toLowerCase()}
                    </span>
                  </span>
                ),
              },
              {
                key: 'desc',
                header: 'Description',
                cell: (t) => {
                  const Icon = TYPE_ICON[t.type];
                  return (
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span
                        className={cn(
                          'grid size-8 shrink-0 place-items-center rounded-[10px]',
                          t.direction === 'credit'
                            ? 'bg-success-bg text-success-text'
                            : 'bg-accent text-primary',
                        )}
                      >
                        <Icon className="size-[15px]" strokeWidth={2.2} aria-hidden />
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="font-semibold text-foreground">
                          {t.description || TYPE_LABEL[t.type]}
                        </span>
                        <span className="text-xs text-muted-foreground">{TYPE_LABEL[t.type]}</span>
                      </span>
                    </span>
                  );
                },
              },
              {
                key: 'ref',
                header: 'Reference',
                cell: (t) => (
                  <span className="font-mono text-xs text-muted-foreground" title={t.referenceId}>
                    …{t.referenceId.slice(-8)}
                  </span>
                ),
                hideOnMobile: true,
              },
              {
                key: 'dr',
                header: 'Debit',
                className: 'text-right tabular-nums',
                cell: (t) =>
                  t.direction === 'debit' ? (
                    <span className="font-semibold text-danger-text">−{fmtRupees(t.amountPaise)}</span>
                  ) : (
                    ''
                  ),
              },
              {
                key: 'cr',
                header: 'Credit',
                className: 'text-right tabular-nums',
                cell: (t) =>
                  t.direction === 'credit' ? (
                    <span className="font-semibold text-success-text">+{fmtRupees(t.amountPaise)}</span>
                  ) : (
                    ''
                  ),
              },
              {
                key: 'bal',
                header: 'Balance',
                className: 'text-right tabular-nums',
                cell: (t) => (
                  <span className="font-semibold text-foreground">{fmtRupees(t.balanceAfterPaise)}</span>
                ),
              },
            ]}
          />
        )}
        {complete && items?.length && sums.data ? (
          <div className="flex items-center justify-between gap-3 border-t bg-subtle px-4 py-2.5 text-sm">
            <span className="text-muted-foreground">{fmtDay(from)} · Opening balance</span>
            <span className="font-bold text-foreground tabular-nums">{fmtRupees(opening)}</span>
          </div>
        ) : null}
      </Card>
      <p className="font-mono text-[11px] text-muted-foreground">Newest first · times IST</p>
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
