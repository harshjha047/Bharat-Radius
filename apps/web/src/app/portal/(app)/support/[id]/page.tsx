'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ReplyBox, TicketStatusBadge, TicketTimeline, type Ticket } from '@/components/tickets';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { api, unwrap } from '@/lib/api';

export default function PortalTicket() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const key = ['portal', 'ticket', id];
  const t = useQuery({
    queryKey: key,
    queryFn: () => unwrap(api.GET('/api/v1/portal/tickets/{id}', { params: { path: { id } } })),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  const saved = (next: Ticket) => {
    qc.setQueryData(key, next);
    void qc.invalidateQueries({ queryKey: ['portal', 'tickets'] });
  };
  const reply = useMutation({
    mutationFn: (body: string) =>
      unwrap(api.POST('/api/v1/portal/tickets/{id}/reply', { params: { path: { id } }, body: { body } })),
    onSuccess: saved,
  });
  const close = useMutation({
    mutationFn: () => unwrap(api.POST('/api/v1/portal/tickets/{id}/close', { params: { path: { id } } })),
    onSuccess: saved,
  });

  if (t.isLoading) return <Skeleton className="h-64 w-full" />;
  if (t.isError) return <ErrorState error={t.error} onRetry={() => void t.refetch()} />;
  const d = t.data!;
  return (
    <>
      <Link href="/portal/support" className="inline-flex items-center gap-1 text-sm text-muted-foreground">
        <ArrowLeft className="size-4" aria-hidden /> All tickets
      </Link>
      <Card className="rounded-[20px]">
        <CardHeader className="flex-row items-start justify-between gap-3 border-b pb-4 sm:pb-4">
          <div className="min-w-0">
            <h1 className="text-xl font-extrabold tracking-[-0.02em]">{d.subject}</h1>
            <p className="font-mono text-xs text-muted-foreground">{d.number}</p>
          </div>
          <TicketStatusBadge status={d.status} />
        </CardHeader>
        <CardContent className="space-y-4 pt-4 sm:pt-5">
          <TicketTimeline events={d.events} viewer="customer" />
          {d.status === 'closed' ? (
            <p className="text-sm text-muted-foreground">
              This ticket is closed.{' '}
              <Link href="/portal/support" className="underline">
                Open a new one
              </Link>{' '}
              if you still need help.
            </p>
          ) : (
            <>
              <ReplyBox loading={reply.isPending} onSend={(body) => reply.mutateAsync(body)} />
              <Button variant="ghost" size="sm" loading={close.isPending} onClick={() => close.mutate()}>
                My problem is solved — close ticket
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}
