import { createServer } from 'node:http';
import { MongoClient } from 'mongodb';
import pg from 'pg';
import { createHealth, type CheckFn } from './health.js';

const port = Number(process.env.API_PORT ?? 4000);
const host = process.env.API_HOST ?? '127.0.0.1';
const version = process.env.APP_VERSION ?? 'dev';
const checks: Record<string, CheckFn> = {};

let mongo: MongoClient | undefined;
if (process.env.MONGO_URL) {
  mongo = new MongoClient(process.env.MONGO_URL, { maxPoolSize: 20, serverSelectionTimeoutMS: 1000 });
  const m = mongo;
  checks.mongo = async () => {
    const hello = await m.db('admin').command({ hello: 1 });
    return { setName: hello.setName, isWritablePrimary: hello.isWritablePrimary };
  };
}

let radius: pg.Pool | undefined;
if (process.env.RADIUS_DB_URL) {
  radius = new pg.Pool({
    connectionString: process.env.RADIUS_DB_URL,
    max: Number(process.env.RADIUS_DB_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 1000,
    application_name: 'isp-api',
  });
  const r = radius;
  checks.radiusDb = async () => {
    const { rows } = await r.query<{ ssl: boolean; nas: string }>(
      'SELECT coalesce((SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()), false) AS ssl, (SELECT count(*) FROM nas)::text AS nas',
    );
    return { ssl: rows[0]?.ssl, routers: Number(rows[0]?.nas) };
  };
}

const health = createHealth(checks, version);

const server = createServer((req, res) => {
  const path = req.url?.split('?')[0];
  if (req.method === 'GET' && (path === '/healthz' || path === '/api/healthz')) {
    health().then(
      (report) => {
        res.writeHead(report.status === 'ok' ? 200 : 503, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        });
        res.end(JSON.stringify(report));
      },
      () => {
        res.writeHead(500).end();
      },
    );
    return;
  }
  if (req.method === 'GET' && path === '/livez') {
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('ok');
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"code":"NOT_FOUND"}}');
});
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.listen(port, host);

async function shutdown() {
  server.close();
  await Promise.allSettled([mongo?.close(), radius?.end()]);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
