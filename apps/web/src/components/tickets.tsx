'use client';
import { Lock } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox, Textarea } from '@/components/ui/input';
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
  open: 'warning',
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
    <Badge tone="danger">{PRIORITY_LABEL[priority]}</Badge>
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
    <ol className="space-y-3" aria-label="Ticket history">
      {events.map((e) => {
        if (e.kind !== 'message' && e.kind !== 'note') {
          return (
            <li key={e.id} className="text-center text-xs text-muted-foreground">
              {e.author.name} {changeText(e)} · {fmtDateTime(e.createdAt)}
            </li>
          );
        }
        const fromCustomer = e.author.type === 'customer';
        const mine = viewer === 'customer' ? fromCustomer : !fromCustomer;
        return (
          <li key={e.id} className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
            <div
              className={cn(
                'max-w-[85%] rounded-lg border px-3 py-2 text-sm',
                e.kind === 'note'
                  ? 'border-warning/50 bg-warning/10'
                  : mine
                    ? 'bg-accent text-accent-foreground'
                    : 'bg-card',
              )}
            >
              <p className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">
                {e.kind === 'note' ? <Lock className="size-3" aria-label="Internal note" /> : null}
                {e.author.name} · {fmtDateTime(e.createdAt)}
              </p>
              <p className="whitespace-pre-wrap break-words">{e.body}</p>
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
    <form onSubmit={(e) => void submit(e)} className="space-y-2">
      <Textarea
        aria-label="Reply"
        rows={3}
        maxLength={4000}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={internal ? 'Internal note — the customer will not see this' : placeholder}
        className={cn(internal && 'border-warning/60 bg-warning/5')}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        {staff ? (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={internal} onChange={(e) => setInternal(e.target.checked)} />
            Internal note
          </label>
        ) : (
          <span />
        )}
        <Button type="submit" loading={loading} disabled={!body.trim()}>
          {internal ? 'Add note' : 'Send'}
        </Button>
      </div>
    </form>
  );
}
