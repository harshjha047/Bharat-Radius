import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import type { Logger } from 'pino';

export interface JobDoc {
  _id: string;
  owner?: string;
  leaseUntil?: Date;
  lastRunAt?: Date;
  lastOkAt?: Date;
  lastError?: string;
  durationMs?: number;
  result?: Record<string, number>;
}

interface Job {
  name: string;
  periodMs: number;
  run: () => Promise<Record<string, number>>;
}

const LEASE_MS = 10 * 60_000;
/** Imports should start within seconds of an upload; period-based jobs simply skip ticks until due. */
const TICK_MS = 10_000;

/**
 * Periodic jobs shared by every worker replica: each run is claimed in `_jobs` (due + no live lease), so exactly
 * one replica runs it per period and a crashed runner's lease expires after 10 minutes.
 */
export class Scheduler {
  private readonly owner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly db: Db,
    private readonly jobs: Job[],
    private readonly log: Logger,
  ) {}

  private get col() {
    return this.db.collection<JobDoc>('_jobs');
  }

  /** Claims the job if it is due; returns false when another replica holds it or it ran recently. */
  async claim(job: Job, now = new Date()): Promise<boolean> {
    await this.col.updateOne({ _id: job.name }, { $setOnInsert: { _id: job.name } }, { upsert: true });
    const r = await this.col.updateOne(
      {
        _id: job.name,
        $and: [
          { $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lt: now } }] },
          {
            $or: [
              { lastRunAt: { $exists: false } },
              { lastRunAt: { $lte: new Date(now.getTime() - job.periodMs) } },
            ],
          },
        ],
      },
      { $set: { owner: this.owner, leaseUntil: new Date(now.getTime() + LEASE_MS), lastRunAt: now } },
    );
    return r.modifiedCount === 1;
  }

  async runNow(job: Job): Promise<Record<string, number>> {
    const t0 = Date.now();
    try {
      const result = await job.run();
      await this.col.updateOne(
        { _id: job.name, owner: this.owner },
        {
          $set: { lastOkAt: new Date(), durationMs: Date.now() - t0, result, leaseUntil: new Date() },
          $unset: { lastError: '' },
        },
      );
      this.log.info({ job: job.name, ms: Date.now() - t0, ...result }, 'job done');
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.col.updateOne(
        { _id: job.name, owner: this.owner },
        { $set: { lastError: msg.slice(0, 500), durationMs: Date.now() - t0, leaseUntil: new Date() } },
      );
      this.log.error({ job: job.name, err: msg }, 'job failed');
      throw e;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const job of this.jobs) {
        if (await this.claim(job)) await this.runNow(job).catch(() => {});
      }
    } catch (e) {
      this.log.error({ err: e }, 'scheduler tick failed');
    } finally {
      this.running = false;
    }
  }

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
