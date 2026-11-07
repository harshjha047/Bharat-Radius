import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

const TZ = 'Asia/Kolkata';
const dateTime = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' });
const dateOnly = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, dateStyle: 'medium' });
const shortDay = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, day: 'numeric', month: 'short' });
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
const num = new Intl.NumberFormat('en-IN');

export const fmtDateTime = (iso: string | null | undefined) => (iso ? dateTime.format(new Date(iso)) : '—');
export const fmtDate = (iso: string | null | undefined) => (iso ? dateOnly.format(new Date(iso)) : '—');
export const fmtDay = (iso: string) => shortDay.format(new Date(iso));
export const fmtRupees = (paise: number) => inr.format(paise / 100);
/** Price + GST rounded to the rupee (matches the API's invoice total). */
export const grossPaise = (paise: number, gstPercent: number) => {
  const half = Math.floor((paise * gstPercent) / 200 + 0.5);
  return Math.floor((paise + 2 * half) / 100 + 0.5) * 100;
};
export const fmtNum = (n: number) => num.format(n);
export const plural = (n: number, word: string) => `${fmtNum(n)} ${word}${n === 1 ? '' : 's'}`;

export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** 1 Mbps = 1000 kbps, as RouterOS counts. */
export function fmtKbps(kbps: number): string {
  if (kbps >= 1_000_000 && kbps % 1_000_000 === 0) return `${kbps / 1_000_000} Gbps`;
  if (kbps >= 1000) return `${+(kbps / 1000).toFixed(1)} Mbps`;
  return `${kbps} kbps`;
}

export function fmtDuration(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return fmtDate(iso);
}

/** Drops empty strings and undefined so optional API fields are omitted, not sent blank. */
export function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined)) as Partial<T>;
}
