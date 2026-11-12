import { Inject, Injectable } from '@nestjs/common';
import type { ObjectId } from 'mongodb';
import { z } from 'zod';
import {
  ScopedDb,
  rupees,
  type CreditNoteDoc,
  type InvoiceDoc,
  type MongoHandle,
  type PaymentDoc,
  type PlanDoc,
  type RechargeDoc,
  type ResellerDoc,
  type SubscriberDoc,
  type WalletDoc,
} from '@isp/db-mongo';
import type { AuthContext } from '../auth/context.js';
import { requireTenant } from '../billing/common.js';
import { MONGO } from '../infra/infra.module.js';
import {
  AGEING,
  anomalies,
  buildAlerts,
  buildNarrative,
  fillDays,
  forecastNext30,
  kpi,
  previousPeriod,
  ratio,
  trend,
  type AgeingKey,
  type Kpi,
} from './insights-calc.js';
import { dayKey, period, type Period, type RangeQuery } from './period.js';
import type { Table } from './render.js';

const DAY = 86_400_000;
/** How far back a renewal of an expiry in the period can have been made early. */
const EARLY_RENEWAL_DAYS = 62;
const OPEN = ['issued', 'partially_paid', 'overdue'] as const;
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 500;

const money = z.number();
const severity = z.enum(['critical', 'warning', 'info', 'positive']);
export const insightsView = z.object({
  from: z.string(),
  to: z.string(),
  previous: z.object({ from: z.string(), to: z.string() }),
  generatedAt: z.string(),
  narrative: z.array(z.string()),
  kpis: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      kind: z.enum(['money', 'int', 'pct']),
      value: z.number().nullable(),
      previous: z.number().nullable(),
      change: z.number().nullable(),
      higherIsBetter: z.boolean(),
    }),
  ),
  alerts: z.array(z.object({ code: z.string(), severity, title: z.string(), detail: z.string() })),
  daily: z.array(z.object({ day: z.string(), netPaise: money, collectedPaise: money })),
  anomalies: z.array(
    z.object({
      day: z.string(),
      valuePaise: money,
      expectedPaise: money,
      kind: z.enum(['spike', 'drop']),
    }),
  ),
  ageing: z.array(z.object({ key: z.string(), label: z.string(), amountPaise: money, invoices: z.number() })),
  defaulters: z.array(
    z.object({
      subscriberId: z.string(),
      name: z.string(),
      customerNo: z.string().nullable(),
      invoices: z.number(),
      balancePaise: money,
      daysOverdue: z.number(),
    }),
  ),
  resellers: z.array(
    z.object({
      reseller: z.string(),
      level: z.string(),
      recharges: z.number(),
      walletPaise: money,
      customerPaise: money,
      marginPaise: money,
      marginPct: z.number().nullable(),
      share: z.number(),
    }),
  ),
  plans: z.array(
    z.object({
      plan: z.string(),
      recharges: z.number(),
      revenuePaise: money,
      avgPaise: money,
      share: z.number(),
    }),
  ),
  forecast: z.object({
    next30Paise: money,
    renewalsDuePaise: money,
    renewalsDueCount: z.number(),
    postpaidMonthlyPaise: money,
    renewalRateUsed: z.number(),
    mrrPaise: money,
  }),
});
export type InsightsView = z.infer<typeof insightsView>;

interface PeriodFigures {
  invoices: { n: number; taxable: number; total: number; subscribers: number };
  creditTaxable: number;
  collected: number;
  recharges: { ok: number; reversed: number };
  joined: number;
  renewed: number;
  lapsed: number;
  postpaid: { total: number; paid: number; credited: number };
}

const hex = (id: ObjectId | null | undefined) => id?.toHexString() ?? '';

@Injectable()
export class FinancialInsightsService {
  private readonly cache = new Map<string, { at: number; value: Promise<InsightsView> }>();

  constructor(@Inject(MONGO) private readonly mongo: MongoHandle) {}

  private get db() {
    return this.mongo.db;
  }

  /** Cached per scope and range for a minute: the dashboard and the page ask for the same thing. */
  get(ctx: AuthContext, q: RangeQuery): Promise<InsightsView> {
    const tenantId = requireTenant(ctx);
    const p = period(q);
    const branch = ctx.scope.kind === 'branch' ? hex(ctx.scope.resellerId) : 'isp';
    const key = `${hex(tenantId)}:${branch}:${p.from}:${p.to}`;
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;
    const value = this.compute(ctx, p);
    value.catch(() => this.cache.delete(key));
    if (this.cache.size >= CACHE_MAX) {
      for (const [k, e] of this.cache) if (now - e.at >= CACHE_TTL_MS) this.cache.delete(k);
      if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    }
    this.cache.set(key, { at: now, value });
    return value;
  }

  private scoped(ctx: AuthContext) {
    return new ScopedDb(this.db, ctx.scope);
  }

  private async compute(ctx: AuthContext, p: Period): Promise<InsightsView> {
    const prevRange = previousPeriod(p.from, p.to);
    const prev = period(prevRange);
    const now = new Date();
    const staff = ctx.scope.kind !== 'branch';
    const [cur, before, daily, open, snapshot, resellers, plans, wallets] = await Promise.all([
      this.figures(ctx, p, now),
      this.figures(ctx, prev, now),
      this.daily(ctx, p),
      this.receivables(ctx, now),
      this.subscriberSnapshot(ctx, now),
      this.resellerMargins(ctx, p),
      this.planRevenue(ctx, p),
      staff ? this.walletHealth(requireTenant(ctx)) : Promise.resolve(null),
    ]);

    const net = (f: PeriodFigures) => f.invoices.taxable - f.creditTaxable;
    const refundRate = (f: PeriodFigures) =>
      ratio(f.recharges.reversed, f.recharges.ok + f.recharges.reversed);
    const renewalRate = (f: PeriodFigures) => ratio(f.renewed, f.renewed + f.lapsed);
    const arpu = (f: PeriodFigures) => (f.invoices.subscribers ? net(f) / f.invoices.subscribers : null);
    const postpaidRate = (f: PeriodFigures) => ratio(f.postpaid.paid, f.postpaid.total - f.postpaid.credited);
    const outstanding = open.buckets.reduce((s, b) => s + b.amountPaise, 0);
    const overdue = outstanding - (open.buckets.find((b) => b.key === 'current')?.amountPaise ?? 0);

    const list: Kpi[] = [
      kpi('netRevenue', 'Net revenue (before GST)', 'money', net(cur), net(before)),
      kpi('grossBilled', 'Billed incl. GST', 'money', cur.invoices.total, before.invoices.total),
      kpi('collected', 'Payments collected', 'money', cur.collected, before.collected),
      kpi('arpu', 'Revenue per paying subscriber', 'money', arpu(cur), arpu(before)),
      kpi('renewalRate', 'Renewal rate', 'pct', renewalRate(cur), renewalRate(before)),
      kpi('lapsed', 'Lapsed (did not renew)', 'int', cur.lapsed, before.lapsed, false),
      kpi('newSubscribers', 'New subscribers', 'int', cur.joined, before.joined),
      kpi('refundRate', 'Refunded recharges', 'pct', refundRate(cur), refundRate(before), false),
      kpi('postpaidCollection', 'Postpaid collection rate', 'pct', postpaidRate(cur), postpaidRate(before)),
      kpi('outstanding', 'Owed on open invoices', 'money', outstanding, null, false),
      kpi('overdue', 'Overdue', 'money', overdue, null, false),
    ];
    if (resellers.length) {
      const m = resellers.reduce((s, r) => s + r.marginPaise, 0);
      list.push(kpi('resellerMargin', 'Reseller margin', 'money', m, null));
    }
    const kpis = Object.fromEntries(list.map((k) => [k.key, k]));

    const series = fillDays(p.from, p.to, daily.net);
    const odd = anomalies(series);
    const tr = trend(series);
    const fc = forecastNext30(snapshot.renewalsDuePaise, renewalRate(cur), snapshot.postpaidMonthlyPaise);
    const ageing = Object.fromEntries(open.buckets.map((b) => [b.key, b.amountPaise])) as Record<
      AgeingKey,
      number
    >;
    const top = resellers[0];
    const alerts = buildAlerts({
      kpis,
      ageing,
      anomalies: odd,
      expiringNext7: snapshot.expiring7,
      topResellerShare: top && resellers.length > 1 ? { name: top.reseller, share: top.share } : null,
      wallets,
    });

    return {
      from: p.from,
      to: p.to,
      previous: prevRange,
      generatedAt: now.toISOString(),
      narrative: buildNarrative({ kpis, trend: tr, forecast: fc, alerts }),
      kpis: list,
      alerts,
      daily: series.map((d) => ({
        day: d.day,
        netPaise: d.value,
        collectedPaise: daily.collected.get(d.day) ?? 0,
      })),
      anomalies: odd.map((a) => ({
        day: a.day,
        valuePaise: a.value,
        expectedPaise: Math.round(a.expected),
        kind: a.kind,
      })),
      ageing: open.buckets,
      defaulters: open.defaulters,
      resellers,
      plans,
      forecast: {
        next30Paise: fc.next30Paise,
        renewalsDuePaise: snapshot.renewalsDuePaise,
        renewalsDueCount: snapshot.renewalsDueCount,
        postpaidMonthlyPaise: snapshot.postpaidMonthlyPaise,
        renewalRateUsed: fc.renewalRateUsed,
        mrrPaise: snapshot.mrrPaise,
      },
    };
  }

  /** Flow figures for one window; run for the period and the one before it. */
  private async figures(ctx: AuthContext, p: Period, now: Date): Promise<PeriodFigures> {
    const s = this.scoped(ctx);
    const range = { $gte: p.start, $lt: p.end };
    const lapseEnd = p.end < now ? p.end : now;
    const [inv, cn, pay, rc, joined, renewed, lapsed, post] = await Promise.all([
      s
        .collection<InvoiceDoc>('invoices')
        .aggregate<{ n: number; taxable: number; total: number; subs: ObjectId[] }>([
          { $match: { issueDate: range } },
          {
            $group: {
              _id: null,
              n: { $sum: 1 },
              taxable: { $sum: '$taxablePaise' },
              total: { $sum: '$totalPaise' },
              subs: { $addToSet: '$subscriberId' },
            },
          },
        ])
        .next(),
      s
        .collection<CreditNoteDoc>('credit_notes')
        .aggregate<{ taxable: number }>([
          { $match: { createdAt: range } },
          { $group: { _id: null, taxable: { $sum: '$taxablePaise' } } },
        ])
        .next(),
      s
        .collection<PaymentDoc>('payments')
        .aggregate<{ amount: number }>([
          { $match: { status: 'captured', capturedAt: range, method: { $ne: 'wallet' } } },
          { $group: { _id: null, amount: { $sum: '$amountPaise' } } },
        ])
        .next(),
      s
        .collection<RechargeDoc>('recharges')
        .aggregate<{ _id: string; n: number }>([
          { $match: { rechargeDate: range } },
          { $group: { _id: '$status', n: { $sum: 1 } } },
        ])
        .toArray(),
      s
        .collection<SubscriberDoc>('subscribers')
        .countDocuments({ createdAt: range, status: { $ne: 'deleted' } }),
      // Renewed: an expiry that fell in the window was extended (early, on time or late).
      s
        .collection<RechargeDoc>('recharges')
        .aggregate<{ n: number }>([
          {
            $match: {
              status: 'SUCCESS',
              rechargeDate: { $gte: new Date(p.start.getTime() - EARLY_RENEWAL_DAYS * DAY) },
              oldExpiresAt: range,
            },
          },
          { $group: { _id: '$subscriberId' } },
          { $count: 'n' },
        ])
        .next(),
      // Lapsed: prepaid, still on an expiry that fell in the window and has passed.
      lapseEnd > p.start
        ? s.collection<SubscriberDoc>('subscribers').countDocuments({
            status: 'active',
            billingType: 'prepaid',
            expiresAt: { $gte: p.start, $lt: lapseEnd },
          })
        : Promise.resolve(0),
      s
        .collection<InvoiceDoc>('invoices')
        .aggregate<{ total: number; paid: number; credited: number }>([
          { $match: { type: 'postpaid_monthly', dueDate: range, status: { $ne: 'cancelled' } } },
          {
            $group: {
              _id: null,
              total: { $sum: '$totalPaise' },
              paid: { $sum: '$paidPaise' },
              credited: { $sum: '$creditedPaise' },
            },
          },
        ])
        .next(),
    ]);
    const status = new Map(rc.map((r) => [r._id, r.n]));
    return {
      invoices: {
        n: inv?.n ?? 0,
        taxable: inv?.taxable ?? 0,
        total: inv?.total ?? 0,
        subscribers: inv?.subs.length ?? 0,
      },
      creditTaxable: cn?.taxable ?? 0,
      collected: pay?.amount ?? 0,
      recharges: { ok: status.get('SUCCESS') ?? 0, reversed: status.get('REVERSED') ?? 0 },
      joined,
      renewed: renewed?.n ?? 0,
      lapsed,
      postpaid: { total: post?.total ?? 0, paid: post?.paid ?? 0, credited: post?.credited ?? 0 },
    };
  }

  /** Net taxable revenue and collections per IST day. */
  private async daily(ctx: AuthContext, p: Period) {
    const s = this.scoped(ctx);
    const range = { $gte: p.start, $lt: p.end };
    const [inv, cn, pay] = await Promise.all([
      s
        .collection<InvoiceDoc>('invoices')
        .aggregate<{ _id: string; v: number }>([
          { $match: { issueDate: range } },
          { $group: { _id: dayKey('$issueDate'), v: { $sum: '$taxablePaise' } } },
        ])
        .toArray(),
      s
        .collection<CreditNoteDoc>('credit_notes')
        .aggregate<{ _id: string; v: number }>([
          { $match: { createdAt: range } },
          { $group: { _id: dayKey('$createdAt'), v: { $sum: '$taxablePaise' } } },
        ])
        .toArray(),
      s
        .collection<PaymentDoc>('payments')
        .aggregate<{ _id: string; v: number }>([
          { $match: { status: 'captured', capturedAt: range, method: { $ne: 'wallet' } } },
          { $group: { _id: dayKey('$capturedAt'), v: { $sum: '$amountPaise' } } },
        ])
        .toArray(),
    ]);
    const net = new Map(inv.map((r) => [r._id, r.v]));
    for (const r of cn) net.set(r._id, (net.get(r._id) ?? 0) - r.v);
    return { net, collected: new Map(pay.map((r) => [r._id, r.v])) };
  }

  /** Open invoices by age past the due date, and the ten largest overdue balances. */
  private async receivables(ctx: AuthContext, now: Date) {
    const s = this.scoped(ctx);
    const age = { $floor: { $divide: [{ $subtract: [now, '$dueDate'] }, DAY] } };
    const bucket = {
      $switch: {
        branches: AGEING.filter((b) => Number.isFinite(b.max)).map((b) => ({
          case: { $lte: ['$age', b.max] },
          then: b.key,
        })),
        default: 'd90p',
      },
    };
    const res = await s
      .collection<InvoiceDoc>('invoices')
      .aggregate<{
        buckets: { _id: AgeingKey; amount: number; n: number }[];
        top: { _id: ObjectId; balance: number; n: number; age: number }[];
      }>([
        { $match: { status: { $in: [...OPEN] }, balancePaise: { $gt: 0 } } },
        { $project: { subscriberId: 1, balancePaise: 1, age } },
        {
          $facet: {
            buckets: [{ $group: { _id: bucket, amount: { $sum: '$balancePaise' }, n: { $sum: 1 } } }],
            top: [
              { $match: { age: { $gt: 0 } } },
              {
                $group: {
                  _id: '$subscriberId',
                  balance: { $sum: '$balancePaise' },
                  n: { $sum: 1 },
                  age: { $max: '$age' },
                },
              },
              { $sort: { balance: -1 } },
              { $limit: 10 },
            ],
          },
        },
      ])
      .next();
    const by = new Map((res?.buckets ?? []).map((b) => [b._id, b]));
    const top = res?.top ?? [];
    const subs = top.length
      ? await s
          .collection<SubscriberDoc>('subscribers')
          .find({ _id: { $in: top.map((t) => t._id) } }, { projection: { name: 1, customerNo: 1 } })
          .toArray()
      : [];
    const who = new Map(subs.map((x) => [hex(x._id), x]));
    return {
      buckets: AGEING.map((b) => ({
        key: b.key,
        label: b.label,
        amountPaise: by.get(b.key)?.amount ?? 0,
        invoices: by.get(b.key)?.n ?? 0,
      })),
      defaulters: top.map((t) => {
        const x = who.get(hex(t._id));
        return {
          subscriberId: hex(t._id),
          name: x?.name ?? '—',
          customerNo: x?.customerNo ?? null,
          invoices: t.n,
          balancePaise: t.balance,
          daysOverdue: t.age,
        };
      }),
    };
  }

  /** Current base: monthly run-rate, renewals due in the next 30 days and next 7 days. */
  private async subscriberSnapshot(ctx: AuthContext, now: Date) {
    const in7 = new Date(now.getTime() + 7 * DAY);
    const in30 = new Date(now.getTime() + 30 * DAY);
    const res = await this.scoped(ctx)
      .collection<SubscriberDoc>('subscribers')
      .aggregate<{
        base: { _id: { plan: ObjectId | null; type: string }; n: number }[];
        due30: { _id: ObjectId | null; n: number }[];
        due7: { _id: ObjectId | null; n: number }[];
      }>([
        {
          $match: {
            status: 'active',
            $or: [{ billingType: 'postpaid' }, { billingType: 'prepaid', expiresAt: { $gt: now } }],
          },
        },
        { $project: { planId: 1, billingType: 1, expiresAt: 1 } },
        {
          $facet: {
            base: [{ $group: { _id: { plan: '$planId', type: '$billingType' }, n: { $sum: 1 } } }],
            due30: [
              { $match: { billingType: 'prepaid', expiresAt: { $lte: in30 } } },
              { $group: { _id: '$planId', n: { $sum: 1 } } },
            ],
            due7: [
              { $match: { billingType: 'prepaid', expiresAt: { $lte: in7 } } },
              { $group: { _id: '$planId', n: { $sum: 1 } } },
            ],
          },
        },
      ])
      .next();
    const f = res ?? { base: [], due30: [], due7: [] };
    const ids = f.base.flatMap((b) => (b._id.plan ? [b._id.plan] : []));
    const plans = ids.length
      ? await this.db
          .collection<PlanDoc>('plans')
          .find(
            { tenantId: requireTenant(ctx), _id: { $in: ids } },
            { projection: { pricePaise: 1, validityDays: 1 } },
          )
          .toArray()
      : [];
    const plan = new Map(plans.map((x) => [hex(x._id), x]));
    const price = (id: ObjectId | null) => plan.get(hex(id))?.pricePaise ?? 0;
    const monthly = (id: ObjectId | null) => {
      const x = plan.get(hex(id));
      return x ? (x.pricePaise * 30) / Math.max(1, x.validityDays) : 0;
    };
    let mrr = 0;
    let postpaid = 0;
    for (const b of f.base) {
      const m = monthly(b._id.plan) * b.n;
      mrr += m;
      if (b._id.type === 'postpaid') postpaid += m;
    }
    const sum = (rows: { _id: ObjectId | null; n: number }[]) => ({
      n: rows.reduce((s, r) => s + r.n, 0),
      valuePaise: rows.reduce((s, r) => s + price(r._id) * r.n, 0),
    });
    const d30 = sum(f.due30);
    return {
      mrrPaise: Math.round(mrr),
      postpaidMonthlyPaise: Math.round(postpaid),
      renewalsDuePaise: d30.valuePaise,
      renewalsDueCount: d30.n,
      expiring7: sum(f.due7),
    };
  }

  /** What each recharging reseller keeps: customer price (before GST) minus what its wallet paid. */
  private async resellerMargins(ctx: AuthContext, p: Period) {
    const rows = await this.scoped(ctx)
      .collection<RechargeDoc>('recharges')
      .aggregate<{ _id: ObjectId; n: number; wallet: number; customer: number }>([
        {
          $match: {
            rechargeDate: { $gte: p.start, $lt: p.end },
            status: 'SUCCESS',
            siteResellerId: { $ne: null },
          },
        },
        {
          $group: {
            _id: '$siteResellerId',
            n: { $sum: 1 },
            wallet: { $sum: '$amountPaise' },
            customer: { $sum: '$customerPricePaise' },
          },
        },
      ])
      .toArray();
    if (!rows.length) return [];
    const rs = await this.db
      .collection<ResellerDoc>('resellers')
      .find({ _id: { $in: rows.map((r) => r._id) } }, { projection: { name: 1, code: 1, level: 1 } })
      .toArray();
    const m = new Map(rs.map((r) => [hex(r._id), r]));
    const totalCustomer = rows.reduce((s, r) => s + r.customer, 0);
    return rows
      .map((r) => {
        const x = m.get(hex(r._id));
        return {
          reseller: x ? `${x.name} (${x.code})` : '—',
          level: x ? `L${x.level}` : '',
          recharges: r.n,
          walletPaise: r.wallet,
          customerPaise: r.customer,
          marginPaise: r.customer - r.wallet,
          marginPct: r.customer ? ((r.customer - r.wallet) / r.customer) * 100 : null,
          share: totalCustomer ? r.customer / totalCustomer : 0,
        };
      })
      .sort((a, b) => b.customerPaise - a.customerPaise);
  }

  /** Recharge revenue (before GST) by plan. */
  private async planRevenue(ctx: AuthContext, p: Period) {
    const rows = await this.scoped(ctx)
      .collection<RechargeDoc>('recharges')
      .aggregate<{ _id: ObjectId; n: number; v: number }>([
        { $match: { rechargeDate: { $gte: p.start, $lt: p.end }, status: 'SUCCESS' } },
        { $group: { _id: '$planId', n: { $sum: 1 }, v: { $sum: '$customerPricePaise' } } },
        { $sort: { v: -1 } },
      ])
      .toArray();
    if (!rows.length) return [];
    const plans = await this.db
      .collection<PlanDoc>('plans')
      .find(
        { tenantId: requireTenant(ctx), _id: { $in: rows.map((r) => r._id) } },
        { projection: { name: 1 } },
      )
      .toArray();
    const name = new Map(plans.map((x) => [hex(x._id), x.name]));
    const total = rows.reduce((s, r) => s + r.v, 0);
    return rows.map((r) => ({
      plan: name.get(hex(r._id)) ?? 'Deleted plan',
      recharges: r.n,
      revenuePaise: r.v,
      avgPaise: r.n ? Math.round(r.v / r.n) : 0,
      share: total ? r.v / total : 0,
    }));
  }

  /** ISP staff only: reseller wallets below their low-balance level, and wallets frozen by reconciliation. */
  private async walletHealth(tenantId: ObjectId) {
    const [r] = await this.db
      .collection<WalletDoc>('wallets')
      .aggregate<{ low: number; frozen: number }>([
        { $match: { tenantId, isActive: true } },
        {
          $group: {
            _id: null,
            low: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ['$ownerType', 'reseller'] },
                      { $lt: ['$balancePaise', '$lowBalanceThresholdPaise'] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            frozen: { $sum: { $cond: ['$frozen', 1, 0] } },
          },
        },
      ])
      .toArray();
    return { low: r?.low ?? 0, frozen: r?.frozen ?? 0 };
  }
}

/** The same insights as report tables, for the Excel / PDF export. */
export function insightsTables(v: InsightsView): Table[] {
  const show = (k: InsightsView['kpis'][number], x: number | null) =>
    x === null
      ? null
      : k.kind === 'money'
        ? rupees(Math.round(x))
        : k.kind === 'pct'
          ? `${(x * 100).toFixed(1)}%`
          : x.toLocaleString('en-IN');
  return [
    {
      title: 'Summary',
      columns: [{ key: 'line', label: 'What the numbers say' }],
      rows: v.narrative.map((line) => ({ line })),
    },
    {
      title: `Key figures (previous period ${v.previous.from} to ${v.previous.to})`,
      columns: [
        { key: 'label', label: 'Measure' },
        { key: 'value', label: 'This period' },
        { key: 'previous', label: 'Previous period' },
        { key: 'change', label: 'Change (% or points)', kind: 'pct' },
      ],
      rows: v.kpis.map((k) => ({
        label: k.label,
        value: show(k, k.value),
        previous: show(k, k.previous),
        change: k.change,
      })),
    },
    {
      title: 'Needs attention',
      columns: [
        { key: 'severity', label: 'Level' },
        { key: 'title', label: 'Finding', kind: 'text' },
        { key: 'detail', label: 'Detail', kind: 'text' },
      ],
      rows: v.alerts.map((a) => ({ severity: a.severity, title: a.title, detail: a.detail })),
    },
    {
      title: 'Receivables ageing (days past due)',
      columns: [
        { key: 'label', label: 'Age' },
        { key: 'invoices', label: 'Invoices', kind: 'int' },
        { key: 'amountPaise', label: 'Owed', kind: 'money' },
      ],
      rows: v.ageing.map((a) => ({ label: a.label, invoices: a.invoices, amountPaise: a.amountPaise })),
      totals: {
        label: 'Total',
        invoices: v.ageing.reduce((s, a) => s + a.invoices, 0),
        amountPaise: v.ageing.reduce((s, a) => s + a.amountPaise, 0),
      },
    },
    {
      title: 'Largest overdue balances',
      columns: [
        { key: 'name', label: 'Subscriber' },
        { key: 'customerNo', label: 'Customer no.', kind: 'text' },
        { key: 'invoices', label: 'Invoices', kind: 'int' },
        { key: 'daysOverdue', label: 'Oldest (days)', kind: 'int' },
        { key: 'balancePaise', label: 'Owed', kind: 'money' },
      ],
      rows: v.defaulters.map((d) => ({
        name: d.name,
        customerNo: d.customerNo,
        invoices: d.invoices,
        daysOverdue: d.daysOverdue,
        balancePaise: d.balancePaise,
      })),
    },
    {
      title: 'Reseller margin (customer price before GST − wallet price)',
      columns: [
        { key: 'reseller', label: 'Reseller' },
        { key: 'level', label: 'Level' },
        { key: 'recharges', label: 'Recharges', kind: 'int' },
        { key: 'customerPaise', label: 'Customer value', kind: 'money' },
        { key: 'walletPaise', label: 'Wallet paid', kind: 'money' },
        { key: 'marginPaise', label: 'Margin', kind: 'money' },
        { key: 'marginPct', label: 'Margin %', kind: 'pct' },
        { key: 'sharePct', label: 'Share', kind: 'pct' },
      ],
      rows: v.resellers.map((r) => ({
        reseller: r.reseller,
        level: r.level,
        recharges: r.recharges,
        customerPaise: r.customerPaise,
        walletPaise: r.walletPaise,
        marginPaise: r.marginPaise,
        marginPct: r.marginPct,
        sharePct: r.share * 100,
      })),
    },
    {
      title: 'Recharge revenue by plan (before GST)',
      columns: [
        { key: 'plan', label: 'Plan' },
        { key: 'recharges', label: 'Recharges', kind: 'int' },
        { key: 'revenuePaise', label: 'Revenue', kind: 'money' },
        { key: 'avgPaise', label: 'Average', kind: 'money' },
        { key: 'sharePct', label: 'Share', kind: 'pct' },
      ],
      rows: v.plans.map((x) => ({
        plan: x.plan,
        recharges: x.recharges,
        revenuePaise: x.revenuePaise,
        avgPaise: x.avgPaise,
        sharePct: x.share * 100,
      })),
    },
    {
      title: 'Next 30 days',
      columns: [
        { key: 'k', label: 'Measure' },
        { key: 'v', label: 'Amount', kind: 'money' },
      ],
      rows: [
        {
          k: `Prepaid renewals due (${v.forecast.renewalsDueCount} subscribers, plan price)`,
          v: v.forecast.renewalsDuePaise,
        },
        {
          k: `Expected at ${Math.round(v.forecast.renewalRateUsed * 100)}% renewal + postpaid`,
          v: v.forecast.next30Paise,
        },
        { k: 'Postpaid monthly run-rate', v: v.forecast.postpaidMonthlyPaise },
        { k: 'Monthly run-rate, whole active base', v: v.forecast.mrrPaise },
      ],
    },
  ];
}
