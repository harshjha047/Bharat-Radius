/**
 * Pure maths behind the financial insights: period comparison, robust anomaly detection, trend, ageing buckets,
 * rule-based alerts and the plain-language summary. No I/O, so every rule is unit-tested.
 */
import { rupees } from '@isp/db-mongo';

export type Severity = 'critical' | 'warning' | 'info' | 'positive';

export interface Kpi {
  key: string;
  label: string;
  kind: 'money' | 'int' | 'pct';
  value: number | null;
  previous: number | null;
  /** Percent change vs the previous period (pct KPIs: change in points); null when not comparable. */
  change: number | null;
  /** true when a rise is good news (revenue), false when it is bad (refunds). */
  higherIsBetter: boolean;
}

export interface Alert {
  code: string;
  severity: Severity;
  title: string;
  detail: string;
}

export interface DayPoint {
  day: string;
  value: number;
}

export interface Anomaly extends DayPoint {
  kind: 'spike' | 'drop';
  expected: number;
  score: number;
}

export const AGEING = [
  { key: 'current', label: 'Not yet due', min: -Infinity, max: 0 },
  { key: 'd1_30', label: '1–30 days', min: 1, max: 30 },
  { key: 'd31_60', label: '31–60 days', min: 31, max: 60 },
  { key: 'd61_90', label: '61–90 days', min: 61, max: 90 },
  { key: 'd90p', label: 'Over 90 days', min: 91, max: Infinity },
] as const;
export type AgeingKey = (typeof AGEING)[number]['key'];

export const ageingBucket = (daysOverdue: number): AgeingKey =>
  AGEING.find((b) => daysOverdue >= b.min && daysOverdue <= b.max)!.key;

export const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);

/** Percent change; null when the base is zero (no meaningful percentage). */
export function pctChange(cur: number | null, prev: number | null): number | null {
  if (cur === null || prev === null || prev === 0) return null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}

export function kpi(
  key: string,
  label: string,
  kind: Kpi['kind'],
  value: number | null,
  previous: number | null,
  higherIsBetter = true,
): Kpi {
  const change =
    kind === 'pct'
      ? value !== null && previous !== null
        ? (value - previous) * 100
        : null
      : pctChange(value, previous);
  return { key, label, kind, value, previous, change, higherIsBetter };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * Days far outside the usual range, by modified z-score (median / MAD, robust to the outliers it looks for).
 * Needs at least 14 days; a flat series (MAD 0) has no anomalies.
 */
export function anomalies(series: DayPoint[], threshold = 3.5): Anomaly[] {
  if (series.length < 14) return [];
  const vals = series.map((p) => p.value);
  const med = median(vals);
  const mad = median(vals.map((v) => Math.abs(v - med)));
  if (mad === 0) return [];
  return series
    .map((p) => ({ ...p, score: (0.6745 * (p.value - med)) / mad }))
    .filter((p) => Math.abs(p.score) >= threshold)
    .map((p) => ({ ...p, kind: p.score > 0 ? ('spike' as const) : ('drop' as const), expected: med }))
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
}

/** Least-squares slope per day and the fitted value at the last day. */
export function trend(
  series: DayPoint[],
): { slopePerDay: number; fittedStart: number; fittedEnd: number } | null {
  const n = series.length;
  if (n < 7) return null;
  const mx = (n - 1) / 2;
  const my = series.reduce((s, p) => s + p.value, 0) / n;
  let num = 0;
  let den = 0;
  series.forEach((p, i) => {
    num += (i - mx) * (p.value - my);
    den += (i - mx) ** 2;
  });
  const slopePerDay = num / den;
  return { slopePerDay, fittedStart: my - slopePerDay * mx, fittedEnd: my + slopePerDay * (n - 1 - mx) };
}

/** Every IST day from `from` to `to` inclusive, with missing days as zero. */
export function fillDays(from: string, to: string, values: Map<string, number>): DayPoint[] {
  const out: DayPoint[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push({ day, value: values.get(day) ?? 0 });
  }
  return out;
}

/** The equal-length window just before [from, to]. */
export function previousPeriod(from: string, to: string): { from: string; to: string } {
  const f = Date.parse(`${from}T00:00:00Z`);
  const t = Date.parse(`${to}T00:00:00Z`);
  const len = t - f + 86_400_000;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { from: iso(f - len), to: iso(f - 86_400_000) };
}

export interface AlertInput {
  kpis: Record<string, Kpi>;
  ageing: Record<AgeingKey, number>;
  anomalies: Anomaly[];
  expiringNext7: { n: number; valuePaise: number };
  topResellerShare: { name: string; share: number } | null;
  wallets: { low: number; frozen: number } | null;
}

const pct = (x: number, digits = 0) => `${x.toFixed(digits)}%`;
/** Whole rupees for prose: "Rs. 7,84,500". */
const rs = (paise: number) => rupees(Math.round(paise / 100) * 100).replace(/\.00$/, '');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayName = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
const v = (k: Kpi | undefined) => k?.value ?? null;

export function buildAlerts(a: AlertInput): Alert[] {
  const out: Alert[] = [];
  const net = a.kpis.netRevenue;
  if (net?.change !== null && net?.change !== undefined) {
    if (net.change <= -30)
      out.push({
        code: 'revenue_drop',
        severity: 'critical',
        title: `Net revenue down ${pct(-net.change)}`,
        detail: `${rs(net.value!)} against ${rs(net.previous!)} in the previous period.`,
      });
    else if (net.change <= -15)
      out.push({
        code: 'revenue_drop',
        severity: 'warning',
        title: `Net revenue down ${pct(-net.change)}`,
        detail: `${rs(net.value!)} against ${rs(net.previous!)} in the previous period.`,
      });
    else if (net.change >= 15)
      out.push({
        code: 'revenue_growth',
        severity: 'positive',
        title: `Net revenue up ${pct(net.change)}`,
        detail: `${rs(net.value!)} against ${rs(net.previous!)} in the previous period.`,
      });
  }

  const cash = a.kpis.collected;
  if (cash?.change !== null && cash?.change !== undefined && cash.change <= -15) {
    out.push({
      code: 'collections_drop',
      severity: cash.change <= -30 ? 'critical' : 'warning',
      title: `Collections down ${pct(-cash.change)}`,
      detail: `${rs(cash.value!)} collected against ${rs(cash.previous!)} in the previous period.`,
    });
  }

  const refund = a.kpis.refundRate;
  const rr = v(refund);
  if (rr !== null && rr >= 0.05) {
    out.push({
      code: 'refunds_high',
      severity: rr >= 0.1 ? 'critical' : 'warning',
      title: `${pct(rr * 100, 1)} of recharges were refunded`,
      detail:
        refund!.previous !== null
          ? `Previous period: ${pct(refund!.previous * 100, 1)}. Check for wrong-plan recharges or disputes.`
          : 'Check for wrong-plan recharges or disputes.',
    });
  }

  const renewal = a.kpis.renewalRate;
  const rn = v(renewal);
  if (rn !== null) {
    if (rn < 0.7)
      out.push({
        code: 'renewals_low',
        severity: rn < 0.5 ? 'critical' : 'warning',
        title: `Only ${pct(rn * 100)} of expiring subscribers renewed`,
        detail: `${a.kpis.lapsed?.value ?? 0} lapsed without renewing. Follow up before they move to another ISP.`,
      });
    else if (renewal!.change !== null && renewal!.change <= -10)
      out.push({
        code: 'renewals_falling',
        severity: 'warning',
        title: `Renewal rate fell ${renewal!.change.toFixed(0)} points`,
        detail: `${pct(rn * 100)} now, ${pct(renewal!.previous! * 100)} in the previous period.`,
      });
  }

  const outstanding = Object.values(a.ageing).reduce((s, x) => s + x, 0);
  const overdue = outstanding - a.ageing.current;
  if (a.ageing.d90p > 0) {
    out.push({
      code: 'receivables_90',
      severity: 'critical',
      title: `${rs(a.ageing.d90p)} unpaid for over 90 days`,
      detail: 'Likely bad debt. Chase it or write it off with a credit note.',
    });
  } else if (overdue > 0) {
    const billed = v(a.kpis.grossBilled) ?? 0;
    const heavy = billed > 0 && overdue / billed >= 0.2;
    out.push({
      code: 'receivables_overdue',
      severity: heavy ? 'warning' : 'info',
      title: `${rs(overdue)} overdue`,
      detail: heavy
        ? `That is ${pct((overdue / billed) * 100)} of what was billed in this period.`
        : 'Postpaid invoices past their due date.',
    });
  }

  for (const x of a.anomalies.slice(0, 3)) {
    out.push({
      code: `anomaly_${x.kind}`,
      severity: x.kind === 'drop' ? 'warning' : 'info',
      title: `Unusual ${x.kind === 'drop' ? 'dip' : 'spike'} in revenue on ${dayName(x.day)}`,
      detail: `${rs(x.value)} against a typical day of ${rs(x.expected)}.`,
    });
  }

  if (a.wallets?.frozen) {
    out.push({
      code: 'wallets_frozen',
      severity: 'critical',
      title: `${a.wallets.frozen} wallet${a.wallets.frozen > 1 ? 's' : ''} frozen by reconciliation`,
      detail: 'No recharges can be made from them until the mismatch is checked and cleared.',
    });
  }
  if (a.wallets?.low) {
    out.push({
      code: 'wallets_low',
      severity: 'warning',
      title: `${a.wallets.low} reseller wallet${a.wallets.low > 1 ? 's' : ''} below the low-balance level`,
      detail: 'Their recharges will start failing; prompt a top-up.',
    });
  }

  if (a.topResellerShare && a.topResellerShare.share >= 0.5) {
    out.push({
      code: 'reseller_concentration',
      severity: 'info',
      title: `${a.topResellerShare.name} brings ${pct(a.topResellerShare.share * 100)} of reseller sales`,
      detail: 'High dependence on one reseller.',
    });
  }

  if (a.expiringNext7.n > 0) {
    out.push({
      code: 'expiring_soon',
      severity: 'info',
      title: `${a.expiringNext7.n} subscribers expire in the next 7 days`,
      detail: `${rs(a.expiringNext7.valuePaise)} of renewals (before GST) at stake.`,
    });
  }

  const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2, positive: 3 };
  return out.sort((x, y) => order[x.severity] - order[y.severity]);
}

export interface NarrativeInput {
  kpis: Record<string, Kpi>;
  trend: { slopePerDay: number; fittedStart: number; fittedEnd: number } | null;
  forecast: { next30Paise: number };
  alerts: Alert[];
}

const changeWords = (k: Kpi) =>
  k.change === null
    ? ''
    : Math.abs(k.change) < 1
      ? ', flat on the previous period'
      : `, ${k.change > 0 ? 'up' : 'down'} ${pct(Math.abs(k.change))} on the previous period`;

/** A few plain sentences a non-accountant owner can read in ten seconds. */
export function buildNarrative(n: NarrativeInput): string[] {
  const k = n.kpis;
  const out: string[] = [];
  if (k.netRevenue)
    out.push(`Net revenue was ${rs(k.netRevenue.value ?? 0)} before GST${changeWords(k.netRevenue)}.`);
  if (k.collected && k.collected.value !== null)
    out.push(`${rs(k.collected.value)} came in as payments${changeWords(k.collected)}.`);
  if (n.trend && k.netRevenue?.value) {
    const { fittedStart: a, fittedEnd: b } = n.trend;
    const base = Math.max(a, b);
    if (base > 0 && Math.abs(b - a) / base >= 0.1)
      out.push(
        `Daily revenue ${b > a ? 'climbed' : 'slipped'} through the period, from about ${rs(Math.max(0, a))} to about ${rs(Math.max(0, b))} a day.`,
      );
  }
  const rn = k.renewalRate?.value;
  if (rn !== null && rn !== undefined)
    out.push(`${pct(rn * 100)} of subscribers due for renewal renewed; ${k.lapsed?.value ?? 0} lapsed.`);
  if (k.arpu?.value) out.push(`Average revenue per paying subscriber was ${rs(k.arpu.value)}.`);
  if (k.outstanding?.value) out.push(`${rs(k.outstanding.value)} is still owed on open invoices.`);
  if (n.forecast.next30Paise > 0)
    out.push(`Expected revenue in the next 30 days: about ${rs(n.forecast.next30Paise)} before GST.`);
  const crit = n.alerts.filter((a) => a.severity === 'critical').length;
  const warn = n.alerts.filter((a) => a.severity === 'warning').length;
  out.push(
    crit || warn
      ? `${crit ? `${crit} critical` : ''}${crit && warn ? ' and ' : ''}${warn ? `${warn} warning` : ''} item${crit + warn > 1 ? 's' : ''} need attention.`
      : 'Nothing needs urgent attention.',
  );
  return out;
}

/**
 * Next-30-day revenue estimate: prepaid renewals due (at plan price) × the renewal rate, plus the postpaid monthly
 * run-rate. Uses 0.8 when there is no renewal history yet.
 */
export function forecastNext30(
  renewalsDuePaise: number,
  renewalRate: number | null,
  postpaidMonthlyPaise: number,
) {
  const rate = renewalRate ?? 0.8;
  return { next30Paise: Math.round(renewalsDuePaise * rate + postpaidMonthlyPaise), renewalRateUsed: rate };
}
