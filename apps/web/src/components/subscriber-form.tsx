'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Field } from '@/components/ui/misc';
import { ApiError } from '@/lib/api';
import { applyServerErrors, endOfDayIst, istDateInput } from '@/lib/forms';
import { usePlans, type Subscriber } from '@/lib/queries';

const opt = z.string().trim();
const schema = z.object({
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
});
export type SubscriberFormValues = z.infer<typeof schema>;

const addr = (s?: Subscriber) => (s?.address ?? {}) as Record<string, string | undefined>;

function defaults(s?: Subscriber): SubscriberFormValues {
  const a = addr(s);
  return {
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
];

/** API body: on create everything filled in; on edit only what changed (nullable fields cleared with null). */
export function toBody(
  v: SubscriberFormValues,
  dirty: Partial<Record<keyof SubscriberFormValues, unknown>> | null,
) {
  const changed = (k: keyof SubscriberFormValues) => dirty === null || !!dirty[k];
  const nul = (s: string) => (s === '' ? (dirty === null ? undefined : null) : s);
  const b: Record<string, unknown> = {};
  if (dirty === null) b.username = v.username;
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
  submitting,
  onSubmit,
  onCancel,
}: {
  subscriber?: Subscriber;
  submitting: boolean;
  onSubmit: (body: Record<string, unknown>) => Promise<unknown>;
  onCancel: () => void;
}) {
  const editing = !!subscriber;
  const { plans } = usePlans();
  const form = useForm<SubscriberFormValues>({
    resolver: zodResolver(schema),
    defaultValues: defaults(subscriber),
  });
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, dirtyFields, isDirty },
  } = form;
  const err = (k: keyof SubscriberFormValues) => errors[k]?.message;
  const serverPath = (p: string) => {
    const [head, tail] = p.split('.');
    return head === 'address' || head === 'network' ? (tail ?? head) : head!;
  };

  const submit = handleSubmit(async (v) => {
    try {
      await onSubmit(toBody(v, editing ? (dirtyFields as Record<string, unknown>) : null));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const field = /username/i.test(e.message)
          ? 'username'
          : /static IP/i.test(e.message)
            ? 'staticIp'
            : null;
        if (field) return setError(field, { type: 'server', message: e.message });
      }
      applyServerErrors(
        (path, opt) => setError(serverPath(path) as keyof SubscriberFormValues, opt),
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
            label="PPPoE username"
            htmlFor="username"
            error={err('username')}
            hint={
              editing
                ? 'Cannot be changed. Delete and recreate to rename.'
                : 'What the customer’s router dials with.'
            }
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
            label={editing ? 'New PPPoE password' : 'PPPoE password'}
            htmlFor="pppoePassword"
            error={err('pppoePassword')}
            hint={editing ? 'Leave empty to keep the current one.' : 'Leave empty to generate one.'}
          >
            <Input
              id="pppoePassword"
              autoComplete="new-password"
              spellCheck={false}
              {...register('pppoePassword')}
            />
          </Field>
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
          <Field
            label="Static IP"
            htmlFor="staticIp"
            error={err('staticIp')}
            hint="Optional. Unique in your ISP."
          >
            <Input
              id="staticIp"
              inputMode="decimal"
              placeholder="e.g. 100.64.1.10"
              {...register('staticIp')}
            />
          </Field>
          <Field
            label="Lock to MAC"
            htmlFor="macLock"
            error={err('macLock')}
            hint="Optional. Logins from other devices are refused."
          >
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
        <Button type="submit" loading={submitting} disabled={editing && !isDirty}>
          {editing ? 'Save changes' : 'Create subscriber'}
        </Button>
      </div>
    </form>
  );
}
