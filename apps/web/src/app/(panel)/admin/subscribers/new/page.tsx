'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { PageSkeleton } from '@/components/shell';
import { SubscriberForm } from '@/components/subscriber-form';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { PageHeader, SecretBox } from '@/components/ui/misc';
import { api, unwrap } from '@/lib/api';
import type { Subscriber } from '@/lib/queries';

function NewSubscriber() {
  const router = useRouter();
  const resellerId = useSearchParams().get('reseller');
  const reseller = useQuery({
    queryKey: ['reseller', resellerId],
    queryFn: () => unwrap(api.GET('/api/v1/resellers/{id}', { params: { path: { id: resellerId! } } })),
    enabled: !!resellerId,
  });
  const qc = useQueryClient();
  const [created, setCreated] = useState<Subscriber | null>(null);
  const create = useMutation({
    meta: { silent: true },
    mutationFn: (body: Record<string, unknown>) =>
      unwrap(api.POST('/api/v1/subscribers', { body: body as never })),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ['subscribers'] });
      if (s.pppoePassword) setCreated(s);
      else router.replace(`/admin/subscribers/${s.id}`);
    },
  });

  return (
    <>
      <PageHeader
        title="New subscriber"
        description="The account reaches the RADIUS server within seconds."
      />
      {resellerId && reseller.isLoading ? (
        <PageSkeleton />
      ) : (
        <SubscriberForm
          initialReseller={
            reseller.data
              ? { id: reseller.data.id, code: reseller.data.code, name: reseller.data.name }
              : null
          }
          submitting={create.isPending}
          onSubmit={(b) => create.mutateAsync(b)}
          onCancel={() => router.back()}
        />
      )}
      <Dialog
        open={!!created}
        onOpenChange={(o) => !o && created && router.replace(`/admin/subscribers/${created.id}`)}
      >
        <DialogContent
          title="Subscriber created"
          description="Give these to the customer or set them on their router."
        >
          {created ? (
            <div className="space-y-4">
              <SecretBox label="Username" value={created.username} />
              <SecretBox label="PPPoE password" value={created.pppoePassword!} />
              <p className="text-xs text-muted-foreground">
                The password is shown once. Staff with permission can reveal it later (recorded in the audit
                log).
              </p>
              <Button className="w-full" onClick={() => router.replace(`/admin/subscribers/${created.id}`)}>
                Open subscriber
              </Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function NewSubscriberPage() {
  return (
    <Suspense>
      <NewSubscriber />
    </Suspense>
  );
}
