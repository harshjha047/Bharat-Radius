'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileUp, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from '@/lib/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { Checkbox, Select } from '@/components/ui/input';
import { ErrorState, Field, PageHeader } from '@/components/ui/misc';
import { api, authFetch, download, toApiError, unwrap, XLSX_MIME, type ApiData } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { usePlans } from '@/lib/queries';
import { fmtDateTime, fmtNum } from '@/lib/utils';

type Batch = ApiData<'/api/v1/subscribers/imports/{id}'>;
const MAX_BYTES = 10 * 1024 * 1024;

async function upload(file: File, dryRun: boolean, skipInvalid: boolean): Promise<Batch> {
  const qs = new URLSearchParams({ dryRun: String(dryRun), skipInvalid: String(skipInvalid) });
  const res = await authFetch(
    new Request(`/api/v1/subscribers/import?${qs}`, {
      method: 'POST',
      body: file,
      credentials: 'same-origin',
      headers: { 'content-type': XLSX_MIME, 'x-file-name': encodeURIComponent(file.name) },
    }),
  );
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as Batch;
}

const STATUS: Record<Batch['status'], ['neutral' | 'primary' | 'success' | 'warning' | 'danger', string]> = {
  validated: ['primary', 'Checked'],
  rejected: ['danger', 'Rejected'],
  queued: ['neutral', 'Queued'],
  running: ['primary', 'Importing'],
  done: ['success', 'Done'],
  failed: ['danger', 'Failed'],
};

function BatchResult({ b }: { b: Batch }) {
  const [tone, label] = STATUS[b.status];
  const total = b.counts.valid || 1;
  const pct = Math.round(((b.counts.created + b.counts.failed) / total) * 100);
  const running = b.status === 'queued' || b.status === 'running';
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={tone}>{label}</Badge>
        <span>
          {fmtNum(b.counts.read)} rows read · {fmtNum(b.counts.valid)} valid
          {b.counts.created || b.counts.failed
            ? ` · ${fmtNum(b.counts.created)} created · ${fmtNum(b.counts.failed)} failed`
            : ''}
        </span>
      </div>
      {running ? (
        <div
          className="h-2 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Import progress"
        >
          <div className="h-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      {b.errors.length ? (
        <>
          <DataTable
            caption="Rows with problems"
            rows={b.errors.slice(0, 100)}
            rowKey={(e) => `${e.row}-${e.column ?? ''}-${e.message}`}
            columns={[
              { key: 'row', header: 'Row', cell: (e) => e.row },
              { key: 'col', header: 'Column', cell: (e) => e.column ?? '—' },
              { key: 'msg', header: 'Problem', cell: (e) => e.message },
            ]}
          />
          {b.errors.length > 100 || b.errorsTruncated ? (
            <p className="text-xs text-muted-foreground">
              Showing the first 100. Download the error sheet for all of them.
            </p>
          ) : null}
          {b.id ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void download(`/api/v1/subscribers/imports/${b.id}/errors`, 'import-errors.xlsx').catch(
                  (e: Error) => toast.error(e.message),
                )
              }
            >
              <Download /> Error sheet
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function ImportCard() {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [skipInvalid, setSkipInvalid] = useState(false);
  const [checked, setChecked] = useState<Batch | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);

  const check = useMutation({
    mutationFn: (f: File) => upload(f, true, false),
    onSuccess: setChecked,
  });
  const run = useMutation({
    mutationFn: (f: File) => upload(f, false, skipInvalid),
    onSuccess: (b) => {
      setChecked(b);
      if (b.id && b.status !== 'rejected') setBatchId(b.id);
      void qc.invalidateQueries({ queryKey: ['imports'] });
    },
  });
  const progress = useQuery({
    queryKey: ['imports', batchId],
    queryFn: () =>
      unwrap(api.GET('/api/v1/subscribers/imports/{id}', { params: { path: { id: batchId! } } })),
    enabled: !!batchId,
    refetchInterval: (q) => (q.state.data && ['done', 'failed'].includes(q.state.data.status) ? false : 2000),
  });
  const shown = progress.data ?? checked;
  const finished = progress.data && ['done', 'failed'].includes(progress.data.status);
  useEffect(() => {
    if (!finished) return;
    void qc.invalidateQueries({ queryKey: ['subscribers'] });
    void qc.invalidateQueries({ queryKey: ['imports', 'recent'] });
  }, [finished, qc]);

  const pick = (f: File | undefined) => {
    setChecked(null);
    setBatchId(null);
    if (!f) return setFile(null);
    if (f.size > MAX_BYTES) {
      toast.error('The file is larger than 10 MB. Split it into smaller files.');
      return setFile(null);
    }
    setFile(f);
    check.mutate(f);
  };
  const invalid = checked ? checked.counts.read - checked.counts.valid : 0;
  const canImport =
    !!file && checked?.status === 'validated' && checked.counts.valid > 0 && (invalid === 0 || skipInvalid);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Import subscribers</CardTitle>
        <CardDescription>
          Fill in the template (up to 50,000 rows). Every row is checked first; nothing is created until you
          confirm.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() =>
              void download('/api/v1/subscribers/import/template', 'subscribers-template.xlsx').catch(
                (e: Error) => toast.error(e.message),
              )
            }
          >
            <Download /> Template
          </Button>
          <Button variant="outline" onClick={() => input.current?.click()} loading={check.isPending}>
            <FileUp /> {file ? 'Choose another file' : 'Choose file'}
          </Button>
          <input
            ref={input}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="sr-only"
            aria-label="Excel file"
            onChange={(e) => {
              pick(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>
        {file ? <p className="text-sm text-muted-foreground">{file.name}</p> : null}
        {shown ? <BatchResult b={shown} /> : null}
        {checked?.status === 'validated' ? (
          <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
            {invalid ? (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={skipInvalid} onChange={(e) => setSkipInvalid(e.target.checked)} />
                Skip the {fmtNum(invalid)} rows with problems
              </label>
            ) : (
              <span className="text-sm text-success-text">Every row is valid.</span>
            )}
            <Button disabled={!canImport} loading={run.isPending} onClick={() => file && run.mutate(file)}>
              <Upload /> Import {fmtNum(checked.counts.valid)} subscribers
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Recent() {
  const q = useQuery({
    queryKey: ['imports', 'recent'],
    queryFn: () => unwrap(api.GET('/api/v1/subscribers/imports')),
  });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <section className="space-y-3" aria-labelledby="recent">
      <h2 id="recent" className="text-base font-semibold">
        Recent imports
      </h2>
      <DataTable
        caption="Recent imports"
        loading={q.isLoading}
        rows={q.data}
        rowKey={(b) => b.id ?? b.fileName}
        empty="No imports yet."
        columns={[
          { key: 'file', header: 'File', cell: (b) => b.fileName },
          { key: 'when', header: 'Started', cell: (b) => fmtDateTime(b.createdAt) },
          {
            key: 'status',
            header: 'Status',
            cell: (b) => <Badge tone={STATUS[b.status][0]}>{STATUS[b.status][1]}</Badge>,
          },
          {
            key: 'created',
            header: 'Created',
            cell: (b) => `${fmtNum(b.counts.created)} of ${fmtNum(b.counts.valid)}`,
          },
        ]}
      />
    </section>
  );
}

function ExportCard() {
  const { plans } = usePlans();
  const [status, setStatus] = useState('');
  const [planId, setPlanId] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    const qs = new URLSearchParams({ ...(status ? { status } : {}), ...(planId ? { planId } : {}) });
    try {
      await download(`/api/v1/subscribers/export${qs.size ? `?${qs}` : ''}`, 'subscribers.xlsx');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Export subscribers</CardTitle>
        <CardDescription>
          Excel file without passwords. Each export is recorded in the audit log.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label="Status" htmlFor="x-status">
          <Select id="x-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
            <option value="disabled">Disabled</option>
          </Select>
        </Field>
        <Field label="Plan" htmlFor="x-plan">
          <Select id="x-plan" value={planId} onChange={(e) => setPlanId(e.target.value)}>
            <option value="">All plans</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Button onClick={() => void run()} loading={busy}>
          <Download /> Download
        </Button>
      </CardContent>
    </Card>
  );
}

export default function ImportPage() {
  const can = useCan();
  return (
    <>
      <PageHeader title="Import & export" />
      <div className="space-y-6">
        {can('imports.run') ? <ImportCard /> : null}
        {can('subscribers.export') ? <ExportCard /> : null}
        {can('imports.run') ? <Recent /> : null}
      </div>
    </>
  );
}
