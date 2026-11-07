import { ObjectId, type ClientSession, type Db } from 'mongodb';
import type { NotificationDoc, TemplateKey } from './types.js';

export const notifications = (db: Db) => db.collection<NotificationDoc>('notifications');

/**
 * Queues an SMS (TRD §6.8); the worker fills the tenant's DLT template, sends with retries and records the result.
 * A `dedupeKey` makes repeats (e.g. the same day's expiry reminder) no-ops.
 */
export async function notify(
  db: Db,
  session: ClientSession | undefined,
  n: {
    tenantId: ObjectId;
    to: string;
    key: TemplateKey;
    vars: string[];
    dedupeKey?: string;
    ref?: NotificationDoc['ref'];
  },
): Promise<void> {
  const now = new Date();
  const doc: NotificationDoc = {
    _id: new ObjectId(),
    tenantId: n.tenantId,
    channel: 'sms',
    to: n.to,
    templateKey: n.key,
    vars: n.vars,
    status: 'queued',
    attempts: 0,
    nextAttemptAt: now,
    ...(n.dedupeKey ? { dedupeKey: n.dedupeKey } : {}),
    ...(n.ref ? { ref: n.ref } : {}),
    createdAt: now,
  };
  try {
    await notifications(db).insertOne(doc, session ? { session } : {});
  } catch (e) {
    if ((e as { code?: number }).code !== 11000 || !n.dedupeKey) throw e;
  }
}

/** Fills {#var#} placeholders in order. */
export const fillTemplate = (body: string, vars: string[]) => {
  let i = 0;
  return body.replace(/\{#var#\}/gi, () => vars[i++] ?? '');
};
