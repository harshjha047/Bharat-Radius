'use client';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { useCallback, useState } from 'react';
import { toast } from '@/lib/toast';
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
  type TopupRequest,
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

const QUANTITIES = [1, 2, 3, 4, 5, 6, 12] as const;

/** ISO instant → its calendar day in India, YYYY-MM-DD (for <input type="date">). */
const istDay = (iso: string) => new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(0, 10);

/** Reseller asks the wallet above it for money; the parent approves it as a normal top-up. */
export function RequestTopUpDialog({
  open,
  onOpenChange,
  suggestPaise,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  suggestPaise?: number;
}) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState('');
  const [via, setVia] = useState<'cash' | 'upi' | 'bank' | ''>('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const paise = toPaise(amount);
  const m = useMutation({
    meta: { silent: true },
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/wallets/topup-requests', {
          body: {
            amountPaise: paise!,
            ...(via ? { paidVia: via } : {}),
            ...(reference.trim() ? { reference: reference.trim() } : {}),
            ...(note.trim() ? { note: note.trim() } : {}),
          },
        }),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['topup-requests'] });
      toast.success(`Asked for ${fmtRupees(paise!)}. You will see the balance once it is approved.`);
      setAmount('');
      setReference('');
      setNote('');
      onOpenChange(false);
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o && suggestPaise && !amount) setAmount(String(Math.ceil(suggestPaise / 100)));
        onOpenChange(o);
      }}
    >
      <DialogContent
        title="Request a top-up"
        description="Sent to the level above you. The balance is added when they approve it."
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
            htmlFor="rq-amount"
            error={amount && !paise ? 'Enter an amount, e.g. 5000' : m.error ? errorText(m.error) : undefined}
          >
            <Input
              id="rq-amount"
              inputMode="decimal"
              autoFocus
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Paid via" htmlFor="rq-via">
              <Select id="rq-via" value={via} onChange={(e) => setVia(e.target.value as typeof via)}>
                <option value="">—</option>
                <option value="cash">Cash</option>
                <option value="upi">UPI</option>
                <option value="bank">Bank transfer</option>
              </Select>
            </Field>
            <Field label="Reference / UTR" htmlFor="rq-ref">
              <Input
                id="rq-ref"
                maxLength={60}
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Note" htmlFor="rq-note">
            <Input id="rq-note" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className={dialogActions}>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={m.isPending} disabled={!paise}>
              Request {paise ? fmtRupees(paise) : ''}
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
  const [quantity, setQuantity] = useState(1);
  const [price, setPrice] = useState<string | null>(null);
  const [until, setUntil] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [askTopUp, setAskTopUp] = useState(false);
  const quote = useQuery({
    queryKey: ['recharge-quote', subscriber.id, planId, quantity],
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/recharges/quote', {
          params: { query: { subscriberId: subscriber.id, planId, quantity } },
        }),
      ),
    placeholderData: keepPreviousData,
    enabled: open && !!planId,
    staleTime: 10_000,
  });
  const m = useMutation({
    meta: { silent: true },
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/recharges', {
          body: {
            subscriberId: subscriber.id,
            planId,
            quantity,
            ...(staff ? { payment } : {}),
            ...(override ? { override } : {}),
          },
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
  const complimentary = staff && payment === 'none';
  const pricePaise = price === null ? null : toPaise(price);
  const priceBad = price !== null && (pricePaise === null || pricePaise % 100 !== 0);
  const priceChanged = !!q && !complimentary && pricePaise !== null && pricePaise !== q.customerTotalPaise;
  const untilChanged = !!q && until !== null && !!until && until !== istDay(q.newExpiresAt);
  const untilBad =
    !!q &&
    untilChanged &&
    (until! <= istDay(q.periodStart) || (!!q.maxExpiresAt && until! > istDay(q.maxExpiresAt)));
  const override =
    priceChanged || untilChanged
      ? {
          ...(priceChanged ? { customerTotalPaise: pricePaise! } : {}),
          ...(untilChanged ? { expiresOn: until! } : {}),
          reason: reason.trim(),
        }
      : null;
  const resetEdits = () => {
    setPrice(null);
    setUntil(null);
    setReason('');
  };
  const prepaidPlans = plans.filter((p) => p.status === 'active' && p.billingTypes.includes('prepaid'));
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) {
          newKey();
          resetEdits();
        }
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
            <Select
              id="rc-plan"
              value={planId}
              onChange={(e) => {
                setPlanId(e.target.value);
                resetEdits();
              }}
            >
              <option value="">Choose a plan</option>
              {prepaidPlans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Periods"
            htmlFor="rc-qty"
            hint={q ? `${q.plan.validityDays * quantity} days` : undefined}
          >
            <Select
              id="rc-qty"
              value={quantity}
              onChange={(e) => {
                setQuantity(Number(e.target.value));
                resetEdits();
              }}
            >
              {QUANTITIES.map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? '1 (single)' : `${n} ×`}
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
                      [
                        'From your wallet',
                        q.walletModel === 'revenue_share' && q.sharePercent !== null
                          ? `${fmtRupees(q.walletPricePaise)} (${q.sharePercent}% of plan price)`
                          : fmtRupees(q.walletPricePaise),
                      ],
                      [
                        'Wallet balance',
                        q.walletBalancePaise === null ? '—' : fmtRupees(q.walletBalancePaise),
                      ],
                    ] as [string, string][])),
                ...(q.canOverride
                  ? ([['Starts', fmtDateTime(q.periodStart)]] as [string, string][])
                  : ([
                      ['Customer pays (incl. GST)', fmtRupees(q.customerTotalPaise)],
                      ['Starts', fmtDateTime(q.periodStart)],
                      ['Valid until', fmtDateTime(q.newExpiresAt)],
                    ] as [string, string][])),
              ]}
            />
          ) : null}
          {q?.canOverride ? (
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Customer pays (₹, incl. GST)"
                htmlFor="rc-price"
                hint={priceChanged ? `Plan price ${fmtRupees(q.customerTotalPaise)}` : undefined}
                error={!complimentary && priceBad ? 'Whole rupees, e.g. 590' : undefined}
              >
                <Input
                  id="rc-price"
                  inputMode="numeric"
                  disabled={complimentary}
                  value={complimentary ? '0' : (price ?? String(q.customerTotalPaise / 100))}
                  onChange={(e) => setPrice(e.target.value)}
                />
              </Field>
              <Field
                label="Valid until"
                htmlFor="rc-until"
                hint={untilChanged ? `Plan gives ${fmtDate(q.newExpiresAt)}` : 'Ends 11:59 pm'}
                error={
                  untilBad
                    ? q.maxExpiresAt && until! > istDay(q.maxExpiresAt)
                      ? `At most ${fmtDate(q.maxExpiresAt)}: add periods for more days`
                      : 'Must be after the start'
                    : undefined
                }
              >
                <Input
                  id="rc-until"
                  type="date"
                  min={istDay(q.periodStart)}
                  {...(q.maxExpiresAt ? { max: istDay(q.maxExpiresAt) } : {})}
                  value={until ?? istDay(q.newExpiresAt)}
                  onChange={(e) => setUntil(e.target.value)}
                />
              </Field>
            </div>
          ) : null}
          {override ? (
            <Field
              label="Reason for the change"
              htmlFor="rc-reason"
              hint="Saved with the recharge and in the audit log"
            >
              <Input
                id="rc-reason"
                maxLength={200}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. festival offer, compensation for outage"
              />
            </Field>
          ) : null}
          {short ? (
            <div className="flex flex-wrap items-center gap-2 text-sm text-destructive">
              <span>Insufficient Wallet Balance.</span>
              {can('wallets.transfer') ? (
                <Button type="button" size="sm" variant="outline" onClick={() => setAskTopUp(true)}>
                  Request top-up
                </Button>
              ) : (
                <span>Ask your parent for a top-up.</span>
              )}
            </div>
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
                !planId ||
                !!short ||
                (staff && !can(payment === 'cash' ? 'billing.cash' : 'wallets.adjust')) ||
                priceBad ||
                untilBad ||
                (!!override && override.reason.length < 3)
              }
            >
              Recharge
            </Button>
          </div>
        </form>
        {q && short ? (
          <RequestTopUpDialog
            open={askTopUp}
            onOpenChange={setAskTopUp}
            suggestPaise={q.walletPricePaise - (q.walletBalancePaise ?? 0)}
          />
        ) : null}
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
            <div className="flex items-center gap-2 rounded-xl border bg-subtle p-2 text-sm">
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
            cell: (r) =>
              r.amountPaise ? (
                <span>
                  {fmtRupees(r.amountPaise)}
                  {r.sharePercent !== null ? (
                    <span className="block text-xs text-muted-foreground">{r.sharePercent}% share</span>
                  ) : null}
                </span>
              ) : (
                '—'
              ),
            className: 'text-right',
          },
          {
            key: 'period',
            header: 'Period',
            cell: (r) => (
              <span className="whitespace-nowrap" title={r.override?.reason}>
                {fmtDate(r.periodStart)} → {fmtDate(r.newExpiresAt)}
                {r.quantity > 1 ? (
                  <span className="block text-xs text-muted-foreground">× {r.quantity}</span>
                ) : null}
                {r.override ? (
                  <span className="block text-xs text-warning-text">
                    Edited
                    {r.override.customerTotal
                      ? ` · ${fmtRupees(r.override.customerTotal.setPaise)} (was ${fmtRupees(r.override.customerTotal.quotedPaise)})`
                      : ''}
                    {r.override.expiresAt ? ` · plan gave ${fmtDate(r.override.expiresAt.quoted)}` : ''}
                  </span>
                ) : null}
              </span>
            ),
          },
          {
            key: 'actor',
            header: 'Recharged by',
            cell: (r) => r.by?.name ?? '—',
            hideOnMobile: true,
          },
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

const REQUEST_TONE = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  cancelled: 'neutral',
} as const;

/** Top-up requests asked of my wallet (incoming: approve / reject) or sent by me (outgoing: withdraw). */
export function TopupRequestsPanel({ box }: { box: 'incoming' | 'outgoing' }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<'pending' | 'all'>('pending');
  const [deciding, setDeciding] = useState<{ r: TopupRequest; mode: 'approve' | 'reject' } | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const list = useQuery({
    queryKey: ['topup-requests', box, status],
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/wallets/topup-requests', {
          params: { query: { box, limit: 50, ...(status === 'pending' ? { status: 'pending' } : {}) } },
        }),
      ),
    refetchInterval: 60_000,
  });
  const done = (msg: string) => {
    void qc.invalidateQueries({ queryKey: ['topup-requests'] });
    void qc.invalidateQueries({ queryKey: ['wallets'] });
    void qc.invalidateQueries({ queryKey: ['wallet'] });
    toast.success(msg);
    setDeciding(null);
  };
  const decide = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const id = deciding!.r.id;
      if (deciding!.mode === 'approve') {
        const p = toPaise(amount);
        return unwrap(
          api.POST('/api/v1/wallets/topup-requests/{id}/approve', {
            params: { path: { id } },
            body: { ...(p ? { amountPaise: p } : {}), ...(note.trim() ? { note: note.trim() } : {}) },
          }),
        );
      }
      return unwrap(
        api.POST('/api/v1/wallets/topup-requests/{id}/reject', {
          params: { path: { id } },
          body: { note: note.trim() },
        }),
      );
    },
    onSuccess: (r) =>
      done(
        r.status === 'approved'
          ? `${fmtRupees(r.approvedPaise ?? r.amountPaise)} sent to ${r.reseller.name}.`
          : 'Request rejected.',
      ),
  });
  const cancel = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.POST('/api/v1/wallets/topup-requests/{id}/cancel', { params: { path: { id } } })),
    onSuccess: () => done('Request withdrawn.'),
  });
  if (list.isError) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
  const items = list.data?.items;
  const approveP = toPaise(amount);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">
          {box === 'incoming' ? 'Top-up requests' : 'My top-up requests'}
          {list.data?.pending ? (
            <Badge tone="warning" className="ml-2">
              {list.data.pending} waiting
            </Badge>
          ) : null}
        </h2>
        <Tabs value={status} onValueChange={(v) => setStatus(v as typeof status)} className="ml-auto">
          <TabsList>
            <TabsTrigger value="pending">Waiting</TabsTrigger>
            <TabsTrigger value="all">All</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <DataTable
        caption={box === 'incoming' ? 'Top-up requests to approve' : 'My top-up requests'}
        loading={list.isLoading}
        rows={items}
        rowKey={(r) => r.id}
        empty={status === 'pending' ? 'Nothing waiting.' : 'No requests yet.'}
        columns={[
          { key: 'at', header: 'Asked', cell: (r) => fmtDateTime(r.createdAt) },
          ...(box === 'incoming'
            ? [
                {
                  key: 'who',
                  header: 'Reseller',
                  cell: (r: TopupRequest) => (
                    <div>
                      <span className="font-medium">{r.reseller.name}</span>
                      <div className="text-xs text-muted-foreground">
                        {r.reseller.code} · balance {fmtRupees(r.balancePaise)}
                      </div>
                    </div>
                  ),
                },
              ]
            : []),
          {
            key: 'amt',
            header: 'Amount',
            className: 'text-right tabular-nums',
            cell: (r) => (
              <span>
                {fmtRupees(r.amountPaise)}
                {r.approvedPaise !== null && r.approvedPaise !== r.amountPaise ? (
                  <span className="block text-xs text-muted-foreground">
                    sent {fmtRupees(r.approvedPaise)}
                  </span>
                ) : null}
              </span>
            ),
          },
          {
            key: 'pay',
            header: 'Paid via',
            hideOnMobile: true,
            cell: (r) => [r.paidVia?.toUpperCase(), r.reference, r.note].filter(Boolean).join(' · ') || '—',
          },
          {
            key: 'st',
            header: 'Status',
            cell: (r) => (
              <span title={r.decisionNote ?? undefined}>
                <Badge tone={REQUEST_TONE[r.status]}>{r.status}</Badge>
                {r.decisionNote ? (
                  <span className="block text-xs text-muted-foreground">{r.decisionNote}</span>
                ) : null}
              </span>
            ),
          },
          {
            key: 'act',
            header: '',
            cell: (r) =>
              r.canDecide ? (
                <div className="flex justify-end gap-2">
                  <Button
                    size="sm"
                    onClick={() => {
                      setAmount(String(r.amountPaise / 100));
                      setNote('');
                      setDeciding({ r, mode: 'approve' });
                    }}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setNote('');
                      setDeciding({ r, mode: 'reject' });
                    }}
                  >
                    Reject
                  </Button>
                </div>
              ) : r.canCancel ? (
                <Button
                  size="sm"
                  variant="outline"
                  loading={cancel.isPending && cancel.variables === r.id}
                  onClick={() => cancel.mutate(r.id)}
                >
                  Withdraw
                </Button>
              ) : null,
          },
        ]}
      />
      <Dialog open={!!deciding} onOpenChange={(o) => !o && setDeciding(null)}>
        <DialogContent
          title={
            deciding
              ? `${deciding.mode === 'approve' ? 'Approve' : 'Reject'} ${deciding.r.reseller.name}’s request`
              : ''
          }
          description={
            deciding?.mode === 'approve'
              ? 'Moves the money from your wallet to theirs, recorded in both ledgers.'
              : 'Nothing moves; they see your note.'
          }
        >
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              decide.mutate();
            }}
          >
            {deciding?.mode === 'approve' ? (
              <Field
                label="Amount to send (₹)"
                htmlFor="tr-amount"
                hint={`Asked: ${fmtRupees(deciding.r.amountPaise)}`}
                error={amount && !approveP ? 'Enter an amount' : undefined}
              >
                <Input
                  id="tr-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </Field>
            ) : null}
            <Field
              label={deciding?.mode === 'reject' ? 'Reason' : 'Note (optional)'}
              htmlFor="tr-note"
              error={decide.error ? errorText(decide.error) : undefined}
            >
              <Input id="tr-note" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <div className={dialogActions}>
              <Button type="button" variant="outline" onClick={() => setDeciding(null)}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant={deciding?.mode === 'reject' ? 'destructive' : 'default'}
                loading={decide.isPending}
                disabled={deciding?.mode === 'approve' ? !approveP : note.trim().length < 3}
              >
                {deciding?.mode === 'approve' ? `Send ${approveP ? fmtRupees(approveP) : ''}` : 'Reject'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
