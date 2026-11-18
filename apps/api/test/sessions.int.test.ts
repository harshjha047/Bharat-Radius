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
            ($1, $2, 'Access-Accept', NULL, $3, now() - interval '1 minute'),
            ($1, $4, 'Access-Reject', 'User not found', $3, now() - interval '3 minutes')`,
    [tid, user, nasIp, `${user}x`],
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

  it('activity: online users per hour vs last week, logins vs rejects per hour', async () => {
    const r = await support.req('GET', '/api/v1/sessions/activity');
    expect(r.status).toBe(200);
    const pts = r.body.points as { at: string; online: number; lastWeek: number }[];
    expect(pts).toHaveLength(25); // 24 IST hour starts + now
    expect(pts.at(-1)!.online).toBe(1); // the stale session no longer counts
    // The 4 h session (stale since ~30 min) was up for several of the earlier hour marks, alongside nothing else.
    expect(pts.slice(0, -1).filter((p) => p.online >= 1).length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...pts.map((p) => p.online))).toBeLessThanOrEqual(2);
    expect(pts.every((p) => p.lastWeek === 0)).toBe(true);
    const hours = r.body.hours as { hour: string; accepted: number; rejected: number }[];
    expect(hours).toHaveLength(24);
    expect(new Date(hours[0]!.hour).getUTCMinutes()).toBe(30); // IST hours start at :30 UTC
    expect(hours.reduce((n, x) => n + x.accepted, 0)).toBe(1);
    expect(hours.reduce((n, x) => n + x.rejected, 0)).toBe(2);
    // Another ISP sees none of it.
    const o = await other.req('GET', '/api/v1/sessions/activity');
    expect(o.body.points).toEqual([]);
    expect(o.body.hours.every((x: { accepted: number }) => x.accepted === 0)).toBe(true);
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

  it('ISP auth log: filters, reasons, Why? with similar usernames, live tail', async () => {
    const all = await support.req('GET', '/api/v1/radius/auth-log');
    expect(all.status).toBe(200);
    expect(all.body.items.map((e: { username: string }) => e.username)).toEqual([user, user, `${user}x`]);
    expect(all.body.items[0]).toMatchObject({
      accepted: true,
      nasName: 'POP-A',
      subscriberId: sub.toHexString(),
    });
    const rej = await support.req('GET', '/api/v1/radius/auth-log?result=reject&limit=1');
    expect(rej.body.items).toHaveLength(1);
    expect(rej.body.items[0].reason).toBe('MAC address not allowed');
    const page2 = await support.req(
      'GET',
      `/api/v1/radius/auth-log?result=reject&limit=1&cursor=${encodeURIComponent(rej.body.nextCursor)}`,
    );
    expect(page2.body.items[0].reason).toBe('User not found');
    expect(page2.body.nextCursor).toBeNull();
    const byReason = await support.req('GET', '/api/v1/radius/auth-log?reason=User%20not%20found');
    expect(byReason.body.items).toHaveLength(1);

    const sum = await support.req('GET', '/api/v1/radius/auth-log/summary');
    expect(sum.body).toMatchObject({ accepted: 1, rejected: 2 });
    expect(sum.body.reasons).toEqual(
      expect.arrayContaining([{ reason: 'User not found', accepted: false, count: 1 }]),
    );

    const nf = page2.body.items[0];
    const why = await support.req('GET', `/api/v1/radius/auth-log/why?id=${encodeURIComponent(nf.id)}`);
    expect(why.status, JSON.stringify(why.body)).toBe(200);
    expect(why.body).toMatchObject({ category: 'not_found', subscriber: null });
    expect(why.body.similar[0]).toEqual({ username: user, subscriberId: sub.toHexString() });
    const mac = rej.body.items[0];
    const why2 = await support.req('GET', `/api/v1/radius/auth-log/why?id=${encodeURIComponent(mac.id)}`);
    expect(why2.body).toMatchObject({
      category: 'mac',
      subscriber: { username: user },
      last24h: { accepted: 1, rejected: 1 },
    });

    const after = encodeURIComponent(new Date(Date.now() - 10 * 60_000).toISOString());
    const tail = await support.req('GET', `/api/v1/radius/tail?after=${after}`);
    expect(tail.body.events.map((e: { type: string }) => e.type)).toEqual(['reject', 'reject', 'accept']);
    const mine = await support.req('GET', `/api/v1/radius/tail?after=${after}&user=${user}x`);
    expect(mine.body.events).toHaveLength(1);
    expect((await support.req('GET', '/api/v1/radius/auth-log?from=2026-01-01&to=2026-03-01')).status).toBe(
      400,
    );
  });

  it('another ISP sees none of it', async () => {
    expect((await other.req('GET', '/api/v1/sessions/live')).body.items).toEqual([]);
    expect((await other.req('GET', '/api/v1/sessions/summary')).body.online).toBe(0);
    expect((await other.req('GET', '/api/v1/radius/auth-log')).body.items).toEqual([]);
    expect((await other.req('GET', '/api/v1/radius/tail')).body.events).toEqual([]);
    expect((await other.req('GET', `/api/v1/subscribers/${sub.toHexString()}/sessions`)).status).toBe(404);
    const at = new Date().toISOString();
    expect((await other.req('GET', `/api/v1/sessions/lookup?ip=100.66.0.10&at=${at}`)).body).toEqual([]);
  });
});
