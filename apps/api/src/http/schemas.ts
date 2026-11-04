import { ObjectId } from 'mongodb';
import { z } from 'zod';

export const objectId = z
  .string()
  .regex(/^[0-9a-f]{24}$/, 'must be a 24-character id')
  .transform((s) => new ObjectId(s));

export const idParams = z.object({ id: objectId });

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
  cursor: z
    .string()
    .regex(/^[0-9a-f]{24}$/)
    .optional(),
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
