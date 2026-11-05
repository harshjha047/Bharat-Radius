/** Ids and bookkeeping; older entries still contain them. */
const HIDDEN = new Set([
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

const show = (v: unknown): string => {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
};

/** before → after per changed field; secrets arrive already as "[redacted]". */
/** Turns ids in known fields (planId, roleIds) into names. */
export type Resolve = (key: string, value: unknown) => string | undefined;

export function AuditChanges({
  before,
  after,
  resolve,
}: {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  resolve?: Resolve | undefined;
}) {
  const fmt = (k: string, v: unknown) => resolve?.(k, v) ?? show(v);
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].filter(
    (k) => !HIDDEN.has(k),
  );
  if (!keys.length) return <span className="text-muted-foreground">—</span>;
  return (
    <ul className="space-y-0.5 text-xs">
      {keys.slice(0, 12).map((k) => (
        <li key={k} className="break-words">
          <span className="font-medium">{k}</span>:{' '}
          {before && k in before ? (
            <>
              <span className="text-muted-foreground line-through">{fmt(k, before[k])}</span> →{' '}
            </>
          ) : null}
          <span>{after && k in after ? fmt(k, after[k]) : '(removed)'}</span>
        </li>
      ))}
      {keys.length > 12 ? <li className="text-muted-foreground">+{keys.length - 12} more</li> : null}
    </ul>
  );
}

export const actionLabel = (a: string) =>
  a
    .replace(/^[a-z]+\./, '')
    .replace(/_/g, ' ')
    .replace(/^2fa/, '2FA')
    .replace(/^./, (c) => c.toUpperCase());
