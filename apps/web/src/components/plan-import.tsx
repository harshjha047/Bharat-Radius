'use client';
import { useMutation } from '@tanstack/react-query';
import { Download, FileUp, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { dialogActions } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/input';
import { authFetch, download, toApiError, XLSX_MIME } from '@/lib/api';
import type { paths } from '@/lib/api-types';
import { fmtNum } from '@/lib/utils';

type Result = paths['/api/v1/plans/import']['post']['responses'][200]['content']['application/json'];
type Action = Result['rows'][number]['action'];
const MAX_BYTES = 10 * 1024 * 1024;

const ACTION: Record<Action, ['neutral' | 'primary' | 'success' | 'warning' | 'danger', string]> = {
  create: ['success', 'New'],
  update: ['primary', 'Update'],
  unchanged: ['neutral', 'No change'],
  skip: ['warning', 'Exists, skipped'],
  invalid: ['danger', 'Problem'],
};

/** Field names in the API → what staff see. */
const FIELD: Record<string, string> = {
  name: 'name',
  description: 'description',
  downloadKbps: 'download',
  uploadKbps: 'upload',
  burst: 'burst',
  dataCapBytes: 'data cap',
  fup: 'speed after cap',
  fupCycle: 'cap cycle',
  validityDays: 'validity',
  ipPool: 'IP pool',
  simUse: 'logins at once',
  billingTypes: 'billing types',
  pricePaise: 'price',
  gstRatePercent: 'GST',
  hsnSac: 'HSN/SAC',
  extraAttributes: 'extra attributes',
  status: 'status',
};

async function upload(file: File, o: { dryRun: boolean; updateExisting: boolean; skipInvalid: boolean }) {
  const qs = new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)]));
  const res = await authFetch(
    new Request(`/api/v1/plans/import?${qs}`, {
      method: 'POST',
      body: file,
      credentials: 'same-origin',
      headers: { 'content-type': XLSX_MIME, 'x-file-name': encodeURIComponent(file.name) },
    }),
  );
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as Result;
}

export function PlanImport({ onImported, onClose }: { onImported: () => void; onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [updateExisting, setUpdateExisting] = useState(false);
  const [skipInvalid, setSkipInvalid] = useState(false);
  const check = useMutation({
    mutationFn: (v: { f: File; updateExisting: boolean }) =>
      upload(v.f, { dryRun: true, updateExisting: v.updateExisting, skipInvalid: false }),
  });
  const run = useMutation({
    mutationFn: (f: File) => upload(f, { dryRun: false, updateExisting, skipInvalid }),
    onSuccess: (r) => {
      if (r.status !== 'done') return;
      const { created, updated, failed } = r.counts;
      (failed ? toast.warning : toast.success)(
        `${fmtNum(created)} created, ${fmtNum(updated)} updated${failed ? `, ${fmtNum(failed)} failed` : ''}.`,
      );
      onImported();
    },
  });
  const shown = run.data ?? check.data;

  const pick = (f: File | undefined) => {
    run.reset();
    if (!f) return setFile(null);
    if (f.size > MAX_BYTES) {
      toast.error('The file is larger than 10 MB.');
      return setFile(null);
    }
    setFile(f);
    check.mutate({ f, updateExisting });
  };
  const toggleUpdate = (v: boolean) => {
    setUpdateExisting(v);
    run.reset();
    if (file) check.mutate({ f: file, updateExisting: v });
  };

  const c = check.data?.counts;
  const todo = c ? c.create + c.update : 0;
  const canImport = !!file && !!c && todo > 0 && (c.invalid === 0 || skipInvalid) && !run.data;

  return (
    <div className="space-y-4 text-sm">
      <p className="text-muted-foreground">
        One row per plan. Rows are checked first; nothing changes until you confirm. Export gives the same
        columns, so you can export, edit and import again.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() =>
            void download('/api/v1/plans/import/template', 'plans-template.xlsx').catch((e: Error) =>
              toast.error(e.message),
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
          aria-label="Excel file with plans"
          onChange={(e) => {
            pick(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>
      {file ? <p className="text-muted-foreground">{file.name}</p> : null}
      <label className="flex items-start gap-2">
        <Checkbox checked={updateExisting} onChange={(e) => toggleUpdate(e.target.checked)} />
        <span>
          Update existing plans with the same name
          <span className="block text-xs text-muted-foreground">
            Speed changes reach online customers on those plans at once.
          </span>
        </span>
      </label>
      {check.error ? <p className="text-danger-text">{check.error.message}</p> : null}
      {shown ? (
        <>
          <p>
            {fmtNum(shown.counts.read)} rows · {fmtNum(shown.counts.create)} new ·{' '}
            {fmtNum(shown.counts.update)} to update · {fmtNum(shown.counts.unchanged)} unchanged
            {shown.counts.skip ? ` · ${fmtNum(shown.counts.skip)} existing skipped` : ''}
            {shown.counts.invalid ? ` · ${fmtNum(shown.counts.invalid)} with problems` : ''}
          </p>
          <DataTable
            caption="Plans in the file"
            rows={shown.rows}
            rowKey={(r) => String(r.row)}
            columns={[
              { key: 'row', header: 'Row', cell: (r) => r.row },
              { key: 'name', header: 'Plan', cell: (r) => r.name || '—' },
              {
                key: 'action',
                header: 'Action',
                cell: (r) =>
                  r.result === 'failed' ? (
                    <Badge tone="danger">Failed</Badge>
                  ) : r.result ? (
                    <Badge tone="success">{r.result === 'created' ? 'Created' : 'Updated'}</Badge>
                  ) : (
                    <Badge tone={ACTION[r.action][0]}>{ACTION[r.action][1]}</Badge>
                  ),
              },
              {
                key: 'detail',
                header: 'Details',
                cell: (r) => {
                  const errs = shown.errors.filter((e) => e.row === r.row);
                  if (errs.length)
                    return (
                      <span className="text-danger-text">
                        {errs.map((e) => (e.column ? `${e.column}: ${e.message}` : e.message)).join('; ')}
                      </span>
                    );
                  return r.changes.length ? r.changes.map((k) => FIELD[k] ?? k).join(', ') : '—';
                },
              },
            ]}
          />
        </>
      ) : null}
      {c?.invalid && !run.data ? (
        <label className="flex items-center gap-2">
          <Checkbox checked={skipInvalid} onChange={(e) => setSkipInvalid(e.target.checked)} />
          Skip the {fmtNum(c.invalid)} rows with problems
        </label>
      ) : null}
      <div className={dialogActions}>
        <Button type="button" variant="outline" onClick={onClose}>
          {run.data ? 'Close' : 'Cancel'}
        </Button>
        {!run.data ? (
          <Button disabled={!canImport} loading={run.isPending} onClick={() => file && run.mutate(file)}>
            <Upload /> Import {todo ? fmtNum(todo) : ''} plans
          </Button>
        ) : null}
      </div>
    </div>
  );
}
