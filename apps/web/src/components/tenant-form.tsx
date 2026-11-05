'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { dialogActions } from '@/components/ui/dialog';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/misc';
import { type ApiData } from '@/lib/api';
import { applyServerErrors, changedOnly } from '@/lib/forms';

export type Tenant = ApiData<'/api/v1/tenant'>;

const opt = z.string().trim();
const schema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/, 'Lower-case letters, digits, -'),
  name: z.string().trim().min(1, 'Required').max(120),
  legalName: z.string().trim().min(1, 'Required').max(200),
  gstin: z.union([z.literal(''), z.string().regex(/^\d{2}[0-9A-Z]{13}$/, '15-character GSTIN')]),
  stateCode: z.string().regex(/^\d{2}$/, '2-digit GST state code'),
  line1: z.string().trim().min(1, 'Required').max(200),
  line2: opt,
  city: z.string().trim().min(1, 'Required').max(80),
  state: z.string().trim().min(1, 'Required').max(80),
  pincode: z.string().regex(/^\d{6}$/, '6 digits'),
  phone: opt,
  email: z.union([z.literal(''), z.email('Enter a valid email')]),
  domain: z.union([
    z.literal(''),
    z.string().regex(/^([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/, 'e.g. panel.example.in'),
  ]),
  expiredRate: z.string().regex(/^\d+[kM]?\/\d+[kM]?$/, 'upload/download, e.g. 256k/256k'),
  expiredAddressList: z.string().regex(/^[\w-]{1,32}$/, 'Letters, digits, _ -'),
  expiredSessionSecs: z.string().regex(/^\d+$/, 'Seconds'),
  interimInterval: z.string().regex(/^\d+$/, 'Seconds'),
});
type Values = z.infer<typeof schema>;

const defaults = (t?: Tenant): Values => ({
  slug: t?.slug ?? '',
  name: t?.name ?? '',
  legalName: t?.legalName ?? '',
  gstin: t?.gstin ?? '',
  stateCode: t?.stateCode ?? '',
  line1: t?.address.line1 ?? '',
  line2: t?.address.line2 ?? '',
  city: t?.address.city ?? '',
  state: t?.address.state ?? '',
  pincode: t?.address.pincode ?? '',
  phone: t?.contact.phone ?? '',
  email: t?.contact.email ?? '',
  domain: t?.domain ?? '',
  expiredRate: t?.radius.expiredRate ?? '256k/256k',
  expiredAddressList: t?.radius.expiredAddressList ?? 'expired',
  expiredSessionSecs: String(t?.radius.expiredSessionSecs ?? 3600),
  interimInterval: String(t?.radius.interimInterval ?? 300),
});

/**
 * Own ISP (staff): no slug/domain. Platform (super-admin): slug on create, domain editable.
 * `platform` decides which fields exist in the body.
 */
function toBody(v: Values, mode: 'own' | 'create' | 'platform') {
  const edit = mode !== 'create';
  return JSON.parse(
    JSON.stringify({
      ...(mode === 'create' ? { slug: v.slug } : {}),
      name: v.name,
      legalName: v.legalName,
      gstin: v.gstin || (edit ? null : undefined),
      stateCode: v.stateCode,
      address: {
        line1: v.line1,
        ...(v.line2 ? { line2: v.line2 } : {}),
        city: v.city,
        state: v.state,
        pincode: v.pincode,
      },
      contact: { ...(v.phone ? { phone: v.phone } : {}), ...(v.email ? { email: v.email } : {}) },
      ...(mode !== 'own' ? { domain: v.domain || (edit ? null : undefined) } : {}),
      radius: {
        expiredRate: v.expiredRate,
        expiredAddressList: v.expiredAddressList,
        expiredSessionSecs: Number(v.expiredSessionSecs),
        interimInterval: Number(v.interimInterval),
      },
    }),
  ) as Record<string, unknown>;
}

const FIELD: Record<string, keyof Values> = { address: 'line1', contact: 'email', radius: 'expiredRate' };

export function TenantForm({
  tenant,
  mode,
  submitting,
  onSubmit,
  onCancel,
}: {
  tenant?: Tenant;
  mode: 'own' | 'create' | 'platform';
  submitting: boolean;
  onSubmit: (b: Record<string, unknown>) => Promise<unknown>;
  onCancel?: () => void;
}) {
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isDirty },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: defaults(tenant) });
  const err = (k: keyof Values) => errors[k]?.message;
  const submit = handleSubmit(async (v) => {
    const b =
      mode === 'create' ? toBody(v, mode) : changedOnly(toBody(v, mode), toBody(defaults(tenant), mode));
    if (mode !== 'create' && !Object.keys(b).length) return;
    try {
      await onSubmit(b);
      if (mode !== 'create') reset(v);
    } catch (e) {
      applyServerErrors((p, o) => {
        const [head, tail] = p.split('.');
        const k = (tail && (tail in defaults() ? tail : undefined)) ?? FIELD[head!] ?? head;
        setError(k as keyof Values, o);
      }, e);
    }
  });

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      <Card>
        <CardHeader>
          <CardTitle>Business</CardTitle>
          <CardDescription>Printed on invoices from Step 3.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {mode === 'create' ? (
            <Field
              label="Organisation ID"
              htmlFor="t-slug"
              error={err('slug')}
              hint="Used to sign in; cannot change later."
            >
              <Input id="t-slug" autoCapitalize="none" {...register('slug')} />
            </Field>
          ) : null}
          <Field label="Display name" htmlFor="t-name" error={err('name')}>
            <Input id="t-name" {...register('name')} />
          </Field>
          <Field label="Legal name" htmlFor="t-legal" error={err('legalName')}>
            <Input id="t-legal" {...register('legalName')} />
          </Field>
          <Field label="GSTIN" htmlFor="t-gstin" error={err('gstin')}>
            <Input id="t-gstin" autoCapitalize="characters" {...register('gstin')} />
          </Field>
          <Field
            label="GST state code"
            htmlFor="t-sc"
            error={err('stateCode')}
            hint="e.g. 09 for Uttar Pradesh."
          >
            <Input id="t-sc" inputMode="numeric" maxLength={2} {...register('stateCode')} />
          </Field>
          <Field label="Address" htmlFor="t-l1" error={err('line1')} className="sm:col-span-2">
            <Input id="t-l1" {...register('line1')} />
          </Field>
          <Field label="Address line 2" htmlFor="t-l2" error={err('line2')} className="sm:col-span-2">
            <Input id="t-l2" {...register('line2')} />
          </Field>
          <Field label="City" htmlFor="t-city" error={err('city')}>
            <Input id="t-city" {...register('city')} />
          </Field>
          <Field label="State" htmlFor="t-state" error={err('state')}>
            <Input id="t-state" {...register('state')} />
          </Field>
          <Field label="PIN code" htmlFor="t-pin" error={err('pincode')}>
            <Input id="t-pin" inputMode="numeric" maxLength={6} {...register('pincode')} />
          </Field>
          <Field label="Support phone" htmlFor="t-phone" error={err('phone')}>
            <Input id="t-phone" type="tel" {...register('phone')} />
          </Field>
          <Field label="Support email" htmlFor="t-email" error={err('email')}>
            <Input id="t-email" type="email" {...register('email')} />
          </Field>
          {mode !== 'own' ? (
            <Field
              label="Panel domain"
              htmlFor="t-domain"
              error={err('domain')}
              hint="Staff sign in here without the organisation ID."
            >
              <Input id="t-domain" autoCapitalize="none" {...register('domain')} />
            </Field>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Expired customers</CardTitle>
          <CardDescription>What RADIUS gives a customer whose validity has run out.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Speed (upload/download)" htmlFor="t-rate" error={err('expiredRate')}>
            <Input id="t-rate" {...register('expiredRate')} />
          </Field>
          <Field
            label="MikroTik address list"
            htmlFor="t-list"
            error={err('expiredAddressList')}
            hint="Redirected to the pay page."
          >
            <Input id="t-list" {...register('expiredAddressList')} />
          </Field>
          <Field label="Session length (seconds)" htmlFor="t-sess" error={err('expiredSessionSecs')}>
            <Input id="t-sess" inputMode="numeric" {...register('expiredSessionSecs')} />
          </Field>
          <Field label="Accounting interval (seconds)" htmlFor="t-int" error={err('interimInterval')}>
            <Input id="t-int" inputMode="numeric" {...register('interimInterval')} />
          </Field>
        </CardContent>
      </Card>
      <div className={mode === 'own' ? 'flex justify-end gap-2' : dialogActions}>
        {onCancel ? (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" loading={submitting} disabled={mode !== 'create' && !isDirty}>
          {mode === 'create' ? 'Create ISP' : 'Save settings'}
        </Button>
      </div>
    </form>
  );
}
