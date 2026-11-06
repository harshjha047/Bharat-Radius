'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { dialogActions } from '@/components/ui/dialog';
import { Checkbox, Input } from '@/components/ui/input';
import { Field } from '@/components/ui/misc';
import { applyServerErrors, changedOnly } from '@/lib/forms';
import type { Reseller } from '@/lib/queries';

const optional = (re: RegExp, msg: string) => z.union([z.literal(''), z.string().trim().regex(re, msg)]);
const schema = z.object({
  name: z.string().trim().min(1, 'Required').max(120),
  ownerName: z.string().trim().min(1, 'Required').max(120),
  phone: optional(/^(\+?[0-9][0-9\s-]{7,16})$/, 'Enter a phone number'),
  email: z.union([z.literal(''), z.email('Enter an email address')]),
  gstin: optional(/^\d{2}[0-9A-Z]{13}$/, '15-character GSTIN'),
  line1: z.string().trim().max(200),
  city: z.string().trim().max(80),
  state: z.string().trim().max(80),
  pincode: optional(/^\d{6}$/, '6-digit PIN code'),
  creditLimit: z.string().regex(/^\d{0,8}(\.\d{1,2})?$/, 'Rupees, e.g. 5000'),
  canCreateSubResellers: z.boolean(),
});
type Values = z.infer<typeof schema>;

const defaults = (r?: Reseller): Values => ({
  name: r?.name ?? '',
  ownerName: r?.ownerName ?? '',
  phone: r?.phone ?? '',
  email: r?.email ?? '',
  gstin: r?.gstin ?? '',
  line1: r?.address?.line1 ?? '',
  city: r?.address?.city ?? '',
  state: r?.address?.state ?? '',
  pincode: r?.address?.pincode ?? '',
  creditLimit: r ? String(r.creditLimitPaise / 100) : '0',
  canCreateSubResellers: r?.canCreateSubResellers ?? true,
});

function toBody(v: Values, editing: boolean): Record<string, unknown> {
  const blank = editing ? null : undefined;
  const address = Object.fromEntries(
    Object.entries({ line1: v.line1, city: v.city, state: v.state, pincode: v.pincode }).filter(([, x]) => x),
  );
  return JSON.parse(
    JSON.stringify({
      name: v.name,
      ownerName: v.ownerName,
      phone: v.phone || blank,
      email: v.email || blank,
      gstin: v.gstin || blank,
      address: Object.keys(address).length ? address : blank,
      creditLimitPaise: Math.round(Number(v.creditLimit || 0) * 100),
      canCreateSubResellers: v.canCreateSubResellers,
    }),
  ) as Record<string, unknown>;
}

const FIELD: Record<string, keyof Values> = { creditLimitPaise: 'creditLimit' };

export function ResellerForm({
  reseller,
  parentLabel,
  staff,
  submitting,
  onSubmit,
  onCancel,
}: {
  reseller?: Reseller;
  /** Shown when adding under a reseller. */
  parentLabel?: string;
  /** Credit limits are set by ISP staff only. */
  staff: boolean;
  submitting: boolean;
  onSubmit: (body: Record<string, unknown>) => Promise<unknown>;
  onCancel: () => void;
}) {
  const editing = !!reseller;
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: defaults(reseller) });
  const err = (k: keyof Values) => errors[k]?.message;
  const submit = handleSubmit(async (v) => {
    const body = editing ? changedOnly(toBody(v, true), toBody(defaults(reseller), true)) : toBody(v, false);
    if (!staff) delete body.creditLimitPaise;
    if (editing && !Object.keys(body).length) return onCancel();
    try {
      await onSubmit(body);
    } catch (e) {
      applyServerErrors((p, o) => {
        const [head, tail] = p.split('.');
        setError((head === 'address' ? tail : (FIELD[head!] ?? head)) as keyof Values, o);
      }, e);
    }
  });
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {parentLabel ? <p className="text-sm text-muted-foreground">Under {parentLabel}</p> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Business name" htmlFor="r-name" error={err('name')}>
          <Input id="r-name" {...register('name')} />
        </Field>
        <Field label="Owner" htmlFor="r-owner" error={err('ownerName')}>
          <Input id="r-owner" {...register('ownerName')} />
        </Field>
        <Field label="Mobile" htmlFor="r-phone" error={err('phone')}>
          <Input id="r-phone" inputMode="tel" {...register('phone')} />
        </Field>
        <Field label="Email" htmlFor="r-email" error={err('email')}>
          <Input id="r-email" type="email" {...register('email')} />
        </Field>
        <Field label="GSTIN" htmlFor="r-gstin" error={err('gstin')} hint="If GST-registered.">
          <Input id="r-gstin" className="uppercase" maxLength={15} {...register('gstin')} />
        </Field>
        {staff ? (
          <Field
            label="Credit limit (₹)"
            htmlFor="r-credit"
            error={err('creditLimit')}
            hint="0 = the wallet can never go below zero."
          >
            <Input id="r-credit" inputMode="decimal" {...register('creditLimit')} />
          </Field>
        ) : null}
        <Field label="Address" htmlFor="r-line1" error={err('line1')} className="sm:col-span-2">
          <Input id="r-line1" {...register('line1')} />
        </Field>
        <Field label="City" htmlFor="r-city" error={err('city')}>
          <Input id="r-city" {...register('city')} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="State" htmlFor="r-state" error={err('state')}>
            <Input id="r-state" {...register('state')} />
          </Field>
          <Field label="PIN code" htmlFor="r-pin" error={err('pincode')}>
            <Input id="r-pin" inputMode="numeric" maxLength={6} {...register('pincode')} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <Checkbox {...register('canCreateSubResellers')} /> May add its own sub-resellers
        </label>
      </div>
      <div className={dialogActions}>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={submitting}>
          {editing ? 'Save reseller' : 'Add reseller'}
        </Button>
      </div>
    </form>
  );
}
