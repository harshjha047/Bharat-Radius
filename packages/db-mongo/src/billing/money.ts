import type { GstLine, GstParty, GstTotals, TenantBilling } from './types.js';

/** Money and wallet failures the API turns into HTTP errors (TRD §7 codes). */
export class MoneyError extends Error {
  constructor(
    readonly status: number,
    readonly code:
      | 'WALLET_INSUFFICIENT'
      | 'WALLET_FROZEN'
      | 'WALLET_INACTIVE'
      | 'BRANCH_SUSPENDED'
      | 'NOT_FOUND'
      | 'CONFLICT'
      | 'VALIDATION_FAILED'
      | 'GATEWAY_ERROR',
    message: string,
  ) {
    super(message);
    this.name = 'MoneyError';
  }
}

export const insufficient = () => new MoneyError(409, 'WALLET_INSUFFICIENT', 'Insufficient Wallet Balance');

export const DEFAULT_BILLING: TenantBilling = {
  invoicePrefix: 'INV',
  reminderDaysBefore: [3, 1],
  dueDays: 6,
  graceDays: 3,
  lowBalancePaise: 500_000,
};

const IST_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

/** Calendar date in India as { y, m (1–12), d }. */
export function istParts(at: Date): { y: number; m: number; d: number } {
  const t = new Date(at.getTime() + IST_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** 00:00:00 IST of the given calendar day, as a UTC instant. */
export const istMidnight = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d) - IST_MS);

/** 23:59:59 IST of the calendar day `at` falls on. */
export function endOfIstDay(at: Date): Date {
  const { y, m, d } = istParts(at);
  return new Date(istMidnight(y, m, d + 1).getTime() - 1000);
}

/**
 * Prepaid renewal (TRD §6.5): new expiry = max(now, current expiry) + validity days, ending 23:59:59 IST.
 * A customer still in service keeps the unused days; an expired one starts today.
 */
export function renewedExpiry(
  current: Date | null | undefined,
  validityDays: number,
  now = new Date(),
): Date {
  const base = current && current > now ? current : now;
  if (base === now) return endOfIstDay(new Date(now.getTime() + (validityDays - 1) * DAY_MS));
  return endOfIstDay(new Date(base.getTime() + validityDays * DAY_MS));
}

/** Period a prepaid recharge buys: starts at the current expiry if still in service, else now. */
export function rechargePeriod(
  current: Date | null | undefined,
  validityDays: number,
  quantity = 1,
  now = new Date(),
): { start: Date; end: Date } {
  return {
    start: current && current > now ? current : now,
    end: renewedExpiry(current, validityDays * quantity, now),
  };
}

/** Indian financial year of a date, e.g. "2026-27". */
export function financialYear(at: Date): string {
  const { y, m } = istParts(at);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** GST document number: PREFIX/2627/00001 — at most 16 characters, consecutive per FY. */
export function documentNumber(prefix: string, fy: string, seq: number): string {
  const n = `${prefix}/${fy.slice(2, 4)}${fy.slice(5, 7)}/${String(seq).padStart(5, '0')}`;
  if (n.length > 16) throw new MoneyError(500, 'CONFLICT', 'Invoice number would exceed 16 characters');
  return n;
}

/** Round half up to the paisa (amounts are non-negative). */
const halfUp = (x: number) => Math.floor(x + 0.5);

/**
 * One GST line: CGST + SGST (each half the rate) when the place of supply is the seller's state, else IGST.
 * Each component rounded half up to the paisa (TRD §6.5).
 */
export function gstLine(input: {
  description: string;
  hsnSac: string;
  ratePaise: number;
  qty?: number;
  gstRatePercent: number;
  intraState: boolean;
}): GstLine {
  const qty = input.qty ?? 1;
  const taxable = input.ratePaise * qty;
  const cgst = input.intraState ? halfUp((taxable * input.gstRatePercent) / 200) : 0;
  const igst = input.intraState ? 0 : halfUp((taxable * input.gstRatePercent) / 100);
  return {
    description: input.description,
    hsnSac: input.hsnSac,
    qty,
    ratePaise: input.ratePaise,
    taxablePaise: taxable,
    gstRatePercent: input.gstRatePercent,
    cgstPaise: cgst,
    sgstPaise: cgst,
    igstPaise: igst,
    totalPaise: taxable + 2 * cgst + igst,
  };
}

/** Totals of a document; the grand total is rounded to the rupee with the difference shown as round-off. */
export function gstTotals(lines: GstLine[]): GstTotals {
  const sum = (k: keyof GstLine) => lines.reduce((a, l) => a + (l[k] as number), 0);
  const exact = sum('totalPaise');
  const total = halfUp(exact / 100) * 100;
  return {
    taxablePaise: sum('taxablePaise'),
    cgstPaise: sum('cgstPaise'),
    sgstPaise: sum('sgstPaise'),
    igstPaise: sum('igstPaise'),
    roundOffPaise: total - exact,
    totalPaise: total,
  };
}

/** What a customer pays for a plan priced `pricePaise` (excl. GST): price + GST, rounded to the rupee. */
export function grossPrice(pricePaise: number, gstRatePercent: number): number {
  return gstTotals([
    gstLine({ description: '', hsnSac: '', ratePaise: pricePaise, gstRatePercent, intraState: true }),
  ]).totalPaise;
}

export const partyAddress = (a: {
  line1?: string;
  line2?: string;
  city?: string;
  district?: string;
  state?: string;
  pincode?: string;
}) => [a.line1, a.line2, a.city, a.district, a.state, a.pincode].filter(Boolean).join(', ');

export type { GstParty };

/** Rs. 1,23,456.78 (Indian grouping) for SMS and PDFs. */
export function rupees(paise: number): string {
  const neg = paise < 0;
  const s = (Math.abs(paise) / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${neg ? '-' : ''}Rs. ${s}`;
}

export const istDate = (d: Date) =>
  d.toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
