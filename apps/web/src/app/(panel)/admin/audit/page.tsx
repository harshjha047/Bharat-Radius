'use client';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { actionLabel, AuditChanges, type Resolve } from '@/components/audit-changes';
import { Badge } from '@/components/ui/badge';
import { DataTable } from '@/components/ui/data-table';
import { Input, Select } from '@/components/ui/input';
import { ErrorState, Field, PageHeader } from '@/components/ui/misc';
import { api, unwrap } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { usePlans, useRoles } from '@/lib/queries';
import { fmtDateTime, relTime } from '@/lib/utils';

const AREAS: [string, string][] = [
  ['', 'Everything'],
  ['subscriber.', 'Subscribers'],
  ['import.', 'Imports'],
  ['plan.', 'Plans'],
  ['nas.', 'Routers'],
  ['user.', 'Staff accounts'],
  ['role.', 'Roles'],
  ['auth.', 'Sign-ins and security'],
  ['tenant.', 'ISP settings'],
];

const entityHref = (type: string, id: string | null) =>
  !id ? null : type === 'subscriber' ? `/admin/subscribers/${id}` : null;

export default function AuditPage() {
  const can = useCan();
  const [action, setAction] = useState('');
  const [actorId, setActorId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const staff = useQuery({
    queryKey: ['users', 'all'],
    queryFn: () => unwrap(api.GET('/api/v1/users', { params: { query: { limit: 200 } } })),
    enabled: can('users.read'),
    staleTime: 5 * 60_000,
  });
  const { byId: planById } = usePlans();
  const { byId: roleById } = useRoles(can('users.read'));
  const userById = new Map((staff.data?.items ?? []).map((u) => [u.id, u.name]));
  const resolve: Resolve = (k, v) => {
    if (k === 'planId' && typeof v === 'string') return planById.get(v)?.name;
    if (k === 'roleIds' && Array.isArray(v))
      return v.map((r) => roleById.get(String(r))?.name ?? String(r)).join(', ');
    return undefined;
  };
  const filters = {
    ...(action ? { action } : {}),
    ...(actorId ? { actorId } : {}),
    ...(from ? { from: `${from}T00:00:00+05:30` } : {}),
    ...(to ? { to: `${to}T23:59:59+05:30` } : {}),
  };
  const q = useInfiniteQuery({
    queryKey: ['audit', filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/v1/audit', {
          params: { query: { limit: 50, ...filters, ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    placeholderData: (prev) => prev,
  });

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every change, secret view, export and sign-in: who, when and what changed."
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <Field label="Area" htmlFor="a-area">
          <Select id="a-area" value={action} onChange={(e) => setAction(e.target.value)}>
            {AREAS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Person" htmlFor="a-who">
          <Select
            id="a-who"
            value={actorId}
            onChange={(e) => setActorId(e.target.value)}
            disabled={!staff.data}
          >
            <option value="">Anyone</option>
            {staff.data?.items.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="From" htmlFor="a-from">
          <Input id="a-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To" htmlFor="a-to">
          <Input id="a-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <DataTable
          caption="Audit log"
          loading={q.isLoading}
          rows={q.data?.pages.flatMap((p) => p.items)}
          rowKey={(r) => r.id}
          hasMore={q.hasNextPage}
          loadingMore={q.isFetchingNextPage}
          onLoadMore={() => void q.fetchNextPage()}
          empty="Nothing recorded for these filters."
          columns={[
            {
              key: 'at',
              header: 'When',
              cell: (r) => <span title={fmtDateTime(r.at)}>{relTime(r.at)}</span>,
            },
            { key: 'who', header: 'Who', cell: (r) => r.actor.name },
            {
              key: 'what',
              header: 'What',
              className: 'whitespace-nowrap',
              cell: (r) => (
                <span className="flex items-center gap-1.5">
                  <Badge
                    tone={r.action.includes('failed') || r.action.includes('locked') ? 'danger' : 'neutral'}
                  >
                    {r.entity.type}
                  </Badge>
                  {actionLabel(r.action)}
                </span>
              ),
            },
            {
              key: 'entity',
              header: 'Record',
              hideOnMobile: true,
              cell: (r) => {
                const href = entityHref(r.entity.type, r.entity.id);
                const label = (r.after?.username ??
                  r.after?.name ??
                  r.before?.name ??
                  (r.entity.type === 'user' && r.entity.id ? userById.get(r.entity.id) : undefined) ??
                  r.entity.id?.slice(-6) ??
                  '—') as string;
                return href ? (
                  <Link href={href} className="text-primary hover:underline">
                    {label}
                  </Link>
                ) : (
                  <span>{label}</span>
                );
              },
            },
            {
              key: 'changes',
              header: 'Changes',
              cell: (r) => <AuditChanges before={r.before} after={r.after} resolve={resolve} />,
            },
            {
              key: 'ip',
              header: 'IP',
              hideOnMobile: true,
              cell: (r) => <span className="font-mono text-xs">{r.ip ?? '—'}</span>,
            },
          ]}
        />
      )}
    </>
  );
}
