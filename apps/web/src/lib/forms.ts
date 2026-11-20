import { toast } from '@/lib/toast';
import { fieldErrors } from './api';

type SetError = (path: string, error: { type: string; message: string }) => void;

/** Puts the server's per-field messages on the form; anything else becomes a toast. */
export function applyServerErrors(setError: SetError, e: unknown, known?: string[]) {
  let placed = 0;
  for (const [path, message] of Object.entries(fieldErrors(e))) {
    if (known && !known.some((k) => path === k || path.startsWith(`${k}.`))) continue;
    setError(path, { type: 'server', message });
    placed++;
  }
  if (!placed) toast.error(e instanceof Error ? e.message : 'Could not save');
}

/** Date input (YYYY-MM-DD) → end of that day in IST, the way staff mean "valid until". */
export const endOfDayIst = (d: string) => `${d}T23:59:59+05:30`;
/** ISO → YYYY-MM-DD in IST for a date input. */
export const istDateInput = (iso: string | null | undefined) =>
  iso ? new Date(new Date(iso).getTime() + 5.5 * 3600_000).toISOString().slice(0, 10) : '';

/** Top-level fields of `next` that differ from `prev` (JSON compare); for PATCH bodies. */
export function changedOnly(
  next: Record<string, unknown>,
  prev: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(next).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(prev[k])),
  );
}

export const num = (s: string) => (s.trim() === '' ? undefined : Number(s));
