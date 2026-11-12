import { z } from 'zod';
import { AppError } from '../errors.js';

export const TZ = 'Asia/Kolkata';
export const MAX_DAYS = 400;
export const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date in YYYY-MM-DD form');
export const rangeQuery = z.object({ from: isoDay.optional(), to: isoDay.optional() });
export type RangeQuery = z.output<typeof rangeQuery>;

export const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
export const istStart = (d: string) => new Date(`${d}T00:00:00+05:30`);
export const dayKey = (field: string) => ({
  $dateToString: { format: '%Y-%m-%d', date: field, timezone: TZ },
});

/** Default: this month so far (IST). Inclusive days; at most 400. */
export function period(q: RangeQuery) {
  const to = q.to ?? istToday();
  const from = q.from ?? `${to.slice(0, 8)}01`;
  const start = istStart(from);
  const end = new Date(istStart(to).getTime() + 86_400_000);
  if (end <= start) throw new AppError(400, 'VALIDATION_FAILED', '"from" must be on or before "to"');
  if ((end.getTime() - start.getTime()) / 86_400_000 > MAX_DAYS) {
    throw new AppError(400, 'VALIDATION_FAILED', `At most ${MAX_DAYS} days per report`);
  }
  return { from, to, start, end };
}
export type Period = ReturnType<typeof period>;
