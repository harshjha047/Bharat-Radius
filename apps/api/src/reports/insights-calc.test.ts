import { describe, expect, it } from 'vitest';
import {
  ageingBucket,
  anomalies,
  buildAlerts,
  buildNarrative,
  fillDays,
  forecastNext30,
  kpi,
  pctChange,
  previousPeriod,
  trend,
  type AlertInput,
} from './insights-calc.js';

const noAgeing = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90p: 0 };
const base = (over: Partial<AlertInput> = {}): AlertInput => ({
  kpis: {},
  ageing: noAgeing,
  anomalies: [],
  expiringNext7: { n: 0, valuePaise: 0 },
  topResellerShare: null,
  wallets: null,
  ...over,
});

describe('period maths', () => {
  it('previous period has the same length and ends the day before', () => {
    expect(previousPeriod('2026-11-01', '2026-11-30')).toEqual({ from: '2026-10-02', to: '2026-10-31' });
    expect(previousPeriod('2026-03-01', '2026-03-01')).toEqual({ from: '2026-02-28', to: '2026-02-28' });
  });
  it('fills missing days with zero', () => {
    const d = fillDays('2026-02-27', '2026-03-02', new Map([['2026-03-01', 5]]));
    expect(d.map((x) => x.day)).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
    expect(d.map((x) => x.value)).toEqual([0, 0, 5, 0]);
  });
  it('percent change is null on a zero base', () => {
    expect(pctChange(150, 100)).toBe(50);
    expect(pctChange(5, 0)).toBeNull();
    expect(pctChange(null, 3)).toBeNull();
  });
  it('pct KPIs change in points', () => {
    expect(kpi('r', 'r', 'pct', 0.6, 0.8).change).toBeCloseTo(-20);
    expect(kpi('m', 'm', 'money', 50, 100).change).toBe(-50);
  });
  it('buckets days overdue', () => {
    expect(ageingBucket(-3)).toBe('current');
    expect(ageingBucket(0)).toBe('current');
    expect(ageingBucket(1)).toBe('d1_30');
    expect(ageingBucket(60)).toBe('d31_60');
    expect(ageingBucket(91)).toBe('d90p');
  });
});

describe('anomalies and trend', () => {
  const flat = (n: number, v = 1000) =>
    Array.from({ length: n }, (_, i) => ({ day: `d${i}`, value: v + (i % 3) * 10 }));
  it('needs two weeks of data', () => {
    expect(anomalies(flat(10))).toEqual([]);
  });
  it('flags a spike and a dip, largest first', () => {
    const s = flat(30);
    s[5] = { day: 'd5', value: 10_000 };
    s[20] = { day: 'd20', value: 0 };
    const a = anomalies(s);
    expect(a.map((x) => [x.day, x.kind])).toEqual([
      ['d5', 'spike'],
      ['d20', 'drop'],
    ]);
  });
  it('a constant series has none', () => {
    expect(anomalies(Array.from({ length: 20 }, (_, i) => ({ day: `${i}`, value: 7 })))).toEqual([]);
  });
  it('fits a rising line', () => {
    const t = trend(Array.from({ length: 10 }, (_, i) => ({ day: `${i}`, value: 100 + 5 * i })));
    expect(t!.slopePerDay).toBeCloseTo(5);
    expect(t!.fittedStart).toBeCloseTo(100);
    expect(t!.fittedEnd).toBeCloseTo(145);
    expect(trend(flat(3))).toBeNull();
  });
});

describe('alerts', () => {
  it('rates a revenue drop by size', () => {
    expect(
      buildAlerts(base({ kpis: { netRevenue: kpi('netRevenue', '', 'money', 60, 100) } }))[0],
    ).toMatchObject({
      code: 'revenue_drop',
      severity: 'critical',
    });
    expect(
      buildAlerts(base({ kpis: { netRevenue: kpi('netRevenue', '', 'money', 80, 100) } }))[0],
    ).toMatchObject({
      severity: 'warning',
    });
    expect(
      buildAlerts(base({ kpis: { netRevenue: kpi('netRevenue', '', 'money', 130, 100) } }))[0],
    ).toMatchObject({
      code: 'revenue_growth',
      severity: 'positive',
    });
    expect(buildAlerts(base({ kpis: { netRevenue: kpi('netRevenue', '', 'money', 95, 100) } }))).toEqual([]);
  });
  it('flags low renewals, high refunds, old receivables and frozen wallets; critical first', () => {
    const a = buildAlerts(
      base({
        kpis: {
          renewalRate: kpi('renewalRate', '', 'pct', 0.6, 0.8),
          lapsed: kpi('lapsed', '', 'int', 12, 4, false),
          refundRate: kpi('refundRate', '', 'pct', 0.12, 0.02, false),
        },
        ageing: { ...noAgeing, d90p: 50_000 },
        wallets: { low: 2, frozen: 1 },
        expiringNext7: { n: 3, valuePaise: 150_000 },
      }),
    );
    expect(a.map((x) => x.code)).toEqual([
      'refunds_high',
      'receivables_90',
      'wallets_frozen',
      'renewals_low',
      'wallets_low',
      'expiring_soon',
    ]);
    expect(a.find((x) => x.code === 'renewals_low')!.detail).toContain('12 lapsed');
  });
  it('overdue becomes a warning when it is a fifth of billing', () => {
    const a = buildAlerts(
      base({
        kpis: { grossBilled: kpi('grossBilled', '', 'money', 100_000, null) },
        ageing: { ...noAgeing, d1_30: 30_000 },
      }),
    );
    expect(a[0]).toMatchObject({ code: 'receivables_overdue', severity: 'warning' });
  });
  it('notes reseller concentration', () => {
    const a = buildAlerts(base({ topResellerShare: { name: 'Shiv Net', share: 0.7 } }));
    expect(a[0]!.title).toBe('Shiv Net brings 70% of reseller sales');
  });
});

describe('narrative and forecast', () => {
  it('reads like a summary', () => {
    const kpis = {
      netRevenue: kpi('netRevenue', '', 'money', 1_200_000, 1_000_000),
      collected: kpi('collected', '', 'money', 900_000, 900_000),
      renewalRate: kpi('renewalRate', '', 'pct', 0.82, 0.8),
      lapsed: kpi('lapsed', '', 'int', 9, 10, false),
    };
    const lines = buildNarrative({ kpis, trend: null, forecast: { next30Paise: 0 }, alerts: [] });
    expect(lines[0]).toBe('Net revenue was Rs. 12,000 before GST, up 20% on the previous period.');
    expect(lines[1]).toBe('Rs. 9,000 came in as payments, flat on the previous period.');
    expect(lines[2]).toBe('82% of subscribers due for renewal renewed; 9 lapsed.');
    expect(lines.at(-1)).toBe('Nothing needs urgent attention.');
  });
  it('describes a clear trend in daily terms', () => {
    const kpis = { netRevenue: kpi('netRevenue', '', 'money', 1_000_000, null) };
    const lines = buildNarrative({
      kpis,
      trend: { slopePerDay: 100, fittedStart: 20_000, fittedEnd: 30_000 },
      forecast: { next30Paise: 0 },
      alerts: [],
    });
    expect(lines).toContain(
      'Daily revenue climbed through the period, from about Rs. 200 to about Rs. 300 a day.',
    );
  });
  it('forecast applies the renewal rate, defaulting to 80%', () => {
    expect(forecastNext30(100_000, 0.5, 20_000)).toEqual({ next30Paise: 70_000, renewalRateUsed: 0.5 });
    expect(forecastNext30(100_000, null, 0).next30Paise).toBe(80_000);
  });
});
