'use client';
import { Lock } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Badge, Tag } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import type { ApiData } from '@/lib/api';
import { cn, fmtDateTime } from '@/lib/utils';

export type Ticket = ApiData<'/api/v1/tickets/{id}'>;
export type TicketEvent = Ticket['events'][number];
export type TicketStatus = Ticket['status'];

export const STATUS_LABEL: Record<TicketStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  waiting_customer: 'Waiting for customer',
  resolved: 'Resolved',
  closed: 'Closed',
};
const STATUS_TONE = {
  open: 'info',
  in_progress: 'primary',
  waiting_customer: 'neutral',
  resolved: 'success',
  closed: 'neutral',
} as const;
export const CATEGORY_LABEL: Record<Ticket['category'], string> = {
  no_internet: 'No internet',
  slow_speed: 'Slow speed',
  billing: 'Billing',
  plan_change: 'Plan change',
  relocation: 'Shifting / relocation',
  other: 'Other',
};
export const PRIORITY_LABEL: Record<Ticket['priority'], string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

export const TicketStatusBadge = ({ status }: { status: TicketStatus }) => (
  <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
);

export const PriorityBadge = ({ priority }: { priority: Ticket['priority'] }) =>
  priority === 'high' || priority === 'urgent' ? (
    <Tag
      className={cn(
        'h-5 rounded-md border-0 px-1.5 text-[11px] font-bold',
        priority === 'urgent' ? 'bg-danger-bg text-danger-text' : 'bg-warning-bg text-warning-text',
      )}
    >
      {PRIORITY_LABEL[priority]}
    </Tag>
  ) : null;

function changeText(e: TicketEvent) {
  if (e.kind === 'status') return `changed status to ${STATUS_LABEL[e.to as TicketStatus] ?? e.to}`;
  if (e.kind === 'priority') return `set priority to ${e.to}`;
  if (e.kind === 'assign') return e.to ? `assigned to ${e.to}` : `unassigned ${e.from ?? ''}`.trim();
  return '';
}

/** Messages as bubbles (customer on the left), internal notes highlighted, changes as one-line entries. */
export function TicketTimeline({ events, viewer }: { events: TicketEvent[]; viewer: 'staff' | 'customer' }) {
  return (
    <ol className="flex flex-col gap-4" aria-label="Ticket history">
      {events.map((e) => {
        if (e.kind !== 'message' && e.kind !== 'note') {
          return (
            <li key={e.id} className="flex items-center gap-2.5 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" aria-hidden />
              <span className="text-center">
                {e.author.name} {changeText(e)} · {fmtDateTime(e.createdAt)}
              </span>
              <span className="h-px flex-1 bg-border" aria-hidden />
            </li>
          );
        }
        const fromCustomer = e.author.type === 'customer';
        const mine = viewer === 'customer' ? fromCustomer : !fromCustomer;
        return (
          <li key={e.id} className={cn('flex max-w-[85%] flex-col gap-1 sm:max-w-[78%]', mine && 'self-end')}>
            <p className={cn('flex items-center gap-2 text-xs text-muted-foreground', mine && 'justify-end')}>
              <span className="font-bold text-foreground">{e.author.name}</span>
              <span className="font-mono">{fmtDateTime(e.createdAt)}</span>
            </p>
            <div
              className={cn(
                'border px-3.5 py-3 text-sm leading-relaxed text-foreground',
                mine ? 'rounded-[14px_4px_14px_14px]' : 'rounded-[4px_14px_14px_14px]',
                e.kind === 'note'
                  ? 'border-[#f5d9a8] bg-warning-bg'
                  : mine
                    ? 'border-accent-border bg-accent'
                    : 'bg-card',
              )}
            >
              {e.kind === 'note' ? (
                <span className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold tracking-[0.06em] text-warning-text uppercase">
                  <Lock className="size-3" strokeWidth={2.2} aria-hidden />
                  Internal note · staff only
                </span>
              ) : null}
              <p className="break-words whitespace-pre-wrap">{e.body}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Reply box. Staff can mark it as an internal note. */
export function ReplyBox({
  staff,
  loading,
  onSend,
  placeholder = 'Write a reply…',
}: {
  staff?: boolean;
  loading: boolean;
  onSend: (body: string, internal: boolean) => Promise<unknown>;
  placeholder?: string;
}) {
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    await onSend(body.trim(), internal);
    setBody('');
    setInternal(false);
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2.5">
      {staff ? (
        <div role="group" aria-label="Reply type" className="flex gap-1">
          {(
            [
              [false, 'Reply to customer'],
              [true, 'Internal note'],
            ] as const
          ).map(([v, label]) => (
            <button
              key={label}
              type="button"
              aria-pressed={internal === v}
              onClick={() => setInternal(v)}
              className={cn(
                'h-8 rounded-lg px-3 text-[13px] font-medium text-body hover:bg-subtle',
                internal === v &&
                  (v ? 'bg-warning-bg font-bold text-warning-text' : 'bg-accent font-bold text-primary'),
              )}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
      <Textarea
        aria-label="Reply"
        rows={3}
        maxLength={4000}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={internal ? 'Internal note — the customer will not see this' : placeholder}
        className={cn(internal && 'border-[#f5d9a8] bg-warning-bg/60')}
      />
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="submit" loading={loading} disabled={!body.trim()}>
          {internal ? 'Add note' : 'Send'}
        </Button>
      </div>
    </form>
  );
}
