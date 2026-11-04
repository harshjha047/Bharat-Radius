import { ObjectId, type Db, type MongoClient, type AnyBulkWriteOperation } from 'mongodb';
import type pg from 'pg';
import type { Logger } from 'pino';
import type { OutboxDoc, PlanDoc, SubscriberDoc } from '@isp/db-mongo';

const BATCH = 1000;
const TZ = 'Asia/Kolkata';

/** YYYY-MM-DD of an instant in IST (billing days are Indian calendar days). */
export function istDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * First IST day of the data-cap cycle:
 * - calendar_month, postpaid, or no expiry known → 1st of the current month;
 * - billing_cycle (prepaid) → the day the current paid period began (expiry − validity), never in the future.
 */
export function cycleStart(
  plan: Pick<PlanDoc, 'fupCycle' | 'validityDays'>,
  sub: Pick<SubscriberDoc, 'billingType' | 'expiresAt'>,
  now = new Date(),
): string {
  const today = istDate(now);
  const monthStart = `${today.slice(0, 8)}01`;
  if (plan.fupCycle === 'calendar_month' || sub.billingType === 'postpaid' || !sub.expiresAt)
    return monthStart;
  const start = istDate(new Date(sub.expiresAt.getTime() - plan.validityDays * 86_400_000));
  return start > today ? monthStart : start;
}

export interface UsageResult extends Record<string, number> {
  sessions: number;
  users: number;
  checked: number;
  fupOn: number;
  fupOff: number;
}

/**
 * 15-minute usage job (TRD §6.7): roll radacct deltas into usage_daily, then compare each capped subscriber's
 * cycle usage with the plan cap. Crossing the cap either way flips `fup.active` and queues a sync + Disconnect
 * (the FUP state carries an address list, so the router must re-authenticate).
 */
export class UsageJob {
  constructor(
    private readonly pool: pg.Pool,
    private readonly client: MongoClient,
    private readonly db: Db,
    private readonly log: Logger,
  ) {}

  async run(now = new Date()): Promise<UsageResult> {
    const { rows } = await this.pool.query<{ sessions: number; users: number }>(
      'SELECT * FROM radius_usage_rollup()',
    );
    const roll = rows[0] ?? { sessions: 0, users: 0 };
    const fup = await this.checkCaps(now);
    return { sessions: roll.sessions, users: roll.users, ...fup };
  }

  async checkCaps(now = new Date()): Promise<{ checked: number; fupOn: number; fupOff: number }> {
    const totals = { checked: 0, fupOn: 0, fupOff: 0 };
    const plans = await this.db
      .collection<PlanDoc>('plans')
      .find(
        { dataCapBytes: { $gt: 0 } },
        { projection: { tenantId: 1, dataCapBytes: 1, fupCycle: 1, validityDays: 1 } },
      )
      .toArray();
    const tenantIds = new Map<string, number | null>();
    for (const plan of plans) {
      const key = plan.tenantId.toHexString();
      if (!tenantIds.has(key)) {
        const r = await this.pool.query<{ id: number }>('SELECT id FROM tenants WHERE external_id = $1', [
          key,
        ]);
        tenantIds.set(key, r.rows[0]?.id ?? null);
      }
      const pgTenant = tenantIds.get(key);
      if (pgTenant == null) continue;

      const cursor = this.db.collection<SubscriberDoc>('subscribers').find(
        { tenantId: plan.tenantId, planId: plan._id, status: 'active', username: { $type: 'string' } },
        {
          projection: { username: 1, billingType: 1, expiresAt: 1, fup: 1, version: 1, tenantId: 1 },
          batchSize: BATCH,
        },
      );
      let batch: SubscriberDoc[] = [];
      for await (const s of cursor) {
        batch.push(s);
        if (batch.length === BATCH) {
          this.add(totals, await this.checkBatch(pgTenant, plan, batch, now));
          batch = [];
        }
      }
      if (batch.length) this.add(totals, await this.checkBatch(pgTenant, plan, batch, now));
    }
    // Plan lost its cap, or the subscriber moved to an uncapped plan: lift FUP.
    const orphaned = await this.db
      .collection<SubscriberDoc>('subscribers')
      .find(
        { 'fup.active': true, status: 'active', planId: { $nin: plans.map((p) => p._id) } },
        { projection: { tenantId: 1, version: 1, fup: 1 } },
      )
      .toArray();
    for (const s of orphaned)
      if (await this.flip(s, false, s.fup?.usedBytes ?? 0, s.fup?.cycleStart ?? new Date()))
        totals.fupOff += 1;
    return totals;
  }

  private add(t: { checked: number; fupOn: number; fupOff: number }, r: typeof t) {
    t.checked += r.checked;
    t.fupOn += r.fupOn;
    t.fupOff += r.fupOff;
  }

  private async checkBatch(pgTenant: number, plan: PlanDoc, subs: SubscriberDoc[], now: Date) {
    const starts = subs.map((s) => cycleStart(plan, s, now));
    const { rows } = await this.pool.query<{ username: string; used: string }>(
      `SELECT u.username, coalesce(sum(d.bytes_in + d.bytes_out), 0) AS used
         FROM unnest($2::text[], $3::date[]) AS u(username, start)
         LEFT JOIN usage_daily d ON d.tenant_id = $1 AND d.username = u.username AND d.day >= u.start
        GROUP BY u.username`,
      [pgTenant, subs.map((s) => s.username), starts],
    );
    const used = new Map(rows.map((r) => [r.username, Number(r.used)]));
    const cache: AnyBulkWriteOperation<SubscriberDoc>[] = [];
    const r = { checked: subs.length, fupOn: 0, fupOff: 0 };

    for (const [i, s] of subs.entries()) {
      const bytes = used.get(s.username!) ?? 0;
      const over = bytes >= plan.dataCapBytes!;
      const start = new Date(`${starts[i]}T00:00:00+05:30`);
      if (over !== (s.fup?.active === true)) {
        if (await this.flip(s, over, bytes, start)) r[over ? 'fupOn' : 'fupOff'] += 1;
      } else if (s.fup?.usedBytes !== bytes || s.fup?.cycleStart?.getTime() !== start.getTime()) {
        cache.push({
          updateOne: {
            filter: { _id: s._id },
            update: { $set: { 'fup.active': over, 'fup.usedBytes': bytes, 'fup.cycleStart': start } },
          },
        });
      }
    }
    if (cache.length)
      await this.db.collection<SubscriberDoc>('subscribers').bulkWrite(cache, { ordered: false });
    return r;
  }

  /** Same contract as an API edit: version-checked change + outbox row in one transaction. */
  private async flip(s: SubscriberDoc, active: boolean, bytes: number, start: Date): Promise<boolean> {
    let changed = false;
    await this.client.withSession((session) =>
      session.withTransaction(async () => {
        const u = await this.db.collection<SubscriberDoc>('subscribers').updateOne(
          { _id: s._id, version: s.version, status: 'active' },
          {
            $set: {
              'fup.active': active,
              'fup.usedBytes': bytes,
              'fup.cycleStart': start,
              syncStatus: 'pending',
              updatedAt: new Date(),
              updatedBy: 'system:fup',
            },
            $inc: { version: 1 },
          },
          { session },
        );
        changed = u.modifiedCount === 1;
        if (!changed) return;
        const now = new Date();
        await this.db.collection<OutboxDoc>('outbox').insertOne(
          {
            _id: new ObjectId(),
            tenantId: s.tenantId,
            entity: 'subscriber',
            entityId: s._id,
            coa: { action: 'disconnect', reason: 'fup' },
            status: 'pending',
            attempts: 0,
            nextAttemptAt: now,
            createdAt: now,
          },
          { session },
        );
      }),
    );
    if (changed)
      this.log.info({ subscriber: s._id.toHexString(), active, bytes }, active ? 'FUP on' : 'FUP off');
    return changed;
  }
}
