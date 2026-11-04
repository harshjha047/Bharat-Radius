import { ObjectId, type Db } from 'mongodb';
import type pg from 'pg';
import type { Logger } from 'pino';
import type { CoaLogDoc, CoaReason, OutboxDoc } from '@isp/db-mongo';
import type { CoaResult, RadiusCoaClient } from '@isp/radius-client';

interface Session {
  subscriber_ext: string | null;
  username: string;
  acctsessionid: string;
  framedip: string | null;
  nasip: string;
  secret: string;
  coa_port: number;
}

const SESSION_SQL = `
  SELECT s.external_id AS subscriber_ext, a.username, a.acctsessionid, host(a.framedipaddress) AS framedip,
         host(a.nasipaddress) AS nasip, n.secret, n.coa_port
    FROM radacct a
    JOIN tenants t ON t.id = a.tenant_id
    JOIN nas n ON n.nasname = a.nasipaddress AND n.tenant_id = a.tenant_id
    LEFT JOIN subscribers s ON s.tenant_id = a.tenant_id AND s.username = a.username
   WHERE a.acctstoptime IS NULL
     AND a.acctupdatetime > now() - make_interval(secs => 3 * t.interim_interval)`;

export type CoaAction = NonNullable<OutboxDoc['coa']>;

/** Disconnect beats rate change; the first reason of the strongest action wins. */
export function strongest(list: (OutboxDoc['coa'] | undefined)[]): CoaAction | undefined {
  const all = list.filter((c): c is CoaAction => !!c);
  return all.find((c) => c.action === 'disconnect') ?? all[0];
}

/**
 * Sends CoA / Disconnect-Request for live sessions after their RADIUS rows changed (TRD §6.4) and records every
 * attempt in coa_log. Best effort: a router that does not answer never blocks the sync itself.
 */
export class CoaSender {
  constructor(
    private readonly pool: pg.Pool,
    private readonly db: Db,
    private readonly client: RadiusCoaClient,
    private readonly log: Logger,
  ) {}

  private async record(entry: Omit<CoaLogDoc, '_id' | 'createdAt'>): Promise<void> {
    await this.db.collection('coa_log').insertOne({ ...entry, createdAt: new Date() });
  }

  /** The reply FreeRADIUS would give now; null when it cannot be read (then we disconnect instead). */
  private async reply(nasip: string, username: string): Promise<Map<string, string> | null> {
    try {
      const r = await this.pool.query<{ attribute: string; value: string }>(
        'SELECT attribute, value FROM radius_reply($1::inet, $2)',
        [nasip, username],
      );
      return new Map(r.rows.map((x) => [x.attribute, x.value]));
    } catch (err) {
      this.log.warn({ err }, 'radius_reply not readable; falling back to disconnect');
      return null;
    }
  }

  private async one(s: Session, tenantId: ObjectId, subscriberId: ObjectId, coa: CoaAction): Promise<void> {
    const target = { host: s.nasip, port: s.coa_port, secret: s.secret };
    const session = {
      userName: s.username,
      acctSessionId: s.acctsessionid,
      ...(s.framedip ? { framedIp: s.framedip } : {}),
    };
    const base = {
      tenantId,
      subscriberId,
      username: s.username,
      nasIp: s.nasip,
      trigger: { type: coa.reason },
    };
    const log = (type: 'coa' | 'disconnect', r: CoaResult | Error, attributes?: Record<string, string>) =>
      this.record({
        ...base,
        type,
        ...(attributes ? { attributes } : {}),
        ...(r instanceof Error
          ? { result: 'error' as const }
          : {
              result: r.result,
              latencyMs: Math.round(r.latencyMs),
              ...(r.errorCause !== undefined ? { errorCause: r.errorCause } : {}),
            }),
      });

    if (coa.action === 'update') {
      const reply = await this.reply(s.nasip, s.username);
      const rate = reply?.get('Mikrotik-Rate-Limit');
      // Entering or leaving an address list (expired / fup) needs a fresh login, not a rate change.
      if (reply && rate && !reply.has('Mikrotik-Address-List')) {
        const r = await this.client.changeRate(target, session, { rateLimit: rate }).catch((e: Error) => e);
        await log('coa', r, { 'Mikrotik-Rate-Limit': rate });
        if (!(r instanceof Error) && r.result === 'ack') return;
      }
    }
    const r = await this.client.disconnect(target, session).catch((e: Error) => e);
    await log('disconnect', r);
  }

  async forSubscriber(
    tenantId: ObjectId,
    subscriberId: ObjectId,
    username: string,
    coa: CoaAction,
  ): Promise<number> {
    const { rows } = await this.pool.query<Session>(
      `${SESSION_SQL} AND t.external_id = $1 AND a.username = $2`,
      [tenantId.toHexString(), username],
    );
    if (!rows.length) {
      await this.record({
        tenantId,
        subscriberId,
        username,
        nasIp: '',
        type: coa.action === 'update' ? 'coa' : 'disconnect',
        result: 'skipped_offline',
        trigger: { type: coa.reason },
      });
      return 0;
    }
    await Promise.all(rows.map((s) => this.one(s, tenantId, subscriberId, coa)));
    return rows.length;
  }

  /** New plan speed for everyone on the plan who is online now. */
  async forPlan(tenantId: ObjectId, planExt: string, reason: CoaReason): Promise<number> {
    const { rows } = await this.pool.query<Session>(
      `${SESSION_SQL} AND s.plan_id = (SELECT id FROM plans WHERE external_id = $1)`,
      [planExt],
    );
    await Promise.all(
      rows
        .filter((s) => s.subscriber_ext)
        .map((s) => this.one(s, tenantId, new ObjectId(s.subscriber_ext!), { action: 'update', reason })),
    );
    return rows.length;
  }
}
