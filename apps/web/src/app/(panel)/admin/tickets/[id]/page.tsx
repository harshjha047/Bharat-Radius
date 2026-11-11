'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PageSkeleton } from '@/components/shell';
import {
  CATEGORY_LABEL,
  PriorityBadge,
  ReplyBox,
  STATUS_LABEL,
  TicketStatusBadge,
  TicketTimeline,
  type Ticket,
} from '@/components/tickets';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { ErrorState, Field, KeyValue, PageHeader } from '@/components/ui/misc';
import { api, unwrap } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { fmtDateTime } from '@/lib/utils';

type Patch = { status?: string; priority?: string; category?: string; assigneeId?: string | null };

export default function TicketPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const can = useCan();
  const key = ['ticket', id];
  const t = useQuery({
    queryKey: key,
    queryFn: () => unwrap(api.GET('/api/v1/tickets/{id}', { params: { path: { id } } })),
    refetchInterval: 30_000,
  });
  const assignees = useQuery({
    queryKey: ['tickets', 'assignees'],
    queryFn: () => unwrap(api.GET('/api/v1/tickets/assignees')),
    enabled: can('tickets.assign'),
    staleTime: 300_000,
  });
  const saved = (next: Ticket) => {
    qc.setQueryData(key, next);
    void qc.invalidateQueries({ queryKey: ['tickets'] });
  };
  const patch = useMutation({
    mutationFn: (b: Patch) =>
      unwrap(api.PATCH('/api/v1/tickets/{id}', { params: { path: { id } }, body: b as never })),
    onSuccess: saved,
  });
  const reply = useMutation({
    mutationFn: (b: { body: string; internal: boolean }) =>
      unwrap(api.POST('/api/v1/tickets/{id}/reply', { params: { path: { id } }, body: b })),
    onSuccess: saved,
  });

  if (t.isLoading) return <PageSkeleton />;
  if (t.isError) return <ErrorState error={t.error} onRetry={() => void t.refetch()} />;
  const d = t.data!;
  const write = can('tickets.write');

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {d.subject}
            <TicketStatusBadge status={d.status} />
            <PriorityBadge priority={d.priority} />
          </span>
        }
        description={`${d.number} · ${CATEGORY_LABEL[d.category]} · opened ${fmtDateTime(d.createdAt)} by ${d.openedBy.name}`}
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
        <Card>
          <CardContent className="space-y-4 pt-4 sm:pt-5">
            <TicketTimeline events={d.events} viewer="staff" />
            {write && d.status !== 'closed' ? (
              <ReplyBox
                staff
                loading={reply.isPending}
                onSend={(body, internal) => reply.mutateAsync({ body, internal })}
                placeholder={d.subscriber ? `Reply to ${d.subscriber.name}…` : 'Add an update…'}
              />
            ) : null}
          </CardContent>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Field label="Status" htmlFor="status">
                <Select
                  id="status"
                  value={d.status}
                  disabled={!write || patch.isPending}
                  onChange={(e) => patch.mutate({ status: e.target.value })}
                >
                  {Object.entries(STATUS_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Priority" htmlFor="priority">
                <Select
                  id="priority"
                  value={d.priority}
                  disabled={!write || patch.isPending}
                  onChange={(e) => patch.mutate({ priority: e.target.value })}
                >
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </Select>
              </Field>
              <Field label="Assigned to" htmlFor="assignee">
                {can('tickets.assign') ? (
                  <Select
                    id="assignee"
                    value={d.assignee?.id ?? ''}
                    disabled={patch.isPending}
                    onChange={(e) => patch.mutate({ assigneeId: e.target.value || null })}
                  >
                    <option value="">Unassigned</option>
                    {d.assignee && !assignees.data?.items.some((a) => a.id === d.assignee!.id) ? (
                      <option value={d.assignee.id}>{d.assignee.name}</option>
                    ) : null}
                    {assignees.data?.items.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <p className="text-sm">{d.assignee?.name ?? 'Unassigned'}</p>
                )}
              </Field>
            </CardContent>
          </Card>
          {d.subscriber ? (
            <Card>
              <CardHeader>
                <CardTitle>Customer</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <KeyValue
                  items={[
                    ['Name', d.subscriber.name],
                    ['Customer no.', d.subscriber.customerNo],
                    ['Username', d.subscriber.username],
                    [
                      'Phone',
                      <a key="p" href={`tel:${d.subscriber.phone}`} className="underline">
                        {d.subscriber.phone}
                      </a>,
                    ],
                  ]}
                />
                <Link
                  href={`/admin/subscribers/${d.subscriber.id}`}
                  className="text-sm text-primary underline"
                >
                  Open subscriber
                </Link>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
