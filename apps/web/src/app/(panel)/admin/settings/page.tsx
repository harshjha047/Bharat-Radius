'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { toast } from '@/lib/toast';
import { PageSkeleton } from '@/components/shell';
import { PrivacyNoticeCard } from '@/components/privacy';
import { TenantForm } from '@/components/tenant-form';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/input';
import { ErrorState, PageHeader } from '@/components/ui/misc';
import { api, unwrap } from '@/lib/api';
import { ME_KEY } from '@/lib/auth';
import { activeSidebarUpdate } from '@/lib/sidebar-update';

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
      <UpdatesCard on={t.data!.showUpdates} />
      <PrivacyNoticeCard />
    </>
  );
}

/** One switch for the sidebar Updates banner, applied to every staff and reseller panel of this ISP. */
function UpdatesCard({ on }: { on: boolean }) {
  const qc = useQueryClient();
  const u = activeSidebarUpdate();
  const toggle = useMutation({
    meta: { silent: true },
    mutationFn: (showUpdates: boolean) => unwrap(api.PATCH('/api/v1/tenant', { body: { showUpdates } })),
    onSuccess: (n) => {
      qc.setQueryData(['tenant'], n);
      void qc.invalidateQueries({ queryKey: ME_KEY });
      toast.success(n.showUpdates ? 'Updates banner shown to everyone.' : 'Updates banner hidden.');
    },
    onError: () => toast.error('Could not change the Updates banner. Try again.'),
  });
  const checked = toggle.isPending ? toggle.variables : on;
  return (
    <Card className="mt-5">
      <CardHeader>
        <CardTitle>Sidebar Updates banner</CardTitle>
        <CardDescription>
          Shows the Updates banner above the user card for all your staff and resellers.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <label className="flex items-center gap-2.5 text-sm font-semibold">
          <Checkbox
            role="switch"
            aria-checked={checked}
            checked={checked}
            disabled={toggle.isPending || !u}
            onChange={(e) => toggle.mutate(e.target.checked)}
          />
          Show the Updates banner to everyone
        </label>
        {u ? (
          <img
            src={u.imageUrl}
            alt={u.alt}
            width={236}
            height={Math.round(236 / (u.aspect ?? 4 / 3))}
            style={{ aspectRatio: u.aspect ?? 4 / 3 }}
            className={`w-[236px] rounded-xl border border-[#ECEAEF] object-cover ${checked ? '' : 'opacity-50'}`}
          />
        ) : (
          <p className="text-sm text-muted-foreground">No banner is available right now.</p>
        )}
      </CardContent>
    </Card>
  );
}
