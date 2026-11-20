import { isIP } from 'node:net';
import { Controller, Get, Inject, Injectable, Param, Query } from '@nestjs/common';
import { ObjectId } from 'mongodb';
import type pg from 'pg';
import { z } from 'zod';
import {
  ScopedDb,
  type MongoHandle,
  type NasDeviceDoc,
  type PlanDoc,
  type SubscriberDoc,
} from '@isp/db-mongo';
import type { AuthContext } from '../auth/context.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { Ctx, Endpoint } from '../http/endpoint.js';
import { hexId, idParams, isoDate } from '../http/schemas.js';
import { MONGO, RADIUS_DB } from '../infra/infra.module.js';

const usageQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
});
const usageView = z.object({
  days: z.array(
    z.object({
      day: z.string(),
      uploadBytes: z.number(),
      downloadBytes: z.number(),
      sessionSecs: z.number(),
    }),
  ),
  cycle: z
    .object({
      start: z.string().nullable(),
      usedBytes: z.number(),
      capBytes: z.number(),
      fupActive: z.boolean(),
    })
    .nullable(),
});

const tenantQuery = z.object({
  /** Super-admin only: which ISP to read. Ignored for staff (always their own). */
  tenantId: hexId.optional(),
});
const keysetCursor = z
  .string()
  .regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z_\d+$/, 'invalid cursor')
  .optional();
const liveQuery = tenantQuery.extend({
  q: z.string().trim().min(1).max(64).optional(),
  nasIp: z
    .string()
    .refine((s) => isIP(s) !== 0, 'must be an IP')
    .optional(),
  cursor: keysetCursor,
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const historyQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: keysetCursor,
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const lookupQuery = tenantQuery.extend({
  ip: z.string().refine((s) => isIP(s) !== 0, 'must be an IP'),
  at: z.coerce.date(),
});

const sessionView = z.object({
  id: z.string(),
  username: z.string(),
  subscriberId: z.string().nullable(),
  nasIp: z.string(),
  nasName: z.string().nullable(),
  framedIp: z.string().nullable(),
  mac: z.string().nullable(),
  startedAt: z.string(),
  updatedAt: z.string(),
  stoppedAt: z.string().nullable(),
  sessionSecs: z.number(),
  uploadBytes: z.number(),
  downloadBytes: z.number(),
  terminateCause: z.string().nullable(),
  /** Open but not heard from in 3 interim periods: RADIUS no longer counts it (router crash, lost Stop). */
  stale: z.boolean(),
});
const sessionsPage = z.object({ items: z.array(sessionView), nextCursor: z.string().nullable() });
const authView = z.object({
  at: z.string(),
  accepted: z.boolean(),
  reason: z.string().nullable(),
  nasIp: z.string(),
  mac: z.string().nullable(),
});
const authPage = z.object({ items: z.array(authView), nextCursor: z.string().nullable() });
const summaryView = z.object({
  online: z.number(),
  stale: z.number(),
  byNas: z.array(z.object({ nasIp: z.string(), nasName: z.string().nullable(), online: z.number() })),
});

const activityView = z.object({
  /** Hourly (IST hour starts) for the last 24 h, then one point for now; lastWeek is the same moment 7 days earlier. */
  points: z.array(z.object({ at: z.string(), online: z.number(), lastWeek: z.number() })),
  /** RADIUS logins per IST hour, the last 24 hours including the current one, oldest first. */
  hours: z.array(z.object({ hour: z.string(), accepted: z.number(), rejected: z.number() })),
});

/** Start of the IST hour 23 hours before the current one. */
const ACTIVITY_START = `date_trunc('hour', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata' - interval '23 hours'`;
/** A session counts at time t while it is started and not stopped; an open one until 3 missed interim updates. */
const SESSION_END = 'coalesce(acctstoptime, acctupdatetime + make_interval(secs => 3 * $2::int))';
/** Longest session we look back for when counting who was online (bounds the partition scan). */
const LONGEST_SESSION_DAYS = 45;

interface SessionRow {
  radacctid: string;
  start_key: string;
  username: string;
  subscriber_ext: string | null;
  nasip: string;
  shortname: string | null;
  framedip: string | null;
  callingstationid: string | null;
  acctstarttime: Date;
  acctupdatetime: Date;
  acctstoptime: Date | null;
  acctsessiontime: string;
  acctinputoctets: string;
  acctoutputoctets: string;
  acctterminatecause: string | null;
  stale: boolean;
}

/** Microsecond-exact UTC text, so a keyset cursor never rounds onto a row it already returned. */
const PG_ISO = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const SESSION_COLUMNS = `
  a.radacctid, ${PG_ISO('a.acctstarttime')} AS start_key, a.username,
  s.external_id AS subscriber_ext, host(a.nasipaddress) AS nasip, n.shortname, host(a.framedipaddress) AS framedip,
  a.callingstationid, a.acctstarttime, a.acctupdatetime, a.acctstoptime, a.acctsessiontime,
  a.acctinputoctets, a.acctoutputoctets, a.acctterminatecause,
  (a.acctstoptime IS NULL AND a.acctupdatetime <= now() - make_interval(secs => 3 * $2::int)) AS stale`;
const SESSION_JOINS = `
  LEFT JOIN subscribers s ON s.tenant_id = a.tenant_id AND s.username = a.username
  LEFT JOIN nas n ON n.nasname = a.nasipaddress AND n.tenant_id = a.tenant_id`;

const toSession = (r: SessionRow): z.output<typeof sessionView> => ({
  id: r.radacctid,
  username: r.username,
  subscriberId: r.subscriber_ext,
  nasIp: r.nasip,
  nasName: r.shortname,
  framedIp: r.framedip,
  mac: r.callingstationid,
  startedAt: r.acctstarttime.toISOString(),
  updatedAt: r.acctupdatetime.toISOString(),
  stoppedAt: r.acctstoptime?.toISOString() ?? null,
  sessionSecs: Number(r.acctsessiontime),
  // RADIUS input = what the router received from the customer = their upload.
  uploadBytes: Number(r.acctinputoctets),
  downloadBytes: Number(r.acctoutputoctets),
  terminateCause: r.acctterminatecause,
  stale: r.stale,
});

/** Keyset cursor "<start time>_<id>", newest first: stable while sessions are added, no OFFSET scans. */
function keyset(cursor: string | undefined): [string, string] | null {
  if (!cursor) return null;
  const i = cursor.lastIndexOf('_');
  return [cursor.slice(0, i), cursor.slice(i + 1)];
}
const nextCursor = <T extends { start_key: string; radacctid: string }>(rows: T[], limit: number) =>
  rows.length > limit ? `${rows[limit - 1]!.start_key}_${rows[limit - 1]!.radacctid}` : null;

const HISTORY_DAYS_DEFAULT = 90;
/** A router is "used by your customers" when one of them had a session on it within this many days. */
const USED_ROUTER_DAYS = 30;
const BRANCH_TTL_MS = 60_000;

/** What a reseller may see of the network: its customers' usernames and the routers they own or use. */
export interface BranchNet {
  tenantId: ObjectId;
  resellerId: ObjectId;
  pg: { id: number; interim: number } | null;
  /** PPPoE usernames in the branch, as stored and lower-cased (routers report either). */
  usernames: string[];
  /** Routers added by the branch. */
  ownIps: string[];
  /** Own routers plus routers the branch's customers used in the last 30 days. */
  visibleIps: string[];
}

@Injectable()
export class SessionsService {
  private readonly tenantCache = new Map<string, { at: number; id: number; interim: number }>();
  private readonly branchCache = new Map<string, { at: number; v: BranchNet }>();

  constructor(
    @Inject(MONGO) private readonly mongo: MongoHandle,
    @Inject(RADIUS_DB) private readonly pool: pg.Pool | null,
  ) {}

  db(): pg.Pool {
    if (!this.pool) throw new AppError(503, 'INTERNAL', 'RADIUS database not configured');
    return this.pool;
  }

  mongoTenant(ctx: AuthContext, requested?: string): ObjectId {
    if (ctx.scope.kind === 'branch') throw forbidden('Not available in a reseller panel');
    if (ctx.scope.kind === 'tenant') return ctx.scope.tenantId;
    if (!requested) throw new AppError(400, 'VALIDATION_FAILED', 'tenantId is required for super-admins');
    return new ObjectId(requested);
  }

  /** Tenant scope for ISP-wide reads; a reseller gets its branch (callers must filter by it). */
  async scopeFor(
    ctx: AuthContext,
    requested?: string,
  ): Promise<{ mongoId: ObjectId; branch: BranchNet | null }> {
    if (ctx.scope.kind === 'branch') {
      const branch = await this.branchNet(ctx);
      return { mongoId: ctx.scope.tenantId, branch };
    }
    return { mongoId: this.mongoTenant(ctx, requested), branch: null };
  }

  /** Cached 60 s per reseller; `forgetBranches` after a reseller adds or removes a router. */
  async branchNet(ctx: AuthContext): Promise<BranchNet | null> {
    if (ctx.scope.kind !== 'branch') return null;
    const { tenantId, resellerId } = ctx.scope;
    const key = resellerId.toHexString();
    const hit = this.branchCache.get(key);
    if (hit && Date.now() - hit.at < BRANCH_TTL_MS) return hit.v;
    const inBranch = { tenantId, $or: [{ resellerId }, { ancestors: resellerId }] };
    const [names, own, pgT] = await Promise.all([
      this.mongo.db
        .collection<SubscriberDoc>('subscribers')
        .distinct('username', { ...inBranch, status: { $ne: 'deleted' }, username: { $type: 'string' } }),
      this.mongo.db
        .collection<NasDeviceDoc>('nas_devices')
        .distinct('ip', { ...inBranch, status: { $ne: 'deleted' }, ip: { $type: 'string' } }),
      this.pool ? this.pgTenant(tenantId) : null,
    ]);
    const usernames = [...new Set((names as string[]).flatMap((u) => [u, u.toLowerCase()]))];
    let used: string[] = [];
    if (pgT && usernames.length && this.pool) {
      const r = await this.pool.query<{ ip: string }>(
        `SELECT DISTINCT host(nasipaddress) AS ip FROM radacct
          WHERE tenant_id = $1 AND username = ANY($2::text[])
            AND acctstarttime > now() - make_interval(days => $3::int)`,
        [pgT.id, usernames, USED_ROUTER_DAYS],
      );
      used = r.rows.map((x) => x.ip);
    }
    const ownIps = own as string[];
    const v: BranchNet = {
      tenantId,
      resellerId,
      pg: pgT ? { id: pgT.id, interim: pgT.interim } : null,
      usernames,
      ownIps,
      visibleIps: [...new Set([...ownIps, ...used])],
    };
    this.branchCache.set(key, { at: Date.now(), v });
    return v;
  }

  forgetBranches() {
    this.branchCache.clear();
  }

  /** PostgreSQL id and interim interval of the ISP; null until its first sync (then there is nothing to read). */
  async pgTenant(tenantId: ObjectId): Promise<{ id: number; interim: number } | null> {
    const key = tenantId.toHexString();
    const hit = this.tenantCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit;
    const r = await this.db().query<{ id: number; interim_interval: number }>(
      'SELECT id, interim_interval FROM tenants WHERE external_id = $1',
      [key],
    );
    const row = r.rows[0];
    if (!row) return null;
    const v = { at: Date.now(), id: row.id, interim: row.interim_interval };
    this.tenantCache.set(key, v);
    return v;
  }

  private async subscriber(ctx: AuthContext, id: ObjectId) {
    const s = await new ScopedDb(this.mongo.db, ctx.scope)
      .collection<SubscriberDoc>('subscribers')
      .findOne({ _id: id }, { projection: { tenantId: 1, username: 1, deletedUsername: 1 } });
    const username = s?.username ?? s?.deletedUsername;
    if (!s || !username) throw notFound('Subscriber');
    return { tenantId: s.tenantId, username };
  }

  async live(ctx: AuthContext, q: z.output<typeof liveQuery>) {
    const { mongoId, branch } = await this.scopeFor(ctx, q.tenantId);
    const t = await this.pgTenant(mongoId);
    if (!t || (branch && !branch.usernames.length)) return { items: [], nextCursor: null };
    const params: unknown[] = [t.id, t.interim];
    const where = ['a.tenant_id = $1', 'a.acctstoptime IS NULL'];
    if (branch) where.push(`a.username = ANY($${params.push(branch.usernames)}::text[])`);
    if (q.nasIp) where.push(`a.nasipaddress = $${params.push(q.nasIp)}::inet`);
    if (q.q) {
      const like = `${q.q.replace(/[\\%_]/g, '\\$&')}%`;
      const n = params.push(like);
      where.push(
        `(a.username ILIKE $${n} OR host(a.framedipaddress) LIKE $${n} OR a.callingstationid ILIKE $${n})`,
      );
    }
    const k = keyset(q.cursor);
    if (k) {
      const a = params.push(k[0]);
      const b = params.push(k[1]);
      where.push(`(a.acctstarttime, a.radacctid) < ($${a}::timestamptz, $${b}::bigint)`);
    }
    const limit = params.push(q.limit + 1);
    const { rows } = await this.db().query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM radacct a ${SESSION_JOINS}
        WHERE ${where.join(' AND ')}
        ORDER BY a.acctstarttime DESC, a.radacctid DESC LIMIT $${limit}`,
      params,
    );
    return { items: rows.slice(0, q.limit).map(toSession), nextCursor: nextCursor(rows, q.limit) };
  }

  async summary(ctx: AuthContext, q: z.output<typeof tenantQuery>) {
    const { mongoId, branch } = await this.scopeFor(ctx, q.tenantId);
    const t = await this.pgTenant(mongoId);
    if (!t || (branch && !branch.usernames.length)) return { online: 0, stale: 0, byNas: [] };
    const params: unknown[] = [t.id, t.interim];
    const mine = branch ? `AND a.username = ANY($${params.push(branch.usernames)}::text[])` : '';
    const { rows } = await this.db().query<{
      nasip: string;
      shortname: string | null;
      online: string;
      stale: string;
    }>(
      `SELECT host(a.nasipaddress) AS nasip, n.shortname,
              count(*) FILTER (WHERE a.acctupdatetime > now() - make_interval(secs => 3 * $2::int)) AS online,
              count(*) FILTER (WHERE a.acctupdatetime <= now() - make_interval(secs => 3 * $2::int)) AS stale
         FROM radacct a
         LEFT JOIN nas n ON n.nasname = a.nasipaddress AND n.tenant_id = a.tenant_id
        WHERE a.tenant_id = $1 AND a.acctstoptime IS NULL ${mine}
        GROUP BY 1, 2 ORDER BY 3 DESC`,
      params,
    );
    return {
      online: rows.reduce((n, r) => n + Number(r.online), 0),
      stale: rows.reduce((n, r) => n + Number(r.stale), 0),
      byNas: rows.map((r) => ({ nasIp: r.nasip, nasName: r.shortname, online: Number(r.online) })),
    };
  }

  /** Online users over the last 24 h (with the same hours last week) and logins vs rejects per hour. */
  async activity(ctx: AuthContext, q: z.output<typeof tenantQuery>) {
    const t = await this.pgTenant(this.mongoTenant(ctx, q.tenantId));
    const start = new Date(Math.floor((Date.now() + IST_OFFSET_MS) / 3_600_000) * 3_600_000 - IST_OFFSET_MS);
    start.setTime(start.getTime() - 23 * 3_600_000);
    const emptyHours = () =>
      Array.from({ length: 24 }, (_, i) => ({
        hour: new Date(start.getTime() + i * 3_600_000).toISOString(),
        accepted: 0,
        rejected: 0,
      }));
    if (!t) return { points: [], hours: emptyHours() };

    const [online, auth] = await Promise.all([
      this.db().query<{ t: Date; online: string; last_week: string }>(
        `WITH pts AS (
           SELECT g AS t FROM generate_series(${ACTIVITY_START}, ${ACTIVITY_START} + interval '23 hours', interval '1 hour') g
           UNION ALL SELECT now()
         ), cand AS MATERIALIZED (
           SELECT acctstarttime AS s, ${SESSION_END} AS e
             FROM radacct
            WHERE tenant_id = $1
              AND acctstarttime >= now() - make_interval(days => $3::int) AND acctstarttime <= now()
              AND ${SESSION_END} > now() - interval '8 days'
         )
         SELECT p.t,
                (SELECT count(*) FROM cand WHERE s <= p.t AND e > p.t) AS online,
                (SELECT count(*) FROM cand WHERE s <= p.t - interval '7 days' AND e > p.t - interval '7 days') AS last_week
           FROM pts p ORDER BY p.t`,
        [t.id, t.interim, LONGEST_SESSION_DAYS],
      ),
      this.db().query<{ hour: Date; accepted: string; rejected: string }>(
        `SELECT date_trunc('hour', authdate AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata' AS hour,
                count(*) FILTER (WHERE reply = 'Access-Accept') AS accepted,
                count(*) FILTER (WHERE reply <> 'Access-Accept') AS rejected
           FROM radpostauth
          WHERE tenant_id = $1 AND authdate >= ${ACTIVITY_START}
          GROUP BY 1`,
        [t.id],
      ),
    ]);
    const byHour = new Map(auth.rows.map((r) => [r.hour.toISOString(), r]));
    return {
      points: online.rows.map((r) => ({
        at: r.t.toISOString(),
        online: Number(r.online),
        lastWeek: Number(r.last_week),
      })),
      hours: emptyHours().map((h) => {
        const r = byHour.get(h.hour);
        return r ? { ...h, accepted: Number(r.accepted), rejected: Number(r.rejected) } : h;
      }),
    };
  }

  async history(ctx: AuthContext, id: ObjectId, q: z.output<typeof historyQuery>) {
    const s = await this.subscriber(ctx, id);
    const t = await this.pgTenant(s.tenantId);
    if (!t) return { items: [], nextCursor: null };
    const to = q.to ?? new Date();
    const from = q.from ?? new Date(to.getTime() - HISTORY_DAYS_DEFAULT * 86_400_000);
    const params: unknown[] = [t.id, t.interim, s.username, from, to];
    // acctstarttime bounds let PostgreSQL skip monthly partitions outside the window.
    const where = ['a.tenant_id = $1', 'a.username = $3', 'a.acctstarttime >= $4', 'a.acctstarttime <= $5'];
    const k = keyset(q.cursor);
    if (k) {
      const a = params.push(k[0]);
      const b = params.push(k[1]);
      where.push(`(a.acctstarttime, a.radacctid) < ($${a}::timestamptz, $${b}::bigint)`);
    }
    const limit = params.push(q.limit + 1);
    const { rows } = await this.db().query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM radacct a ${SESSION_JOINS}
        WHERE ${where.join(' AND ')}
        ORDER BY a.acctstarttime DESC, a.radacctid DESC LIMIT $${limit}`,
      params,
    );
    return { items: rows.slice(0, q.limit).map(toSession), nextCursor: nextCursor(rows, q.limit) };
  }

  async authLog(ctx: AuthContext, id: ObjectId, q: z.output<typeof historyQuery>) {
    const s = await this.subscriber(ctx, id);
    const t = await this.pgTenant(s.tenantId);
    if (!t) return { items: [], nextCursor: null };
    const to = q.to ?? new Date();
    const from = q.from ?? new Date(to.getTime() - HISTORY_DAYS_DEFAULT * 86_400_000);
    const params: unknown[] = [t.id, s.username, from, to];
    const where = ['tenant_id = $1', 'username = $2', 'authdate >= $3', 'authdate <= $4'];
    const k = keyset(q.cursor);
    if (k) {
      const a = params.push(k[0]);
      const b = params.push(k[1]);
      where.push(`(authdate, id) < ($${a}::timestamptz, $${b}::bigint)`);
    }
    const limit = params.push(q.limit + 1);
    const { rows } = await this.db().query<{
      id: string;
      start_key: string;
      radacctid: string;
      authdate: Date;
      reply: string;
      reason: string | null;
      nasip: string;
      callingstationid: string | null;
    }>(
      `SELECT id, id AS radacctid, ${PG_ISO('authdate')} AS start_key, authdate, reply, reason,
              host(nasipaddress) AS nasip, callingstationid
         FROM radpostauth WHERE ${where.join(' AND ')}
        ORDER BY authdate DESC, id DESC LIMIT $${limit}`,
      params,
    );
    return {
      items: rows.slice(0, q.limit).map((r) => ({
        at: r.authdate.toISOString(),
        accepted: r.reply === 'Access-Accept',
        reason: r.reason,
        nasIp: r.nasip,
        mac: r.callingstationid,
      })),
      nextCursor: nextCursor(rows, q.limit),
    };
  }

  /** Daily usage (IST days, default the last 31) and the current data-cap cycle from the usage job. */
  async usage(ctx: AuthContext, id: ObjectId, q: z.output<typeof usageQuery>) {
    const s = await new ScopedDb(this.mongo.db, ctx.scope)
      .collection<SubscriberDoc>('subscribers')
      .findOne(
        { _id: id },
        { projection: { tenantId: 1, username: 1, deletedUsername: 1, planId: 1, fup: 1 } },
      );
    const username = s?.username ?? s?.deletedUsername;
    if (!s || !username) throw notFound('Subscriber');
    const plan = s.planId
      ? await this.mongo.db
          .collection<PlanDoc>('plans')
          .findOne({ _id: s.planId }, { projection: { dataCapBytes: 1 } })
      : null;
    const cycle = plan?.dataCapBytes
      ? {
          start: s.fup?.cycleStart?.toISOString() ?? null,
          usedBytes: s.fup?.usedBytes ?? 0,
          capBytes: plan.dataCapBytes,
          fupActive: s.fup?.active === true,
        }
      : null;
    const t = await this.pgTenant(s.tenantId);
    if (!t) return { days: [], cycle };
    const to = q.to ?? istToday();
    const from = q.from ?? istDaysBefore(to, 30);
    const { rows } = await this.db().query<{
      day: string;
      bytes_in: string;
      bytes_out: string;
      session_secs: string;
    }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, bytes_in, bytes_out, session_secs
         FROM usage_daily WHERE tenant_id = $1 AND username = $2 AND day BETWEEN $3 AND $4 ORDER BY day`,
      [t.id, username, from, to],
    );
    return {
      days: rows.map((r) => ({
        day: r.day,
        uploadBytes: Number(r.bytes_in),
        downloadBytes: Number(r.bytes_out),
        sessionSecs: Number(r.session_secs),
      })),
      cycle,
    };
  }

  /** Who had this IP at that moment (law-enforcement requests, abuse reports). */
  async lookup(ctx: AuthContext, q: z.output<typeof lookupQuery>) {
    const t = await this.pgTenant(this.mongoTenant(ctx, q.tenantId));
    if (!t) return [];
    const { rows } = await this.db().query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM radacct a ${SESSION_JOINS}
        WHERE a.tenant_id = $1 AND a.framedipaddress = $3::inet
          AND a.acctstarttime <= $4 AND (a.acctstoptime IS NULL OR a.acctstoptime >= $4)
        ORDER BY a.acctstarttime DESC LIMIT 20`,
      [t.id, t.interim, q.ip, q.at],
    );
    return rows.map(toSession);
  }
}

const IST = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const IST_OFFSET_MS = 330 * 60_000;
const istToday = () => IST.format(new Date());
const istDaysBefore = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

@Controller()
export class SessionsController {
  constructor(@Inject(SessionsService) private readonly sessions: SessionsService) {}

  @Get('sessions/live')
  @Endpoint({
    summary: 'Users online now (search username, IP or MAC prefix; filter by router)',
    tags: ['sessions'],
    permission: 'sessions.read',
    query: liveQuery,
    response: sessionsPage,
  })
  live(@Ctx() ctx: AuthContext, @Query() q: z.output<typeof liveQuery>) {
    return this.sessions.live(ctx, q);
  }

  @Get('sessions/summary')
  @Endpoint({
    summary: 'Online count, total and per router',
    tags: ['sessions'],
    permission: 'sessions.read',
    query: tenantQuery,
    response: summaryView,
  })
  summary(@Ctx() ctx: AuthContext, @Query() q: z.output<typeof tenantQuery>) {
    return this.sessions.summary(ctx, q);
  }

  @Get('sessions/activity')
  @Endpoint({
    summary: 'Online users over the last 24 h vs last week, and logins vs rejects per hour',
    tags: ['sessions'],
    permission: 'sessions.read',
    query: tenantQuery,
    response: activityView,
  })
  activity(@Ctx() ctx: AuthContext, @Query() q: z.output<typeof tenantQuery>) {
    return this.sessions.activity(ctx, q);
  }

  @Get('sessions/lookup')
  @Endpoint({
    summary: 'Who used an IP address at a given time',
    tags: ['sessions'],
    permission: 'sessions.read',
    query: lookupQuery,
    response: z.array(sessionView),
  })
  lookup(@Ctx() ctx: AuthContext, @Query() q: z.output<typeof lookupQuery>) {
    return this.sessions.lookup(ctx, q);
  }

  @Get('subscribers/:id/sessions')
  @Endpoint({
    access: 'subscriber',
    summary: 'Session history (default last 90 days)',
    tags: ['sessions'],
    permission: 'sessions.read',
    params: idParams,
    query: historyQuery,
    response: sessionsPage,
  })
  history(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }, @Query() q: z.output<typeof historyQuery>) {
    return this.sessions.history(ctx, p.id, q);
  }

  @Get('subscribers/:id/usage')
  @Endpoint({
    access: 'subscriber',
    summary: 'Daily data usage (IST days, default last 31) and the current data-cap cycle',
    tags: ['sessions'],
    permission: 'subscribers.read',
    params: idParams,
    query: usageQuery,
    response: usageView,
  })
  usage(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }, @Query() q: z.output<typeof usageQuery>) {
    return this.sessions.usage(ctx, p.id, q);
  }

  @Get('subscribers/:id/auth-log')
  @Endpoint({
    access: 'subscriber',
    summary: 'Login attempts with the reject reason (default last 90 days)',
    tags: ['sessions'],
    permission: 'sessions.read',
    params: idParams,
    query: historyQuery,
    response: authPage,
  })
  authLog(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }, @Query() q: z.output<typeof historyQuery>) {
    return this.sessions.authLog(ctx, p.id, q);
  }
}
