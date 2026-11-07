import { randomBytes } from 'node:crypto';
import { ObjectId, type Db, type MongoClient } from 'mongodb';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connectMongo,
  expiryReminders,
  migrate,
  notifications,
  notify,
  type MessageTemplateDoc,
  type NotificationDoc,
  type SubscriberDoc,
  type TenantDoc,
} from '@isp/db-mongo';
import { FieldCrypto } from '@isp/shared';
import { SmsSender } from '../src/billing.js';

let client: MongoClient;
let db: Db;
const crypto = new FieldCrypto(randomBytes(32).toString('base64'));
const log = pino({ level: 'silent' });
const tenantId = new ObjectId();
const calls: string[] = [];
let replies: { status: number; body: string }[] = [];
const fakeFetch = (async (url: string | URL) => {
  calls.push(String(url));
  const r = replies.shift() ?? { status: 200, body: 'OK msgid=1' };
  return new Response(r.body, { status: r.status });
}) as typeof fetch;

beforeAll(async () => {
  const base = process.env.MONGO_URL;
  if (!base) throw new Error('MONGO_URL is required for integration tests');
  const url = new URL(base);
  url.pathname = `/isp_billing_${randomBytes(4).toString('hex')}`;
  ({ client, db } = await connectMongo(url.toString(), 5));
  await migrate(db);
  const now = new Date();
  await db.collection<TenantDoc>('tenants').insertOne({
    _id: tenantId,
    slug: 'smsisp',
    name: 'SMS ISP',
    legalName: 'SMS ISP Pvt Ltd',
    status: 'active',
    stateCode: '07',
    address: { line1: '1', city: 'Delhi', state: 'Delhi', pincode: '110001' },
    radius: {
      expiredRate: '256k/256k',
      expiredAddressList: 'expired',
      expiredSessionSecs: 3600,
      interimInterval: 300,
    },
    sms: {
      enabled: true,
      urlTemplate:
        'https://sms.example/api?key={apiKey}&sender={sender}&tid={templateId}&to={to}&msg={message}',
      apiKey: crypto.encrypt('k-secret', `tenants.sms:${tenantId.toHexString()}:apiKey`),
      senderId: 'BRADUS',
      successPattern: '^OK',
    },
    version: 0,
    createdAt: now,
    updatedAt: now,
    createdBy: 't',
    updatedBy: 't',
  });
  await db.collection<MessageTemplateDoc>('message_templates').insertOne({
    _id: new ObjectId(),
    tenantId,
    key: 'payment_receipt',
    channel: 'sms',
    dltTemplateId: '1107160000000000001',
    body: 'Dear {#var#}, received {#var#} for {#var#}. Valid till {#var#}. Inv {#var#} -BRADUS',
    active: true,
    updatedAt: now,
    updatedBy: 't',
  });
});
afterAll(async () => {
  await db?.dropDatabase();
  await client?.close();
});

const due = async () =>
  db.collection<NotificationDoc>('notifications').updateMany({}, { $set: { nextAttemptAt: new Date(0) } });

describe('SMS queue', () => {
  it('fills the DLT template, URL-encodes every value and records the result', async () => {
    await notify(db, undefined, {
      tenantId,
      to: '+919876543210',
      key: 'payment_receipt',
      vars: ['Ravi Kumar', 'Rs. 118.00', 'Basic 100', '06 Dec 2026', 'INV/2627/00001'],
    });
    const sender = new SmsSender(db, crypto, log, fakeFetch);
    expect(await sender.run()).toMatchObject({ sent: 1 });
    const u = new URL(calls.at(-1)!);
    expect(u.searchParams.get('key')).toBe('k-secret');
    expect(u.searchParams.get('to')).toBe('919876543210');
    expect(u.searchParams.get('tid')).toBe('1107160000000000001');
    expect(u.searchParams.get('msg')).toBe(
      'Dear Ravi Kumar, received Rs. 118.00 for Basic 100. Valid till 06 Dec 2026. Inv INV/2627/00001 -BRADUS',
    );
    expect((await notifications(db).findOne({}))!.status).toBe('sent');
  });

  it('retries failures with backoff and gives up after three attempts', async () => {
    await notifications(db).deleteMany({});
    await notify(db, undefined, {
      tenantId,
      to: '+919800000000',
      key: 'payment_receipt',
      vars: ['A', 'B', 'C', 'D', 'E'],
    });
    replies = [
      { status: 500, body: 'down' },
      { status: 200, body: 'ERROR invalid template' },
      { status: 502, body: 'bad gateway' },
    ];
    const sender = new SmsSender(db, crypto, log, fakeFetch);
    expect(await sender.run()).toMatchObject({ retried: 1 });
    expect(await sender.run()).toMatchObject({ sent: 0, retried: 0 }); // backoff: not due yet
    await due();
    expect(await sender.run()).toMatchObject({ retried: 1 });
    await due();
    expect(await sender.run()).toMatchObject({ failed: 1 });
    const n = (await notifications(db).findOne({}))!;
    expect(n).toMatchObject({ status: 'failed', attempts: 3 });
    expect(n.error).toContain('502');
  });

  it('a missing template is skipped with the reason, not retried', async () => {
    await notifications(db).deleteMany({});
    await notify(db, undefined, { tenantId, to: '+919800000001', key: 'invoice_issued', vars: [] });
    expect(await new SmsSender(db, crypto, log, fakeFetch).run()).toMatchObject({ skipped: 1 });
    expect((await notifications(db).findOne({}))!).toMatchObject({
      status: 'skipped',
      error: 'No active invoice_issued template',
    });
  });

  it('expiry reminders go out once per day per subscriber', async () => {
    await notifications(db).deleteMany({});
    const at = new Date('2026-11-10T06:00:00Z'); // 11:30 IST
    await db.collection<SubscriberDoc>('subscribers').insertOne({
      _id: new ObjectId(),
      tenantId,
      resellerId: null,
      ancestors: [],
      customerNo: 'C1',
      username: 'remind1',
      pppoePassword: crypto.encrypt('x', 'x'),
      name: 'Remind Me',
      phone: '+919811111111',
      address: { line1: '1', city: 'Delhi', state: 'Delhi', stateCode: '07', pincode: '110001' },
      billingType: 'prepaid',
      planId: new ObjectId(),
      expiresAt: new Date('2026-11-13T18:29:59Z'), // 13 Nov 23:59:59 IST = 3 days ahead
      status: 'active',
      network: {},
      kyc: { status: 'pending' },
      tags: [],
      search: [],
      syncStatus: 'synced',
      version: 0,
      createdAt: at,
      updatedAt: at,
      createdBy: 't',
      updatedBy: 't',
    });
    expect((await expiryReminders(db, at)).queued).toBe(1);
    await expiryReminders(db, at);
    expect(await notifications(db).countDocuments({ templateKey: 'expiry_reminder' })).toBe(1);
    expect((await expiryReminders(db, new Date('2026-11-10T03:00:00Z'))).queued).toBe(0); // 08:30 IST: too early
  });
});
