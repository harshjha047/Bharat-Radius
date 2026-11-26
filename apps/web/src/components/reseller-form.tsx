'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { dialogActions } from '@/components/ui/dialog';
import { Checkbox, Input, PasswordInput } from '@/components/ui/input';
import { Field } from '@/components/ui/misc';
import { applyServerErrors, changedOnly } from '@/lib/forms';
import { useCan } from '@/lib/auth';
import type { Reseller } from '@/lib/queries';
import { usePincodeAutofill } from '@/lib/pincode';

const optional = (re: RegExp, msg: string) => z.union([z.literal(''), z.string().trim().regex(re, msg)]);
const phoneRe = /^(\+?[0-9][0-9\s-]{7,16})$/;
const base = z.object({
  name: z.string().trim().min(1, 'Required').max(120),
  ownerName: z.string().trim().min(1, 'Required').max(120),
  phone: optional(phoneRe, 'Enter a phone number'),
  email: z.union([z.literal(''), z.email('Enter an email address')]),
  gstin: optional(/^\d{2}[0-9A-Z]{13}$/, '15-character GSTIN'),
  line1: z.string().trim().max(200),
  city: z.string().trim().max(80),
  state: z.string().trim().max(80),
  pincode: optional(/^\d{6}$/, '6-digit PIN code'),
  creditLimit: z.string().regex(/^\d{0,8}(\.\d{1,2})?$/, 'Rupees, e.g. 5000'),
  canCreateSubResellers: z.boolean(),
  createLogin: z.boolean(),
  loginEmail: z.union([z.literal(''), z.email('Enter an email address')]),
  loginPhone: optional(phoneRe, 'Enter a phone number'),
  loginPassword: z.string(),
});
const schema = base.superRefine((v, c) => {
  if (!v.createLogin) return;
  if (!(v.loginEmail || v.email || v.loginPhone || v.phone))
    c.addIssue({ code: 'custom', path: ['loginEmail'], message: 'Give an email or mobile to sign in with' });
  if (v.loginPassword.length < 10)
    c.addIssue({ code: 'custom', path: ['loginPassword'], message: 'At least 10 characters' });
  else if (new Set(v.loginPassword).size < 5)
    c.addIssue({ code: 'custom', path: ['loginPassword'], message: 'Too repetitive' });
});
type Values = z.infer<typeof base>;

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
  createLogin: false,
  loginEmail: '',
  loginPhone: '',
  loginPassword: '',
});

/** 14 characters from an unambiguous alphabet (no 0/O, 1/l/I). */
function newPassword(): string {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  return Array.from(bytes, (b) => abc[b % abc.length]).join('');
}

function ownerLogin(v: Values) {
  const email = v.loginEmail || v.email;
  const phone = v.loginPhone || v.phone;
  return { ...(email ? { email } : {}), ...(phone ? { phone } : {}), password: v.loginPassword };
}

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

const FIELD: Record<string, keyof Values> = {
  creditLimitPaise: 'creditLimit',
  'owner.email': 'loginEmail',
  'owner.phone': 'loginPhone',
  'owner.password': 'loginPassword',
};

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
  const canAddLogin = useCan()('users.write') && !editing;
  const {
    register,
    control,
    getValues,
    setValue,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: defaults(reseller) });
  const err = (k: keyof Values) => errors[k]?.message;
  const pinHint = usePincodeAutofill(control, getValues, setValue, {
    pincode: 'pincode',
    city: 'city',
    state: 'state',
  });
  const createLogin = useWatch({ control, name: 'createLogin' });
  const submit = handleSubmit(async (v) => {
    const body = editing ? changedOnly(toBody(v, true), toBody(defaults(reseller), true)) : toBody(v, false);
    if (!staff) delete body.creditLimitPaise;
    if (canAddLogin && v.createLogin) body.owner = ownerLogin(v);
    if (editing && !Object.keys(body).length) return onCancel();
    try {
      await onSubmit(body);
    } catch (e) {
      applyServerErrors((p, o) => {
        const [head, tail] = p.split('.');
        setError((FIELD[p] ?? (head === 'address' ? tail : (FIELD[head!] ?? head))) as keyof Values, o);
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
        <Field label="PIN code" htmlFor="r-pin" error={err('pincode')} hint={pinHint}>
          <Input id="r-pin" inputMode="numeric" maxLength={6} {...register('pincode')} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="City" htmlFor="r-city" error={err('city')}>
            <Input id="r-city" {...register('city')} />
          </Field>
          <Field label="State" htmlFor="r-state" error={err('state')}>
            <Input id="r-state" {...register('state')} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <Checkbox {...register('canCreateSubResellers')} /> May add its own sub-resellers
        </label>
        {canAddLogin ? (
          <fieldset className="space-y-4 rounded-xl border p-4 sm:col-span-2">
            <label className="flex items-center gap-2 text-sm font-medium">
              <Checkbox {...register('createLogin')} /> Create the owner&apos;s login now
            </label>
            {createLogin ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Login email"
                  htmlFor="r-login-email"
                  error={err('loginEmail')}
                  hint="Empty = the email above."
                >
                  <Input id="r-login-email" type="email" autoComplete="off" {...register('loginEmail')} />
                </Field>
                <Field
                  label="Login mobile"
                  htmlFor="r-login-phone"
                  error={err('loginPhone')}
                  hint="Empty = the mobile above."
                >
                  <Input id="r-login-phone" inputMode="tel" autoComplete="off" {...register('loginPhone')} />
                </Field>
                <Field
                  label="Password"
                  htmlFor="r-login-pw"
                  error={err('loginPassword')}
                  hint="Share it with the owner. They sign in with the email or mobile and this password."
                  className="sm:col-span-2"
                >
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <PasswordInput
                        id="r-login-pw"
                        autoComplete="new-password"
                        {...register('loginPassword')}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() =>
                        setValue('loginPassword', newPassword(), { shouldDirty: true, shouldValidate: true })
                      }
                    >
                      Generate
                    </Button>
                  </div>
                </Field>
                <p className="text-xs text-muted-foreground sm:col-span-2">
                  Gets the Reseller Owner role. It is created together with the reseller, or not at all.
                </p>
              </div>
            ) : null}
          </fieldset>
        ) : null}
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
