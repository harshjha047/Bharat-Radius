'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { dialogActions } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';
import { Field } from '@/components/ui/misc';
import { applyServerErrors, changedOnly } from '@/lib/forms';
import type { Nas } from '@/lib/queries';

const ipv4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const schema = z.object({
  name: z.string().trim().min(1, 'Required').max(64),
  ip: z.string().trim().regex(ipv4, 'IPv4 address the router sends RADIUS from'),
  coaPort: z.string().regex(/^\d{1,5}$/, 'Port'),
  routerOsVersion: z.enum(['', '6', '7']),
  popName: z.string().trim().max(80),
  address: z.string().trim().max(200),
  description: z.string().max(500),
  radiusSecret: z
    .string()
    .regex(/^([A-Za-z0-9!#%+,.:=@_^~-]{16,64})?$/, '16–64 characters, no spaces or quotes'),
});
type Values = z.infer<typeof schema>;

const defaults = (n?: Nas): Values => ({
  name: n?.name ?? '',
  ip: n?.ip ?? '',
  coaPort: String(n?.coaPort ?? 3799),
  routerOsVersion: n?.routerOsVersion ?? '',
  popName: n?.location.popName ?? '',
  address: n?.location.address ?? '',
  description: n?.description ?? '',
  radiusSecret: '',
});

function toBody(v: Values, editing: boolean) {
  const location = {
    ...(v.popName ? { popName: v.popName } : {}),
    ...(v.address ? { address: v.address } : {}),
  };
  return JSON.parse(
    JSON.stringify({
      name: v.name,
      ip: v.ip,
      coaPort: Number(v.coaPort),
      routerOsVersion: v.routerOsVersion || undefined,
      location,
      description: v.description.trim() || (editing ? null : undefined),
      radiusSecret: v.radiusSecret || undefined,
    }),
  ) as Record<string, unknown>;
}

export function RouterForm({
  nas,
  submitting,
  onSubmit,
  onCancel,
}: {
  nas?: Nas;
  submitting: boolean;
  onSubmit: (body: Record<string, unknown>) => Promise<unknown>;
  onCancel: () => void;
}) {
  const editing = !!nas;
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: defaults(nas) });
  const err = (k: keyof Values) => errors[k]?.message;
  const submit = handleSubmit(async (v) => {
    const body = editing ? changedOnly(toBody(v, true), toBody(defaults(nas), true)) : toBody(v, false);
    if (editing && !Object.keys(body).length) return onCancel();
    try {
      await onSubmit(body);
    } catch (e) {
      applyServerErrors((p, o) => {
        const [head, tail] = p.split('.');
        setError(
          (head === 'location' ? (tail === 'address' ? 'address' : 'popName') : head) as keyof Values,
          o,
        );
      }, e);
    }
  });
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="n-name" error={err('name')}>
          <Input id="n-name" placeholder="e.g. POP-1 CCR1036" {...register('name')} />
        </Field>
        <Field
          label="Router IP"
          htmlFor="n-ip"
          error={err('ip')}
          hint="The public IP RADIUS packets come from."
        >
          <Input id="n-ip" inputMode="decimal" {...register('ip')} />
        </Field>
        <Field label="RouterOS" htmlFor="n-ros" error={err('routerOsVersion')}>
          <Select id="n-ros" {...register('routerOsVersion')}>
            <option value="">Not set</option>
            <option value="6">v6</option>
            <option value="7">v7</option>
          </Select>
        </Field>
        <Field label="CoA port" htmlFor="n-coa" error={err('coaPort')} hint="MikroTik default 3799.">
          <Input id="n-coa" inputMode="numeric" {...register('coaPort')} />
        </Field>
        <Field label="POP" htmlFor="n-pop" error={err('popName')}>
          <Input id="n-pop" {...register('popName')} />
        </Field>
        <Field label="Location" htmlFor="n-addr" error={err('address')}>
          <Input id="n-addr" {...register('address')} />
        </Field>
        <Field label="Notes" htmlFor="n-desc" error={err('description')} className="sm:col-span-2">
          <Input id="n-desc" {...register('description')} />
        </Field>
        {!editing ? (
          <Field
            label="RADIUS secret"
            htmlFor="n-secret"
            error={err('radiusSecret')}
            hint="Leave empty to generate a strong one (recommended)."
            className="sm:col-span-2"
          >
            <Input id="n-secret" autoComplete="off" spellCheck={false} {...register('radiusSecret')} />
          </Field>
        ) : null}
      </div>
      <div className={dialogActions}>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={submitting}>
          {editing ? 'Save router' : 'Add router'}
        </Button>
      </div>
    </form>
  );
}
