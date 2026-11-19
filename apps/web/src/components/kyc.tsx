'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, FileDown, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';
import { ErrorState, Field } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorText, openFile, unwrap, uploadFile, type ApiData } from '@/lib/api';
import { fmtBytes, fmtDateTime } from '@/lib/utils';

type Kyc = ApiData<'/api/v1/subscribers/{id}/kyc'>;
type Doc = Kyc['documents'][number];
type Kind = Doc['kind'];

export const KIND_LABEL: Record<Kind, string> = {
  aadhaar: 'Aadhaar',
  pan: 'PAN card',
  voter_id: 'Voter ID',
  passport: 'Passport',
  driving_licence: 'Driving licence',
  photo: 'Photo',
  caf_signed: 'Signed CAF',
  address_proof: 'Address proof',
  other: 'Other',
};
const KINDS = Object.keys(KIND_LABEL) as Kind[];
const ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';
const MAX = 5 * 1024 * 1024;

export const KYC_TONE = { pending: 'warning', verified: 'success', rejected: 'danger' } as const;

/** Kind + number + file picker; `onUpload` sends it. */
export function KycUploadForm({
  kinds = KINDS,
  withNumber = true,
  onUpload,
}: {
  kinds?: readonly Kind[];
  withNumber?: boolean;
  onUpload: (file: File, kind: Kind, number: string) => Promise<unknown>;
}) {
  const [kind, setKind] = useState<Kind>(kinds[0]!);
  const [number, setNumber] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const tooBig = !!file && file.size > MAX;
  const m = useMutation({
    meta: { silent: true },
    mutationFn: () => onUpload(file!, kind, number.trim()),
    onSuccess: () => {
      toast.success(`${KIND_LABEL[kind]} uploaded.`);
      setFile(null);
      setNumber('');
      if (input.current) input.current.value = '';
    },
  });
  return (
    <form
      className="grid gap-3 sm:grid-cols-[180px_1fr_auto] sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        if (file && !tooBig) m.mutate();
      }}
    >
      <Field label="Document" htmlFor="kyc-kind">
        <Select id="kyc-kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        {withNumber && kind !== 'photo' && kind !== 'caf_signed' ? (
          <Field label="Number (stored masked)" htmlFor="kyc-no">
            <Input
              id="kyc-no"
              maxLength={30}
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              placeholder={kind === 'aadhaar' ? 'Last 4 is enough' : ''}
            />
          </Field>
        ) : (
          <span />
        )}
        <Field
          label="File (JPEG, PNG, WebP, PDF; 5 MB)"
          htmlFor="kyc-file"
          error={tooBig ? 'Larger than 5 MB' : m.error ? errorText(m.error) : undefined}
        >
          <Input
            ref={input}
            id="kyc-file"
            type="file"
            accept={ACCEPT}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </Field>
      </div>
      <Button type="submit" loading={m.isPending} disabled={!file || tooBig}>
        <Upload /> Upload
      </Button>
    </form>
  );
}

export default function SubscriberKyc({ subscriberId }: { subscriberId: string }) {
  const qc = useQueryClient();
  const key = ['kyc', subscriberId];
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      unwrap(api.GET('/api/v1/subscribers/{id}/kyc', { params: { path: { id: subscriberId } } })),
  });
  const [decide, setDecide] = useState<'verified' | 'rejected' | null>(null);
  const [note, setNote] = useState('');
  const [removing, setRemoving] = useState<Doc | null>(null);
  const [reason, setReason] = useState('');
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ['subscriber', subscriberId] });
  };
  const verify = useMutation({
    meta: { silent: true },
    mutationFn: (status: 'verified' | 'rejected' | 'pending') =>
      unwrap(
        api.POST('/api/v1/subscribers/{id}/kyc/verify', {
          params: { path: { id: subscriberId } },
          body: { status, ...(note.trim() ? { note: note.trim() } : {}) },
        }),
      ),
    onSuccess: (k) => {
      qc.setQueryData(key, k);
      refresh();
      toast.success(`KYC ${k.status}.`);
      setDecide(null);
      setNote('');
    },
  });
  const remove = useMutation({
    meta: { silent: true },
    mutationFn: (id: string) =>
      unwrap(
        api.POST('/api/v1/kyc-documents/{id}/remove', {
          params: { path: { id } },
          body: { reason: reason.trim() },
        }),
      ),
    onSuccess: () => {
      refresh();
      toast.success('Document removed.');
      setRemoving(null);
      setReason('');
    },
  });
  const caf = useMutation({
    mutationFn: () => openFile(`/api/v1/subscribers/${subscriberId}/caf`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
  });
  const view = useMutation({ mutationFn: (id: string) => openFile(`/api/v1/kyc-documents/${id}/file`) });

  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data) return <Skeleton className="h-64 w-full" />;
  const k = q.data;
  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader className="flex-row flex-wrap items-center gap-3">
          <CardTitle>KYC</CardTitle>
          <Badge tone={KYC_TONE[k.status]}>{k.status}</Badge>
          {k.cafNo ? <span className="font-mono text-sm text-muted-foreground">{k.cafNo}</span> : null}
          <div className="ml-auto flex flex-wrap gap-2">
            <Button variant="outline" size="sm" loading={caf.isPending} onClick={() => caf.mutate()}>
              <FileDown /> {k.cafNo ? 'CAF form' : 'Create CAF form'}
            </Button>
            {k.canVerify && k.status !== 'verified' ? (
              <Button size="sm" disabled={k.missing.length > 0} onClick={() => setDecide('verified')}>
                Verify
              </Button>
            ) : null}
            {k.canVerify && k.status !== 'rejected' ? (
              <Button size="sm" variant="outline" onClick={() => setDecide('rejected')}>
                Reject
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {k.missing.length ? (
            <p className="text-warning-text">Missing: {k.missing.join(', ')}</p>
          ) : (
            <p className="text-muted-foreground">Identity, address, photo and signed CAF are on file.</p>
          )}
          {k.note ? (
            <p>
              <span className="text-muted-foreground">Remark:</span> {k.note}
            </p>
          ) : null}
          {k.decidedAt ? (
            <p className="text-muted-foreground">Last decision {fmtDateTime(k.decidedAt)}</p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Print the CAF form, have the customer sign it, then upload it here as <em>Signed CAF</em>.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Documents</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <DataTable
            caption="KYC documents"
            rows={k.documents}
            rowKey={(d) => d.id}
            empty="No documents yet."
            columns={[
              { key: 'kind', header: 'Document', cell: (d) => KIND_LABEL[d.kind] },
              { key: 'no', header: 'Number', cell: (d) => d.maskedNumber ?? '—' },
              {
                key: 'file',
                header: 'File',
                hideOnMobile: true,
                cell: (d) => (
                  <span className="text-muted-foreground">
                    {d.mimeType === 'application/pdf'
                      ? 'PDF'
                      : d.mimeType.replace('image/', '').toUpperCase()}{' '}
                    · {fmtBytes(d.sizeBytes)}
                  </span>
                ),
              },
              {
                key: 'at',
                header: 'Uploaded',
                cell: (d) => (
                  <span>
                    {fmtDateTime(d.createdAt)}
                    <span className="block text-xs text-muted-foreground">by {d.uploadedVia}</span>
                  </span>
                ),
              },
              {
                key: 'act',
                header: '',
                cell: (d) => (
                  <div className="flex justify-end gap-1">
                    {k.canView ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Open ${KIND_LABEL[d.kind]}`}
                        loading={view.isPending && view.variables === d.id}
                        onClick={() => view.mutate(d.id, { onError: (e) => toast.error(errorText(e)) })}
                      >
                        <Eye />
                      </Button>
                    ) : null}
                    {k.canVerify ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Remove ${KIND_LABEL[d.kind]}`}
                        onClick={() => setRemoving(d)}
                      >
                        <Trash2 />
                      </Button>
                    ) : null}
                  </div>
                ),
              },
            ]}
          />
          {k.canUpload ? (
            <KycUploadForm
              onUpload={async (file, kind, number) => {
                const qs = new URLSearchParams({ kind, ...(number ? { number } : {}) });
                await uploadFile(`/api/v1/subscribers/${subscriberId}/kyc/documents?${qs}`, file);
                refresh();
              }}
            />
          ) : null}
          {!k.canView ? (
            <p className="text-xs text-muted-foreground">Opening documents needs the KYC view permission.</p>
          ) : null}
        </CardContent>
      </Card>

      <Dialog open={!!decide} onOpenChange={(o) => !o && setDecide(null)}>
        <DialogContent
          title={decide === 'verified' ? 'Verify KYC' : 'Reject KYC'}
          description={
            decide === 'verified'
              ? 'You checked the documents against the customer.'
              : 'The customer or reseller sees the reason and uploads again.'
          }
        >
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (decide) verify.mutate(decide);
            }}
          >
            <Field
              label={decide === 'rejected' ? 'Reason' : 'Remark (optional)'}
              htmlFor="kyc-note"
              error={verify.error ? errorText(verify.error) : undefined}
            >
              <Input id="kyc-note" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setDecide(null)}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant={decide === 'rejected' ? 'destructive' : 'default'}
                loading={verify.isPending}
                disabled={decide === 'rejected' && note.trim().length < 3}
              >
                {decide === 'verified' ? 'Verify' : 'Reject'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
        <DialogContent
          title={removing ? `Remove ${KIND_LABEL[removing.kind]}` : ''}
          description="The file is deleted; the record of the upload and its removal stays in the history."
        >
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (removing) remove.mutate(removing.id);
            }}
          >
            <Field label="Reason" htmlFor="kyc-rm" error={remove.error ? errorText(remove.error) : undefined}>
              <Input id="kyc-rm" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setRemoving(null)}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="destructive"
                loading={remove.isPending}
                disabled={reason.trim().length < 3}
              >
                Remove
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
