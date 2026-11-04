'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { SubscriberForm } from '@/components/subscriber-form';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { PageHeader, SecretBox } from '@/components/ui/misc';
import { api, unwrap } from '@/lib/api';
import type { Subscriber } from '@/lib/queries';

export default function NewSubscriberPage() {
  const router = useRouter();
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
      <SubscriberForm
        submitting={create.isPending}
        onSubmit={(b) => create.mutateAsync(b)}
        onCancel={() => router.back()}
      />
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
