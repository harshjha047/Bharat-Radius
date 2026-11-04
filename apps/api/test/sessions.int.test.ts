import { randomBytes } from 'node:crypto';
import type { ObjectId } from 'mongodb';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  roleId,
  seedSubscriber,
  seedTenant,
  seedUser,
  signIn,
  startHarness,
  type Client,
  type Harness,
} from './harness.js';

let h: Harness;
let pgAdmin: pg.Pool;
let support: Client;
let other: Client;
let sub: ObjectId;
const run = randomBytes(3).toString('hex');
const user = `sess-${run}`;
const nasIp = `198.18.${Number.parseInt(run.slice(0, 2), 16)}.1`;

beforeAll(async () => {
  h = await startHarness();
  pgAdmin = new pg.Pool({ connectionString: process.env.RADIUS_ADMIN_URL });
  const t = await seedTenant(h.db, `sess${run}`, 'new.example.test');
  const t2 = await seedTenant(h.db, `othr${run}`);
  sub = await seedSubscriber(h, t, user);
  support = await signIn(
    h,
    await seedUser(h, { tenantId: t, email: 's@a.in', roles: [await roleId(h.db, 'Support')] }),
  );
  other = await signIn(
    h,
    await seedUser(h, { tenantId: t2, email: 's@b.in', roles: [await roleId(h.db, 'Support')] }),
    `othr${run}`,
  );

  // What FreeRADIUS and the worker would have written for this ISP.
  const tid = (
    await pgAdmin.query<{ id: number }>(
      'INSERT INTO tenants (external_id, slug, name) VALUES ($1, $2, $2) RETURNING id',
      [t.toHexString(), `sess${run}`],
    )
  ).rows[0]!.id;
  await pgAdmin.query(
    "INSERT INTO nas (tenant_id, nasname, shortname, secret) VALUES ($1, $2, 'POP-A', 'secret-1234567')",
    [tid, nasIp],
  );
  await pgAdmin.query(
    `INSERT INTO subscribers (external_id, tenant_id, username, password_enc)
     VALUES ($1, $2, $3, radius_encrypt_password('x', 'k'))`,
    [sub.toHexString(), tid, user],
  );
  const session = (start: string, update: string, stop: boolean, ip: string) =>
    pgAdmin.query(
      `INSERT INTO radacct (tenant_id, acctsessionid, acctuniqueid, username, nasipaddress, acctstarttime,
                            acctupdatetime, acctstoptime, framedipaddress, acctinputoctets, acctoutputoctets)
       VALUES ($1, 'x', $2, $3, $4, now() - $5::interval, now() - $6::interval,
               CASE WHEN $7 THEN now() - $6::interval END, $8, 6000000000, 42)`,
      [tid, randomBytes(8).toString('hex'), user, nasIp, start, update, stop, ip],
    );
  await session('1 hour', '1 minute', false, '100.66.0.10');
  await session('4 hours', '45 minutes', false, '100.66.0.11');
  await session('3 days', '2 days', true, '100.66.0.10');
  await pgAdmin.query(
    `INSERT INTO radpostauth (tenant_id, username, reply, reason, nasipaddress, authdate)
     VALUES ($1, $2, 'Access-Reject', 'MAC address not allowed', $3, now() - interval '2 minutes'),
            ($1, $2, 'Access-Accept', NULL, $3, now() - interval '1 minute')`,
    [tid, user, nasIp],
  );
});
afterAll(async () => {
  await pgAdmin?.end();
  await h?.close();
});

describe('sessions and logs', () => {
  it('live sessions page newest first, with subscriber link, router name, bytes and staleness', async () => {
    const p1 = await support.req('GET', '/api/v1/sessions/live?limit=1');
    expect(p1.status).toBe(200);
    expect(p1.body.items[0]).toMatchObject({
      username: user,
      subscriberId: sub.toHexString(),
      nasName: 'POP-A',
      framedIp: '100.66.0.10',
      uploadBytes: 6e9,
      downloadBytes: 42,
      stale: false,
    });
    const p2 = await support.req(
      'GET',
      `/api/v1/sessions/live?limit=1&cursor=${encodeURIComponent(p1.body.nextCursor)}`,
    );
    expect(p2.body.items[0]).toMatchObject({ framedIp: '100.66.0.11', stale: true });
    expect(p2.body.nextCursor).toBeNull();
    expect((await support.req('GET', '/api/v1/sessions/live?q=100.66.0.11')).body.items).toHaveLength(1);
  });

  it('summary counts online and stale sessions per router', async () => {
    const r = await support.req('GET', '/api/v1/sessions/summary');
    expect(r.body).toEqual({ online: 1, stale: 1, byNas: [{ nasIp, nasName: 'POP-A', online: 1 }] });
  });

  it('history and login attempts with the reject reason', async () => {
    const hist = await support.req('GET', `/api/v1/subscribers/${sub.toHexString()}/sessions`);
    expect(hist.body.items).toHaveLength(3);
    expect(hist.body.items[2].stoppedAt).not.toBeNull();
    const auth = await support.req('GET', `/api/v1/subscribers/${sub.toHexString()}/auth-log`);
    expect(
      auth.body.items.map((a: { accepted: boolean; reason: string | null }) => [a.accepted, a.reason]),
    ).toEqual([
      [true, null],
      [false, 'MAC address not allowed'],
    ]);
  });

  it('daily usage for the subscriber page', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const tid = (
      await pgAdmin.query<{ id: number }>('SELECT id FROM tenants WHERE external_id = $1', [
        (await h.db.collection('subscribers').findOne({ _id: sub }))!.tenantId.toHexString(),
      ])
    ).rows[0]!.id;
    await pgAdmin.query(
      'INSERT INTO usage_daily (tenant_id, username, day, bytes_in, bytes_out, session_secs) VALUES ($1, $2, $3, 10, 90, 60)',
      [tid, user, today],
    );
    const r = await support.req('GET', `/api/v1/subscribers/${sub.toHexString()}/usage`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      days: [{ day: today, uploadBytes: 10, downloadBytes: 90, sessionSecs: 60 }],
      cycle: null,
    });
  });

  it('who had an IP at a given time', async () => {
    const at = new Date(Date.now() - 2.5 * 86_400_000).toISOString();
    const r = await support.req('GET', `/api/v1/sessions/lookup?ip=100.66.0.10&at=${at}`);
    expect(r.body).toHaveLength(1);
    expect(r.body[0].username).toBe(user);
  });

  it('another ISP sees none of it', async () => {
    expect((await other.req('GET', '/api/v1/sessions/live')).body.items).toEqual([]);
    expect((await other.req('GET', '/api/v1/sessions/summary')).body.online).toBe(0);
    expect((await other.req('GET', `/api/v1/subscribers/${sub.toHexString()}/sessions`)).status).toBe(404);
    const at = new Date().toISOString();
    expect((await other.req('GET', `/api/v1/sessions/lookup?ip=100.66.0.10&at=${at}`)).body).toEqual([]);
  });
});
