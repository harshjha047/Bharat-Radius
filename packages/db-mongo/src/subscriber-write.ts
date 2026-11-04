import { ObjectId, type ClientSession, type Db, type MongoClient } from 'mongodb';
import type { FieldCrypto } from '@isp/shared';
import type { OutboxDoc, SubscriberDoc } from './types.js';

/** Lower-case prefix tokens for the indexed search (name words, username, phone, customer number). */
export function searchTokens(s: {
  name: string;
  username?: string | undefined;
  phone: string;
  altPhone?: string | undefined;
  customerNo: string;
}): string[] {
  const t = new Set<string>();
  for (const w of s.name.toLowerCase().split(/\s+/)) if (w) t.add(w);
  if (s.username) t.add(s.username.toLowerCase());
  for (const p of [s.phone, s.altPhone]) {
    if (!p) continue;
    t.add(p.replace(/^\+/, ''));
    if (p.startsWith('+91')) t.add(p.slice(3));
  }
  t.add(s.customerNo.toLowerCase());
  return [...t];
}

export const pppoeAad = (id: ObjectId) => `subscribers.pppoe:${id.toHexString()}`;

/** Validated input for a new subscriber (API create and Excel import share it). */
export interface NewSubscriber {
  username: string;
  pppoePassword: string;
  name: string;
  phone: string;
  altPhone?: string | undefined;
  email?: string | undefined;
  address: SubscriberDoc['address'];
  gstin?: string | undefined;
  billingType: SubscriberDoc['billingType'];
  planId?: ObjectId | undefined;
  expiresAt?: Date | undefined;
  network: SubscriberDoc['network'];
  tags: string[];
  notes?: string | undefined;
}

export interface InsertContext {
  tenantId: ObjectId;
  actor: string;
  resellerId?: ObjectId | null;
  ancestors?: ObjectId[];
  importBatchId?: ObjectId;
}

async function nextCustomerNo(db: Db, tenantId: ObjectId, session: ClientSession): Promise<string> {
  const c = await db
    .collection<{ _id: string; seq: number }>('counters')
    .findOneAndUpdate(
      { _id: `customerNo:${tenantId.toHexString()}` },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after', session, includeResultMetadata: false },
    );
  return `C${String(c!.seq).padStart(6, '0')}`;
}

/**
 * The single way a subscriber is created: customer number, encrypted PPPoE password, search tokens and the outbox
 * row (RADIUS sync) in one transaction. Throws MongoServerError 11000 on a duplicate username or static IP.
 */
export async function insertSubscriber(
  client: MongoClient,
  db: Db,
  crypto: FieldCrypto,
  ctx: InsertContext,
  input: NewSubscriber,
): Promise<SubscriberDoc> {
  const _id = new ObjectId();
  const now = new Date();
  let doc: SubscriberDoc | undefined;
  await client.withSession((session) =>
    session.withTransaction(async () => {
      const customerNo = await nextCustomerNo(db, ctx.tenantId, session);
      doc = {
        _id,
        tenantId: ctx.tenantId,
        resellerId: ctx.resellerId ?? null,
        ancestors: ctx.ancestors ?? [],
        customerNo,
        username: input.username,
        pppoePassword: crypto.encrypt(input.pppoePassword, pppoeAad(_id)),
        name: input.name,
        phone: input.phone,
        ...(input.altPhone ? { altPhone: input.altPhone } : {}),
        ...(input.email ? { email: input.email } : {}),
        address: input.address,
        ...(input.gstin ? { gstin: input.gstin } : {}),
        billingType: input.billingType,
        ...(input.planId ? { planId: input.planId } : {}),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
        status: 'active',
        network: input.network,
        kyc: { status: 'pending' },
        tags: [...new Set(input.tags)],
        ...(input.notes ? { notes: input.notes } : {}),
        search: searchTokens({ ...input, customerNo }),
        syncStatus: 'pending',
        ...(ctx.importBatchId ? { importBatchId: ctx.importBatchId } : {}),
        version: 0,
        createdAt: now,
        updatedAt: now,
        createdBy: ctx.actor,
        updatedBy: ctx.actor,
      };
      await db.collection<SubscriberDoc>('subscribers').insertOne(doc, { session });
      await db.collection<OutboxDoc>('outbox').insertOne(
        {
          _id: new ObjectId(),
          tenantId: ctx.tenantId,
          entity: 'subscriber',
          entityId: _id,
          status: 'pending',
          attempts: 0,
          nextAttemptAt: now,
          createdAt: now,
        },
        { session },
      );
    }),
  );
  return doc!;
}
