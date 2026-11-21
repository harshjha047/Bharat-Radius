import { Controller, Get, Inject, Injectable, Param, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ObjectId } from 'mongodb';
import type pg from 'pg';
import { z } from 'zod';
import writeXlsxFile, { type SheetData } from 'write-excel-file/node';
import {
  ScopedDb,
  gstr1,
  type CreditNoteDoc,
  type InvoiceDoc,
  type MongoHandle,
  type PaymentDoc,
  type PlanDoc,
  type RechargeDoc,
  type ResellerDoc,
  type SubscriberDoc,
  type TenantDoc,
  type TicketDoc,
} from '@isp/db-mongo';
import type { AuthContext } from '../auth/context.js';
import { assertStaff, requireTenant } from '../billing/common.js';
import { AppError } from '../errors.js';
import { Ctx, Endpoint } from '../http/endpoint.js';
import { MONGO, RADIUS_DB } from '../infra/infra.module.js';
import { FinancialInsightsService, insightsTables, insightsView } from './insights.js';
import { dayKey, istStart, period, rangeQuery, type Period } from './period.js';
import { toPdf, toXlsx, type Report, type Table } from './render.js';

export const REPORTS = {
  financial: 'Financial insights',
  revenue: 'Revenue (invoices)',
  collections: 'Collections',
  subscribers: 'Active and expired subscribers',
  recharges: 'Recharges and expiries',
  'reseller-sales': 'Reseller sales',
  usage: 'Data usage',
  tickets: 'Support tickets',
} as const;
type ReportName = keyof typeof REPORTS;
const NAMES = Object.keys(REPORTS) as [ReportName, ...ReportName[]];

const downloadQuery = rangeQuery.extend({ format: z.enum(['xlsx', 'pdf']).default('xlsx') });
const nameParams = z.object({ name: z.enum(NAMES) });
const monthQuery = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be YYYY-MM') });

const cell = z.union([z.string(), z.number(), z.null()]);
const tableView = z.object({
  title: z.string(),
  columns: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      kind: z.enum(['text', 'int', 'money', 'bytes', 'hours', 'pct']).optional(),
    }),
  ),
  rows: z.array(z.record(z.string(), cell)),
  totals: z.record(z.string(), cell).optional(),
});
const reportView = z.object({
  name: z.string(),
  title: z.string(),
  from: z.string(),
  to: z.string(),
  generatedAt: z.string(),
  tables: z.array(tableView),
});
const gstrView = z.object({
  month: z.string(),
  sheets: z.array(z.object({ name: z.string(), rows: z.number() })),
  summary: z.object({
    invoices: z.number(),
    creditNotes: z.number(),
    taxablePaise: z.number(),
    igstPaise: z.number(),
    cgstPaise: z.number(),
    sgstPaise: z.number(),
    netTaxablePaise: z.number(),
  }),
});

const sumRow = (rows: Record<string, unknown>[], keys: string[]) =>
  Object.fromEntries(keys.map((k) => [k, rows.reduce((n, r) => n + (Number(r[k]) || 0), 0)]));

@Injectable()
export class ReportsService {
  constructor(
    @Inject(MONGO) private readonly mongo: MongoHandle,
    @Inject(RADIUS_DB) private readonly pool: pg.Pool | null,
    @Inject(FinancialInsightsService) private readonly insights: FinancialInsightsService,
  ) {}

  private get db() {
    return this.mongo.db;
  }
  private scoped(ctx: AuthContext) {
    return new ScopedDb(this.db, ctx.scope);
  }

  async ispName(ctx: AuthContext) {
    const t = await this.db
      .collection<TenantDoc>('tenants')
      .findOne({ _id: requireTenant(ctx) }, { projection: { legalName: 1, name: 1 } });
    return t?.legalName ?? t?.name ?? '';
  }

  async build(ctx: AuthContext, name: ReportName, q: z.output<typeof rangeQuery>): Promise<Report> {
    requireTenant(ctx);
    const p = period(q);
    const tables =
      name === 'financial'
        ? insightsTables(await this.insights.get(ctx, { from: p.from, to: p.to }))
        : name === 'revenue'
          ? await this.revenue(ctx, p)
          : name === 'collections'
            ? await this.collections(ctx, p)
            : name === 'subscribers'
              ? await this.subscribers(ctx, p)
              : name === 'recharges'
                ? await this.recharges(ctx, p)
                : name === 'reseller-sales'
                  ? await this.resellerSales(ctx, p)
                  : name === 'usage'
                    ? await this.usage(ctx, p)
                    : await this.tickets(ctx, p);
    return {
      name,
      title: REPORTS[name],
      from: p.from,
      to: p.to,
      generatedAt: new Date().toISOString(),
      tables,
    };
  }

  private async revenue(ctx: AuthContext, p: Period): Promise<Table[]> {
    const sums = {
      n: { $sum: 1 },
      taxable: { $sum: '$taxablePaise' },
      cgst: { $sum: '$cgstPaise' },
      sgst: { $sum: '$sgstPaise' },
      igst: { $sum: '$igstPaise' },
      total: { $sum: '$totalPaise' },
    };
    const range = { $gte: p.start, $lt: p.end };
    const [inv, byType, cn] = await Promise.all([
      this.scoped(ctx)
        .collection<InvoiceDoc>('invoices')
        .aggregate<{ _id: string } & Record<string, number>>([
          { $match: { issueDate: range } },
          { $group: { _id: dayKey('$issueDate'), ...sums } },
        ])
        .toArray(),
      this.scoped(ctx)
        .collection<InvoiceDoc>('invoices')
        .aggregate<{ _id: string } & Record<string, number>>([
          { $match: { issueDate: range } },
          { $group: { _id: '$type', ...sums } },
        ])
        .toArray(),
      this.scoped(ctx)
        .collection<CreditNoteDoc>('credit_notes')
        .aggregate<{ _id: string; n: number; total: number; taxable: number }>([
          { $match: { createdAt: range } },
          {
            $group: {
              _id: dayKey('$createdAt'),
              n: { $sum: 1 },
              total: { $sum: '$totalPaise' },
              taxable: { $sum: '$taxablePaise' },
            },
          },
        ])
        .toArray(),
    ]);
    type Day = {
      day: string;
      n: number;
      taxable: number;
      cgst: number;
      sgst: number;
      igst: number;
      total: number;
      cn: number;
      net: number;
    };
    const days = new Map<string, Day>();
    const blank = (day: string): Day => ({
      day,
      n: 0,
      taxable: 0,
      cgst: 0,
      sgst: 0,
      igst: 0,
      total: 0,
      cn: 0,
      net: 0,
    });
    for (const r of inv) {
      days.set(r._id, {
        ...blank(r._id),
        n: r.n!,
        taxable: r.taxable!,
        cgst: r.cgst!,
        sgst: r.sgst!,
        igst: r.igst!,
        total: r.total!,
      });
    }
    for (const r of cn) {
      const d = days.get(r._id) ?? blank(r._id);
      d.cn = r.total;
      days.set(r._id, d);
    }
    const rows = [...days.values()]
      .map((d) => ({ ...d, net: d.total - d.cn }))
      .sort((a, b) => a.day.localeCompare(b.day));
    const keys = ['n', 'taxable', 'cgst', 'sgst', 'igst', 'total', 'cn', 'net'];
    const TYPE = { prepaid_recharge: 'Prepaid recharges', postpaid_monthly: 'Postpaid monthly' } as const;
    return [
      {
        title: 'By day',
        columns: [
          { key: 'day', label: 'Day' },
          { key: 'n', label: 'Invoices', kind: 'int' },
          { key: 'taxable', label: 'Taxable', kind: 'money' },
          { key: 'cgst', label: 'CGST', kind: 'money' },
          { key: 'sgst', label: 'SGST', kind: 'money' },
          { key: 'igst', label: 'IGST', kind: 'money' },
          { key: 'total', label: 'Invoiced', kind: 'money' },
          { key: 'cn', label: 'Credit notes', kind: 'money' },
          { key: 'net', label: 'Net', kind: 'money' },
        ],
        rows,
        totals: { day: 'Total', ...sumRow(rows, keys) },
      },
      {
        title: 'By type',
        columns: [
          { key: 'type', label: 'Type' },
          { key: 'n', label: 'Invoices', kind: 'int' },
          { key: 'taxable', label: 'Taxable', kind: 'money' },
          { key: 'total', label: 'Invoiced', kind: 'money' },
        ],
        rows: byType.map((r) => ({
          type: TYPE[r._id as keyof typeof TYPE] ?? r._id,
          n: r.n!,
          taxable: r.taxable!,
          total: r.total!,
        })),
      },
    ];
  }

  private async collections(ctx: AuthContext, p: Period): Promise<Table[]> {
    const rows = await this.scoped(ctx)
      .collection<PaymentDoc>('payments')
      .aggregate<{ _id: { day: string; method: string }; n: number; amount: number }>([
        { $match: { status: 'captured', capturedAt: { $gte: p.start, $lt: p.end } } },
        {
          $group: {
            _id: { day: dayKey('$capturedAt'), method: '$method' },
            n: { $sum: 1 },
            amount: { $sum: '$amountPaise' },
          },
        },
      ])
      .toArray();
    const methods = ['cash', 'razorpay', 'cashfree', 'bank_transfer'] as const;
    const days = new Map<string, Record<string, number | string>>();
    for (const r of rows) {
      const d = days.get(r._id.day) ?? {
        day: r._id.day,
        cash: 0,
        razorpay: 0,
        cashfree: 0,
        bank_transfer: 0,
        n: 0,
        total: 0,
      };
      if ((methods as readonly string[]).includes(r._id.method))
        d[r._id.method] = Number(d[r._id.method]) + r.amount;
      d.n = Number(d.n) + r.n;
      d.total = Number(d.total) + r.amount;
      days.set(r._id.day, d);
    }
    const list = [...days.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)));
    return [
      {
        title: 'By day and method',
        columns: [
          { key: 'day', label: 'Day' },
          { key: 'n', label: 'Payments', kind: 'int' },
          { key: 'cash', label: 'Cash', kind: 'money' },
          { key: 'razorpay', label: 'Razorpay', kind: 'money' },
          { key: 'cashfree', label: 'Cashfree', kind: 'money' },
          { key: 'bank_transfer', label: 'Bank transfer', kind: 'money' },
          { key: 'total', label: 'Total', kind: 'money' },
        ],
        rows: list,
        totals: { day: 'Total', ...sumRow(list, ['n', ...methods, 'total']) },
      },
    ];
  }

  private async subscribers(ctx: AuthContext, p: Period): Promise<Table[]> {
    const now = new Date();
    const week = new Date(now.getTime() + 7 * 86_400_000);
    const expired = {
      $and: [
        { $eq: ['$status', 'active'] },
        { $eq: ['$billingType', 'prepaid'] },
        { $or: [{ $not: ['$expiresAt'] }, { $lte: ['$expiresAt', now] }] },
      ],
    };
    const facets = await this.scoped(ctx)
      .collection<SubscriberDoc>('subscribers')
      .aggregate<{
        state: { _id: string; n: number }[];
        plans: { _id: ObjectId | null; active: number; expired: number; suspended: number; total: number }[];
        owners: { _id: ObjectId | null; active: number; expired: number; total: number }[];
        joined: { n: number }[];
        expiring: { n: number }[];
      }>([
        { $match: { status: { $ne: 'deleted' } } },
        { $set: { _expired: expired } },
        {
          $facet: {
            state: [
              {
                $group: {
                  _id: { $cond: ['$_expired', 'expired', '$status'] },
                  n: { $sum: 1 },
                },
              },
            ],
            plans: [
              {
                $group: {
                  _id: '$planId',
                  active: {
                    $sum: {
                      $cond: [{ $and: [{ $eq: ['$status', 'active'] }, { $not: ['$_expired'] }] }, 1, 0],
                    },
                  },
                  expired: { $sum: { $cond: ['$_expired', 1, 0] } },
                  suspended: { $sum: { $cond: [{ $eq: ['$status', 'suspended'] }, 1, 0] } },
                  total: { $sum: 1 },
                },
              },
            ],
            owners: [
              {
                $group: {
                  _id: '$resellerId',
                  active: {
                    $sum: {
                      $cond: [{ $and: [{ $eq: ['$status', 'active'] }, { $not: ['$_expired'] }] }, 1, 0],
                    },
                  },
                  expired: { $sum: { $cond: ['$_expired', 1, 0] } },
                  total: { $sum: 1 },
                },
              },
            ],
            joined: [{ $match: { createdAt: { $gte: p.start, $lt: p.end } } }, { $count: 'n' }],
            expiring: [
              { $match: { status: 'active', billingType: 'prepaid', expiresAt: { $gt: now, $lte: week } } },
              { $count: 'n' },
            ],
          },
        },
      ])
      .next();
    const f = facets!;
    const state = new Map(f.state.map((s) => [s._id, s.n]));
    const planIds = f.plans.flatMap((x) => (x._id ? [x._id] : []));
    const ownerIds = f.owners.flatMap((x) => (x._id ? [x._id] : []));
    const [plans, owners] = await Promise.all([
      this.db
        .collection<PlanDoc>('plans')
        .find({ _id: { $in: planIds } }, { projection: { name: 1 } })
        .toArray(),
      this.db
        .collection<ResellerDoc>('resellers')
        .find({ _id: { $in: ownerIds } }, { projection: { name: 1, code: 1 } })
        .toArray(),
    ]);
    const planName = new Map(plans.map((x) => [x._id.toHexString(), x.name]));
    const ownerName = new Map(owners.map((x) => [x._id.toHexString(), `${x.name} (${x.code})`]));
    const planRows = f.plans
      .map((x) => ({
        plan: x._id ? (planName.get(x._id.toHexString()) ?? 'Deleted plan') : 'No plan',
        active: x.active,
        expired: x.expired,
        suspended: x.suspended,
        total: x.total,
      }))
      .sort((a, b) => b.total - a.total);
    const ownerRows = f.owners
      .map((x) => ({
        owner: x._id ? (ownerName.get(x._id.toHexString()) ?? '—') : 'Direct (ISP)',
        active: x.active,
        expired: x.expired,
        total: x.total,
      }))
      .sort((a, b) => b.total - a.total);
    return [
      {
        title: 'Summary',
        columns: [
          { key: 'k', label: 'Measure' },
          { key: 'v', label: 'Subscribers', kind: 'int' },
        ],
        rows: [
          { k: 'Active (valid)', v: state.get('active') ?? 0 },
          { k: 'Expired (prepaid, not renewed)', v: state.get('expired') ?? 0 },
          { k: 'Suspended', v: state.get('suspended') ?? 0 },
          { k: 'Disabled', v: state.get('disabled') ?? 0 },
          { k: 'Expiring in the next 7 days', v: f.expiring[0]?.n ?? 0 },
          { k: `New between ${p.from} and ${p.to}`, v: f.joined[0]?.n ?? 0 },
        ],
      },
      {
        title: 'By plan',
        columns: [
          { key: 'plan', label: 'Plan' },
          { key: 'active', label: 'Active', kind: 'int' },
          { key: 'expired', label: 'Expired', kind: 'int' },
          { key: 'suspended', label: 'Suspended', kind: 'int' },
          { key: 'total', label: 'Total', kind: 'int' },
        ],
        rows: planRows,
        totals: { plan: 'Total', ...sumRow(planRows, ['active', 'expired', 'suspended', 'total']) },
      },
      {
        title: 'By owner',
        columns: [
          { key: 'owner', label: 'Owner' },
          { key: 'active', label: 'Active', kind: 'int' },
          { key: 'expired', label: 'Expired', kind: 'int' },
          { key: 'total', label: 'Total', kind: 'int' },
        ],
        rows: ownerRows,
      },
    ];
  }

  /**
   * Recharges and expiries in the period (docx §8): recharge count / amount / users recharged, users expired in the
   * period (still expired = pending, or renewed late), pending now, day- and month-wise, package-wise, recharge list.
   */
  private async recharges(ctx: AuthContext, p: Period): Promise<Table[]> {
    const now = new Date();
    const capEnd = p.end < now ? p.end : now;
    const ok = { $eq: ['$status', 'SUCCESS'] };
    const gross = { $add: ['$customerPricePaise', '$taxPaise'] };
    const qty = { $ifNull: ['$quantity', 1] };
    const rc = this.scoped(ctx).collection<RechargeDoc>('recharges');
    const subs = this.scoped(ctx).collection<SubscriberDoc>('subscribers');
    const inPeriod = { rechargeDate: { $gte: p.start, $lt: p.end } };
    const expiredNow = {
      status: 'active' as const,
      billingType: 'prepaid' as const,
      expiresAt: { $lte: now },
    };
    const groupBy = (fmt: string) => ({
      $group: {
        _id: { $dateToString: { format: fmt, date: '$rechargeDate', timezone: 'Asia/Kolkata' } },
        n: { $sum: { $cond: [ok, 1, 0] } },
        users: { $addToSet: { $cond: [ok, '$subscriberId', '$$REMOVE'] } },
        amount: { $sum: { $cond: [ok, gross, 0] } },
        reversed: { $sum: { $cond: [ok, 0, 1] } },
      },
    });
    const expiredGroup = (fmt: string) => ({
      $group: {
        _id: { $dateToString: { format: fmt, date: '$expiresAt', timezone: 'Asia/Kolkata' } },
        n: { $sum: 1 },
      },
    });
    const [byDay, byMonth, byPlan, users, stillExpired, renewedLate, pending, expiring, joined, list] =
      await Promise.all([
        rc
          .aggregate<{ _id: string; n: number; users: ObjectId[]; amount: number; reversed: number }>([
            { $match: inPeriod },
            groupBy('%Y-%m-%d'),
          ])
          .toArray(),
        rc
          .aggregate<{ _id: string; n: number; users: ObjectId[]; amount: number; reversed: number }>([
            { $match: inPeriod },
            groupBy('%Y-%m'),
          ])
          .toArray(),
        rc
          .aggregate<{ _id: ObjectId; n: number; periods: number; amount: number }>([
            { $match: { ...inPeriod, status: 'SUCCESS' } },
            { $group: { _id: '$planId', n: { $sum: 1 }, periods: { $sum: qty }, amount: { $sum: gross } } },
          ])
          .toArray(),
        rc
          .aggregate<{ n: number }>([
            { $match: { ...inPeriod, status: 'SUCCESS' } },
            { $group: { _id: '$subscriberId' } },
            { $count: 'n' },
          ])
          .toArray(),
        subs
          .aggregate<{ _id: string; n: number }>([
            { $match: { ...expiredNow, expiresAt: { $gte: p.start, $lt: capEnd } } },
            expiredGroup('%Y-%m-%d'),
          ])
          .toArray(),
        // Expired in the period and renewed afterwards: the recharge that renewed them started from their old expiry.
        rc
          .aggregate<{ _id: null; ids: ObjectId[] }>([
            {
              $match: {
                status: 'SUCCESS',
                oldExpiresAt: { $gte: p.start, $lt: capEnd },
                $expr: { $lt: ['$oldExpiresAt', '$rechargeDate'] },
              },
            },
            { $group: { _id: null, ids: { $addToSet: '$subscriberId' } } },
          ])
          .toArray(),
        subs.countDocuments(expiredNow),
        subs.countDocuments({
          status: 'active',
          billingType: 'prepaid',
          expiresAt: { $gt: now, $lte: new Date(now.getTime() + 7 * 86_400_000) },
        }),
        subs.countDocuments({ status: { $ne: 'deleted' }, createdAt: { $gte: p.start, $lt: p.end } }),
        rc.find(inPeriod, { sort: { rechargeDate: -1 }, limit: 5000 }).toArray(),
      ]);

    const planIds = [...new Set([...byPlan.map((x) => x._id), ...list.map((x) => x.planId)].map(String))].map(
      (x) => new ObjectId(x),
    );
    const subIds = [...new Set(list.map((x) => x.subscriberId.toHexString()))].map((x) => new ObjectId(x));
    const actorIds = [...new Set(list.map((x) => x.actorId).filter((a) => ObjectId.isValid(a)))].map(
      (a) => new ObjectId(a),
    );
    const [plans, people, actors] = await Promise.all([
      this.db
        .collection<PlanDoc>('plans')
        .find({ _id: { $in: planIds } }, { projection: { name: 1 } })
        .toArray(),
      this.db
        .collection<SubscriberDoc>('subscribers')
        .find({ _id: { $in: subIds } }, { projection: { customerNo: 1, username: 1, name: 1 } })
        .toArray(),
      this.db
        .collection<{ _id: ObjectId; name: string }>('users')
        .find({ _id: { $in: actorIds } }, { projection: { name: 1 } })
        .toArray(),
    ]);
    const planName = new Map(plans.map((x) => [x._id.toHexString(), x.name]));
    const person = new Map(people.map((x) => [x._id.toHexString(), x]));
    const actor = new Map(actors.map((x) => [x._id.toHexString(), x.name]));
    const istDay = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);

    const expiredByDay = new Map(stillExpired.map((x) => [x._id, x.n]));
    const lateIds = renewedLate[0]?.ids ?? [];
    const stillExpiredTotal = stillExpired.reduce((n, x) => n + x.n, 0);
    const dayRows = [...new Set([...byDay.map((x) => x._id), ...expiredByDay.keys()])].sort().map((day) => {
      const x = byDay.find((d) => d._id === day);
      return {
        day,
        n: x?.n ?? 0,
        users: x?.users.length ?? 0,
        amount: x?.amount ?? 0,
        reversed: x?.reversed ?? 0,
        expired: expiredByDay.get(day) ?? 0,
      };
    });
    const monthExpired = new Map<string, number>();
    for (const x of stillExpired)
      monthExpired.set(x._id.slice(0, 7), (monthExpired.get(x._id.slice(0, 7)) ?? 0) + x.n);
    const monthRows = [...new Set([...byMonth.map((x) => x._id), ...monthExpired.keys()])]
      .sort()
      .map((month) => {
        const x = byMonth.find((d) => d._id === month);
        return {
          month,
          n: x?.n ?? 0,
          users: x?.users.length ?? 0,
          amount: x?.amount ?? 0,
          reversed: x?.reversed ?? 0,
          expired: monthExpired.get(month) ?? 0,
        };
      });
    const planRows = byPlan
      .map((x) => ({
        plan: planName.get(x._id.toHexString()) ?? 'Deleted plan',
        n: x.n,
        periods: x.periods,
        amount: x.amount,
      }))
      .sort((a, b) => b.amount - a.amount);
    const listRows = list.map((x) => {
      const s = person.get(x.subscriberId.toHexString());
      const start =
        x.periodStart ??
        (x.oldExpiresAt && x.oldExpiresAt > x.rechargeDate ? x.oldExpiresAt : x.rechargeDate);
      return {
        date: istDay(x.rechargeDate),
        customer: s?.customerNo ?? '',
        username: s?.username ?? '',
        name: s?.name ?? '',
        plan: planName.get(x.planId.toHexString()) ?? '',
        qty: x.quantity ?? 1,
        start: istDay(start),
        end: istDay(x.newExpiresAt),
        amount: x.status === 'SUCCESS' ? x.customerPricePaise + x.taxPaise : 0,
        status: x.status === 'SUCCESS' ? 'Done' : 'Refunded',
        by: actor.get(x.actorId) ?? x.channel,
      };
    });
    const sumKeys = ['n', 'users', 'amount', 'reversed', 'expired'];
    const periodCols = [
      { key: 'n', label: 'Recharges', kind: 'int' as const },
      { key: 'users', label: 'Users recharged', kind: 'int' as const },
      { key: 'amount', label: 'Amount incl. GST', kind: 'money' as const },
      { key: 'reversed', label: 'Refunded', kind: 'int' as const },
      { key: 'expired', label: 'Expired, not renewed', kind: 'int' as const },
    ];
    return [
      {
        title: 'Summary',
        columns: [
          { key: 'k', label: 'Measure' },
          { key: 'v', label: 'Count', kind: 'int' },
        ],
        rows: [
          { k: 'Recharges', v: byDay.reduce((n, x) => n + x.n, 0) },
          { k: 'Users recharged', v: users[0]?.n ?? 0 },
          { k: 'Expired in the period', v: stillExpiredTotal + lateIds.length },
          { k: '  of them renewed later', v: lateIds.length },
          { k: '  still not renewed', v: stillExpiredTotal },
          { k: 'Pending recharge now (all expired)', v: pending },
          { k: 'Expiring in the next 7 days', v: expiring },
          { k: 'New subscribers', v: joined },
        ],
      },
      {
        title: 'Amount',
        columns: [
          { key: 'k', label: 'Measure' },
          { key: 'v', label: 'Amount', kind: 'money' },
        ],
        rows: [{ k: 'Recharges incl. GST', v: byDay.reduce((n, x) => n + x.amount, 0) }],
      },
      {
        title: 'By day',
        columns: [{ key: 'day', label: 'Day' }, ...periodCols],
        rows: dayRows,
        totals: { day: 'Total', ...sumRow(dayRows, sumKeys), users: users[0]?.n ?? 0 },
      },
      {
        title: 'By month',
        columns: [{ key: 'month', label: 'Month' }, ...periodCols],
        rows: monthRows,
        totals: { month: 'Total', ...sumRow(monthRows, sumKeys), users: users[0]?.n ?? 0 },
      },
      {
        title: 'By package',
        columns: [
          { key: 'plan', label: 'Package' },
          { key: 'n', label: 'Recharges', kind: 'int' },
          { key: 'periods', label: 'Periods sold', kind: 'int' },
          { key: 'amount', label: 'Amount incl. GST', kind: 'money' },
        ],
        rows: planRows,
        totals: { plan: 'Total', ...sumRow(planRows, ['n', 'periods', 'amount']) },
      },
      {
        title: list.length === 5000 ? 'Recharges (latest 5,000)' : 'Recharges',
        columns: [
          { key: 'date', label: 'Date' },
          { key: 'customer', label: 'Customer no.' },
          { key: 'username', label: 'Username' },
          { key: 'name', label: 'Name' },
          { key: 'plan', label: 'Package' },
          { key: 'qty', label: 'Qty', kind: 'int' },
          { key: 'start', label: 'Start' },
          { key: 'end', label: 'End' },
          { key: 'amount', label: 'Amount incl. GST', kind: 'money' },
          { key: 'status', label: 'Status' },
          { key: 'by', label: 'By' },
        ],
        rows: listRows,
      },
    ];
  }

  private async resellerSales(ctx: AuthContext, p: Period): Promise<Table[]> {
    const rows = await this.scoped(ctx)
      .collection<RechargeDoc>('recharges')
      .aggregate<{
        _id: ObjectId | null;
        n: number;
        reversed: number;
        wallet: number;
        customer: number;
      }>([
        { $match: { rechargeDate: { $gte: p.start, $lt: p.end } } },
        {
          $group: {
            _id: '$siteResellerId',
            n: { $sum: { $cond: [{ $eq: ['$status', 'SUCCESS'] }, 1, 0] } },
            reversed: { $sum: { $cond: [{ $eq: ['$status', 'REVERSED'] }, 1, 0] } },
            wallet: { $sum: { $cond: [{ $eq: ['$status', 'SUCCESS'] }, '$amountPaise', 0] } },
            customer: {
              $sum: {
                $cond: [{ $eq: ['$status', 'SUCCESS'] }, { $add: ['$customerPricePaise', '$taxPaise'] }, 0],
              },
            },
          },
        },
      ])
      .toArray();
    const ids = rows.flatMap((r) => (r._id ? [r._id] : []));
    const rs = await this.db
      .collection<ResellerDoc>('resellers')
      .find({ _id: { $in: ids } }, { projection: { name: 1, code: 1, level: 1 } })
      .toArray();
    const m = new Map(rs.map((r) => [r._id.toHexString(), r]));
    const list = rows
      .map((r) => {
        const x = r._id ? m.get(r._id.toHexString()) : undefined;
        return {
          reseller: r._id ? (x ? `${x.name} (${x.code})` : '—') : 'ISP (staff / online)',
          level: x ? `L${x.level}` : '',
          n: r.n,
          reversed: r.reversed,
          wallet: r.wallet,
          customer: r.customer,
        };
      })
      .sort((a, b) => b.wallet - a.wallet);
    return [
      {
        title: 'Recharges by the level that recharged',
        columns: [
          { key: 'reseller', label: 'Reseller' },
          { key: 'level', label: 'Level' },
          { key: 'n', label: 'Recharges', kind: 'int' },
          { key: 'reversed', label: 'Refunded', kind: 'int' },
          { key: 'wallet', label: 'Wallet debit', kind: 'money' },
          { key: 'customer', label: 'Customer value incl. GST', kind: 'money' },
        ],
        rows: list,
        totals: { reseller: 'Total', ...sumRow(list, ['n', 'reversed', 'wallet', 'customer']) },
      },
    ];
  }

  private async usage(ctx: AuthContext, p: Period): Promise<Table[]> {
    assertStaff(ctx, 'see the usage report');
    if (!this.pool) throw new AppError(503, 'INTERNAL', 'RADIUS database not configured');
    const tenantId = requireTenant(ctx);
    const t = await this.pool.query<{ id: number }>('SELECT id FROM tenants WHERE external_id = $1', [
      tenantId.toHexString(),
    ]);
    const pgId = t.rows[0]?.id;
    if (pgId === undefined) return [];
    const [daily, top] = await Promise.all([
      this.pool.query<{ day: string; users: string; down: string; up: string }>(
        `SELECT to_char(day, 'YYYY-MM-DD') AS day, count(DISTINCT username) AS users,
                sum(bytes_out) AS down, sum(bytes_in) AS up
           FROM usage_daily WHERE tenant_id = $1 AND day BETWEEN $2 AND $3 GROUP BY day ORDER BY day`,
        [pgId, p.from, p.to],
      ),
      this.pool.query<{ username: string; down: string; up: string; secs: string }>(
        `SELECT username, sum(bytes_out) AS down, sum(bytes_in) AS up, sum(session_secs) AS secs
           FROM usage_daily WHERE tenant_id = $1 AND day BETWEEN $2 AND $3
          GROUP BY username ORDER BY sum(bytes_out) + sum(bytes_in) DESC LIMIT 50`,
        [pgId, p.from, p.to],
      ),
    ]);
    const subs = await this.db
      .collection<SubscriberDoc>('subscribers')
      .find(
        { tenantId, username: { $in: top.rows.map((r) => r.username) } },
        { projection: { username: 1, name: 1, customerNo: 1 } },
      )
      .toArray();
    const who = new Map(subs.map((s) => [s.username!, s]));
    const dayRows = daily.rows.map((r) => ({
      day: r.day,
      users: Number(r.users),
      down: Number(r.down),
      up: Number(r.up),
    }));
    return [
      {
        title: 'By day',
        columns: [
          { key: 'day', label: 'Day' },
          { key: 'users', label: 'Users online', kind: 'int' },
          { key: 'down', label: 'Download', kind: 'bytes' },
          { key: 'up', label: 'Upload', kind: 'bytes' },
        ],
        rows: dayRows,
        totals: { day: 'Total', users: null, ...sumRow(dayRows, ['down', 'up']) },
      },
      {
        title: 'Top 50 users',
        columns: [
          { key: 'username', label: 'Username' },
          { key: 'name', label: 'Name' },
          { key: 'down', label: 'Download', kind: 'bytes' },
          { key: 'up', label: 'Upload', kind: 'bytes' },
          { key: 'hours', label: 'Online hours', kind: 'hours' },
        ],
        rows: top.rows.map((r) => ({
          username: r.username,
          name: who.get(r.username)?.name ?? '',
          down: Number(r.down),
          up: Number(r.up),
          hours: Number(r.secs) / 3600,
        })),
      },
    ];
  }

  private async tickets(ctx: AuthContext, p: Period): Promise<Table[]> {
    const rows = await this.scoped(ctx)
      .collection<TicketDoc>('tickets')
      .aggregate<{
        _id: string;
        opened: number;
        resolved: number;
        responded: number;
        responseMs: number;
        resolveMs: number;
      }>([
        { $match: { createdAt: { $gte: p.start, $lt: p.end } } },
        {
          $group: {
            _id: '$category',
            opened: { $sum: 1 },
            resolved: { $sum: { $cond: [{ $in: ['$status', ['resolved', 'closed']] }, 1, 0] } },
            responded: { $sum: { $cond: [{ $ifNull: ['$firstResponseAt', false] }, 1, 0] } },
            responseMs: {
              $sum: {
                $cond: [
                  { $ifNull: ['$firstResponseAt', false] },
                  { $subtract: ['$firstResponseAt', '$createdAt'] },
                  0,
                ],
              },
            },
            resolveMs: {
              $sum: {
                $cond: [{ $ifNull: ['$resolvedAt', false] }, { $subtract: ['$resolvedAt', '$createdAt'] }, 0],
              },
            },
          },
        },
      ])
      .toArray();
    const LABEL: Record<string, string> = {
      no_internet: 'No internet',
      slow_speed: 'Slow speed',
      billing: 'Billing',
      plan_change: 'Plan change',
      relocation: 'Shifting / relocation',
      other: 'Other',
    };
    const list = rows
      .map((r) => ({
        category: LABEL[r._id] ?? r._id,
        opened: r.opened,
        resolved: r.resolved,
        response: r.responded ? r.responseMs / r.responded / 3_600_000 : null,
        resolve: r.resolved ? r.resolveMs / r.resolved / 3_600_000 : null,
      }))
      .sort((a, b) => b.opened - a.opened);
    return [
      {
        title: 'By category (tickets opened in the period)',
        columns: [
          { key: 'category', label: 'Category' },
          { key: 'opened', label: 'Opened', kind: 'int' },
          { key: 'resolved', label: 'Resolved / closed', kind: 'int' },
          { key: 'response', label: 'Avg first response (h)', kind: 'hours' },
          { key: 'resolve', label: 'Avg time to resolve (h)', kind: 'hours' },
        ],
        rows: list,
        totals: { category: 'Total', ...sumRow(list, ['opened', 'resolved']), response: null, resolve: null },
      },
    ];
  }

  /** GSTR-1 for an IST month from the stored invoice and credit-note snapshots (ISP staff only). */
  async gstr1(ctx: AuthContext, month: string) {
    assertStaff(ctx, 'export GST returns');
    const tenantId = requireTenant(ctx);
    const [y, m] = month.split('-').map(Number) as [number, number];
    const start = istStart(`${month}-01`);
    const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    const end = istStart(next);
    const [invs, cns] = await Promise.all([
      this.db
        .collection<InvoiceDoc>('invoices')
        .find({ tenantId, issueDate: { $gte: start, $lt: end } })
        .toArray(),
      this.db
        .collection<CreditNoteDoc>('credit_notes')
        .find({ tenantId, createdAt: { $gte: start, $lt: end } })
        .toArray(),
    ]);
    const parents = await this.db
      .collection<InvoiceDoc>('invoices')
      .find({ _id: { $in: cns.map((c) => c.invoiceId) } }, { projection: { totalPaise: 1 } })
      .toArray();
    const total = new Map(parents.map((x) => [x._id.toHexString(), x.totalPaise]));
    return gstr1(
      invs,
      cns.map((c) => {
        const t = total.get(c.invoiceId.toHexString());
        return { ...c, invoice: t === undefined ? null : { totalPaise: t } };
      }),
    );
  }

  async gstr1Xlsx(ctx: AuthContext, month: string): Promise<Buffer> {
    const r = await this.gstr1(ctx, month);
    return writeXlsxFile(
      r.sheets.map((s) => ({
        sheet: s.name,
        data: [s.header.map((h) => ({ value: h, fontWeight: 'bold' as const })), ...s.rows] as SheetData,
        columns: s.header.map((h) => ({ width: Math.max(12, h.length + 2) })),
      })),
    ).toBuffer();
  }
}

@Controller('reports')
export class ReportsController {
  constructor(
    @Inject(ReportsService) private readonly s: ReportsService,
    @Inject(FinancialInsightsService) private readonly fin: FinancialInsightsService,
  ) {}

  @Get('insights')
  @Endpoint({
    summary:
      'Financial insights for a date range: key figures vs the previous period, alerts, receivables ageing, ' +
      'reseller margin, plan revenue, anomalies and a 30-day forecast; a reseller sees its branch',
    tags: ['reports'],
    permission: 'reports.view',
    query: rangeQuery,
    response: insightsView,
  })
  insightsSummary(@Ctx() ctx: AuthContext, @Query() q: z.output<typeof rangeQuery>) {
    return this.fin.get(ctx, q);
  }

  @Get('gstr1')
  @Endpoint({
    summary: 'GSTR-1 summary for a month (row counts per sheet, totals); ISP staff only',
    tags: ['reports'],
    permission: 'reports.view',
    query: monthQuery,
    response: gstrView,
  })
  async gstr1(@Ctx() ctx: AuthContext, @Query() q: z.output<typeof monthQuery>) {
    const r = await this.s.gstr1(ctx, q.month);
    return {
      month: q.month,
      summary: r.summary,
      sheets: r.sheets.map((s) => ({ name: s.name, rows: s.rows.length })),
    };
  }

  @Get('gstr1/download')
  @Endpoint({
    summary: 'GSTR-1 Excel in the GST offline tool layout (b2b, b2cl, b2cs, cdnr, cdnur, hsn, docs)',
    tags: ['reports'],
    permission: 'reports.view',
    audit: 'report.gstr1_export',
    query: monthQuery,
  })
  async gstr1Download(
    @Ctx() ctx: AuthContext,
    @Query() q: z.output<typeof monthQuery>,
    @Res() reply: FastifyReply,
  ) {
    const data = await this.s.gstr1Xlsx(ctx, q.month);
    void reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="GSTR1-${q.month}.xlsx"`)
      .header('cache-control', 'private, no-store')
      .send(data);
  }

  @Get(':name')
  @Endpoint({
    summary: 'A report for a date range (IST days, default this month); a reseller sees its branch',
    tags: ['reports'],
    permission: 'reports.view',
    params: nameParams,
    query: rangeQuery,
    response: reportView,
  })
  get(
    @Ctx() ctx: AuthContext,
    @Param() p: z.output<typeof nameParams>,
    @Query() q: z.output<typeof rangeQuery>,
  ) {
    return this.s.build(ctx, p.name, q);
  }

  @Get(':name/download')
  @Endpoint({
    summary: 'The same report as Excel or PDF',
    tags: ['reports'],
    permission: 'reports.view',
    audit: 'report.export',
    params: nameParams,
    query: downloadQuery,
  })
  async download(
    @Ctx() ctx: AuthContext,
    @Param() p: z.output<typeof nameParams>,
    @Query() q: z.output<typeof downloadQuery>,
    @Res() reply: FastifyReply,
  ) {
    const r = await this.s.build(ctx, p.name, q);
    const file = `${p.name}-${r.from}-to-${r.to}.${q.format}`;
    const data = q.format === 'pdf' ? await toPdf(r, await this.s.ispName(ctx)) : await toXlsx(r);
    void reply
      .header(
        'content-type',
        q.format === 'pdf'
          ? 'application/pdf'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      )
      .header('content-disposition', `attachment; filename="${file}"`)
      .header('cache-control', 'private, no-store')
      .send(data);
  }
}
