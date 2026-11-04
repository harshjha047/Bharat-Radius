import { randomBytes } from 'node:crypto';
import { ObjectId, type Db, type MongoClient } from 'mongodb';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connectMongo,
  insertSubscriber,
  migrate,
  type ImportBatchDoc,
  type ImportRowDoc,
  type CoaLogDoc,
  type NasDeviceDoc,
  type OutboxDoc,
  type PlanDoc,
  type SubscriberDoc,
  type TenantDoc,
} from '@isp/db-mongo';
import { FieldCrypto } from '@isp/shared';
import { RadiusCoaClient } from '@isp/radius-client';
import { startFakeNas } from '@isp/radius-client/testing';
import { CoaSender } from '../src/coa.js';
import { UsageJob } from '../src/usage.js';
import { ImportJob } from '../src/imports.js';
import { OutboxWorker } from '../src/outbox-worker.js';
import { RadiusSync } from '../src/radius-sync.js';

let client: MongoClient;
let db: Db;
let pool: pg.Pool;
let crypto: FieldCrypto;
let worker: OutboxWorker;
const log = pino({ level: 'silent' });
const run = randomBytes(3).toString('hex');
const PW_KEY = 'test-pgcrypto-key-0123456789';
const now = () => new Date();
const std = () => ({ createdAt: now(), updatedAt: now(), createdBy: 'test', updatedBy: 'test' });

async function enqueue(tenantId: ObjectId, entity: OutboxDoc['entity'], entityId: ObjectId) {
  await db.collection<OutboxDoc>('outbox').insertOne({
    _id: new ObjectId(),
    tenantId,
    entity,
    entityId,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: now(),
    createdAt: now(),
  });
}

async function tenant(slug = `t${run}${randomBytes(2).toString('hex')}`): Promise<ObjectId> {
  const _id = new ObjectId();
  await db.collection<TenantDoc>('tenants').insertOne({
    _id,
    slug,
    name: slug,
    legalName: slug,
    status: 'active',
    stateCode: '07',
    address: { line1: 'x', city: 'Delhi', state: 'Delhi', pincode: '110001' },
    radius: {
      expiredRate: '256k/256k',
      expiredAddressList: 'expired',
      expiredSessionSecs: 3600,
      interimInterval: 300,
    },
    version: 0,
    ...std(),
  });
  return _id;
}

async function nas(tenantId: ObjectId, ip: string, secret = 'Router-Secret-12345'): Promise<ObjectId> {
  const _id = new ObjectId();
  await db.collection<NasDeviceDoc>('nas_devices').insertOne({
    _id,
    tenantId,
    name: `r-${ip}`,
    ip,
    radiusSecret: crypto.encrypt(secret, `nas.secret:${_id.toHexString()}`),
    coaPort: 3799,
    status: 'active',
    version: 0,
    ...std(),
  });
  return _id;
}

async function plan(tenantId: ObjectId, name: string): Promise<ObjectId> {
  const _id = new ObjectId();
  await db.collection<PlanDoc>('plans').insertOne({
    _id,
    tenantId,
    name,
    downloadKbps: 50_000,
    uploadKbps: 20_000,
    rateLimit: '20M/50M',
    dataCapBytes: 200e9,
    fup: { downloadKbps: 2000, uploadKbps: 2000 },
    fupRate: '2M/2M',
    validityDays: 30,
    ipPool: 'pool-home',
    simUse: 1,
    billingTypes: ['prepaid'],
    pricePaise: 49_900,
    gstRatePercent: 18,
    hsnSac: '998422',
    extraAttributes: [{ attribute: 'Mikrotik-Group', op: ':=', value: 'home' }],
    status: 'active',
    version: 0,
    ...std(),
  });
  return _id;
}

const one = async <T extends pg.QueryResultRow>(sql: string, p: unknown[]) =>
  (await pool.query<T>(sql, p)).rows[0];
const ip = (n: number) => `198.51.${Number.parseInt(run.slice(0, 2), 16)}.${n}`;

beforeAll(async () => {
  const url = new URL(process.env.MONGO_URL!);
  url.pathname = `/isp_wtest_${run}`;
  ({ client, db } = await connectMongo(url.toString(), 5));
  await migrate(db);
  pool = new pg.Pool({ connectionString: process.env.RADIUS_DB_URL, max: 4 });
  crypto = new FieldCrypto(randomBytes(32).toString('base64'));
  worker = new OutboxWorker(
    db,
    new RadiusSync(pool, db, crypto, PW_KEY),
    log,
    new CoaSender(pool, db, new RadiusCoaClient({ timeoutMs: 500, retries: 1 }), log),
  );
});
afterAll(async () => {
  await worker?.stop();
  await db?.dropDatabase();
  await client?.close();
  await pool?.end();
});

describe('outbox → RADIUS', () => {
  it('syncs tenant, router and plan (tenant pulled in on demand)', async () => {
    const t = await tenant();
    const n = await nas(t, ip(1));
    const p = await plan(t, 'Home 50');
    await enqueue(t, 'nas', n);
    await enqueue(t, 'plan', p);
    expect(await worker.drain()).toBe(2);

    const tRow = await one<{ id: number; status: string }>(
      'SELECT id, status FROM tenants WHERE external_id = $1',
      [t.toHexString()],
    );
    expect(tRow?.status).toBe('active');
    const nRow = await one<{ tenant_id: number; secret: string; nasname: string }>(
      'SELECT tenant_id, secret, host(nasname) AS nasname FROM nas WHERE external_id = $1',
      [n.toHexString()],
    );
    expect(nRow).toEqual({ tenant_id: tRow!.id, secret: 'Router-Secret-12345', nasname: ip(1) });
    const pRow = await one<{ id: number; rate_limit: string; fup_rate: string; ip_pool: string }>(
      'SELECT id, rate_limit, fup_rate, ip_pool FROM plans WHERE external_id = $1',
      [p.toHexString()],
    );
    expect(pRow).toMatchObject({ rate_limit: '20M/50M', fup_rate: '2M/2M', ip_pool: 'pool-home' });
    const attrs = await pool.query('SELECT attribute, op, value FROM plan_attributes WHERE plan_id = $1', [
      pRow!.id,
    ]);
    expect(attrs.rows).toEqual([{ attribute: 'Mikrotik-Group', op: ':=', value: 'home' }]);
    expect((await db.collection<NasDeviceDoc>('nas_devices').findOne({ _id: n }))?.radiusId).toBeTypeOf(
      'number',
    );
    expect(await db.collection('outbox').countDocuments({ status: { $ne: 'done' } })).toBe(0);
  });

  it('updates, removes a disabled router, and re-adds it', async () => {
    const t = await tenant();
    const n = await nas(t, ip(2));
    await enqueue(t, 'nas', n);
    await worker.drain();
    const col = db.collection<NasDeviceDoc>('nas_devices');

    await col.updateOne({ _id: n }, { $set: { ip: ip(3), coaPort: 1700 } });
    await enqueue(t, 'nas', n);
    await worker.drain();
    expect(
      await one('SELECT host(nasname) AS ip, coa_port FROM nas WHERE external_id = $1', [n.toHexString()]),
    ).toEqual({
      ip: ip(3),
      coa_port: 1700,
    });

    await col.updateOne({ _id: n }, { $set: { status: 'disabled' } });
    await enqueue(t, 'nas', n);
    await worker.drain();
    expect(await one('SELECT 1 FROM nas WHERE external_id = $1', [n.toHexString()])).toBeUndefined();

    await col.updateOne({ _id: n }, { $set: { status: 'active' } });
    await enqueue(t, 'nas', n);
    await worker.drain();
    expect(await one('SELECT 1 AS ok FROM nas WHERE external_id = $1', [n.toHexString()])).toEqual({ ok: 1 });
  });

  it('adopts rows created before sync existed (Step 1 seeds) instead of duplicating them', async () => {
    const slug = `adopt${run}`;
    const pre = await one<{ id: number }>(
      "INSERT INTO tenants (slug, name) VALUES ($1, 'old') RETURNING id",
      [slug],
    );
    const t = await tenant(slug);
    await enqueue(t, 'tenant', t);
    await worker.drain();
    expect(await one('SELECT id, name FROM tenants WHERE external_id = $1', [t.toHexString()])).toEqual({
      id: pre!.id,
      name: slug,
    });
  });

  it('settles every queued row of an entity with one sync', async () => {
    const t = await tenant();
    const p = await plan(t, 'Burst');
    for (let i = 0; i < 3; i++) await enqueue(t, 'plan', p);
    expect(await worker.drain()).toBe(1);
    expect(await db.collection('outbox').countDocuments({ entityId: p, status: 'done' })).toBe(3);
  });

  it('a failing row backs off with the error recorded and does not block others', async () => {
    const orphanTenant = new ObjectId();
    const p = await plan(orphanTenant, 'Orphan');
    await enqueue(orphanTenant, 'plan', p);
    const t = await tenant();
    const ok = await plan(t, 'Fine');
    await enqueue(t, 'plan', ok);
    await worker.drain();
    const failed = await db.collection<OutboxDoc>('outbox').findOne({ entityId: p });
    expect(failed).toMatchObject({ status: 'pending', attempts: 1 });
    expect(failed!.lastError).toMatch(/missing in MongoDB/);
    expect(failed!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 3000);
    expect(await one('SELECT 1 AS ok FROM plans WHERE external_id = $1', [ok.toHexString()])).toEqual({
      ok: 1,
    });
  });

  it('subscriber: synced with encrypted password, kick reaches the live session (rows coalesced)', async () => {
    const admin = new pg.Pool({ connectionString: process.env.RADIUS_ADMIN_URL });
    const nasDev = await startFakeNas('Router-Secret-12345', 'ack');
    try {
      const t = await tenant();
      const n = await nas(t, '127.0.0.1');
      await db
        .collection<NasDeviceDoc>('nas_devices')
        .updateOne({ _id: n }, { $set: { coaPort: nasDev.port } });
      const p = await plan(t, 'Sub plan');
      const sid = new ObjectId();
      await db.collection<SubscriberDoc>('subscribers').insertOne({
        _id: sid,
        tenantId: t,
        resellerId: null,
        ancestors: [],
        customerNo: 'C000001',
        username: `u${run}`,
        pppoePassword: crypto.encrypt('pppoe-pw', `subscribers.pppoe:${sid.toHexString()}`),
        name: 'Test User',
        phone: '+919876543210',
        address: { line1: 'x', city: 'Delhi', state: 'Delhi', stateCode: '07', pincode: '110001' },
        billingType: 'prepaid',
        planId: p,
        expiresAt: new Date(Date.now() + 86_400_000),
        status: 'active',
        network: {},
        kyc: { status: 'pending' },
        tags: [],
        search: [],
        syncStatus: 'pending',
        version: 0,
        ...std(),
      });
      await enqueue(t, 'nas', n);
      await enqueue(t, 'subscriber', sid);
      await worker.drain();
      const row = await one<{ id: number }>('SELECT id FROM subscribers WHERE external_id = $1', [
        sid.toHexString(),
      ]);
      expect(row).toBeDefined();
      const pw = await admin.query(
        `SELECT value FROM radius_check('127.0.0.1', $1, NULL, $2) WHERE attribute = 'Cleartext-Password'`,
        [`u${run}`, PW_KEY],
      );
      expect(pw.rows[0]?.value).toBe('pppoe-pw');
      expect((await db.collection<SubscriberDoc>('subscribers').findOne({ _id: sid }))?.syncStatus).toBe(
        'synced',
      );

      const tid = (await one<{ id: number }>('SELECT id FROM tenants WHERE external_id = $1', [
        t.toHexString(),
      ]))!.id;
      await admin.query(
        `INSERT INTO radacct (tenant_id, acctsessionid, acctuniqueid, username, nasipaddress, acctstarttime, acctupdatetime)
         VALUES ($1, 'sess-1', $2, $3, '127.0.0.1', now(), now())`,
        [tid, randomBytes(8).toString('hex'), `u${run}`],
      );
      await enqueue(t, 'subscriber', sid);
      await db.collection<OutboxDoc>('outbox').insertOne({
        _id: new ObjectId(),
        tenantId: t,
        entity: 'subscriber',
        entityId: sid,
        coa: { action: 'disconnect', reason: 'kick' },
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now(),
        createdAt: now(),
      });
      expect(await worker.drain()).toBe(1);
      expect(nasDev.received.map((r) => r.code)).toEqual([40]);
      const log = await db.collection<CoaLogDoc>('coa_log').findOne({ subscriberId: sid });
      expect(log).toMatchObject({ type: 'disconnect', result: 'ack', trigger: { type: 'kick' } });
    } finally {
      await nasDev.close();
      await admin.end();
    }
  });

  it('usage roll-up → FUP on at the cap (synced to RADIUS with a disconnect) → off when the cap is removed', async () => {
    const admin = new pg.Pool({ connectionString: process.env.RADIUS_ADMIN_URL });
    try {
      const t = await tenant();
      const p = await plan(t, 'Capped');
      await db
        .collection<PlanDoc>('plans')
        .updateOne({ _id: p }, { $set: { dataCapBytes: 1_000_000, fupCycle: 'calendar_month' } });
      const sid = new ObjectId();
      const uname = `fup${run}`;
      await db.collection<SubscriberDoc>('subscribers').insertOne({
        _id: sid,
        tenantId: t,
        resellerId: null,
        ancestors: [],
        customerNo: 'C000009',
        username: uname,
        pppoePassword: crypto.encrypt('pw', `subscribers.pppoe:${sid.toHexString()}`),
        name: 'Cap User',
        phone: '+919876543211',
        address: { line1: 'x', city: 'Delhi', state: 'Delhi', stateCode: '07', pincode: '110001' },
        billingType: 'prepaid',
        planId: p,
        expiresAt: new Date(Date.now() + 86_400_000),
        status: 'active',
        network: {},
        kyc: { status: 'pending' },
        tags: [],
        search: [],
        syncStatus: 'pending',
        version: 0,
        ...std(),
      });
      await enqueue(t, 'subscriber', sid);
      await worker.drain();
      const tid = (await one<{ id: number }>('SELECT id FROM tenants WHERE external_id = $1', [
        t.toHexString(),
      ]))!.id;
      const acctId = randomBytes(8).toString('hex');
      await admin.query(
        `INSERT INTO radacct (tenant_id, acctsessionid, acctuniqueid, username, nasipaddress, acctstarttime,
                              acctupdatetime, acctinputoctets, acctoutputoctets)
         VALUES ($1, 'cap', $2, $3, '192.0.2.1', now() - interval '1 hour', now(), 100000, 500000)`,
        [tid, acctId, uname],
      );
      const job = new UsageJob(pool, client, db, log);
      const r1 = await job.run();
      expect(r1.fupOn).toBe(0);
      expect((await db.collection<SubscriberDoc>('subscribers').findOne({ _id: sid }))?.fup).toMatchObject({
        active: false,
        usedBytes: 600_000,
      });

      await admin.query(
        `UPDATE radacct SET acctoutputoctets = 950000, acctupdatetime = now() WHERE acctuniqueid = $1`,
        [acctId],
      );
      const r2 = await job.run();
      expect(r2).toMatchObject({ fupOn: 1 });
      const sub = await db.collection<SubscriberDoc>('subscribers').findOne({ _id: sid });
      expect(sub).toMatchObject({
        fup: { active: true, usedBytes: 1_050_000 },
        syncStatus: 'pending',
        version: 1,
      });
      const queued = await db.collection<OutboxDoc>('outbox').findOne({ entityId: sid, status: 'pending' });
      expect(queued?.coa).toEqual({ action: 'disconnect', reason: 'fup' });
      await worker.drain();
      expect(
        await one('SELECT fup_active FROM subscribers WHERE external_id = $1', [sid.toHexString()]),
      ).toEqual({
        fup_active: true,
      });
      expect((await job.run()).fupOn).toBe(0);

      await db.collection<PlanDoc>('plans').updateOne({ _id: p }, { $unset: { dataCapBytes: '' } });
      expect((await job.run()).fupOff).toBe(1);
      await worker.drain();
      expect(
        await one('SELECT fup_active FROM subscribers WHERE external_id = $1', [sid.toHexString()]),
      ).toEqual({
        fup_active: false,
      });
      const daily = await one<{ total: string }>(
        'SELECT sum(bytes_in + bytes_out)::text AS total FROM usage_daily WHERE tenant_id = $1 AND username = $2',
        [tid, uname],
      );
      expect(daily?.total).toBe('1050000');
    } finally {
      await admin.end();
    }
  });

  it('import job creates queued rows, reports races, and resumes after a crash without false errors', async () => {
    const t = await tenant();
    const batchId = new ObjectId();
    await db.collection<ImportBatchDoc>('import_batches').insertOne({
      _id: batchId,
      tenantId: t,
      source: 'excel',
      fileName: 'x.xlsx',
      status: 'queued',
      counts: { read: 3, valid: 3, created: 0, failed: 0 },
      errors: [],
      createdBy: 'tester',
      createdAt: now(),
    });
    const input = (username: string) => ({
      username,
      name: 'Imported',
      phone: '+919800000000',
      address: { line1: 'x', city: 'Delhi', state: 'Delhi', stateCode: '07', pincode: '110001' },
      billingType: 'prepaid' as const,
      network: {},
      tags: [],
    });
    const rows = ['imp-a', 'imp-b', 'imp-c'].map((u, i) => {
      const _id = new ObjectId();
      return {
        _id,
        batchId,
        tenantId: t,
        row: i + 2,
        input: { ...input(u), pppoePassword: crypto.encrypt(`pw-${u}`, `import_rows:${_id.toHexString()}`) },
        status: 'pending' as const,
        createdAt: now(),
      };
    });
    await db.collection<ImportRowDoc>('import_rows').insertMany(rows);
    // imp-b taken meanwhile by someone else; imp-c already created by this batch before a crash.
    await insertSubscriber(
      client,
      db,
      crypto,
      { tenantId: t, actor: 'other' },
      { ...input('imp-b'), pppoePassword: 'x' },
    );
    await insertSubscriber(
      client,
      db,
      crypto,
      { tenantId: t, actor: 'tester', importBatchId: batchId },
      { ...input('imp-c'), pppoePassword: 'pw-imp-c' },
    );

    const job = new ImportJob(client, db, crypto, log);
    expect(await job.run()).toMatchObject({ batches: 1, created: 2, failed: 1 });
    const batch = await db.collection<ImportBatchDoc>('import_batches').findOne({ _id: batchId });
    expect(batch).toMatchObject({ status: 'done', counts: { created: 2, failed: 1 } });
    expect(batch!.errors).toEqual([
      { row: 3, column: 'username', message: 'Username was taken by another subscriber meanwhile' },
    ]);
    const a = await db.collection<SubscriberDoc>('subscribers').findOne({ tenantId: t, username: 'imp-a' });
    expect(a).toMatchObject({ importBatchId: batchId, syncStatus: 'pending', createdBy: 'tester' });
    expect(crypto.decrypt(a!.pppoePassword, `subscribers.pppoe:${a!._id.toHexString()}`)).toBe('pw-imp-a');
    expect(await db.collection('outbox').countDocuments({ entityId: a!._id })).toBe(1);
    const left = await db.collection<ImportRowDoc>('import_rows').find({ batchId }).toArray();
    expect(left.every((r) => r.status !== 'pending' && !('input' in r))).toBe(true);
    expect((await job.run()).batches).toBe(0);
  });

  it('only one worker leads', async () => {
    expect(await worker.holdLease()).toBe(true);
    const other = new OutboxWorker(db, new RadiusSync(pool, db, crypto, PW_KEY), log);
    expect(await other.holdLease()).toBe(false);
  });

  it('a change reaches PostgreSQL in under 2 s through the running loop (TRD §12)', async () => {
    const loop = worker.start();
    const t = await tenant();
    const n = await nas(t, ip(9));
    const t0 = Date.now();
    await enqueue(t, 'nas', n);
    let seen = false;
    while (Date.now() - t0 < 5000 && !seen) {
      seen = !!(await one('SELECT 1 AS ok FROM nas WHERE external_id = $1', [n.toHexString()]));
      if (!seen) await new Promise((r) => setTimeout(r, 50));
    }
    const ms = Date.now() - t0;
    await worker.stop();
    await loop;
    expect(seen).toBe(true);
    expect(ms).toBeLessThan(2000);
  });
});
