'use client';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { Dialog, DialogContent, dialogActions } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';
import { CopyButton, ErrorState, Field, KeyValue } from '@/components/ui/misc';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, ApiError, unwrap } from '@/lib/api';
import { useCan, useMe } from '@/lib/auth';
import {
  usePlans,
  type Invoice,
  type Payment,
  type Recharge,
  type Subscriber,
  type Wallet,
} from '@/lib/queries';
import { fmtDate, fmtDateTime, fmtRupees } from '@/lib/utils';

/** A fresh Idempotency-Key per dialog opening: a double click or retry of the same dialog moves money once. */
export function useIdemKey() {
  const [k, setK] = useState(() => crypto.randomUUID());
  return [k, useCallback(() => setK(crypto.randomUUID()), [])] as const;
}
export const idem = (k: string) => ({ headers: { 'idempotency-key': k } });

/** "1,234.50" → 123450 paise; null when not a valid amount. */
export function toPaise(s: string): number | null {
  const t = s.replace(/[,\s₹]/g, '');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

export function WalletStateBadge({ state }: { state: Wallet['state'] }) {
  if (state === 'frozen') return <Badge tone="danger">Frozen</Badge>;
  if (state === 'inactive') return <Badge tone="neutral">Inactive</Badge>;
  if (state === 'empty') return <Badge tone="danger">Empty</Badge>;
  if (state === 'low') return <Badge tone="warning">Low balance</Badge>;
  return <Badge tone="success">Normal</Badge>;
}

const CHANNEL: Record<Recharge['channel'], string> = {
  online: 'Online',
  reseller_wallet: 'Reseller wallet',
  cash: 'Cash',
  staff: 'Complimentary',
  import: 'Import',
};
export const channelLabel = (c: Recharge['channel']) => CHANNEL[c];

const INVOICE_TONE: Record<Invoice['status'], 'success' | 'warning' | 'danger' | 'neutral'> = {
  paid: 'success',
  partially_paid: 'warning',
  issued: 'neutral',
  overdue: 'danger',
  cancelled: 'neutral',
};
export function InvoiceStatus({ s }: { s: Invoice['status'] }) {
  return (
    <Badge tone={INVOICE_TONE[s]}>
      {s === 'partially_paid' ? 'Part paid' : s[0]!.toUpperCase() + s.slice(1)}
    </Badge>
  );
}
export function PaymentStatus({ s }: { s: Payment['status'] }) {
  const tone =
    s === 'captured' ? 'success' : s === 'failed' ? 'danger' : s === 'refunded' ? 'warning' : 'neutral';
  const label = s === 'captured' ? 'Paid' : s === 'created' ? 'Link sent' : s[0]!.toUpperCase() + s.slice(1);
  return <Badge tone={tone}>{label}</Badge>;
}

export const pdfUrl = (invoiceId: string) => `/api/v1/invoices/${invoiceId}/pdf`;

function errorText(e: unknown) {
  return e instanceof ApiError ? e.message : 'Something went wrong';
}

/** Top-up (ISP → level 1) or allocation (reseller → direct child). */
export function TopUpDialog({
  wallet,
  open,
  onOpenChange,
}: {
  wallet: { id: string; owner: { name: string; code: string } } | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const me = useMe();
  const staff = me.data?.user.type !== 'reseller';
  const [key, newKey] = useIdemKey();
  const [amount, setAmount] = useState('');
  const [via, setVia] = useState<'cash' | 'upi' | 'bank' | ''>('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const paise = toPaise(amount);
  const m = useMutation({
    meta: { silent: true },
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/wallets/transfer', {
          body: {
            toWalletId: wallet!.id,
            amountPaise: paise!,
            ...(via ? { receivedVia: via } : {}),
            ...(reference.trim() ? { reference: reference.trim() } : {}),
            ...(note.trim() ? { note: note.trim() } : {}),
          },
          ...idem(key),
        }),
      ),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['wallets'] });
      void qc.invalidateQueries({ queryKey: ['wallet'] });
      toast.success(`${fmtRupees(paise!)} sent. ${r.to.owner.name} now has ${fmtRupees(r.to.balancePaise)}.`);
      setAmount('');
      setReference('');
      setNote('');
      newKey();
      onOpenChange(false);
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) newKey();
        onOpenChange(o);
      }}
    >
      <DialogContent
        title={wallet ? `${staff ? 'Top up' : 'Send money to'} ${wallet.owner.name}` : 'Top up'}
        description="Added to the existing balance. Recorded in both ledgers."
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (paise) m.mutate();
          }}
        >
          <Field
            label="Amount (₹)"
            htmlFor="t-amount"
            error={amount && !paise ? 'Enter an amount, e.g. 5000' : m.error ? errorText(m.error) : undefined}
          >
            <Input
              id="t-amount"
              inputMode="decimal"
              autoFocus
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Received via" htmlFor="t-via">
              <Select id="t-via" value={via} onChange={(e) => setVia(e.target.value as typeof via)}>
                <option value="">—</option>
                <option value="cash">Cash</option>
                <option value="upi">UPI</option>
                <option value="bank">Bank transfer</option>
              </Select>
            </Field>
            <Field label="Reference / UTR" htmlFor="t-ref">
              <Input
                id="t-ref"
                maxLength={60}
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Note" htmlFor="t-note">
            <Input id="t-note" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className={dialogActions}>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={m.isPending} disabled={!paise}>
              Send {paise ? fmtRupees(paise) : ''}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Prepaid recharge with a live quote: reseller pays from its wallet; staff records cash or a complimentary one. */
export function RechargeDialog({
  subscriber,
  open,
  onOpenChange,
}: {
  subscriber: Pick<Subscriber, 'id' | 'name' | 'planId'>;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const can = useCan();
  const me = useMe();
  const staff = me.data?.user.type !== 'reseller';
  const { plans } = usePlans();
  const [key, newKey] = useIdemKey();
  const [planId, setPlanId] = useState(subscriber.planId ?? '');
  const [payment, setPayment] = useState<'cash' | 'none'>('cash');
  const quote = useQuery({
    queryKey: ['recharge-quote', subscriber.id, planId],
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/recharges/quote', { params: { query: { subscriberId: subscriber.id, planId } } }),
      ),
    enabled: open && !!planId,
    staleTime: 10_000,
  });
  const m = useMutation({
    meta: { silent: true },
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/recharges', {
          body: { subscriberId: subscriber.id, planId, ...(staff ? { payment } : {}) },
          ...idem(key),
        }),
      ),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['subscriber', subscriber.id] });
      void qc.invalidateQueries({ queryKey: ['subscribers'] });
      void qc.invalidateQueries({ queryKey: ['recharges'] });
      void qc.invalidateQueries({ queryKey: ['wallet'] });
      void qc.invalidateQueries({ queryKey: ['wallets'] });
      toast.success(`Recharged. Valid until ${fmtDate(r.newExpiresAt)}; speed restored if online.`);
      onOpenChange(false);
    },
  });
  const q = quote.data;
  const short = !staff && q && q.walletBalancePaise !== null && q.walletBalancePaise < q.walletPricePaise;
  const prepaidPlans = plans.filter((p) => p.status === 'active' && p.billingTypes.includes('prepaid'));
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) newKey();
        onOpenChange(o);
      }}
    >
      <DialogContent title={`Recharge ${subscriber.name}`}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate();
          }}
        >
          <Field label="Plan" htmlFor="rc-plan">
            <Select id="rc-plan" value={planId} onChange={(e) => setPlanId(e.target.value)}>
              <option value="">Choose a plan</option>
              {prepaidPlans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          {staff ? (
            <Field label="Payment" htmlFor="rc-pay">
              <Select
                id="rc-pay"
                value={payment}
                onChange={(e) => setPayment(e.target.value as 'cash' | 'none')}
              >
                {can('billing.cash') ? <option value="cash">Cash received</option> : null}
                {can('wallets.adjust') ? <option value="none">Complimentary (no invoice)</option> : null}
              </Select>
            </Field>
          ) : null}
          {q ? (
            <KeyValue
              items={[
                ...(staff
                  ? []
                  : ([
                      ['From your wallet', fmtRupees(q.walletPricePaise)],
                      [
                        'Wallet balance',
                        q.walletBalancePaise === null ? '—' : fmtRupees(q.walletBalancePaise),
                      ],
                    ] as [string, string][])),
                ['Customer pays (incl. GST)', fmtRupees(q.customerTotalPaise)],
                ['New expiry', fmtDateTime(q.newExpiresAt)],
              ]}
            />
          ) : null}
          {short ? (
            <p className="text-sm text-destructive">
              Insufficient Wallet Balance. Ask your parent for a top-up.
            </p>
          ) : null}
          {m.error ? <p className="text-sm text-destructive">{errorText(m.error)}</p> : null}
          <div className={dialogActions}>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={m.isPending}
              disabled={
                !planId || !!short || (staff && !can(payment === 'cash' ? 'billing.cash' : 'wallets.adjust'))
              }
            >
              Recharge
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Razorpay / Cashfree link for a recharge or an invoice; the customer pays, the webhook settles it. */
export function PaymentLinkDialog({
  subscriber,
  invoice,
  open,
  onOpenChange,
}: {
  subscriber: Pick<Subscriber, 'id' | 'name' | 'planId' | 'billingType'>;
  invoice?: Pick<Invoice, 'id' | 'number' | 'balancePaise'>;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { plans } = usePlans();
  const [gateway, setGateway] = useState<'razorpay' | 'cashfree'>('razorpay');
  const [planId, setPlanId] = useState(subscriber.planId ?? '');
  const m = useMutation({
    meta: { silent: true },
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/payments/link', {
          body: {
            subscriberId: subscriber.id,
            gateway,
            ...(invoice ? { invoiceId: invoice.id } : { planId }),
          },
        }),
      ),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) m.reset();
        onOpenChange(o);
      }}
    >
      <DialogContent
        title={invoice ? `Payment link for ${invoice.number}` : `Payment link for ${subscriber.name}`}
        description="Send it to the customer. The recharge or invoice is settled as soon as they pay."
      >
        {m.data ? (
          <div className="space-y-3">
            <KeyValue items={[['Amount', fmtRupees(m.data.amountPaise)]]} />
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-2 text-sm">
              <span className="truncate font-mono">{m.data.linkUrl}</span>
              <CopyButton value={m.data.linkUrl ?? ''} />
            </div>
            <Button className="w-full" variant="outline" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              m.mutate();
            }}
          >
            <Field label="Gateway" htmlFor="pl-gw">
              <Select
                id="pl-gw"
                value={gateway}
                onChange={(e) => setGateway(e.target.value as typeof gateway)}
              >
                <option value="razorpay">Razorpay</option>
                <option value="cashfree">Cashfree</option>
              </Select>
            </Field>
            {invoice ? (
              <KeyValue items={[['Amount due', fmtRupees(invoice.balancePaise)]]} />
            ) : (
              <Field label="Plan" htmlFor="pl-plan">
                <Select id="pl-plan" value={planId} onChange={(e) => setPlanId(e.target.value)}>
                  <option value="">Choose a plan</option>
                  {plans
                    .filter((p) => p.status === 'active' && p.billingTypes.includes('prepaid'))
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </Select>
              </Field>
            )}
            {m.error ? <p className="text-sm text-destructive">{errorText(m.error)}</p> : null}
            <div className={dialogActions}>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={m.isPending} disabled={!invoice && !planId}>
                Create link
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function CashPaymentDialog({
  invoice,
  open,
  onOpenChange,
}: {
  invoice: Pick<Invoice, 'id' | 'number' | 'balancePaise'> | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const [key, newKey] = useIdemKey();
  const [amount, setAmount] = useState('');
  const [receipt, setReceipt] = useState('');
  const paise = toPaise(amount);
  const m = useMutation({
    meta: { silent: true },
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/payments/cash', {
          body: {
            invoiceId: invoice!.id,
            amountPaise: paise!,
            ...(receipt.trim() ? { receiptNo: receipt.trim() } : {}),
          },
          ...idem(key),
        }),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['invoices'] });
      void qc.invalidateQueries({ queryKey: ['payments'] });
      void qc.invalidateQueries({ queryKey: ['subscriber'] });
      toast.success('Cash recorded.');
      onOpenChange(false);
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o && invoice) {
          newKey();
          setAmount(String(invoice.balancePaise / 100));
        }
        onOpenChange(o);
      }}
    >
      <DialogContent title={invoice ? `Cash for ${invoice.number}` : 'Cash'}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (paise) m.mutate();
          }}
        >
          <Field
            label="Amount (₹)"
            htmlFor="c-amount"
            error={amount && !paise ? 'Enter an amount' : m.error ? errorText(m.error) : undefined}
          >
            <Input
              id="c-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <Field label="Receipt no." htmlFor="c-receipt">
            <Input
              id="c-receipt"
              maxLength={40}
              value={receipt}
              onChange={(e) => setReceipt(e.target.value)}
            />
          </Field>
          <div className={dialogActions}>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={m.isPending} disabled={!paise}>
              Record cash
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function usePaged<T>(
  key: unknown[],
  fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null }>,
) {
  return useInfiniteQuery({
    queryKey: key,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    placeholderData: (prev) => prev,
  });
}

export function RechargesTable({
  query,
  showSubscriber = true,
}: {
  query: Record<string, string>;
  showSubscriber?: boolean;
}) {
  const can = useCan();
  const qc = useQueryClient();
  const [refunding, setRefunding] = useState<Recharge | null>(null);
  const [reason, setReason] = useState('');
  const q = usePaged(['recharges', query], (cursor) =>
    unwrap(
      api.GET('/api/v1/recharges', {
        params: { query: { limit: 50, ...query, ...(cursor ? { cursor } : {}) } },
      }),
    ),
  );
  const refund = useMutation({
    meta: { silent: true },
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/recharges/{id}/refund', {
          params: { path: { id: refunding!.id } },
          body: { reason },
        }),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['recharges'] });
      void qc.invalidateQueries({ queryKey: ['wallet'] });
      toast.success('Refunded: wallet credited, credit note issued.');
      setRefunding(null);
      setReason('');
    },
  });
  const staff = useMe().data?.user.type !== 'reseller';
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <>
      <DataTable
        caption="Recharges"
        loading={q.isLoading}
        rows={q.data?.pages.flatMap((p) => p.items)}
        rowKey={(r) => r.id}
        hasMore={q.hasNextPage}
        loadingMore={q.isFetchingNextPage}
        onLoadMore={() => void q.fetchNextPage()}
        empty="No recharges."
        columns={[
          { key: 'at', header: 'When', cell: (r) => fmtDateTime(r.createdAt) },
          ...(showSubscriber
            ? [
                {
                  key: 'sub',
                  header: 'Subscriber',
                  cell: (r: Recharge) => (
                    <a href={`/admin/subscribers/${r.subscriber.id}`} className="hover:underline">
                      {r.subscriber.name}
                      <span className="block text-xs text-muted-foreground">
                        {r.subscriber.username ?? r.subscriber.customerNo}
                      </span>
                    </a>
                  ),
                },
              ]
            : []),
          { key: 'plan', header: 'Plan', cell: (r) => r.plan?.name ?? '—' },
          {
            key: 'by',
            header: 'Paid by',
            cell: (r) => r.siteReseller?.name ?? channelLabel(r.channel),
            hideOnMobile: true,
          },
          {
            key: 'wallet',
            header: 'Wallet debit',
            cell: (r) => (r.amountPaise ? fmtRupees(r.amountPaise) : '—'),
            className: 'text-right',
          },
          { key: 'until', header: 'Valid until', cell: (r) => fmtDate(r.newExpiresAt), hideOnMobile: true },
          {
            key: 'status',
            header: 'Status',
            cell: (r) =>
              r.status === 'REVERSED' ? (
                <Badge tone="warning" title={r.reversal?.reason}>
                  Refunded
                </Badge>
              ) : (
                <Badge tone="success">Done</Badge>
              ),
          },
          {
            key: 'act',
            header: '',
            cell: (r) => (
              <div className="flex justify-end gap-1">
                {r.invoiceId ? (
                  <Button variant="ghost" size="icon" asChild aria-label="Invoice PDF">
                    <a
                      href={pdfUrl(r.invoiceId)}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <FileText />
                    </a>
                  </Button>
                ) : null}
                {staff && can('wallets.refund') && r.status === 'SUCCESS' ? (
                  <Button variant="ghost" size="sm" onClick={() => setRefunding(r)}>
                    Refund
                  </Button>
                ) : null}
              </div>
            ),
          },
        ]}
      />
      <Dialog open={!!refunding} onOpenChange={(o) => !o && setRefunding(null)}>
        <DialogContent
          title="Refund this recharge?"
          description="Credits the wallet that paid, issues a credit note and rolls the expiry back if this is the latest recharge. Nothing is deleted."
        >
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              refund.mutate();
            }}
          >
            <Field
              label="Reason"
              htmlFor="rf-reason"
              error={refund.error ? errorText(refund.error) : undefined}
            >
              <Input
                id="rf-reason"
                minLength={5}
                maxLength={200}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
            <div className={dialogActions}>
              <Button type="button" variant="outline" onClick={() => setRefunding(null)}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="destructive"
                loading={refund.isPending}
                disabled={reason.trim().length < 5}
              >
                Refund
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function InvoicesTable({
  query,
  showSubscriber = true,
}: {
  query: Record<string, string>;
  showSubscriber?: boolean;
}) {
  const can = useCan();
  const [cash, setCash] = useState<Invoice | null>(null);
  const q = usePaged(['invoices', query], (cursor) =>
    unwrap(
      api.GET('/api/v1/invoices', {
        params: { query: { limit: 50, ...query, ...(cursor ? { cursor } : {}) } },
      }),
    ),
  );
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <>
      <DataTable
        caption="Invoices"
        loading={q.isLoading}
        rows={q.data?.pages.flatMap((p) => p.items)}
        rowKey={(r) => r.id}
        hasMore={q.hasNextPage}
        loadingMore={q.isFetchingNextPage}
        onLoadMore={() => void q.fetchNextPage()}
        empty="No invoices."
        columns={[
          { key: 'no', header: 'Number', cell: (r) => <span className="font-mono text-xs">{r.number}</span> },
          { key: 'date', header: 'Date', cell: (r) => fmtDate(r.issueDate) },
          ...(showSubscriber
            ? [
                {
                  key: 'sub',
                  header: 'Subscriber',
                  cell: (r: Invoice) => (
                    <a href={`/admin/subscribers/${r.subscriber.id}`} className="hover:underline">
                      {r.subscriber.name}
                    </a>
                  ),
                },
              ]
            : []),
          {
            key: 'type',
            header: 'Type',
            cell: (r) => (r.type === 'postpaid_monthly' ? 'Monthly' : 'Recharge'),
            hideOnMobile: true,
          },
          { key: 'total', header: 'Total', cell: (r) => fmtRupees(r.totalPaise), className: 'text-right' },
          {
            key: 'due',
            header: 'Due',
            cell: (r) => (r.balancePaise ? fmtRupees(r.balancePaise) : '—'),
            className: 'text-right',
          },
          { key: 'status', header: 'Status', cell: (r) => <InvoiceStatus s={r.status} /> },
          {
            key: 'act',
            header: '',
            cell: (r) => (
              <div className="flex justify-end gap-1">
                <Button variant="ghost" size="icon" asChild aria-label={`PDF of ${r.number}`}>
                  <a href={pdfUrl(r.id)} target="_blank" rel="noreferrer">
                    <FileText />
                  </a>
                </Button>
                {can('billing.cash') && r.balancePaise > 0 ? (
                  <Button variant="ghost" size="sm" onClick={() => setCash(r)}>
                    Cash
                  </Button>
                ) : null}
              </div>
            ),
          },
        ]}
      />
      <CashPaymentDialog invoice={cash} open={!!cash} onOpenChange={(o) => !o && setCash(null)} />
    </>
  );
}

export function PaymentsTable({
  query,
  showSubscriber = true,
}: {
  query: Record<string, string>;
  showSubscriber?: boolean;
}) {
  const q = usePaged(['payments', query], (cursor) =>
    unwrap(
      api.GET('/api/v1/payments', {
        params: { query: { limit: 50, ...query, ...(cursor ? { cursor } : {}) } },
      }),
    ),
  );
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <DataTable
      caption="Payments"
      loading={q.isLoading}
      rows={q.data?.pages.flatMap((p) => p.items)}
      rowKey={(r) => r.id}
      hasMore={q.hasNextPage}
      loadingMore={q.isFetchingNextPage}
      onLoadMore={() => void q.fetchNextPage()}
      empty="No payments."
      columns={[
        { key: 'at', header: 'When', cell: (r) => fmtDateTime(r.capturedAt ?? r.createdAt) },
        ...(showSubscriber
          ? [
              {
                key: 'sub',
                header: 'Subscriber',
                cell: (r: Payment) => (
                  <a href={`/admin/subscribers/${r.subscriber.id}`} className="hover:underline">
                    {r.subscriber.name}
                  </a>
                ),
              },
            ]
          : []),
        {
          key: 'method',
          header: 'Method',
          cell: (r) => r.method[0]!.toUpperCase() + r.method.slice(1).replace('_', ' '),
        },
        {
          key: 'for',
          header: 'For',
          cell: (r) => (r.purpose.type === 'invoice' ? 'Invoice' : 'Recharge'),
          hideOnMobile: true,
        },
        { key: 'amount', header: 'Amount', cell: (r) => fmtRupees(r.amountPaise), className: 'text-right' },
        {
          key: 'ref',
          header: 'Reference',
          cell: (r) => <span className="font-mono text-xs">{r.gatewayPaymentId ?? r.receiptNo ?? '—'}</span>,
          hideOnMobile: true,
        },
        { key: 'status', header: 'Status', cell: (r) => <PaymentStatus s={r.status} /> },
      ]}
    />
  );
}

/** Subscriber page "Billing" tab. */
export function SubscriberBilling({ subscriberId }: { subscriberId: string }) {
  const query = { subscriberId };
  return (
    <Tabs defaultValue="recharges">
      <TabsList>
        <TabsTrigger value="recharges">Recharges</TabsTrigger>
        <TabsTrigger value="invoices">Invoices</TabsTrigger>
        <TabsTrigger value="payments">Payments</TabsTrigger>
      </TabsList>
      <TabsContent value="recharges">
        <RechargesTable query={query} showSubscriber={false} />
      </TabsContent>
      <TabsContent value="invoices">
        <InvoicesTable query={query} showSubscriber={false} />
      </TabsContent>
      <TabsContent value="payments">
        <PaymentsTable query={query} showSubscriber={false} />
      </TabsContent>
    </Tabs>
  );
}
