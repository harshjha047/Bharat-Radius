import { isIP } from 'node:net';
import { Controller, Get, Inject, Injectable, Query } from '@nestjs/common';
import { z } from 'zod';
import { USERNAME_COLLATION, type MongoHandle, type PlanDoc, type SubscriberDoc } from '@isp/db-mongo';
import type { AuthContext } from '../auth/context.js';
import { CONFIG, type Config } from '../config.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { Ctx, Endpoint } from '../http/endpoint.js';
import { hexId } from '../http/schemas.js';
import { MONGO } from '../infra/infra.module.js';
import { SessionsService, type BranchNet } from './sessions.js';

const ip = z.string().refine((s) => isIP(s) !== 0, 'must be an IP');
const tenantQuery = z.object({ tenantId: hexId.optional() });
const cursor = z
  .string()
  .regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z_\d+$/, 'invalid cursor')
  .optional();
const MAX_RANGE_DAYS = 31;
const IST_MS = 330 * 60_000;

const listQuery = tenantQuery.extend({
  /** Username or MAC prefix. */
  q: z.string().trim().min(1).max(64).optional(),
  result: z.enum(['accept', 'reject']).optional(),
  reason: z.string().trim().min(1).max(200).optional(),
  nasIp: ip.optional(),
  /** Default: the last 24 hours. At most 31 days. */
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor,
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const summaryQuery = tenantQuery.extend({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
/** `id` as returned in the list (`<authdate µs>_<row id>`). */
const whyQuery = tenantQuery.extend({
  id: z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z_\d+$/, 'invalid id'),
});
const tailQuery = tenantQuery.extend({
  /** Events at or after this time (client drops ids it already has). Default: the last 2 minutes. */
  after: z.coerce.date().optional(),
  user: z.string().trim().min(1).max(64).optional(),
  type: z.enum(['all', 'auth', 'acct']).default('all'),
});

const entryView = z.object({
  id: z.string(),
  at: z.string(),
  username: z.string(),
  subscriberId: z.string().nullable(),
  accepted: z.boolean(),
  reason: z.string().nullable(),
  nasIp: z.string(),
  nasName: z.string().nullable(),
  mac: z.string().nullable(),
});
const listView = z.object({ items: z.array(entryView), nextCursor: z.string().nullable() });
const summaryView = z.object({
  accepted: z.number(),
  rejected: z.number(),
  reasons: z.array(z.object({ reason: z.string(), accepted: z.boolean(), count: z.number() })),
  /** Accepted / rejected per hour (IST hour start, every hour of the period, oldest first); empty past 48 h. */
  byHour: z.array(z.object({ hour: z.string(), accepted: z.number(), rejected: z.number() })),
});
const whyView = z.object({
  entry: entryView,
  category: z.enum([
    'accepted',
    'expired',
    'not_found',
    'wrong_password',
    'suspended',
    'disabled',
    'isp_suspended',
    'mac',
    'already_online',
    'username_format',
    'other',
  ]),
  title: z.string(),
  explanation: z.string(),
  fix: z.string(),
  subscriber: z
    .object({
      id: z.string(),
      name: z.string(),
      username: z.string(),
      status: z.string(),
      expiresAt: z.string().nullable(),
      plan: z.string().nullable(),
      macLock: z.string().nullable(),
    })
    .nullable(),
  similar: z.array(z.object({ username: z.string(), subscriberId: z.string().nullable() })),
  last24h: z.object({ accepted: z.number(), rejected: z.number() }),
  /** F-17: the router itself looks misconfigured (wrong shared secret), not the customer. */
  routerHint: z.string().nullable(),
});

const problemsView = z.object({
  routers: z.array(
    z.object({
      nasIp: z.string(),
      name: z.string(),
      lastAuthAt: z.string().nullable(),
      accepted24h: z.number(),
      rejected24h: z.number(),
      /** Packets dropped because the router's shared secret differs from the panel's (last 24 h, at least). */
      badSecret: z.object({ packets: z.number(), lastSeen: z.string() }).nullable(),
      /** PAP logins can't show a wrong secret directly: 3+ different users "wrong password" and no accept in 1 h. */
      suspectSecret: z.boolean(),
      problem: z.enum(['bad_secret', 'suspect_secret', 'silent']).nullable(),
    }),
  ),
  problems: z.number(),
});
const addressQuery = tenantQuery.extend({ ip });
const addressView = z.object({
  ip: z.string(),
  /** `mine`: one of the caller's routers; `other`: registered to another ISP; `none`: not a router. */
  registered: z.enum(['mine', 'other', 'none']),
  routerName: z.string().nullable(),
  events: z.array(
    z.object({
      kind: z.enum(['unknown_client', 'firewall_block', 'bad_secret']),
      port: z.number(),
      packets: z.number(),
      firstSeen: z.string(),
      lastSeen: z.string(),
    }),
  ),
  verdict: z.string(),
  radius: z.object({ host: z.string().nullable(), authPort: z.number(), acctPort: z.number() }),
});
const unknownView = z.object({
  items: z.array(
    z.object({
      ip: z.string(),
      kind: z.enum(['unknown_client', 'firewall_block']),
      port: z.number(),
      packets: z.number(),
      lastSeen: z.string(),
    }),
  ),
});
const tailView = z.object({
  now: z.string(),
  events: z.array(
    z.object({
      id: z.string(),
      at: z.string(),
      type: z.enum(['accept', 'reject', 'start', 'stop']),
      username: z.string(),
      nasIp: z.string(),
      detail: z.string().nullable(),
    }),
  ),
});

type Entry = z.output<typeof entryView>;
type Why = z.output<typeof whyView>;

interface Row {
  id: string;
  key: string;
  authdate: Date;
  username: string;
  subscriber_ext: string | null;
  reply: string;
  reason: string | null;
  nasip: string;
  shortname: string | null;
  callingstationid: string | null;
}

const PG_ISO = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const COLUMNS = `p.id, ${PG_ISO('p.authdate')} AS key, p.authdate, p.username, s.external_id AS subscriber_ext,
  p.reply, p.reason, host(p.nasipaddress) AS nasip, n.shortname, p.callingstationid`;
const JOINS = `LEFT JOIN subscribers s ON s.tenant_id = p.tenant_id AND s.username = p.username
  LEFT JOIN nas n ON n.nasname = p.nasipaddress AND n.tenant_id = p.tenant_id`;

const toEntry = (r: Row): Entry => ({
  id: `${r.key}_${r.id}`,
  at: r.authdate.toISOString(),
  username: r.username,
  subscriberId: r.subscriber_ext,
  accepted: r.reply === 'Access-Accept',
  reason: r.reason,
  nasIp: r.nasip,
  nasName: r.shortname,
  mac: r.callingstationid,
});

/** Plain-language cause and fix for a logged reason (TRD §5.2 reasons, Radius engine module messages). */
export function explain(
  reason: string | null,
  accepted: boolean,
): Pick<Why, 'category' | 'title' | 'explanation' | 'fix'> {
  const r = (reason ?? '').toLowerCase();
  if (accepted) {
    return r.includes('expired')
      ? {
          category: 'expired',
          title: 'Logged in on the expired speed',
          explanation:
            'Validity has run out; the ISP keeps expired customers online slowly and sends them to the pay page.',
          fix: 'Recharge the customer; speed returns without a redial.',
        }
      : {
          category: 'accepted',
          title: 'Login accepted',
          explanation: 'Password, status and limits were all fine.',
          fix: 'Nothing to do. If the customer still has no internet, check the router and the line.',
        };
  }
  const c = (category: Why['category'], title: string, explanation: string, fix: string) => ({
    category,
    title,
    explanation,
    fix,
  });
  if (r.includes('expired'))
    return c(
      'expired',
      'Validity has run out',
      'The account is past its expiry date (or has no plan), and this ISP refuses expired logins.',
      'Recharge the customer. The router redials on its own within a minute.',
    );
  if (r.includes('user not found'))
    return c(
      'not_found',
      'No such username',
      'No active subscriber of this ISP has this username. Usually a typing mistake in the customer router, a deleted account, or the router belongs to another ISP.',
      'Compare with the similar usernames below and correct the PPPoE username in the customer router, or create the subscriber.',
    );
  if (r.includes('password') || r.includes('chap') || r.includes('mschap') || r.includes('pap'))
    return c(
      'wrong_password',
      'Wrong password',
      'The username exists but the password the customer router sent does not match.',
      'Subscriber → ⋯ → Show PPPoE password, and set the same password in the customer router.',
    );
  if (r.includes('service provider'))
    return c(
      'isp_suspended',
      'ISP suspended',
      'The whole ISP account is suspended on the platform.',
      'Contact the platform administrator.',
    );
  if (r.includes('suspended'))
    return c(
      'suspended',
      'Account suspended',
      'Staff or the overdue job suspended this subscriber.',
      'Clear the dues or activate the subscriber.',
    );
  if (r.includes('disabled'))
    return c('disabled', 'Account disabled', 'The subscriber is disabled.', 'Activate the subscriber.');
  if (r.includes('mac'))
    return c(
      'mac',
      'Different device (MAC lock)',
      'The subscriber is locked to one MAC address and this login came from another device.',
      'If the customer changed the router, update or clear the MAC lock on the subscriber.',
    );
  if (r.includes('already logged in'))
    return c(
      'already_online',
      'Already online',
      'The login limit is reached: a session for this username is still open (often the old session after a power cut).',
      'Kick the old session from Online now, or wait up to 15 minutes until it times out.',
    );
  if (r.includes('realm') || r.includes('rejected:'))
    return c(
      'username_format',
      'Username format not allowed',
      'The username contains characters Radius refuses (spaces, a dot right after @, control characters).',
      'Fix the PPPoE username in the customer router.',
    );
  return c(
    'other',
    'Rejected',
    reason ?? 'No reason recorded.',
    'Check the subscriber and the router; contact support with the time of this attempt.',
  );
}

function range(from?: Date, to?: Date): [Date, Date] {
  const end = to ?? new Date();
  const start = from ?? new Date(end.getTime() - 86_400_000);
  if (start > end) throw new AppError(400, 'VALIDATION_FAILED', 'from must be before to');
  if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * 86_400_000) {
    throw new AppError(400, 'VALIDATION_FAILED', `Choose at most ${MAX_RANGE_DAYS} days`);
  }
  return [start, end];
}

@Injectable()
export class RadiusLogService {
  constructor(
    @Inject(MONGO) private readonly mongo: MongoHandle,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  /** Resellers get their branch: their customers' logins plus everything on routers they added. */
  private async tenant(ctx: AuthContext, requested?: string) {
    const { mongoId, branch } = await this.sessions.scopeFor(ctx, requested);
    return { mongoId, branch, pg: await this.sessions.pgTenant(mongoId) };
  }

  private static mine(b: BranchNet | null, params: unknown[], alias = ''): string {
    if (!b) return '';
    const col = alias ? `${alias}.` : '';
    const u = params.push(b.usernames);
    const n = params.push(b.ownIps);
    return `AND (${col}username = ANY($${u}::text[]) OR ${col}nasipaddress = ANY($${n}::inet[]))`;
  }

  private static sees(b: BranchNet | null, username: string, nasIp: string) {
    return (
      !b ||
      b.ownIps.includes(nasIp) ||
      b.usernames.includes(username) ||
      b.usernames.includes(username.toLowerCase())
    );
  }

  async list(ctx: AuthContext, q: z.output<typeof listQuery>) {
    const { pg: t, branch } = await this.tenant(ctx, q.tenantId);
    if (!t) return { items: [], nextCursor: null };
    const [from, to] = range(q.from, q.to);
    const params: unknown[] = [t.id, from, to];
    const where = ['p.tenant_id = $1', 'p.authdate >= $2', 'p.authdate <= $3'];
    const mine = RadiusLogService.mine(branch, params, 'p');
    if (mine) where.push(mine.slice(4));
    if (q.result)
      where.push(q.result === 'accept' ? "p.reply = 'Access-Accept'" : "p.reply <> 'Access-Accept'");
    if (q.reason) where.push(`p.reason = $${params.push(q.reason)}`);
    if (q.nasIp) where.push(`p.nasipaddress = $${params.push(q.nasIp)}::inet`);
    if (q.q) {
      const n = params.push(`${q.q.replace(/[\\%_]/g, '\\$&')}%`);
      where.push(`(p.username ILIKE $${n} OR p.callingstationid ILIKE $${n})`);
    }
    if (q.cursor) {
      const i = q.cursor.lastIndexOf('_');
      const a = params.push(q.cursor.slice(0, i));
      const b = params.push(q.cursor.slice(i + 1));
      where.push(`(p.authdate, p.id) < ($${a}::timestamptz, $${b}::bigint)`);
    }
    const limit = params.push(q.limit + 1);
    const { rows } = await this.sessions.db().query<Row>(
      `SELECT ${COLUMNS} FROM radpostauth p ${JOINS}
        WHERE ${where.join(' AND ')}
        ORDER BY p.authdate DESC, p.id DESC LIMIT $${limit}`,
      params,
    );
    const items = rows.slice(0, q.limit).map(toEntry);
    return { items, nextCursor: rows.length > q.limit ? items[items.length - 1]!.id : null };
  }

  async summary(ctx: AuthContext, q: z.output<typeof summaryQuery>) {
    const { pg: t, branch } = await this.tenant(ctx, q.tenantId);
    const [from, to] = range(q.from, q.to);
    const hourly = to.getTime() - from.getTime() <= 48 * 3_600_000;
    const hourMs = 3_600_000;
    const firstHour = Math.floor((from.getTime() + IST_MS) / hourMs) * hourMs - IST_MS;
    const hours = hourly
      ? Array.from({ length: Math.floor((to.getTime() - firstHour) / hourMs) + 1 }, (_, i) =>
          new Date(firstHour + i * hourMs).toISOString(),
        )
      : [];
    if (!t) {
      return {
        accepted: 0,
        rejected: 0,
        reasons: [],
        byHour: hours.map((hour) => ({ hour, accepted: 0, rejected: 0 })),
      };
    }
    const params: unknown[] = [t.id, from, to];
    const mine = RadiusLogService.mine(branch, params);
    const db = this.sessions.db();
    const [{ rows }, perHour] = await Promise.all([
      db.query<{ reason: string | null; accepted: boolean; n: string }>(
        `SELECT reason, reply = 'Access-Accept' AS accepted, count(*) AS n
           FROM radpostauth
          WHERE tenant_id = $1 AND authdate >= $2 AND authdate <= $3 ${mine}
          GROUP BY 1, 2 ORDER BY 3 DESC`,
        params,
      ),
      hourly
        ? db.query<{ hour: Date; accepted: string; rejected: string }>(
            `SELECT date_trunc('hour', authdate AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata' AS hour,
                    count(*) FILTER (WHERE reply = 'Access-Accept') AS accepted,
                    count(*) FILTER (WHERE reply <> 'Access-Accept') AS rejected
               FROM radpostauth
              WHERE tenant_id = $1 AND authdate >= $2 AND authdate <= $3 ${mine}
              GROUP BY 1`,
            params,
          )
        : Promise.resolve({ rows: [] }),
    ]);
    const counted = new Map(perHour.rows.map((r) => [r.hour.toISOString(), r]));
    return {
      byHour: hours.map((hour) => {
        const r = counted.get(hour);
        return { hour, accepted: Number(r?.accepted ?? 0), rejected: Number(r?.rejected ?? 0) };
      }),
      accepted: rows.filter((r) => r.accepted).reduce((s, r) => s + Number(r.n), 0),
      rejected: rows.filter((r) => !r.accepted).reduce((s, r) => s + Number(r.n), 0),
      reasons: rows
        .filter((r) => r.reason)
        .map((r) => ({ reason: r.reason!, accepted: r.accepted, count: Number(r.n) })),
    };
  }

  async why(ctx: AuthContext, q: z.output<typeof whyQuery>): Promise<Why> {
    const { mongoId, pg: t, branch } = await this.tenant(ctx, q.tenantId);
    if (!t) throw notFound('Log entry');
    const db = this.sessions.db();
    const sep = q.id.lastIndexOf('_');
    const { rows } = await db.query<Row>(
      `SELECT ${COLUMNS} FROM radpostauth p ${JOINS}
        WHERE p.tenant_id = $1 AND p.id = $2::bigint AND p.authdate = $3::timestamptz`,
      [t.id, q.id.slice(sep + 1), q.id.slice(0, sep)],
    );
    const row = rows[0];
    if (!row || !RadiusLogService.sees(branch, row.username, row.nasip)) throw notFound('Log entry');
    const entry = toEntry(row);
    const base = explain(row.reason, entry.accepted);

    const [sub, counts, similar] = await Promise.all([
      this.mongo.db.collection<SubscriberDoc>('subscribers').findOne(
        {
          tenantId: mongoId,
          username: row.username,
          status: { $ne: 'deleted' },
          ...(branch ? { $or: [{ resellerId: branch.resellerId }, { ancestors: branch.resellerId }] } : {}),
        },
        {
          collation: USERNAME_COLLATION,
          projection: { name: 1, username: 1, status: 1, expiresAt: 1, planId: 1, network: 1 },
        },
      ),
      db.query<{ accepted: string; rejected: string }>(
        `SELECT count(*) FILTER (WHERE reply = 'Access-Accept') AS accepted,
                count(*) FILTER (WHERE reply <> 'Access-Accept') AS rejected
           FROM radpostauth
          WHERE tenant_id = $1 AND username = $2 AND authdate > now() - interval '24 hours'`,
        [t.id, row.username],
      ),
      base.category === 'not_found'
        ? db.query<{ username: string; external_id: string | null }>(
            `SELECT username, external_id FROM subscribers
              WHERE tenant_id = $1 AND lower(username) % lower($2) ${branch ? 'AND username = ANY($3::text[])' : ''}
              ORDER BY similarity(lower(username), lower($2)) DESC, username LIMIT 5`,
            branch ? [t.id, row.username, branch.usernames] : [t.id, row.username],
          )
        : Promise.resolve({ rows: [] as { username: string; external_id: string | null }[] }),
    ]);
    const [plan, health] = await Promise.all([
      sub?.planId
        ? this.mongo.db.collection<PlanDoc>('plans').findOne({ _id: sub.planId }, { projection: { name: 1 } })
        : null,
      !entry.accepted &&
      (base.category === 'wrong_password' || base.category === 'other') &&
      (!branch || branch.ownIps.includes(entry.nasIp))
        ? this.routerHealth(t.id, [entry.nasIp])
        : null,
    ]);
    const h = health?.[0];
    const routerHint = h?.badSecret
      ? `Router ${h.name} (${h.nasIp}) is sending with a different Radius secret than the panel has (${h.badSecret.packets}+ packets in 24 h). Fix the secret on the router, not the customer password.`
      : h?.suspectSecret
        ? `Several different customers on ${h.name} (${h.nasIp}) failed with "wrong password" in the last hour and nobody logged in: the router's Radius secret is probably wrong.`
        : null;
    return {
      entry,
      ...base,
      routerHint,
      subscriber: sub
        ? {
            id: sub._id.toHexString(),
            name: sub.name,
            username: sub.username ?? row.username,
            status: sub.status,
            expiresAt: sub.expiresAt?.toISOString() ?? null,
            plan: plan?.name ?? null,
            macLock: sub.network?.macLock ?? null,
          }
        : null,
      similar: similar.rows.map((r) => ({ username: r.username, subscriberId: r.external_id })),
      last24h: {
        accepted: Number(counts.rows[0]?.accepted ?? 0),
        rejected: Number(counts.rows[0]?.rejected ?? 0),
      },
    };
  }

  /** Per router of the ISP: last 24 h traffic, wrong-secret drops, PAP wrong-secret pattern. `only` = these IPs. */
  private async routerHealth(pgTenant: number, only?: string[]) {
    const db = this.sessions.db();
    const { rows } = await db.query<{
      nasip: string;
      name: string;
      last_at: Date | null;
      acc: string;
      rej: string;
      bad_packets: string | null;
      bad_last: Date | null;
      wp_users: string;
      acc_1h: string;
    }>(
      `SELECT host(n.nasname) AS nasip, n.shortname AS name, a.last_at, coalesce(a.acc, 0) AS acc,
              coalesce(a.rej, 0) AS rej, e.packets AS bad_packets, e.last AS bad_last,
              coalesce(h.wp_users, 0) AS wp_users, coalesce(h.acc, 0) AS acc_1h
         FROM nas n
         LEFT JOIN LATERAL (
           SELECT max(authdate) AS last_at,
                  count(*) FILTER (WHERE reply = 'Access-Accept') AS acc,
                  count(*) FILTER (WHERE reply <> 'Access-Accept') AS rej
             FROM radpostauth
            WHERE tenant_id = n.tenant_id AND nasipaddress = n.nasname AND authdate > now() - interval '24 hours'
         ) a ON true
         LEFT JOIN LATERAL (
           SELECT sum(packets) AS packets, max(minute) AS last
             FROM radius_events
            WHERE kind = 'bad_secret' AND src_ip = n.nasname AND minute > now() - interval '24 hours'
         ) e ON true
         LEFT JOIN LATERAL (
           SELECT count(DISTINCT username) FILTER (WHERE reply <> 'Access-Accept' AND reason ILIKE '%password%') AS wp_users,
                  count(*) FILTER (WHERE reply = 'Access-Accept') AS acc
             FROM radpostauth
            WHERE tenant_id = n.tenant_id AND nasipaddress = n.nasname AND authdate > now() - interval '1 hour'
         ) h ON true
        WHERE n.tenant_id = $1 ${only ? 'AND n.nasname = ANY($2::inet[])' : ''}
        ORDER BY n.shortname`,
      only ? [pgTenant, only] : [pgTenant],
    );
    return rows.map((r) => {
      const badSecret =
        r.bad_packets && Number(r.bad_packets) > 0
          ? { packets: Number(r.bad_packets), lastSeen: r.bad_last!.toISOString() }
          : null;
      const suspectSecret = !badSecret && Number(r.wp_users) >= 3 && Number(r.acc_1h) === 0;
      return {
        nasIp: r.nasip,
        name: r.name,
        lastAuthAt: r.last_at?.toISOString() ?? null,
        accepted24h: Number(r.acc),
        rejected24h: Number(r.rej),
        badSecret,
        suspectSecret,
        problem: badSecret
          ? ('bad_secret' as const)
          : suspectSecret
            ? ('suspect_secret' as const)
            : !r.last_at
              ? ('silent' as const)
              : null,
      };
    });
  }

  async problems(ctx: AuthContext, q: z.output<typeof tenantQuery>) {
    const { pg: t, branch } = await this.tenant(ctx, q.tenantId);
    if (!t || (branch && !branch.ownIps.length)) return { routers: [], problems: 0 };
    // Resellers: only routers they added (counts on shared routers include other resellers' customers).
    const routers = await this.routerHealth(t.id, branch?.ownIps);
    return { routers, problems: routers.filter((r) => r.problem && r.problem !== 'silent').length };
  }

  /** Is anything arriving from this address, and why is Radius not answering it? Exact address only. */
  async address(ctx: AuthContext, q: z.output<typeof addressQuery>) {
    if (ctx.scope.kind === 'branch') throw forbidden('Ask the ISP to check router addresses');
    const platform = ctx.scope.kind === 'platform' && !q.tenantId;
    const t = platform ? null : (await this.tenant(ctx, q.tenantId)).pg;
    const db = this.sessions.db();
    const [nas, ev] = await Promise.all([
      db.query<{ tenant_id: number; shortname: string }>(
        'SELECT tenant_id, shortname FROM nas WHERE nasname = $1::inet',
        [q.ip],
      ),
      db.query<{
        kind: 'unknown_client' | 'firewall_block' | 'bad_secret';
        port: number;
        packets: string;
        first: Date;
        last: Date;
      }>(
        `SELECT kind, dst_port AS port, sum(packets) AS packets, min(minute) AS first, max(minute) AS last
           FROM radius_events WHERE src_ip = $1::inet AND minute > now() - interval '7 days'
          GROUP BY 1, 2 ORDER BY max(minute) DESC`,
        [q.ip],
      ),
    ]);
    const n = nas.rows[0];
    const registered = !n ? 'none' : t && n.tenant_id === t.id ? 'mine' : 'other';
    // Another ISP's router: do not show its traffic.
    const events =
      registered === 'other' && !platform
        ? []
        : ev.rows.map((e) => ({
            kind: e.kind,
            port: e.port,
            packets: Number(e.packets),
            firstSeen: e.first.toISOString(),
            lastSeen: e.last.toISOString(),
          }));
    const kinds = new Set(events.map((e) => e.kind));
    const { host, authPort, acctPort } = this.config.radiusTarget;
    const target = { host, authPort, acctPort };
    const verdict =
      registered === 'other' && !platform
        ? 'This address is a router of another ISP on this platform.'
        : registered === 'mine' && kinds.has('bad_secret')
          ? 'Packets arrive, but the Radius secret on the router does not match the panel. Set the same secret on both.'
          : registered === 'mine'
            ? 'This is one of your routers and its packets are accepted. If customers still fail, open the Radius log.'
            : kinds.size
              ? 'Packets from this address reach the server, but it is not a router in the panel. Add a router with exactly this address (the one the server sees, after any NAT).'
              : 'Nothing has arrived from this address in 7 days. Check the Radius server address and ports on the router, and that this is the address the router sends from (after NAT).';
    return {
      ip: q.ip,
      registered: registered as 'mine' | 'other' | 'none',
      routerName: registered === 'mine' ? n!.shortname : null,
      events,
      verdict,
      radius: target,
    };
  }

  /** Super-admin: addresses sending Radius that are not a router of any ISP (last 24 h). */
  async unknown() {
    const { rows } = await this.sessions.db().query<{
      ip: string;
      kind: 'unknown_client' | 'firewall_block';
      port: number;
      packets: string;
      last: Date;
    }>(
      `SELECT host(src_ip) AS ip, kind, dst_port AS port, sum(packets) AS packets, max(minute) AS last
         FROM radius_events
        WHERE kind IN ('unknown_client', 'firewall_block') AND minute > now() - interval '24 hours'
        GROUP BY 1, 2, 3 ORDER BY max(minute) DESC LIMIT 200`,
    );
    return {
      items: rows.map((r) => ({
        ip: r.ip,
        kind: r.kind,
        port: r.port,
        packets: Number(r.packets),
        lastSeen: r.last.toISOString(),
      })),
    };
  }

  /** New auth and accounting events since `after` (polled every ~2 s by the live log), oldest first, ≤ 500. */
  async tail(ctx: AuthContext, q: z.output<typeof tailQuery>) {
    const { pg: t, branch } = await this.tenant(ctx, q.tenantId);
    const now = new Date();
    if (!t) return { now: now.toISOString(), events: [] };
    const after =
      q.after && q.after > new Date(now.getTime() - 3_600_000) ? q.after : new Date(now.getTime() - 120_000);
    const db = this.sessions.db();
    const user = q.user ? `${q.user.replace(/[\\%_]/g, '\\$&')}%` : null;
    const params: unknown[] = user ? [t.id, after, user] : [t.id, after];
    const mine = RadiusLogService.mine(branch, params);
    const userSql = (col: string) => `${user ? `AND ${col} ILIKE $3` : ''} ${mine}`;
    const [auth, acct] = await Promise.all([
      q.type === 'acct'
        ? Promise.resolve({ rows: [] })
        : db.query<{
            id: string;
            at: Date;
            username: string;
            nasip: string;
            reply: string;
            reason: string | null;
            mac: string | null;
          }>(
            `SELECT id, authdate AS at, username, host(nasipaddress) AS nasip, reply, reason, callingstationid AS mac
               FROM radpostauth
              WHERE tenant_id = $1 AND authdate >= $2 ${userSql('username')}
              ORDER BY authdate LIMIT 500`,
            params,
          ),
      q.type === 'auth'
        ? Promise.resolve({ rows: [] })
        : db.query<{
            id: string;
            kind: 'start' | 'stop';
            at: Date;
            username: string;
            nasip: string;
            ip: string | null;
            cause: string | null;
          }>(
            `(SELECT radacctid AS id, 'start' AS kind, acctstarttime AS at, username, host(nasipaddress) AS nasip,
                     host(framedipaddress) AS ip, NULL AS cause
                FROM radacct WHERE tenant_id = $1 AND acctstarttime >= $2 ${userSql('username')}
               ORDER BY acctstarttime LIMIT 500)
             UNION ALL
             (SELECT radacctid, 'stop', acctstoptime, username, host(nasipaddress), host(framedipaddress),
                     acctterminatecause
                FROM radacct WHERE acctstoptime >= $2 AND tenant_id = $1 ${userSql('username')}
               ORDER BY acctstoptime LIMIT 500)`,
            params,
          ),
    ]);
    const events = [
      ...auth.rows.map((r) => ({
        id: `a${r.id}`,
        at: r.at.toISOString(),
        type: r.reply === 'Access-Accept' ? ('accept' as const) : ('reject' as const),
        username: r.username,
        nasIp: r.nasip,
        detail: [r.reason, r.mac].filter(Boolean).join(' · ') || null,
      })),
      ...acct.rows.map((r) => ({
        id: `${r.kind === 'start' ? 's' : 'e'}${r.id}`,
        at: r.at.toISOString(),
        type: r.kind,
        username: r.username,
        nasIp: r.nasip,
        detail: [r.ip, r.cause].filter(Boolean).join(' · ') || null,
      })),
    ]
      .sort((a, b) => a.at.localeCompare(b.at))
      .slice(0, 500);
    return { now: now.toISOString(), events };
  }
}

@Controller()
export class RadiusLogController {
  constructor(@Inject(RadiusLogService) private readonly log: RadiusLogService) {}

  @Get('radius/auth-log')
  @Endpoint({
    summary:
      'Every login attempt of the ISP (search, Accept/Reject, reason, router, date range; default 24 h)',
    tags: ['sessions'],
    permission: 'sessions.read',
    query: listQuery,
    response: listView,
  })
  list(@Ctx() ctx: AuthContext, @Query() q: z.output<typeof listQuery>) {
    return this.log.list(ctx, q);
  }

  @Get('radius/auth-log/summary')
  @Endpoint({
    summary: 'Accepted / rejected counts and counts per reason for a period (default 24 h)',
    tags: ['sessions'],
    permission: 'sessions.read',
    query: summaryQuery,
    response: summaryView,
  })
  summary(@Ctx() ctx: AuthContext, @Query() q: z.output<typeof summaryQuery>) {
    return this.log.summary(ctx, q);
  }

  @Get('radius/auth-log/why')
  @Endpoint({
    summary: 'Why a login was accepted or rejected: plain cause, fix, subscriber state, similar usernames',
    tags: ['sessions'],
    permission: 'sessions.read',
    query: whyQuery,
    response: whyView,
  })
  why(@Ctx() ctx: AuthContext, @Query() q: z.output<typeof whyQuery>) {
    return this.log.why(ctx, q);
  }

  @Get('radius/router-problems')
  @Endpoint({
    summary: 'Routers with Radius problems: wrong shared secret (seen or likely), no logins in 24 h',
    tags: ['sessions'],
    permission: 'nas.read',
    query: tenantQuery,
    response: problemsView,
  })
  problems(@Ctx() ctx: AuthContext, @Query() q: z.output<typeof tenantQuery>) {
    return this.log.problems(ctx, q);
  }

  @Get('radius/address-check')
  @Endpoint({
    summary:
      'What arrived from one address in 7 days (unknown router, firewall, wrong secret) and what to fix',
    tags: ['sessions'],
    permission: 'nas.read',
    query: addressQuery,
    response: addressView,
  })
  address(@Ctx() ctx: AuthContext, @Query() q: z.output<typeof addressQuery>) {
    return this.log.address(ctx, q);
  }

  @Get('radius/unknown-clients')
  @Endpoint({
    summary: 'Addresses sending Radius that are not a router of any ISP (super-admin, 24 h)',
    tags: ['sessions'],
    platformOnly: true,
    permission: 'nas.read',
    response: unknownView,
  })
  unknownClients() {
    return this.log.unknown();
  }

  @Get('radius/tail')
  @Endpoint({
    summary: 'Live Radius log: auth and accounting Start/Stop events since a time (poll every 2 s)',
    tags: ['sessions'],
    permission: 'sessions.read',
    query: tailQuery,
    response: tailView,
  })
  tail(@Ctx() ctx: AuthContext, @Query() q: z.output<typeof tailQuery>) {
    return this.log.tail(ctx, q);
  }
}
