import { guardFlag } from './guard.js';
import { createServer } from 'node:http';
import pg from 'pg';
import { pino } from 'pino';
import { z } from 'zod';
import {
  connectMongo,
  expiryReminders,
  notifications,
  pendingMigrations,
  postpaidInvoices,
  postpaidOverdue,
  reconcileWallets,
  wallets,
  type OutboxDoc,
} from '@isp/db-mongo';
import { SmsSender, gatewayReconcile } from './billing.js';
import { FieldCrypto } from '@isp/shared';
import { RadiusCoaClient } from '@isp/radius-client';
import { CoaSender } from './coa.js';
import { Scheduler, type JobDoc } from './jobs.js';
import { OutboxWorker } from './outbox-worker.js';
import { UsageJob } from './usage.js';
import { ImportJob } from './imports.js';
import { RadiusSync } from './radius-sync.js';

const config = z
  .object({
    MONGO_URL: z.string().startsWith('mongodb'),
    RADIUS_DB_URL: z.string().startsWith('postgres'),
    RADIUS_DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(4),
    FIELD_ENCRYPTION_KEY: z.string().min(40),
    RADIUS_PW_KEY: z.string().min(16),
    /** Source address for CoA (router firewalls accept UDP 3799 only from it); default: any. */
    COA_SOURCE_IP: z.string().optional(),
    WORKERS_HOST: z.string().default('127.0.0.1'),
    WORKERS_PORT: z.coerce.number().int().default(4101),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    APP_VERSION: z.string().default('dev'),
  })
  .parse(process.env);

const log = pino({ level: config.LOG_LEVEL, base: { svc: 'isp-workers', ver: config.APP_VERSION } });

const { client, db } = await connectMongo(config.MONGO_URL, 5);
const pending = await pendingMigrations(db);
if (pending.length) {
  log.fatal({ pending }, 'MongoDB has pending migrations');
  process.exit(1);
}
const pool = new pg.Pool({
  connectionString: config.RADIUS_DB_URL,
  max: config.RADIUS_DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 3000,
  application_name: 'isp-workers',
});
pool.on('error', (err) => log.warn({ err }, 'idle PostgreSQL connection failed'));

const coaClient = new RadiusCoaClient(
  config.COA_SOURCE_IP && config.COA_SOURCE_IP !== '0.0.0.0' ? { sourceIp: config.COA_SOURCE_IP } : {},
);
const fieldCrypto = new FieldCrypto(config.FIELD_ENCRYPTION_KEY);
const coa = new CoaSender(pool, db, coaClient, log);
const worker = new OutboxWorker(db, new RadiusSync(pool, db, fieldCrypto, config.RADIUS_PW_KEY), log, coa);

const usage = new UsageJob(pool, client, db, log);
const sms = new SmsSender(db, fieldCrypto, log);
const imports = new ImportJob(client, db, fieldCrypto, log);
const scheduler = new Scheduler(
  db,
  [
    { name: 'usage', periodMs: 15 * 60_000, run: () => usage.run() },
    {
      name: 'expired-sweep',
      periodMs: 5 * 60_000,
      run: async () => ({ disconnected: await coa.expiredSweep() }),
    },
    // Disk guard drill (disk >= 70 %): Excel imports wait; queued rows stay queued.
    {
      name: 'imports',
      periodMs: 5_000,
      run: () => (guardFlag('pause-heavy') ? Promise.resolve({ paused: 1 }) : imports.run()),
    },
    { name: 'notifications', periodMs: 10_000, run: () => sms.run() },
    { name: 'postpaid-invoice', periodMs: 30 * 60_000, run: () => postpaidInvoices(client, db) },
    { name: 'postpaid-overdue', periodMs: 60 * 60_000, run: () => postpaidOverdue(client, db) },
    { name: 'expiry-reminders', periodMs: 60 * 60_000, run: () => expiryReminders(db) },
    { name: 'reconcile-wallets', periodMs: 24 * 3600_000, run: () => reconcileWallets(db) },
    {
      name: 'gateway-reconcile',
      periodMs: 60 * 60_000,
      run: () => gatewayReconcile(client, db, fieldCrypto, log),
    },
  ],
  log,
);

async function metrics(): Promise<string> {
  const outbox = db.collection<OutboxDoc>('outbox');
  const [pendingCount, oldest] = await Promise.all([
    outbox.countDocuments({ status: { $ne: 'done' } }),
    outbox.findOne({ status: { $ne: 'done' } }, { sort: { createdAt: 1 }, projection: { createdAt: 1 } }),
  ]);
  const s = worker.stats;
  const lines = [
    '# HELP isp_outbox_pending Outbox rows not yet synced to RADIUS.',
    '# TYPE isp_outbox_pending gauge',
    `isp_outbox_pending ${pendingCount}`,
    '# HELP isp_outbox_oldest_pending_seconds Age of the oldest unsynced outbox row.',
    '# TYPE isp_outbox_oldest_pending_seconds gauge',
    `isp_outbox_oldest_pending_seconds ${oldest ? (Date.now() - oldest.createdAt.getTime()) / 1000 : 0}`,
    '# HELP isp_outbox_leader 1 when this process holds the outbox lease.',
    '# TYPE isp_outbox_leader gauge',
    `isp_outbox_leader ${s.leader ? 1 : 0}`,
    '# HELP isp_outbox_synced_total Entities written to RADIUS.',
    '# TYPE isp_outbox_synced_total counter',
    ...Object.entries(s.synced).map(([e, n]) => `isp_outbox_synced_total{entity="${e}"} ${n}`),
    '# HELP isp_outbox_errors_total Failed sync attempts (retried with backoff).',
    '# TYPE isp_outbox_errors_total counter',
    ...Object.entries(s.errors).map(([e, n]) => `isp_outbox_errors_total{entity="${e}"} ${n}`),
  ];
  const [frozen, smsQueued, smsFailed] = await Promise.all([
    wallets(db).countDocuments({ frozen: true }),
    notifications(db).countDocuments({ status: 'queued' }),
    notifications(db).countDocuments({
      status: 'failed',
      createdAt: { $gte: new Date(Date.now() - 86_400_000) },
    }),
  ]);
  lines.push(
    '# HELP isp_wallets_frozen Wallets frozen by reconciliation (balance ≠ ledger).',
    '# TYPE isp_wallets_frozen gauge',
    `isp_wallets_frozen ${frozen}`,
    '# HELP isp_sms_queued SMS waiting to be sent.',
    '# TYPE isp_sms_queued gauge',
    `isp_sms_queued ${smsQueued}`,
    '# HELP isp_sms_failed_24h SMS that failed after all retries in the last 24 hours.',
    '# TYPE isp_sms_failed_24h gauge',
    `isp_sms_failed_24h ${smsFailed}`,
  );
  const jobs = await db.collection<JobDoc>('_jobs').find({}).toArray();
  lines.push(
    '# HELP isp_job_last_success_timestamp_seconds Last successful run of a periodic job.',
    '# TYPE isp_job_last_success_timestamp_seconds gauge',
    ...jobs.map(
      (j) => `isp_job_last_success_timestamp_seconds{job="${j._id}"} ${(j.lastOkAt?.getTime() ?? 0) / 1000}`,
    ),
    '# HELP isp_job_duration_seconds Duration of the last run.',
    '# TYPE isp_job_duration_seconds gauge',
    ...jobs.map((j) => `isp_job_duration_seconds{job="${j._id}"} ${(j.durationMs ?? 0) / 1000}`),
    '# HELP isp_job_failing 1 when the last run of a job failed.',
    '# TYPE isp_job_failing gauge',
    ...jobs.map((j) => `isp_job_failing{job="${j._id}"} ${j.lastError ? 1 : 0}`),
  );
  return `${lines.join('\n')}\n`;
}

const server = createServer((req, res) => {
  const path = req.url?.split('?')[0];
  if (req.method !== 'GET') return void res.writeHead(405).end();
  if (path === '/metrics') {
    metrics().then(
      (body) => res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(body),
      () => res.writeHead(503).end(),
    );
  } else if (path === '/healthz') {
    const stale = Date.now() - worker.stats.lastPassAt > 30_000;
    Promise.all([db.command({ ping: 1 }), pool.query('SELECT 1')]).then(
      () =>
        res
          .writeHead(stale ? 503 : 200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ leader: worker.stats.leader, stale })),
      (e: Error) =>
        res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: e.message })),
    );
  } else res.writeHead(404).end();
});
server.listen(config.WORKERS_PORT, config.WORKERS_HOST);

async function shutdown() {
  log.info('stopping');
  server.close();
  scheduler.stop();
  await worker.stop();
  await Promise.allSettled([client.close(), pool.end()]);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

log.info({ port: config.WORKERS_PORT }, 'workers started');
scheduler.start();
await worker.start();
