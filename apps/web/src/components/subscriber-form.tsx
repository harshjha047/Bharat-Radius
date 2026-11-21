'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { ResellerPicker, type ResellerRef } from '@/components/reseller-picker';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Field } from '@/components/ui/misc';
import { ApiError } from '@/lib/api';
import { CONNECTION_LABEL, CONNECTION_TYPES, type ConnectionType } from '@/lib/connection';
import { useCan } from '@/lib/auth';
import { applyServerErrors, endOfDayIst, istDateInput } from '@/lib/forms';
import { usePlans, type Subscriber } from '@/lib/queries';

const opt = z.string().trim();
const CONNECTION_UI: Record<
  ConnectionType,
  {
    user: string;
    userHint: string;
    pw: string;
    pwHint: string;
    ipHint: string;
    macLabel: string;
    macHint: string;
  }
> = {
  pppoe: {
    user: 'PPPoE username',
    userHint: 'What the customer’s router dials with.',
    pw: 'PPPoE password',
    pwHint: 'Leave empty to generate one.',
    ipHint: 'Optional. Unique in your ISP.',
    macLabel: 'Lock to MAC',
    macHint: 'Optional. Logins from other devices are refused.',
  },
  hotspot: {
    user: 'Hotspot username',
    userHint: 'What the customer types on the Hotspot login page.',
    pw: 'Hotspot password',
    pwHint: 'Leave empty to generate one.',
    ipHint: 'Optional. Needs an address pool on the Hotspot server profile.',
    macLabel: 'Lock to MAC',
    macHint: 'Optional. Logins from other devices are refused.',
  },
  static: {
    user: 'Account ID',
    userHint: 'Shown in reports and used for the customer portal; the router logs in by MAC.',
    pw: 'Portal password',
    pwHint: 'Only for the customer portal. Leave empty to generate one.',
    ipHint: 'Required. Given to the customer router by DHCP. Unique in your ISP.',
    macLabel: 'Customer router MAC',
    macHint: 'Required. The DHCP server sends it to RADIUS; unique in your ISP.',
  },
};
const schema = z
  .object({
    connectionType: z.enum(['pppoe', 'hotspot', 'static']),
    username: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._@-]{3,64}$/, '3–64 letters, digits, . _ @ -'),
    pppoePassword: z.string().regex(/^([\x21-\x7e]{4,64})?$/, '4–64 characters, no spaces'),
    name: z.string().trim().min(1, 'Required').max(120),
    phone: z
      .string()
      .trim()
      .regex(/^(\+?[0-9][0-9\s-]{7,16})$/, 'Enter a phone number'),
    altPhone: opt,
    email: z.union([z.literal(''), z.email('Enter a valid email')]),
    line1: z.string().trim().min(1, 'Required').max(200),
    line2: opt,
    city: z.string().trim().min(1, 'Required').max(80),
    district: opt,
    state: z.string().trim().min(1, 'Required').max(80),
    pincode: z.string().regex(/^\d{6}$/, '6 digits'),
    gstin: z.union([z.literal(''), z.string().regex(/^\d{2}[0-9A-Z]{13}$/, '15-character GSTIN')]),
    billingType: z.enum(['prepaid', 'postpaid']),
    planId: opt,
    expiresAt: opt,
    staticIp: opt,
    macLock: opt,
    simUse: opt,
    popName: opt,
    tags: opt,
    notes: z.string().max(2000),
  })
  .superRefine((v, c) => {
    if (v.connectionType !== 'static') return;
    if (!v.macLock) c.addIssue({ code: 'custom', path: ['macLock'], message: 'Required for Static IP' });
    if (!v.staticIp) c.addIssue({ code: 'custom', path: ['staticIp'], message: 'Required for Static IP' });
  });
export type SubscriberFormValues = z.infer<typeof schema>;

const addr = (s?: Subscriber) => (s?.address ?? {}) as Record<string, string | undefined>;

function defaults(s?: Subscriber): SubscriberFormValues {
  const a = addr(s);
  return {
    connectionType: s?.connectionType ?? 'pppoe',
    username: s?.username ?? '',
    pppoePassword: '',
    name: s?.name ?? '',
    phone: s?.phone ?? '',
    altPhone: s?.altPhone ?? '',
    email: s?.email ?? '',
    line1: a.line1 ?? '',
    line2: a.line2 ?? '',
    city: a.city ?? '',
    district: a.district ?? '',
    state: a.state ?? '',
    pincode: a.pincode ?? '',
    gstin: s?.gstin ?? '',
    billingType: s?.billingType ?? 'prepaid',
    planId: s?.planId ?? '',
    expiresAt: istDateInput(s?.expiresAt),
    staticIp: s?.network.staticIp ?? '',
    macLock: s?.network.macLock ?? '',
    simUse: s?.network.simUse ? String(s.network.simUse) : '',
    popName: s?.network.popName ?? '',
    tags: s?.tags.join(', ') ?? '',
    notes: s?.notes ?? '',
  };
}

const ADDRESS = ['line1', 'line2', 'city', 'district', 'state', 'pincode'] as const;
const NETWORK = ['staticIp', 'macLock', 'simUse', 'popName'] as const;
const KNOWN = [
  'connectionType',
  'username',
  'pppoePassword',
  'name',
  'phone',
  'altPhone',
  'email',
  'address',
  'gstin',
  'billingType',
  'planId',
  'expiresAt',
  'network',
  'tags',
  'notes',
  'resellerId',
];

/**
 * `resellerId` for the request body: on create the chosen owner (or nothing); on edit only after the user changed the
 * picker away from the owner the form opened with, so a refetch or untouched field never moves a customer.
 */
export function resellerPatch(
  editing: boolean,
  original: ResellerRef | null | undefined,
  current: ResellerRef | null,
  touched: boolean,
): { resellerId?: string | null } {
  if (!editing) return current ? { resellerId: current.id } : {};
  if (!touched || (current?.id ?? null) === (original?.id ?? null)) return {};
  return { resellerId: current?.id ?? null };
}

/** API body: on create everything filled in; on edit only what changed (nullable fields cleared with null). */
export function toBody(
  v: SubscriberFormValues,
  dirty: Partial<Record<keyof SubscriberFormValues, unknown>> | null,
) {
  const changed = (k: keyof SubscriberFormValues) => dirty === null || !!dirty[k];
  const nul = (s: string) => (s === '' ? (dirty === null ? undefined : null) : s);
  const b: Record<string, unknown> = {};
  if (dirty === null) b.username = v.username;
  if (changed('connectionType')) b.connectionType = v.connectionType;
  if (v.pppoePassword && changed('pppoePassword')) b.pppoePassword = v.pppoePassword;
  if (changed('name')) b.name = v.name;
  if (changed('phone')) b.phone = v.phone;
  if (changed('altPhone')) b.altPhone = nul(v.altPhone);
  if (changed('email')) b.email = nul(v.email);
  if (ADDRESS.some(changed)) {
    b.address = Object.fromEntries(
      ADDRESS.map((k) => [k, v[k] || undefined]).filter(([, x]) => x !== undefined),
    );
  }
  if (changed('gstin')) b.gstin = nul(v.gstin);
  if (changed('billingType')) b.billingType = v.billingType;
  if (changed('planId')) b.planId = nul(v.planId);
  if (changed('expiresAt'))
    b.expiresAt = v.expiresAt ? endOfDayIst(v.expiresAt) : dirty === null ? undefined : null;
  if (NETWORK.some(changed)) {
    const n: Record<string, unknown> = {};
    for (const k of NETWORK) {
      if (!changed(k)) continue;
      const x = k === 'simUse' ? (v.simUse ? Number(v.simUse) : '') : v[k];
      n[k] = x === '' ? (dirty === null ? undefined : null) : x;
    }
    b.network = n;
  }
  if (changed('tags'))
    b.tags = v.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  if (changed('notes')) b.notes = v.notes ? v.notes : dirty === null ? undefined : null;
  return JSON.parse(JSON.stringify(b)) as Record<string, unknown>;
}

export function SubscriberForm({
  subscriber,
  initialReseller,
  submitting,
  onSubmit,
  onCancel,
}: {
  subscriber?: Subscriber;
  /** Pre-selected owner when adding a customer from a reseller's page. */
  initialReseller?: ResellerRef | null;
  submitting: boolean;
  onSubmit: (body: Record<string, unknown>) => Promise<unknown>;
  onCancel: () => void;
}) {
  const editing = !!subscriber;
  const can = useCan();
  const { plans } = usePlans();
  const [original] = useState<ResellerRef | null>(() => subscriber?.reseller ?? null);
  const [reseller, setReseller] = useState<ResellerRef | null>(original ?? initialReseller ?? null);
  const [resellerTouched, setResellerTouched] = useState(false);
  const [resellerError, setResellerError] = useState<string>();
  const willBecomeDirect = editing && resellerTouched && !!original && !reseller;
  const form = useForm<SubscriberFormValues>({
    resolver: zodResolver(schema),
    defaultValues: defaults(subscriber),
  });
  const {
    register,
    handleSubmit,
    setError,
    control,
    formState: { errors, dirtyFields, isDirty },
  } = form;
  const ui = CONNECTION_UI[useWatch({ control, name: 'connectionType' })];
  const err = (k: keyof SubscriberFormValues) => errors[k]?.message;
  const serverPath = (p: string) => {
    const [head, tail] = p.split('.');
    return head === 'address' || head === 'network' ? (tail ?? head) : head!;
  };

  const submit = handleSubmit(async (v) => {
    try {
      const body = toBody(v, editing ? (dirtyFields as Record<string, unknown>) : null);
      Object.assign(body, resellerPatch(editing, original, reseller, resellerTouched));
      await onSubmit(body);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const field = /username/i.test(e.message)
          ? 'username'
          : /static IP/i.test(e.message)
            ? 'staticIp'
            : /MAC/.test(e.message)
              ? 'macLock'
              : null;
        if (field) return setError(field, { type: 'server', message: e.message });
      }
      if (e instanceof ApiError && /reseller|suspended/i.test(e.message) && e.status !== 400) {
        return setResellerError(e.message);
      }
      applyServerErrors(
        (path, opt) =>
          path === 'resellerId'
            ? setResellerError(opt.message)
            : setError(serverPath(path) as keyof SubscriberFormValues, opt),
        e,
        KNOWN,
      );
    }
  });

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      <Card>
        <CardHeader>
          <CardTitle>Connection</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Connection type"
            htmlFor="connectionType"
            error={err('connectionType')}
            hint={
              editing
                ? 'Changing it disconnects the customer; set up the router side first.'
                : 'PPPoE dialer, Hotspot login page, or Static IP by MAC (DHCP).'
            }
            className="sm:col-span-2"
          >
            <Select id="connectionType" {...register('connectionType')}>
              {CONNECTION_TYPES.map((k) => (
                <option key={k} value={k}>
                  {CONNECTION_LABEL[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={ui.user}
            htmlFor="username"
            error={err('username')}
            hint={editing ? 'Cannot be changed. Delete and recreate to rename.' : ui.userHint}
          >
            <Input
              id="username"
              autoCapitalize="none"
              spellCheck={false}
              disabled={editing}
              {...register('username')}
            />
          </Field>
          <Field
            label={editing ? `New ${ui.pw.toLowerCase()}` : ui.pw}
            htmlFor="pppoePassword"
            error={err('pppoePassword')}
            hint={editing ? 'Leave empty to keep the current one.' : ui.pwHint}
          >
            <Input
              id="pppoePassword"
              autoComplete="new-password"
              spellCheck={false}
              {...register('pppoePassword')}
            />
          </Field>
          {can('resellers.read') ? (
            <Field
              label="Reseller"
              htmlFor="resellerId"
              error={resellerError}
              hint={willBecomeDirect ? undefined : "Empty = your ISP's own customer."}
              className="sm:col-span-2"
            >
              <ResellerPicker
                id="resellerId"
                value={reseller}
                onChange={(r) => {
                  setReseller(r);
                  setResellerTouched(true);
                  setResellerError(undefined);
                }}
                noneLabel="Direct customer"
                invalid={!!resellerError}
              />
              {willBecomeDirect ? (
                <p role="alert" className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-destructive">
                  Saving now moves this customer off {original!.name} and makes it a direct ISP customer.
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setReseller(original);
                      setResellerTouched(false);
                    }}
                  >
                    Keep {original!.name}
                  </Button>
                </p>
              ) : null}
            </Field>
          ) : null}
          <Field label="Plan" htmlFor="planId" error={err('planId')}>
            <Select id="planId" {...register('planId')}>
              <option value="">No plan</option>
              {plans
                .filter((p) => p.status === 'active' || p.id === subscriber?.planId)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Billing" htmlFor="billingType" error={err('billingType')}>
            <Select id="billingType" {...register('billingType')}>
              <option value="prepaid">Prepaid</option>
              <option value="postpaid">Postpaid</option>
            </Select>
          </Field>
          <Field
            label="Valid until"
            htmlFor="expiresAt"
            error={err('expiresAt')}
            hint="End of this day (IST). After it the customer gets the pay page."
          >
            <Input id="expiresAt" type="date" {...register('expiresAt')} />
          </Field>
          <Field label="POP" htmlFor="popName" error={err('popName')}>
            <Input id="popName" {...register('popName')} />
          </Field>
          <Field label="Static IP" htmlFor="staticIp" error={err('staticIp')} hint={ui.ipHint}>
            <Input
              id="staticIp"
              inputMode="decimal"
              placeholder="e.g. 100.64.1.10"
              {...register('staticIp')}
            />
          </Field>
          <Field label={ui.macLabel} htmlFor="macLock" error={err('macLock')} hint={ui.macHint}>
            <Input
              id="macLock"
              placeholder="e.g. AA:BB:CC:DD:EE:FF"
              spellCheck={false}
              {...register('macLock')}
            />
          </Field>
          <Field
            label="Simultaneous logins"
            htmlFor="simUse"
            error={err('simUse')}
            hint="Empty = plan default."
          >
            <Input id="simUse" type="number" min={1} max={10} {...register('simUse')} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Customer</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="name" error={err('name')} className="sm:col-span-2">
            <Input id="name" autoComplete="off" {...register('name')} />
          </Field>
          <Field label="Mobile" htmlFor="phone" error={err('phone')}>
            <Input
              id="phone"
              type="tel"
              inputMode="tel"
              placeholder="e.g. 98765 43210"
              {...register('phone')}
            />
          </Field>
          <Field label="Other phone" htmlFor="altPhone" error={err('altPhone')}>
            <Input id="altPhone" type="tel" inputMode="tel" {...register('altPhone')} />
          </Field>
          <Field label="Email" htmlFor="email" error={err('email')}>
            <Input id="email" type="email" {...register('email')} />
          </Field>
          <Field label="GSTIN" htmlFor="gstin" error={err('gstin')} hint="Business customers only.">
            <Input id="gstin" autoCapitalize="characters" {...register('gstin')} />
          </Field>
          <Field label="Address" htmlFor="line1" error={err('line1')} className="sm:col-span-2">
            <Input id="line1" {...register('line1')} />
          </Field>
          <Field label="Address line 2" htmlFor="line2" error={err('line2')} className="sm:col-span-2">
            <Input id="line2" {...register('line2')} />
          </Field>
          <Field label="City" htmlFor="city" error={err('city')}>
            <Input id="city" {...register('city')} />
          </Field>
          <Field label="District" htmlFor="district" error={err('district')}>
            <Input id="district" {...register('district')} />
          </Field>
          <Field label="State" htmlFor="state" error={err('state')}>
            <Input id="state" {...register('state')} />
          </Field>
          <Field label="PIN code" htmlFor="pincode" error={err('pincode')}>
            <Input id="pincode" inputMode="numeric" maxLength={6} {...register('pincode')} />
          </Field>
          <Field label="Tags" htmlFor="tags" error={err('tags')} hint="Comma-separated.">
            <Input id="tags" {...register('tags')} />
          </Field>
          <Field label="Notes" htmlFor="notes" error={err('notes')} className="sm:col-span-2">
            <Textarea id="notes" rows={3} {...register('notes')} />
          </Field>
        </CardContent>
      </Card>

      <div className="sticky bottom-0 -mx-3 flex justify-end gap-2 border-t bg-background/95 px-3 py-3 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          loading={submitting}
          disabled={
            editing && !isDirty && !('resellerId' in resellerPatch(true, original, reseller, resellerTouched))
          }
        >
          {editing ? 'Save changes' : 'Create subscriber'}
        </Button>
      </div>
    </form>
  );
}
