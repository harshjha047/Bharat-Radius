'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { ErrorState } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorText, unwrap } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { fmtDateTime } from '@/lib/utils';

/** ISP settings: the DPDP privacy notice customers accept. Saving a changed text publishes a new version. */
export function PrivacyNoticeCard() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['tenant', 'privacy'],
    queryFn: () => unwrap(api.GET('/api/v1/tenant/privacy')),
  });
  const [text, setText] = useState<string | null>(null);
  const save = useMutation({
    meta: { silent: true },
    mutationFn: (t: string) => unwrap(api.PUT('/api/v1/tenant/privacy', { body: { text: t } })),
    onSuccess: (n) => {
      qc.setQueryData(['tenant', 'privacy'], n);
      setText(null);
      toast.success(
        `Privacy notice v${n.version} published. Customers accept it at their next portal visit.`,
      );
    },
  });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data) return <Skeleton className="h-48 w-full" />;
  const p = q.data;
  const value = text ?? p.text ?? '';
  return (
    <Card className="mt-5">
      <CardHeader>
        <CardTitle>Privacy notice (DPDP)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          {p.version
            ? `Version ${p.version}, published ${fmtDateTime(p.updatedAt!)}. A changed text becomes a new version and every customer is asked to accept it again.`
            : 'Not published yet: customers are not asked for consent. Start from the draft, have your lawyer review it, then publish.'}{' '}
          <code>{'{isp}'}</code>, <code>{'{phone}'}</code>, <code>{'{email}'}</code> are filled in from ISP
          settings.
        </p>
        <textarea
          aria-label="Privacy notice"
          className="min-h-64 w-full rounded-xl border bg-background p-3 font-mono text-[13px] leading-relaxed"
          maxLength={8000}
          value={value}
          onChange={(e) => setText(e.target.value)}
        />
        {save.error ? <p className="text-destructive">{errorText(save.error)}</p> : null}
        <div className="flex flex-wrap gap-2">
          {!value ? (
            <Button variant="outline" onClick={() => setText(p.draft)}>
              Start from the draft
            </Button>
          ) : null}
          <Button
            loading={save.isPending}
            disabled={value.trim().length < 100 || value === (p.text ?? '')}
            onClick={() => save.mutate(value.trim())}
          >
            Publish {p.version ? `v${p.version + 1}` : 'v1'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Subscriber page: which notice version the customer accepted; staff record consent given on the signed CAF. */
export function SubscriberConsent({ subscriberId }: { subscriberId: string }) {
  const qc = useQueryClient();
  const can = useCan();
  const key = ['consent', subscriberId];
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      unwrap(api.GET('/api/v1/subscribers/{id}/consent', { params: { path: { id: subscriberId } } })),
  });
  const rec = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/subscribers/{id}/consent', {
          params: { path: { id: subscriberId } },
          body: { via: 'caf' },
        }),
      ),
    onSuccess: (c) => {
      qc.setQueryData(key, c);
      toast.success('Consent recorded.');
    },
  });
  if (!q.data) return <Skeleton className="h-5 w-40" />;
  const c = q.data;
  if (!c.current) return <span className="text-muted-foreground">No privacy notice published</span>;
  return (
    <span className="flex flex-wrap items-center gap-2">
      {c.version
        ? `v${c.version} via ${c.via}, ${fmtDateTime(c.at!)}${c.upToDate ? '' : ` (current is v${c.current})`}`
        : 'Not given yet'}
      {!c.upToDate && can('subscribers.write') ? (
        <Button size="sm" variant="outline" loading={rec.isPending} onClick={() => rec.mutate()}>
          Signed CAF received
        </Button>
      ) : null}
    </span>
  );
}

/** Portal: asks for consent to the current notice; "Later" hides it until the next visit. */
export function PortalConsent() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['portal', 'privacy'],
    queryFn: () => unwrap(api.GET('/api/v1/portal/privacy')),
  });
  const [later, setLater] = useState(false);
  const accept = useMutation({
    mutationFn: (version: number) => unwrap(api.POST('/api/v1/portal/privacy/accept', { body: { version } })),
    onSuccess: (n) => qc.setQueryData(['portal', 'privacy'], n),
  });
  const p = q.data;
  if (!p?.needsConsent || !p.text) return null;
  return (
    <Dialog open={!later} onOpenChange={(o) => !o && setLater(true)}>
      <DialogContent title="Privacy notice" description="Please read how your data is used.">
        <div className="max-h-[55vh] overflow-y-auto whitespace-pre-line rounded-xl bg-muted p-3 text-sm">
          {p.text}
        </div>
        {accept.error ? <p className="text-sm text-destructive">{errorText(accept.error)}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setLater(true)}>
            Later
          </Button>
          <Button loading={accept.isPending} onClick={() => accept.mutate(p.version)}>
            I accept
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function PortalPrivacyCard() {
  const q = useQuery({
    queryKey: ['portal', 'privacy'],
    queryFn: () => unwrap(api.GET('/api/v1/portal/privacy')),
  });
  const [open, setOpen] = useState(false);
  const p = q.data;
  if (!p?.text) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Privacy</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="text-muted-foreground">
          {p.acceptedAt
            ? `You accepted version ${p.acceptedVersion} on ${fmtDateTime(p.acceptedAt)}.`
            : 'Not accepted yet.'}
        </p>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          Read the privacy notice
        </Button>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent title="Privacy notice">
            <div className="max-h-[60vh] overflow-y-auto whitespace-pre-line text-sm">{p.text}</div>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
