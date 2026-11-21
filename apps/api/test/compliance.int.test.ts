import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { ObjectId } from 'mongodb';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
let admin: Client;
let support: Client;
let other: Client;
let sub: ObjectId;
let vlanSub: ObjectId;
const run = randomBytes(3).toString('hex');
const user = `nat-${run}`;
const vlanUser = `vlan-${run}`;
const oct = Number.parseInt(run.slice(0, 2), 16);
const routerIp = `198.19.${oct}.1`;
const otherRouter = `198.19.${oct}.2`;
const pub = `203.0.${oct}.9`;
const at = new Date(Date.now() - 3600_000);
const iso = (d: Date) => d.toISOString().replace('Z', '+00:00');

const line = (t: Date, router: string, ifc: string, priv: string, pport: number, pubPort: number) =>
  `${iso(t)} ${router} firewall,info ISPNAT srcnat: in:${ifc} out:ether1, src-mac 0c:aa:bb:cc:dd:ee, proto TCP (SYN), ` +
  `${priv}:${pport}->142.250.1.1:443, NAT (${priv}:${pport}->${pub}:${pubPort})->142.250.1.1:443, len 60`;

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'natarch-'));
  const day = at.toISOString().slice(0, 10);
  mkdirSync(join(root, routerIp));
  mkdirSync(join(root, otherRouter));
  writeFileSync(
    join(root, routerIp, `${day}.log.gz`),
    gzipSync(
      [
        line(at, routerIp, `<pppoe-${user}>`, '100.67.0.10', 51515, 40001),
        line(new Date(at.getTime() + 2000), routerIp, 'vlan20', '192.168.20.7', 5000, 40002),
        line(new Date(at.getTime() + 3 * 3600_000), routerIp, `<pppoe-${user}>`, '100.67.0.10', 1, 40001),
      ].join('\n') + '\n',
    ),
  );
  // Another ISP's router: must never show up.
  writeFileSync(
    join(root, otherRouter, `${day}.log`),
    line(at, otherRouter, '<pppoe-x>', '100.67.9.9', 1, 40001) + '\n',
  );

  h = await startHarness({ NAT_ARCHIVE_DIR: root });
  pgAdmin = new pg.Pool({ connectionString: process.env.RADIUS_ADMIN_URL });
  const t = await seedTenant(h.db, `nat${run}`, 'new.example.test');
  const t2 = await seedTenant(h.db, `natb${run}`);
  sub = await seedSubscriber(h, t, user);
  vlanSub = await seedSubscriber(h, t, vlanUser);
  admin = await signIn(
    h,
    await seedUser(h, { tenantId: t, email: 'a@n.in', roles: [await roleId(h.db, 'ISP Admin')], totp: true }),
  );
  support = await signIn(
    h,
    await seedUser(h, { tenantId: t, email: 's@n.in', roles: [await roleId(h.db, 'Support')] }),
  );
  other = await signIn(
    h,
    await seedUser(h, {
      tenantId: t2,
      email: 'a@m.in',
      roles: [await roleId(h.db, 'ISP Admin')],
      totp: true,
    }),
    `natb${run}`,
  );
  const tid = (
    await pgAdmin.query<{ id: number }>(
      'INSERT INTO tenants (external_id, slug, name) VALUES ($1, $2, $2) RETURNING id',
      [t.toHexString(), `nat${run}`],
    )
  ).rows[0]!.id;
  const tid2 = (
    await pgAdmin.query<{ id: number }>(
      'INSERT INTO tenants (external_id, slug, name) VALUES ($1, $2, $2) RETURNING id',
      [t2.toHexString(), `natb${run}`],
    )
  ).rows[0]!.id;
  await pgAdmin.query(
    "INSERT INTO nas (tenant_id, nasname, shortname, secret) VALUES ($1, $2, 'POP-N', 'secret-1234567')",
    [tid, routerIp],
  );
  await pgAdmin.query(
    "INSERT INTO nas (tenant_id, nasname, shortname, secret) VALUES ($1, $2, 'POP-B', 'secret-1234567')",
    [tid2, otherRouter],
  );
  // The VLAN customer is identified through its Radius session (private IP on that router at that time).
  await pgAdmin.query(
    `INSERT INTO radacct (tenant_id, acctsessionid, acctuniqueid, username, nasipaddress, acctstarttime, acctupdatetime, framedipaddress)
     VALUES ($1, 'x', $2, $3, $4, $5::timestamptz - interval '1 hour', now(), '192.168.20.7')`,
    [tid, randomBytes(8).toString('hex'), vlanUser, routerIp, at.toISOString()],
  );
});
afterAll(async () => {
  await pgAdmin?.end();
  await h?.close();
});

const q = (o: Record<string, string | number>) =>
  `/api/v1/compliance/nat-lookup?${new URLSearchParams(Object.entries(o).map(([k, v]): [string, string] => [k, String(v)])).toString()}`;

describe('NAT lookup', () => {
  it('public IP + port + time → the PPPoE customer, with router name; audited', async () => {
    const r = await admin.req('GET', q({ ip: pub, port: 40001, at: at.toISOString() }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ configured: true, truncated: false });
    expect(r.body.hits).toHaveLength(1);
    expect(r.body.hits[0]).toMatchObject({
      router: routerIp,
      routerName: 'POP-N',
      privateIp: '100.67.0.10',
      publicPort: 40001,
      username: user,
      subscriber: { id: sub.toHexString() },
    });
    await vi.waitFor(async () =>
      expect(await h.db.collection('audit_logs').countDocuments({ action: 'compliance.nat_lookup' })).toBe(1),
    );
  });

  it('without a port: every translation in the window; a VLAN customer is found through Radius', async () => {
    const r = await admin.req('GET', q({ ip: pub, at: at.toISOString(), windowMins: 2 }));
    expect(r.body.hits.map((x: { username: string }) => x.username)).toEqual([user, vlanUser]);
    expect(r.body.hits[1].subscriber).toMatchObject({ id: vlanSub.toHexString() });
  });

  it("another ISP sees only its own routers' logs; staff without the permission are refused", async () => {
    const r = await other.req('GET', q({ ip: pub, port: 40001, at: at.toISOString() }));
    expect(r.body.hits.map((x: { router: string }) => x.router)).toEqual([otherRouter]);
    expect((await support.req('GET', q({ ip: pub, at: at.toISOString() }))).status).toBe(403);
  });
});

describe('access log (who viewed a customer)', () => {
  it('records each view of a customer record and lists it for audit.view', async () => {
    expect((await support.req('GET', `/api/v1/subscribers/${sub.toHexString()}`)).status).toBe(200);
    await support.req('GET', `/api/v1/subscribers/${sub.toHexString()}/sessions`);
    await vi.waitFor(async () =>
      expect(await h.db.collection('access_logs').countDocuments({ 'entity.id': sub.toHexString() })).toBe(2),
    );
    const r = await admin.req('GET', `/api/v1/subscribers/${sub.toHexString()}/access-log`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.items.map((x: { route: string }) => x.route)).toEqual([
      'GET /api/v1/subscribers/:id/sessions',
      'GET /api/v1/subscribers/:id',
    ]);
    expect(r.body.items[0].actor).toMatchObject({ name: 's' });
    expect((await support.req('GET', `/api/v1/subscribers/${sub.toHexString()}/access-log`)).status).toBe(
      403,
    );
  });
});
