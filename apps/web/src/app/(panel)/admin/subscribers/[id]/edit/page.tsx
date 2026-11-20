'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { toast } from '@/lib/toast';
import { PageSkeleton } from '@/components/shell';
import { SubscriberForm } from '@/components/subscriber-form';
import { ErrorState, PageHeader } from '@/components/ui/misc';
import { api, unwrap } from '@/lib/api';

export default function EditSubscriberPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const sub = useQuery({
    queryKey: ['subscriber', id],
    queryFn: () => unwrap(api.GET('/api/v1/subscribers/{id}', { params: { path: { id } } })),
  });
  const save = useMutation({
    meta: { silent: true },
    mutationFn: (body: Record<string, unknown>) =>
      unwrap(api.PATCH('/api/v1/subscribers/{id}', { params: { path: { id } }, body: body as never })),
    onSuccess: (s) => {
      qc.setQueryData(['subscriber', id], s);
      void qc.invalidateQueries({ queryKey: ['subscribers'] });
      toast.success('Saved. Router updated if the customer is online.');
      router.replace(`/admin/subscribers/${id}`);
    },
  });

  if (sub.isLoading) return <PageSkeleton />;
  if (sub.isError) return <ErrorState error={sub.error} onRetry={() => void sub.refetch()} />;
  return (
    <>
      <PageHeader
        title={`Edit ${sub.data!.name}`}
        description={`#${sub.data!.customerNo} · ${sub.data!.username}`}
      />
      <SubscriberForm
        subscriber={sub.data!}
        submitting={save.isPending}
        onSubmit={(b) => save.mutateAsync(b)}
        onCancel={() => router.back()}
      />
    </>
  );
}
