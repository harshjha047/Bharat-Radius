'use client';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import {
  useWatch,
  type Control,
  type FieldValues,
  type Path,
  type PathValue,
  type UseFormGetValues,
  type UseFormSetValue,
} from 'react-hook-form';
import { api, unwrap } from './api';

type Target = 'city' | 'district' | 'state' | 'stateCode';
type Fields<T extends FieldValues> = { pincode: Path<T> } & Partial<Record<Target, Path<T>>>;

/**
 * Looks up a 6-digit PIN and fills city/district/state (and GST state code) from the India Post directory.
 * Only fills a field that is empty or still holds the previous auto-filled value, so typed values are kept.
 * Returns a hint for the PIN field.
 */
export function usePincodeAutofill<T extends FieldValues>(
  control: Control<T>,
  getValues: UseFormGetValues<T>,
  setValue: UseFormSetValue<T>,
  fields: Fields<T>,
): string | undefined {
  const pin = String(useWatch({ control, name: fields.pincode }) ?? '');
  const valid = /^\d{6}$/.test(pin);
  const q = useQuery({
    queryKey: ['pincode', pin],
    queryFn: () => unwrap(api.GET('/api/v1/pincodes/{pincode}', { params: { path: { pincode: pin } } })),
    enabled: valid,
    staleTime: Infinity,
    retry: false,
  });
  const filled = useRef<Partial<Record<Target, string>>>({});
  const { city, district, state, stateCode } = fields;

  useEffect(() => {
    const d = q.data;
    if (!d) return;
    const next: Record<Target, string> = {
      city: d.district,
      district: d.district,
      state: d.state,
      stateCode: d.stateCode,
    };
    const names: Partial<Record<Target, Path<T>>> = { city, district, state, stateCode };
    for (const t of Object.keys(next) as Target[]) {
      const name = names[t];
      if (!name) continue;
      const cur = String(getValues(name) ?? '').trim();
      if (cur && cur !== filled.current[t]) continue;
      setValue(name, next[t] as PathValue<T, Path<T>>, { shouldDirty: true, shouldValidate: true });
      filled.current[t] = next[t];
    }
  }, [q.data, getValues, setValue, city, district, state, stateCode]);

  if (!valid) return undefined;
  if (q.data) return `${q.data.district}, ${q.data.state}`;
  if (q.isError) return 'Not in the India Post directory; fill in city and state.';
  return undefined;
}
