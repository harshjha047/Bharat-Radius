import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { ChangeStream, Db } from 'mongodb';
import type { Logger } from 'pino';
import type { OutboxDoc, OutboxEntity } from '@isp/db-mongo';
import { strongest, type CoaAction, type CoaSender } from './coa.js';
import type { RadiusSync } from './radius-sync.js';

const LEASE_ID = 'outbox-worker';
const LEASE_MS = 15_000;
const CLAIM_MS = 60_000;
const POLL_MS = 1000;
const MAX_BACKOFF_MS = 5 * 60_000;

export const backoffMs = (attempts: number) =>
  Math.min(5000 * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);

export interface Stats {
  synced: Record<OutboxEntity, number>;
  errors: Record<OutboxEntity, number>;
  leader: boolean;
  lastPassAt: number;
}

/**
 * Drains the MongoDB outbox into PostgreSQL (TRD §6.3). One leader at a time (lease in `_locks`), rows taken oldest
 * first; a change stream on inserts wakes it at once, a 1 s poll covers retries and missed events.
 * Each row syncs the entity's *current* state, so rows queued earlier for the same entity are settled with it.
 */
export class OutboxWorker {
  readonly stats: Stats = {
    synced: { tenant: 0, nas: 0, plan: 0, subscriber: 0 },
    errors: { tenant: 0, nas: 0, plan: 0, subscriber: 0 },
    leader: false,
    lastPassAt: 0,
  };
  private readonly owner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private stopped = false;
  private wake: (() => void) | undefined;
  private stream: ChangeStream | undefined;

  constructor(
    private readonly db: Db,
    private readonly sync: RadiusSync,
    private readonly log: Logger,
    private readonly coa?: CoaSender,
  ) {}

  private get outbox() {
    return this.db.collection<OutboxDoc>('outbox');
  }

  async holdLease(): Promise<boolean> {
    const now = new Date();
    try {
      await this.db
        .collection<{ _id: string; owner: string; expiresAt: Date }>('_locks')
        .updateOne(
          { _id: LEASE_ID, $or: [{ owner: this.owner }, { expiresAt: { $lt: now } }] },
          { $set: { owner: this.owner, expiresAt: new Date(now.getTime() + LEASE_MS) } },
          { upsert: true },
        );
      if (!this.stats.leader) this.log.info('outbox leader');
      this.stats.leader = true;
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
      if (this.stats.leader) this.log.warn('outbox leadership lost');
      this.stats.leader = false;
    }
    return this.stats.leader;
  }

  private async claim(): Promise<OutboxDoc | null> {
    const now = new Date();
    return this.outbox.findOneAndUpdate(
      {
        $or: [
          { status: 'pending', nextAttemptAt: { $lte: now } },
          { status: 'processing', lockedUntil: { $lt: now } },
        ],
      },
      {
        $set: { status: 'processing', lockedUntil: new Date(now.getTime() + CLAIM_MS) },
        $inc: { attempts: 1 },
      },
      { sort: { createdAt: 1 }, returnDocument: 'after', includeResultMetadata: false },
    );
  }

  /** Writes the entity to PostgreSQL, then sends the strongest CoA any of the settled rows asked for. */
  private async run(row: OutboxDoc, coa: CoaAction | undefined): Promise<string> {
    switch (row.entity) {
      case 'tenant':
        return this.sync.tenant(row.entityId);
      case 'nas':
        return this.sync.nas(row.entityId);
      case 'plan': {
        const r = await this.sync.plan(row.entityId);
        if (coa && this.coa) await this.coa.forPlan(row.tenantId, row.entityId.toHexString(), coa.reason);
        return r;
      }
      case 'subscriber': {
        const r = await this.sync.subscriber(row.entityId);
        if (coa && this.coa && r.username)
          await this.coa.forSubscriber(row.tenantId, row.entityId, r.username, coa);
        return r.result;
      }
    }
  }

  /** Processes one row. Returns false when nothing was due. */
  async step(): Promise<boolean> {
    const row = await this.claim();
    if (!row) return false;
    // Rows already committed for this entity are covered by the state read below (same transaction as their change).
    const siblings = await this.outbox
      .find(
        { entity: row.entity, entityId: row.entityId, status: 'pending', _id: { $ne: row._id } },
        { projection: { _id: 1, coa: 1 } },
      )
      .toArray();
    try {
      const result = await this.run(row, strongest([row.coa, ...siblings.map((x) => x.coa)]));
      const done = {
        $set: { status: 'done' as const, doneAt: new Date() },
        $unset: { lockedUntil: '' as const, lastError: '' as const },
      };
      await this.outbox.updateMany({ _id: { $in: [row._id, ...siblings.map((s) => s._id)] } }, done);
      this.stats.synced[row.entity] += 1;
      this.log.debug(
        {
          entity: row.entity,
          id: row.entityId.toHexString(),
          result,
          ms: Date.now() - row.createdAt.getTime(),
        },
        'synced',
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.stats.errors[row.entity] += 1;
      await this.outbox.updateOne(
        { _id: row._id },
        {
          $set: {
            status: 'pending',
            nextAttemptAt: new Date(Date.now() + backoffMs(row.attempts)),
            lastError: msg.slice(0, 500),
          },
          $unset: { lockedUntil: '' },
        },
      );
      if (row.entity === 'subscriber' && row.attempts >= 3) {
        await this.db
          .collection('subscribers')
          .updateOne({ _id: row.entityId }, { $set: { syncStatus: 'error' } });
      }
      this.log.warn(
        { entity: row.entity, id: row.entityId.toHexString(), attempts: row.attempts, err: msg },
        'sync failed',
      );
    }
    return true;
  }

  /** Processes everything currently due (tests, and one pass of the loop). */
  async drain(max = 10_000): Promise<number> {
    let n = 0;
    while (n < max && !this.stopped && (await this.step())) n++;
    this.stats.lastPassAt = Date.now();
    return n;
  }

  async start(): Promise<void> {
    this.watch();
    let lastLease = 0;
    while (!this.stopped) {
      try {
        if (Date.now() - lastLease > LEASE_MS / 3) {
          await this.holdLease();
          lastLease = Date.now();
        }
        if (this.stats.leader) await this.drain(500);
        else this.stats.lastPassAt = Date.now();
      } catch (e) {
        this.log.error({ err: e }, 'outbox loop error');
      }
      await new Promise<void>((r) => {
        const t = setTimeout(r, POLL_MS);
        this.wake = () => {
          clearTimeout(t);
          r();
        };
      });
    }
  }

  private watch(): void {
    try {
      this.stream = this.outbox.watch([{ $match: { operationType: 'insert' } }], { batchSize: 100 });
      this.stream.on('change', () => this.wake?.());
      this.stream.on('error', (err) => {
        this.log.warn({ err }, 'outbox change stream closed; polling only until restart');
        this.stream = undefined;
      });
    } catch (err) {
      this.log.warn({ err }, 'change stream unavailable; polling');
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.stream?.close().catch(() => {});
    if (this.stats.leader) {
      await this.db
        .collection<{ _id: string; owner: string }>('_locks')
        .deleteOne({ _id: LEASE_ID, owner: this.owner });
    }
  }
}
