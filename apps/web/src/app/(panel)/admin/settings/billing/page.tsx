'use client';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { PageSkeleton } from '@/components/shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { Checkbox, Input, Textarea } from '@/components/ui/input';
import { CopyButton, ErrorState, Field, PageHeader } from '@/components/ui/misc';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, ApiError, unwrap } from '@/lib/api';
import { fmtDateTime } from '@/lib/utils';

type Settings = Awaited<ReturnType<typeof load>>;
const load = () => unwrap(api.GET('/api/v1/billing/settings'));
const field = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim();

function useSave() {
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: (b: Record<string, unknown>) =>
      unwrap(api.PATCH('/api/v1/billing/settings', { body: b as never })),
    onSuccess: (n) => {
      qc.setQueryData(['billing-settings'], n);
      toast.success('Saved.');
    },
  });
}
const errorOf = (e: unknown) => (e instanceof ApiError ? e.message : null);

export default function BillingSettingsPage() {
  const s = useQuery({ queryKey: ['billing-settings'], queryFn: load });
  if (s.isLoading) return <PageSkeleton />;
  if (s.isError) return <ErrorState error={s.error} onRetry={() => void s.refetch()} />;
  return (
    <>
      <PageHeader
        title="Billing settings"
        description="Invoices, postpaid dates, payment gateways and SMS."
      />
      <Tabs defaultValue="billing">
        <TabsList>
          <TabsTrigger value="billing">Invoices & dates</TabsTrigger>
          <TabsTrigger value="gateways">Payment gateways</TabsTrigger>
          <TabsTrigger value="sms">SMS</TabsTrigger>
          <TabsTrigger value="templates">SMS templates</TabsTrigger>
          <TabsTrigger value="log">SMS log</TabsTrigger>
        </TabsList>
        <TabsContent value="billing">
          <BillingForm key={JSON.stringify(s.data!.billing)} s={s.data!} />
        </TabsContent>
        <TabsContent value="gateways">
          <Gateways s={s.data!} />
        </TabsContent>
        <TabsContent value="sms">
          <SmsForm key={JSON.stringify(s.data!.sms)} s={s.data!} />
        </TabsContent>
        <TabsContent value="templates">
          <Templates />
        </TabsContent>
        <TabsContent value="log">
          <SmsLog />
        </TabsContent>
      </Tabs>
    </>
  );
}

function BillingForm({ s }: { s: Settings }) {
  const save = useSave();
  const b = s.billing;
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    save.mutate({
      billing: {
        invoicePrefix: field(fd, 'prefix').toUpperCase(),
        dueDays: Number(field(fd, 'due')),
        graceDays: Number(field(fd, 'grace')),
        lowBalancePaise: Math.round(Number(field(fd, 'low')) * 100),
        reminderDaysBefore: field(fd, 'reminders')
          .split(',')
          .map((x) => Number(x.trim()))
          .filter((n) => Number.isInteger(n) && n > 0),
      },
    });
  };
  return (
    <Card>
      <CardContent className="pt-6">
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Invoice prefix"
            htmlFor="b-prefix"
            hint="1–3 capital letters. Numbers look like INV/2627/00001."
          >
            <Input
              id="b-prefix"
              name="prefix"
              maxLength={3}
              defaultValue={b.invoicePrefix}
              className="uppercase"
            />
          </Field>
          <Field label="Default low-balance level (₹)" htmlFor="b-low" hint="For new reseller wallets.">
            <Input id="b-low" name="low" inputMode="decimal" defaultValue={b.lowBalancePaise / 100} />
          </Field>
          <Field label="Postpaid: due days after the 1st" htmlFor="b-due" hint="6 = due on the 7th.">
            <Input id="b-due" name="due" type="number" min={0} max={60} defaultValue={b.dueDays} />
          </Field>
          <Field
            label="Postpaid: grace days after due"
            htmlFor="b-grace"
            hint="Then the customer is blocked."
          >
            <Input id="b-grace" name="grace" type="number" min={0} max={60} defaultValue={b.graceDays} />
          </Field>
          <Field
            label="Prepaid reminders (days before expiry)"
            htmlFor="b-rem"
            hint="Comma separated, e.g. 3, 1"
          >
            <Input id="b-rem" name="reminders" defaultValue={b.reminderDaysBefore.join(', ')} />
          </Field>
          <div className="flex items-end justify-end gap-3 sm:col-span-2">
            {errorOf(save.error) ? (
              <span className="text-sm text-destructive">{errorOf(save.error)}</span>
            ) : null}
            <Button type="submit" loading={save.isPending}>
              Save
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function Gateways({ s }: { s: Settings }) {
  const save = useSave();
  const rp = s.razorpay;
  const cf = s.cashfree;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Razorpay{' '}
            {rp ? <Badge tone={rp.enabled ? 'success' : 'neutral'}>{rp.enabled ? 'On' : 'Off'}</Badge> : null}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              save.mutate({
                razorpay: {
                  enabled: fd.get('enabled') === 'on',
                  keyId: field(fd, 'keyId'),
                  ...(field(fd, 'keySecret') ? { keySecret: field(fd, 'keySecret') } : {}),
                  ...(field(fd, 'webhookSecret') ? { webhookSecret: field(fd, 'webhookSecret') } : {}),
                },
              });
            }}
          >
            <Field label="Key ID" htmlFor="rp-key">
              <Input
                id="rp-key"
                name="keyId"
                defaultValue={rp?.keyId ?? ''}
                placeholder="rzp_test_…"
                autoComplete="off"
              />
            </Field>
            <Field
              label="Key secret"
              htmlFor="rp-secret"
              hint={rp ? 'Saved. Leave empty to keep it.' : undefined}
            >
              <Input id="rp-secret" name="keySecret" type="password" autoComplete="new-password" />
            </Field>
            <Field
              label="Webhook secret"
              htmlFor="rp-hook"
              hint={rp ? 'Saved. Leave empty to keep it.' : 'Set the same value in Razorpay → Webhooks.'}
            >
              <Input id="rp-hook" name="webhookSecret" type="password" autoComplete="new-password" />
            </Field>
            <WebhookUrl
              url={s.webhookUrls.razorpay}
              events="payment_link.paid, payment.captured, payment.failed"
            />
            <label className="flex items-center gap-2 text-sm">
              <Checkbox name="enabled" defaultChecked={rp?.enabled ?? true} /> Enabled
            </label>
            <div className="flex justify-end gap-2">
              {rp ? (
                <Button type="button" variant="outline" onClick={() => save.mutate({ razorpay: null })}>
                  Remove
                </Button>
              ) : null}
              <Button type="submit" loading={save.isPending}>
                Save
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Cashfree{' '}
            {cf ? (
              <Badge tone={cf.enabled ? 'success' : 'neutral'}>
                {cf.enabled ? (cf.sandbox ? 'Sandbox' : 'Live') : 'Off'}
              </Badge>
            ) : null}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              save.mutate({
                cashfree: {
                  enabled: fd.get('enabled') === 'on',
                  sandbox: fd.get('sandbox') === 'on',
                  appId: field(fd, 'appId'),
                  ...(field(fd, 'secretKey') ? { secretKey: field(fd, 'secretKey') } : {}),
                },
              });
            }}
          >
            <Field label="App ID" htmlFor="cf-app">
              <Input id="cf-app" name="appId" defaultValue={cf?.appId ?? ''} autoComplete="off" />
            </Field>
            <Field
              label="Secret key"
              htmlFor="cf-secret"
              hint={cf ? 'Saved. Leave empty to keep it.' : 'Also signs Cashfree webhooks.'}
            >
              <Input id="cf-secret" name="secretKey" type="password" autoComplete="new-password" />
            </Field>
            <WebhookUrl
              url={s.webhookUrls.cashfree}
              events="Payment success, Payment failed, Payment link events"
            />
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox name="sandbox" defaultChecked={cf?.sandbox ?? true} /> Sandbox
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox name="enabled" defaultChecked={cf?.enabled ?? true} /> Enabled
              </label>
            </div>
            <div className="flex justify-end gap-2">
              {cf ? (
                <Button type="button" variant="outline" onClick={() => save.mutate({ cashfree: null })}>
                  Remove
                </Button>
              ) : null}
              <Button type="submit" loading={save.isPending}>
                Save
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
      {errorOf(save.error) ? (
        <p className="text-sm text-destructive lg:col-span-2">{errorOf(save.error)}</p>
      ) : null}
    </div>
  );
}

function WebhookUrl({ url, events }: { url: string; events: string }) {
  return (
    <div className="rounded-md border bg-muted/40 p-2 text-xs">
      <div className="mb-1 text-muted-foreground">Webhook URL (events: {events})</div>
      <div className="flex items-center gap-2">
        <span className="truncate font-mono">{url}</span>
        <CopyButton value={url} />
      </div>
    </div>
  );
}

function SmsForm({ s }: { s: Settings }) {
  const save = useSave();
  const sms = s.sms;
  return (
    <Card>
      <CardContent className="pt-6">
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            save.mutate({
              sms: {
                enabled: fd.get('enabled') === 'on',
                urlTemplate: field(fd, 'url'),
                senderId: field(fd, 'sender').toUpperCase(),
                entityId: field(fd, 'entity'),
                successPattern: field(fd, 'pattern'),
                ...(field(fd, 'apiKey') ? { apiKey: field(fd, 'apiKey') } : {}),
              },
            });
          }}
        >
          <Field
            label="Provider HTTP API URL"
            htmlFor="s-url"
            className="sm:col-span-2"
            hint="From your RapidSMS panel. Placeholders: {apiKey} {sender} {entityId} {templateId} {to} (91…) {mobile} (10 digits) {message}"
          >
            <Textarea
              id="s-url"
              name="url"
              rows={2}
              defaultValue={sms?.urlTemplate ?? ''}
              className="font-mono text-xs"
            />
          </Field>
          <Field
            label="API key"
            htmlFor="s-key"
            hint={sms?.apiKeySet ? 'Saved. Leave empty to keep it.' : undefined}
          >
            <Input id="s-key" name="apiKey" type="password" autoComplete="new-password" />
          </Field>
          <Field label="Sender ID (DLT header)" htmlFor="s-sender">
            <Input
              id="s-sender"
              name="sender"
              maxLength={6}
              defaultValue={sms?.senderId ?? ''}
              className="uppercase"
            />
          </Field>
          <Field label="DLT entity ID" htmlFor="s-entity">
            <Input id="s-entity" name="entity" defaultValue={sms?.entityId ?? ''} />
          </Field>
          <Field label="Success pattern" htmlFor="s-pattern" hint="Optional. Response must match, e.g. ^OK">
            <Input id="s-pattern" name="pattern" defaultValue={sms?.successPattern ?? ''} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox name="enabled" defaultChecked={sms?.enabled ?? false} /> Send SMS
          </label>
          <div className="flex items-end justify-end gap-3">
            {errorOf(save.error) ? (
              <span className="text-sm text-destructive">{errorOf(save.error)}</span>
            ) : null}
            <Button type="submit" loading={save.isPending}>
              Save
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

const TEMPLATE_LABEL: Record<string, string> = {
  expiry_reminder: 'Expiry reminder',
  expired: 'Expired',
  payment_receipt: 'Payment receipt',
  invoice_issued: 'Invoice issued',
  overdue_suspended: 'Overdue / suspended',
  otp: 'OTP',
};

function Templates() {
  const qc = useQueryClient();
  const t = useQuery({
    queryKey: ['sms-templates'],
    queryFn: () => unwrap(api.GET('/api/v1/billing/templates')),
  });
  const [editing, setEditing] = useState<string | null>(null);
  const save = useMutation({
    meta: { silent: true },
    mutationFn: (v: { key: string; dltTemplateId: string; body: string; active: boolean }) =>
      unwrap(
        api.PUT('/api/v1/billing/templates/{key}', {
          params: { path: { key: v.key as 'otp' } },
          body: { dltTemplateId: v.dltTemplateId, body: v.body, active: v.active },
        }),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sms-templates'] });
      setEditing(null);
      toast.success('Template saved.');
    },
  });
  if (t.isLoading) return <PageSkeleton />;
  if (t.isError) return <ErrorState error={t.error} onRetry={() => void t.refetch()} />;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Paste each template exactly as approved on the DLT portal, with {'{#var#}'} where values go, in the
        order shown.
      </p>
      {t.data!.map((tpl) => (
        <Card key={tpl.key}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              {TEMPLATE_LABEL[tpl.key]}
              <Badge tone={tpl.active ? 'success' : 'neutral'}>
                {tpl.active ? 'Active' : tpl.body ? 'Off' : 'Not set'}
              </Badge>
              <span className="ml-auto text-xs font-normal text-muted-foreground">
                Values: {tpl.variables.join(', ')}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {editing === tpl.key ? (
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  save.mutate({
                    key: tpl.key,
                    dltTemplateId: field(fd, 'tid'),
                    body: field(fd, 'body'),
                    active: fd.get('active') === 'on',
                  });
                }}
              >
                <Field label="DLT template ID" htmlFor={`t-${tpl.key}-id`}>
                  <Input
                    id={`t-${tpl.key}-id`}
                    name="tid"
                    inputMode="numeric"
                    defaultValue={tpl.dltTemplateId ?? ''}
                  />
                </Field>
                <Field label="Text" htmlFor={`t-${tpl.key}-body`}>
                  <Textarea id={`t-${tpl.key}-body`} name="body" rows={3} defaultValue={tpl.body ?? ''} />
                </Field>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox name="active" defaultChecked={tpl.active || !tpl.body} /> Active
                </label>
                {errorOf(save.error) ? (
                  <p className="text-sm text-destructive">{errorOf(save.error)}</p>
                ) : null}
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                  <Button type="submit" loading={save.isPending}>
                    Save
                  </Button>
                </div>
              </form>
            ) : (
              <div className="flex items-start gap-3">
                <p className="flex-1 text-sm whitespace-pre-wrap">
                  {tpl.body ?? <span className="text-muted-foreground">Not set</span>}
                </p>
                <Button variant="outline" size="sm" onClick={() => setEditing(tpl.key)}>
                  Edit
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function SmsLog() {
  const [status, setStatus] = useState<'' | 'queued' | 'sent' | 'failed' | 'skipped'>('');
  const q = useInfiniteQuery({
    queryKey: ['sms-log', status],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/v1/billing/notifications', {
          params: {
            query: { limit: 100, ...(status ? { status } : {}), ...(pageParam ? { cursor: pageParam } : {}) },
          },
        }),
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    refetchInterval: 30_000,
  });
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        {(['', 'queued', 'sent', 'failed', 'skipped'] as const).map((s) => (
          <Button
            key={s || 'all'}
            size="sm"
            variant={status === s ? 'default' : 'outline'}
            onClick={() => setStatus(s)}
          >
            {s ? s[0]!.toUpperCase() + s.slice(1) : 'All'}
          </Button>
        ))}
      </div>
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <DataTable
          caption="SMS log"
          loading={q.isLoading}
          rows={q.data?.pages.flatMap((p) => p.items)}
          rowKey={(n) => n.id}
          hasMore={q.hasNextPage}
          loadingMore={q.isFetchingNextPage}
          onLoadMore={() => void q.fetchNextPage()}
          empty="No SMS yet."
          columns={[
            { key: 'at', header: 'When', cell: (n) => fmtDateTime(n.createdAt) },
            { key: 'to', header: 'To', cell: (n) => <span className="font-mono text-xs">{n.to}</span> },
            { key: 'tpl', header: 'Message', cell: (n) => TEMPLATE_LABEL[n.templateKey] },
            {
              key: 'status',
              header: 'Status',
              cell: (n) => (
                <Badge
                  tone={n.status === 'sent' ? 'success' : n.status === 'failed' ? 'danger' : 'neutral'}
                  title={n.error ?? undefined}
                >
                  {n.status}
                  {n.attempts > 1 ? ` (${n.attempts} tries)` : ''}
                </Badge>
              ),
            },
            { key: 'err', header: 'Reason', cell: (n) => n.error ?? '', hideOnMobile: true },
          ]}
        />
      )}
    </div>
  );
}
