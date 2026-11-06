import { ObjectId } from 'mongodb';
import { z } from 'zod';

export const objectId = z
  .string()
  .regex(/^[0-9a-f]{24}$/, 'must be a 24-character id')
  .transform((s) => new ObjectId(s));

export const idParams = z.object({ id: objectId });

export const hexId = z.string().regex(/^[0-9a-f]{24}$/, 'must be a 24-character id');
export const pincode = z.string().regex(/^\d{6}$/, 'must be a 6-digit PIN code');
export const stateCode = z.string().regex(/^\d{2}$/, 'must be a 2-digit GST state code');
export const gstin = z.string().regex(/^\d{2}[0-9A-Z]{13}$/, 'must be a 15-character GSTIN');
export const isoDate = z.string().regex(/^\d{4}-\d\d-\d\d$/, 'must be a date in YYYY-MM-DD form');

export const phone = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s-]/g, ''))
  .transform((s) => (/^[6-9]\d{9}$/.test(s) ? `+91${s}` : s))
  .pipe(z.string().regex(/^\+[1-9]\d{7,14}$/, 'must be a phone number in +<country><number> form'));

export const email = z
  .email()
  .max(254)
  .transform((s) => s.toLowerCase());

/** Cursor = last seen _id (newest first). Stable under inserts, O(log n) per page via the _id index. */
export const pageQuery = z.object({
  cursor: hexId.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export function pageOf<T extends { _id: ObjectId }, R>(docs: T[], limit: number, map: (d: T) => R) {
  const more = docs.length > limit;
  const items = (more ? docs.slice(0, limit) : docs).map(map);
  return { items, nextCursor: more ? docs[limit - 1]!._id.toHexString() : null };
}

export const okResponse = z.object({ ok: z.literal(true) });

type Defined<T> = T extends Date | ObjectId
  ? T
  : T extends (infer U)[]
    ? Defined<U>[]
    : T extends object
      ? { [K in keyof T]: Defined<Exclude<T[K], undefined>> }
      : T;

/** Drops undefined keys (deep). The driver would store them as null; zod output keeps them as undefined. */
export function compact<T>(v: T): Defined<T> {
  if (Array.isArray(v)) return v.map(compact) as Defined<T>;
  if (v && typeof v === 'object' && !(v instanceof Date) && !(v instanceof ObjectId)) {
    return Object.fromEntries(
      Object.entries(v)
        .filter(([, x]) => x !== undefined)
        .map(([k, x]) => [k, compact(x)]),
    ) as Defined<T>;
  }
  return v as Defined<T>;
}
