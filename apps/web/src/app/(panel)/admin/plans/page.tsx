'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Archive, Download, FileUp, Pencil, Plus, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { toast } from '@/lib/toast';
import { PlanForm } from '@/components/plan-form';
import { PlanImport } from '@/components/plan-import';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/input';
import { ErrorState, PageHeader } from '@/components/ui/misc';
import { api, download, unwrap } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { usePlans, type Plan } from '@/lib/queries';
import { fmtBytes, fmtKbps, fmtRupees, plural } from '@/lib/utils';

export default function PlansPage() {
  const can = useCan();
  const qc = useQueryClient();
  const plans = usePlans();
  const [editing, setEditing] = useState<Plan | 'new' | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const exportPlans = async () => {
    setExporting(true);
    try {
      await download('/api/v1/plans/export', 'plans.xlsx');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  };
  const write = can('plans.write');

  const refresh = () => qc.invalidateQueries({ queryKey: ['plans'] });
  const save = useMutation({
    meta: { silent: true },
    mutationFn: (body: Record<string, unknown>) =>
      editing === 'new'
        ? unwrap(api.POST('/api/v1/plans', { body: body as never }))
        : unwrap(
            api.PATCH('/api/v1/plans/{id}', {
              params: { path: { id: (editing as Plan).id } },
              body: body as never,
            }),
          ),
    onSuccess: (_p, body) => {
      void refresh();
      toast.success(
        editing !== 'new' && ('downloadKbps' in body || 'uploadKbps' in body || 'burst' in body)
          ? 'Saved. Online customers on this plan get the new speed now.'
          : 'Saved.',
      );
      setEditing(null);
    },
  });
  const archive = useMutation({
    mutationFn: (p: Plan) =>
      unwrap(
        api.PATCH('/api/v1/plans/{id}', {
          params: { path: { id: p.id } },
          body: { status: p.status === 'active' ? 'archived' : 'active' },
        }),
      ),
    onSuccess: (p) => {
      void refresh();
      toast.success(p.status === 'archived' ? 'Archived. Existing subscribers keep it.' : 'Restored.');
    },
  });

  const rows = plans.plans.filter((p) => showArchived || p.status === 'active');
  return (
    <>
      <PageHeader
        title="Plans"
        description="Speeds are what MikroTik enforces; editing a speed updates online customers at once."
        actions={
          <>
            <Button variant="outline" onClick={() => void exportPlans()} loading={exporting}>
              <Download /> Export
            </Button>
            {write ? (
              <>
                <Button variant="outline" onClick={() => setImporting(true)}>
                  <FileUp /> Import
                </Button>
                <Button onClick={() => setEditing('new')}>
                  <Plus /> New plan
                </Button>
              </>
            ) : null}
          </>
        }
      />
      <label className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
        <Checkbox checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
      </label>
      {plans.isError ? (
        <ErrorState error={plans.error} onRetry={() => void plans.refetch()} />
      ) : (
        <DataTable
          caption="Plans"
          loading={plans.isLoading}
          rows={rows}
          rowKey={(p) => p.id}
          onRowClick={write ? (p) => setEditing(p) : undefined}
          empty="No plans yet. Create one before adding subscribers."
          columns={[
            {
              key: 'name',
              header: 'Plan',
              cell: (p) => (
                <span className="flex items-center gap-2">
                  {p.name} {p.status === 'archived' ? <Badge>Archived</Badge> : null}
                </span>
              ),
            },
            {
              key: 'speed',
              header: 'Speed',
              cell: (p) => `${fmtKbps(p.downloadKbps)} / ${fmtKbps(p.uploadKbps)}`,
            },
            {
              key: 'cap',
              header: 'Data cap',
              cell: (p) =>
                p.dataCapBytes ? (
                  <span
                    title={
                      p.fup ? `Then ${fmtKbps(p.fup.downloadKbps)} / ${fmtKbps(p.fup.uploadKbps)}` : undefined
                    }
                  >
                    {fmtBytes(p.dataCapBytes)}
                    {p.fup ? (
                      <span className="text-muted-foreground"> → {fmtKbps(p.fup.downloadKbps)}</span>
                    ) : null}
                  </span>
                ) : (
                  'Unlimited'
                ),
            },
            { key: 'validity', header: 'Validity', cell: (p) => plural(p.validityDays, 'day') },
            {
              key: 'price',
              header: 'Price',
              cell: (p) => <span title={`+${p.gstRatePercent}% GST`}>{fmtRupees(p.pricePaise)}</span>,
            },
            {
              key: 'rate',
              header: 'MikroTik rate',
              cell: (p) => <code className="text-xs">{p.rateLimit}</code>,
              hideOnMobile: true,
            },
            ...(write
              ? [
                  {
                    key: 'actions',
                    header: '',
                    className: 'text-right whitespace-nowrap',
                    cell: (p: Plan) => (
                      <span className="inline-flex gap-1" onClick={(e) => e.stopPropagation()}>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Edit ${p.name}`}
                          onClick={() => setEditing(p)}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={p.status === 'active' ? `Archive ${p.name}` : `Restore ${p.name}`}
                          onClick={() => archive.mutate(p)}
                        >
                          {p.status === 'active' ? <Archive /> : <RotateCcw />}
                        </Button>
                      </span>
                    ),
                  },
                ]
              : []),
          ]}
        />
      )}
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent
          wide
          title={editing === 'new' ? 'New plan' : `Edit ${(editing as Plan | null)?.name ?? ''}`}
        >
          {editing !== null ? (
            <PlanForm
              key={editing === 'new' ? 'new' : editing.id}
              plan={editing === 'new' ? undefined : editing}
              submitting={save.isPending}
              onSubmit={(b) => save.mutateAsync(b)}
              onCancel={() => setEditing(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog open={importing} onOpenChange={setImporting}>
        <DialogContent wide title="Import plans">
          {importing ? (
            <PlanImport onImported={() => void refresh()} onClose={() => setImporting(false)} />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
