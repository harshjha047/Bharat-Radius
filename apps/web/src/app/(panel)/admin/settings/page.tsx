'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { toast } from 'sonner';
import { PageSkeleton } from '@/components/shell';
import { PrivacyNoticeCard } from '@/components/privacy';
import { TenantForm } from '@/components/tenant-form';
import { Button } from '@/components/ui/button';
import { ErrorState, PageHeader } from '@/components/ui/misc';
import { api, unwrap } from '@/lib/api';

export default function SettingsPage() {
  const qc = useQueryClient();
  const t = useQuery({ queryKey: ['tenant'], queryFn: () => unwrap(api.GET('/api/v1/tenant')) });
  const save = useMutation({
    meta: { silent: true },
    mutationFn: (b: Record<string, unknown>) => unwrap(api.PATCH('/api/v1/tenant', { body: b as never })),
    onSuccess: (n) => {
      qc.setQueryData(['tenant'], n);
      toast.success('Settings saved.');
    },
  });
  if (t.isLoading) return <PageSkeleton />;
  if (t.isError) return <ErrorState error={t.error} onRetry={() => void t.refetch()} />;
  return (
    <>
      <PageHeader
        title="ISP settings"
        description={`Organisation ID: ${t.data!.slug}`}
        actions={
          <Button variant="outline" asChild>
            <Link href="/admin/settings/billing">Billing, gateways & SMS</Link>
          </Button>
        }
      />
      <TenantForm
        key={t.data!.updatedAt}
        tenant={t.data!}
        mode="own"
        submitting={save.isPending}
        onSubmit={(b) => save.mutateAsync(b)}
      />
      <PrivacyNoticeCard />
    </>
  );
}
