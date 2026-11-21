import { isIP } from 'node:net';
import { Controller, Get, Inject, Injectable, Query } from '@nestjs/common';
import type pg from 'pg';
import { z } from 'zod';
import type { MongoHandle, SubscriberDoc } from '@isp/db-mongo';
import { noteChange } from '../audit/audit.js';
import type { AuthContext } from '../auth/context.js';
import { assertStaff, requireTenant } from '../billing/common.js';
import { CONFIG, type Config } from '../config.js';
import { AppError } from '../errors.js';
import { Ctx, Endpoint } from '../http/endpoint.js';
import { MONGO, RADIUS_DB } from '../infra/infra.module.js';
import { NatArchive, type NatEvent } from './nat-archive.js';

const natQuery = z.object({
  ip: z.string().refine((s) => isIP(s) === 4, 'must be an IPv4 address'),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  at: z.coerce.date(),
  /** Search ± this many minutes around `at` (NAT logs record when a connection started). */
  windowMins: z.coerce.number().int().min(1).max(120).default(5),
});

const hitView = z.object({
  at: z.string(),
  router: z.string(),
  routerName: z.string().nullable(),
  proto: z.string(),
  privateIp: z.string(),
  privatePort: z.number().nullable(),
  publicIp: z.string(),
  publicPort: z.number().nullable(),
  destIp: z.string(),
  destPort: z.number().nullable(),
  inInterface: z.string(),
  /** PPPoE username: from the interface name, else from the Radius session that had the private IP then. */
  username: z.string().nullable(),
  subscriber: z.object({ id: z.string(), name: z.string(), customerNo: z.string() }).nullable(),
});
const natView = z.object({
  configured: z.boolean(),
  hits: z.array(hitView),
  filesScanned: z.number(),
  bytesScanned: z.number(),
  truncated: z.boolean(),
});

const HIT_LIMIT = 200;

@Injectable()
export class ComplianceService {
  private readonly archive: NatArchive;

  constructor(
    @Inject(MONGO) private readonly mongo: MongoHandle,
    @Inject(RADIUS_DB) private readonly pool: pg.Pool | null,
    @Inject(CONFIG) config: Config,
  ) {
    this.archive = new NatArchive(config.NAT_ARCHIVE_DIR);
  }

  /**
   * "Who used public IP X (port P) at time T?" — NAT archive for customers behind NAT; the plain session lookup
   * (Sessions → Who had an IP) covers customers with their own public IP. Every search is audited.
   */
  async natLookup(ctx: AuthContext, q: z.output<typeof natQuery>) {
    assertStaff(ctx, 'search NAT logs');
    const tenantId = requireTenant(ctx);
    noteChange({
      after: { ip: q.ip, port: q.port ?? null, at: q.at.toISOString(), windowMins: q.windowMins },
    });
    if (!this.archive.configured || !this.pool) {
      return { configured: false, hits: [], filesScanned: 0, bytesScanned: 0, truncated: false };
    }
    const nas = await this.pool.query<{ ip: string; name: string | null }>(
      `SELECT host(n.nasname) AS ip, n.shortname AS name
         FROM nas n JOIN tenants t ON t.id = n.tenant_id WHERE t.external_id = $1`,
      [tenantId.toHexString()],
    );
    const routerName = new Map(nas.rows.map((r) => [r.ip, r.name]));
    let found;
    try {
      found = await this.archive.search({
        publicIp: q.ip,
        port: q.port,
        at: q.at,
        windowSecs: q.windowMins * 60,
        routers: [...routerName.keys()],
        limit: HIT_LIMIT,
      });
    } catch (e) {
      if ((e as Error).message === 'BUSY') {
        throw new AppError(429, 'TOO_MANY_ATTEMPTS', 'Another NAT search is running. Try again in a minute.');
      }
      throw e;
    }
    const users = await this.usernames(tenantId.toHexString(), found.hits);
    const subs = await this.mongo.db
      .collection<SubscriberDoc>('subscribers')
      .find(
        { tenantId, username: { $in: [...new Set(users.filter((u): u is string => !!u))] } },
        { projection: { username: 1, name: 1, customerNo: 1 } },
      )
      .toArray();
    const byUser = new Map(subs.map((s) => [s.username!, s]));
    return {
      configured: true,
      filesScanned: found.filesScanned,
      bytesScanned: found.bytesScanned,
      truncated: found.truncated,
      hits: found.hits.map((h, i) => {
        const s = users[i] ? byUser.get(users[i]) : undefined;
        return {
          at: h.at.toISOString(),
          router: h.router,
          routerName: routerName.get(h.router) ?? null,
          proto: h.proto,
          privateIp: h.privateIp,
          privatePort: h.privatePort,
          publicIp: h.publicIp,
          publicPort: h.publicPort,
          destIp: h.destIp,
          destPort: h.destPort,
          inInterface: h.inInterface,
          username: users[i] ?? null,
          subscriber: s ? { id: s._id.toHexString(), name: s.name, customerNo: s.customerNo } : null,
        };
      }),
    };
  }

  /** PPPoE user from the log line; otherwise the Radius session on that router that had the private IP then. */
  private async usernames(tenantKey: string, hits: NatEvent[]): Promise<(string | null)[]> {
    const need = hits
      .map((h, i) => ({ h, i }))
      .filter(({ h }) => !h.pppoeUser)
      .slice(0, 50);
    const out = hits.map((h) => h.pppoeUser);
    if (!need.length || !this.pool) return out;
    const r = await this.pool.query<{ i: number; username: string }>(
      `SELECT q.i, a.username
         FROM unnest($2::int[], $3::inet[], $4::inet[], $5::timestamptz[]) AS q(i, ip, nas, at)
         JOIN tenants t ON t.external_id = $1
         JOIN LATERAL (
           SELECT username FROM radacct a
            WHERE a.tenant_id = t.id AND a.framedipaddress = q.ip AND a.nasipaddress = q.nas
              AND a.acctstarttime <= q.at AND (a.acctstoptime IS NULL OR a.acctstoptime >= q.at)
            ORDER BY a.acctstarttime DESC LIMIT 1) a ON true`,
      [
        tenantKey,
        need.map(({ i }) => i),
        need.map(({ h }) => h.privateIp),
        need.map(({ h }) => h.router),
        need.map(({ h }) => h.at.toISOString()),
      ],
    );
    for (const row of r.rows) out[row.i] = row.username;
    return out;
  }
}

@Controller('compliance')
export class ComplianceController {
  constructor(@Inject(ComplianceService) private readonly s: ComplianceService) {}

  @Get('nat-lookup')
  @Endpoint({
    summary: 'Who used a public IP (and port) at a given time, from the routers’ NAT logs (audited)',
    tags: ['compliance'],
    permission: 'compliance.lookup',
    audit: 'compliance.nat_lookup',
    query: natQuery,
    response: natView,
  })
  natLookup(@Ctx() ctx: AuthContext, @Query() q: z.output<typeof natQuery>) {
    return this.s.natLookup(ctx, q);
  }
}
