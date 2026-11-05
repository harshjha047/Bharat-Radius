'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { dialogActions } from '@/components/ui/dialog';
import { Checkbox, Input, Select, Textarea } from '@/components/ui/input';
import { Field } from '@/components/ui/misc';
import { applyServerErrors, changedOnly } from '@/lib/forms';
import type { Plan } from '@/lib/queries';

const mbps = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,3})?$/, 'Mbps, e.g. 50 or 0.5');
const optMbps = z.union([z.literal(''), mbps]);
const schema = z
  .object({
    name: z.string().trim().min(1, 'Required').max(64),
    description: z.string().max(500),
    down: mbps,
    up: mbps,
    burst: z.boolean(),
    burstDown: optMbps,
    burstUp: optMbps,
    burstThDown: optMbps,
    burstThUp: optMbps,
    burstSecs: z.string().regex(/^(\d{1,4})?$/, 'Seconds'),
    capGb: z.string().regex(/^(\d+(\.\d{1,3})?)?$/, 'GB, e.g. 500'),
    fupDown: optMbps,
    fupUp: optMbps,
    fupCycle: z.enum(['', 'calendar_month', 'billing_cycle']),
    validityDays: z.string().regex(/^\d{1,4}$/, 'Days'),
    ipPool: z.string().regex(/^([\w.-]{1,64})?$/, 'Letters, digits, . _ -'),
    simUse: z.string().regex(/^([1-9]|10)$/, '1–10'),
    prepaid: z.boolean(),
    postpaid: z.boolean(),
    price: z.string().regex(/^\d+(\.\d{1,2})?$/, 'Rupees, e.g. 499'),
    gst: z.enum(['0', '5', '12', '18', '28']),
    hsnSac: z.string().regex(/^\d{4,8}$/, '4–8 digits'),
    extra: z.string(),
  })
  .refine((v) => !v.burst || (v.burstDown && v.burstUp && v.burstThDown && v.burstThUp && v.burstSecs), {
    path: ['burst'],
    message: 'Fill in all burst fields or turn burst off',
  })
  .refine((v) => !v.capGb || (v.fupDown && v.fupUp), {
    path: ['fupDown'],
    message: 'A data cap needs an FUP speed',
  })
  .refine((v) => v.prepaid || v.postpaid, { path: ['prepaid'], message: 'Pick at least one' });
type Values = z.infer<typeof schema>;

const toMbps = (kbps: number | undefined) => (kbps == null ? '' : String(kbps / 1000));
const toKbps = (s: string) => Math.round(Number(s) * 1000);

function defaults(p?: Plan): Values {
  return {
    name: p?.name ?? '',
    description: p?.description ?? '',
    down: toMbps(p?.downloadKbps),
    up: toMbps(p?.uploadKbps),
    burst: !!p?.burst,
    burstDown: toMbps(p?.burst?.downloadKbps),
    burstUp: toMbps(p?.burst?.uploadKbps),
    burstThDown: toMbps(p?.burst?.thresholdDownloadKbps),
    burstThUp: toMbps(p?.burst?.thresholdUploadKbps),
    burstSecs: p?.burst ? String(p.burst.timeSecs) : '',
    capGb: p?.dataCapBytes ? String(p.dataCapBytes / 1e9) : '',
    fupDown: toMbps(p?.fup?.downloadKbps),
    fupUp: toMbps(p?.fup?.uploadKbps),
    fupCycle: p?.fupCycle ?? '',
    validityDays: String(p?.validityDays ?? 30),
    ipPool: p?.ipPool ?? '',
    simUse: String(p?.simUse ?? 1),
    prepaid: p ? p.billingTypes.includes('prepaid') : true,
    postpaid: p ? p.billingTypes.includes('postpaid') : false,
    price: p ? String(p.pricePaise / 100) : '',
    gst: String(p?.gstRatePercent ?? 18) as Values['gst'],
    hsnSac: p?.hsnSac ?? '998422',
    extra: (p?.extraAttributes ?? []).map((a) => `${a.attribute} ${a.op} ${a.value}`).join('\n'),
  };
}

const EXTRA = /^([A-Za-z][A-Za-z0-9-]{1,63})\s*(:=|\+=|=)\s*(.+)$/;

function toBody(v: Values, editing: boolean): Record<string, unknown> {
  const nul = editing ? null : undefined;
  return JSON.parse(
    JSON.stringify({
      name: v.name,
      description: v.description.trim() || nul,
      downloadKbps: toKbps(v.down),
      uploadKbps: toKbps(v.up),
      burst: v.burst
        ? {
            downloadKbps: toKbps(v.burstDown),
            uploadKbps: toKbps(v.burstUp),
            thresholdDownloadKbps: toKbps(v.burstThDown),
            thresholdUploadKbps: toKbps(v.burstThUp),
            timeSecs: Number(v.burstSecs),
          }
        : nul,
      dataCapBytes: v.capGb ? Math.round(Number(v.capGb) * 1e9) : nul,
      fup: v.fupDown && v.fupUp ? { downloadKbps: toKbps(v.fupDown), uploadKbps: toKbps(v.fupUp) } : nul,
      fupCycle: v.fupCycle || nul,
      validityDays: Number(v.validityDays),
      ipPool: v.ipPool || nul,
      simUse: Number(v.simUse),
      billingTypes: [...(v.prepaid ? ['prepaid'] : []), ...(v.postpaid ? ['postpaid'] : [])],
      pricePaise: Math.round(Number(v.price) * 100),
      gstRatePercent: Number(v.gst),
      hsnSac: v.hsnSac,
      extraAttributes: v.extra
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const m = EXTRA.exec(l);
          return m
            ? { attribute: m[1], op: m[2], value: m[3]!.trim() }
            : { attribute: l, op: ':=', value: '' };
        }),
    }),
    // JSON round-trip drops undefined but keeps null (clears on edit).
  ) as Record<string, unknown>;
}

const SERVER_TO_FIELD: Record<string, keyof Values> = {
  downloadKbps: 'down',
  uploadKbps: 'up',
  burst: 'burst',
  dataCapBytes: 'capGb',
  fup: 'fupDown',
  pricePaise: 'price',
  gstRatePercent: 'gst',
  extraAttributes: 'extra',
  billingTypes: 'prepaid',
};

export function PlanForm({
  plan,
  submitting,
  onSubmit,
  onCancel,
}: {
  plan?: Plan;
  submitting: boolean;
  onSubmit: (body: Record<string, unknown>) => Promise<unknown>;
  onCancel: () => void;
}) {
  const editing = !!plan;
  const {
    register,
    handleSubmit,
    control,
    setError,
    formState: { errors },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: defaults(plan) });
  const err = (k: keyof Values) => errors[k]?.message;
  const burst = useWatch({ control, name: 'burst' });

  const submit = handleSubmit(async (v) => {
    const body = editing ? changedOnly(toBody(v, true), toBody(defaults(plan), true)) : toBody(v, false);
    if (editing && !Object.keys(body).length) return onCancel();
    try {
      await onSubmit(body);
    } catch (e) {
      applyServerErrors((p, o) => {
        const head = p.split('.')[0]!;
        setError(SERVER_TO_FIELD[head] ?? (head as keyof Values), o);
      }, e);
    }
  });

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="p-name" error={err('name')} className="sm:col-span-2">
          <Input id="p-name" {...register('name')} />
        </Field>
        <Field label="Download (Mbps)" htmlFor="p-down" error={err('down')}>
          <Input id="p-down" inputMode="decimal" {...register('down')} />
        </Field>
        <Field label="Upload (Mbps)" htmlFor="p-up" error={err('up')}>
          <Input id="p-up" inputMode="decimal" {...register('up')} />
        </Field>
        <Field label="Validity (days)" htmlFor="p-val" error={err('validityDays')}>
          <Input id="p-val" inputMode="numeric" {...register('validityDays')} />
        </Field>
        <Field label="Price (₹, before GST)" htmlFor="p-price" error={err('price')}>
          <Input id="p-price" inputMode="decimal" {...register('price')} />
        </Field>
      </div>

      <fieldset className="space-y-3 rounded-lg border p-4">
        <legend className="px-1 text-sm font-medium">Data cap and FUP</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Data cap (GB)" htmlFor="p-cap" error={err('capGb')} hint="Empty = unlimited.">
            <Input id="p-cap" inputMode="decimal" {...register('capGb')} />
          </Field>
          <Field label="Cap resets" htmlFor="p-cycle" error={err('fupCycle')}>
            <Select id="p-cycle" {...register('fupCycle')}>
              <option value="">Default (calendar month)</option>
              <option value="calendar_month">1st of each month</option>
              <option value="billing_cycle">Each billing cycle</option>
            </Select>
          </Field>
          <Field
            label="FUP download (Mbps)"
            htmlFor="p-fd"
            error={err('fupDown')}
            hint="Speed after the cap."
          >
            <Input id="p-fd" inputMode="decimal" {...register('fupDown')} />
          </Field>
          <Field label="FUP upload (Mbps)" htmlFor="p-fu" error={err('fupUp')}>
            <Input id="p-fu" inputMode="decimal" {...register('fupUp')} />
          </Field>
        </div>
      </fieldset>

      <fieldset className="space-y-3 rounded-lg border p-4">
        <legend className="px-1 text-sm font-medium">Burst</legend>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox {...register('burst')} /> Allow short bursts above the plan speed
        </label>
        {err('burst') ? <p className="text-xs text-danger-text">{err('burst')}</p> : null}
        {burst ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Burst download (Mbps)" htmlFor="b-d" error={err('burstDown')}>
              <Input id="b-d" inputMode="decimal" {...register('burstDown')} />
            </Field>
            <Field label="Burst upload (Mbps)" htmlFor="b-u" error={err('burstUp')}>
              <Input id="b-u" inputMode="decimal" {...register('burstUp')} />
            </Field>
            <Field label="Threshold download (Mbps)" htmlFor="b-td" error={err('burstThDown')}>
              <Input id="b-td" inputMode="decimal" {...register('burstThDown')} />
            </Field>
            <Field label="Threshold upload (Mbps)" htmlFor="b-tu" error={err('burstThUp')}>
              <Input id="b-tu" inputMode="decimal" {...register('burstThUp')} />
            </Field>
            <Field label="Burst time (seconds)" htmlFor="b-t" error={err('burstSecs')}>
              <Input id="b-t" inputMode="numeric" {...register('burstSecs')} />
            </Field>
          </div>
        ) : null}
      </fieldset>

      <details className="rounded-lg border p-4">
        <summary className="cursor-pointer text-sm font-medium">
          More: billing, GST, IP pool, RADIUS attributes
        </summary>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <p className="text-sm font-medium">Billing types</p>
            <div className="flex gap-6 text-sm">
              <label className="flex items-center gap-2">
                <Checkbox {...register('prepaid')} /> Prepaid
              </label>
              <label className="flex items-center gap-2">
                <Checkbox {...register('postpaid')} /> Postpaid
              </label>
            </div>
            {err('prepaid') ? <p className="text-xs text-danger-text">{err('prepaid')}</p> : null}
          </div>
          <Field label="GST rate" htmlFor="p-gst" error={err('gst')}>
            <Select id="p-gst" {...register('gst')}>
              {['0', '5', '12', '18', '28'].map((g) => (
                <option key={g} value={g}>
                  {g} %
                </option>
              ))}
            </Select>
          </Field>
          <Field label="HSN/SAC" htmlFor="p-sac" error={err('hsnSac')}>
            <Input id="p-sac" inputMode="numeric" {...register('hsnSac')} />
          </Field>
          <Field
            label="IP pool"
            htmlFor="p-pool"
            error={err('ipPool')}
            hint="MikroTik pool name; empty = router default."
          >
            <Input id="p-pool" {...register('ipPool')} />
          </Field>
          <Field label="Simultaneous logins" htmlFor="p-sim" error={err('simUse')}>
            <Input id="p-sim" inputMode="numeric" {...register('simUse')} />
          </Field>
          <Field label="Description" htmlFor="p-desc" error={err('description')} className="sm:col-span-2">
            <Input id="p-desc" {...register('description')} />
          </Field>
          <Field
            label="Extra RADIUS attributes"
            htmlFor="p-extra"
            error={err('extra')}
            hint="One per line, e.g. Mikrotik-Address-List := vip. Speed and session attributes are set for you."
            className="sm:col-span-2"
          >
            <Textarea id="p-extra" rows={3} className="font-mono text-xs" {...register('extra')} />
          </Field>
        </div>
      </details>

      <div className={dialogActions}>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={submitting}>
          {editing ? 'Save plan' : 'Create plan'}
        </Button>
      </div>
    </form>
  );
}
