import { ObjectId } from 'mongodb';

/** Keys whose values never enter the audit log (matched case-insensitively, at any depth). */
const SECRET = /pass(word)?|secret|token|totp|pepper|hash|key$|pppoe_?password/i;
export const REDACTED = '[redacted]';
const MAX_STRING = 500;
const MAX_DEPTH = 6;

/** JSON-safe copy with secrets replaced and long strings cut. */
export function redact(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined) return v ?? null;
  if (v instanceof ObjectId) return v.toHexString();
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return `[${v.length} bytes]`;
  if (typeof v === 'string') return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…` : v;
  if (typeof v !== 'object') return v;
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    out[k] = SECRET.test(k) ? (x === undefined || x === null ? null : REDACTED) : redact(x, depth + 1);
  }
  return out;
}

/** Bookkeeping and ids that say nothing about what a person changed. */
export const IGNORED = new Set([
  '_id',
  'tenantId',
  'resellerId',
  'ancestors',
  'createdAt',
  'createdBy',
  'updatedAt',
  'updatedBy',
  'version',
  'search',
  'syncStatus',
  'radiusId',
  'importBatchId',
]);

/**
 * Top-level fields that differ between two documents, both sides redacted. A secret that changed shows as
 * "[redacted]" on both sides: the log says it changed, never to what.
 */
export function changes(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): { before?: Record<string, unknown>; after?: Record<string, unknown> } {
  const b = (redact(before ?? {}) ?? {}) as Record<string, unknown>;
  const a = (redact(after ?? {}) ?? {}) as Record<string, unknown>;
  const raw = { b: before ?? {}, a: after ?? {} };
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  const outB: Record<string, unknown> = {};
  const outA: Record<string, unknown> = {};
  for (const k of keys) {
    if (IGNORED.has(k)) continue;
    const secretChanged =
      SECRET.test(k) && JSON.stringify(redactRaw(raw.b, k)) !== JSON.stringify(redactRaw(raw.a, k));
    if (JSON.stringify(b[k]) === JSON.stringify(a[k]) && !secretChanged) continue;
    if (k in b) outB[k] = b[k];
    if (k in a) outA[k] = a[k];
  }
  return {
    ...(before && Object.keys(outB).length ? { before: outB } : {}),
    ...(after && Object.keys(outA).length ? { after: outA } : {}),
  };
}

const redactRaw = (o: Record<string, unknown>, k: string) => {
  const v = o[k];
  return v instanceof ObjectId ? v.toHexString() : v;
};
