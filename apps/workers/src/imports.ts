import type { Db, MongoClient } from 'mongodb';
import type { Logger } from 'pino';
import type { FieldCrypto } from '@isp/shared';
import {
  insertSubscriber,
  USERNAME_COLLATION,
  type ImportBatchDoc,
  type ImportRowDoc,
  type SubscriberDoc,
} from '@isp/db-mongo';

const LEASE_MS = 10 * 60_000;
/** One pass works at most this long, then hands back so other jobs and batches get a turn. */
const SLICE_MS = 4 * 60_000;
const CHUNK = 200;
const MAX_ERRORS = 10_000;

/**
 * Creates subscribers queued by an Excel import (WP 2.9), through the same writer as the API, so every row gets a
 * customer number, encrypted password and its RADIUS sync. Resumable: a crash leaves rows pending and the batch
 * lease expires; a row created just before a crash is recognised by its importBatchId instead of failing as a dup.
 */
export class ImportJob {
  constructor(
    private readonly client: MongoClient,
    private readonly db: Db,
    private readonly crypto: FieldCrypto,
    private readonly log: Logger,
  ) {}

  private get batches() {
    return this.db.collection<ImportBatchDoc>('import_batches');
  }

  private get rows() {
    return this.db.collection<ImportRowDoc>('import_rows');
  }

  async run(): Promise<{ batches: number; created: number; failed: number }> {
    const total = { batches: 0, created: 0, failed: 0 };
    const until = Date.now() + SLICE_MS;
    while (Date.now() < until) {
      const now = new Date();
      const batch = await this.batches.findOneAndUpdate(
        {
          status: { $in: ['queued', 'running'] },
          $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lt: now } }],
        },
        {
          $set: { status: 'running', leaseUntil: new Date(now.getTime() + LEASE_MS) },
          $min: { startedAt: now },
        },
        { sort: { createdAt: 1 }, returnDocument: 'after', includeResultMetadata: false },
      );
      if (!batch) break;
      total.batches += 1;
      const r = await this.process(batch, until);
      total.created += r.created;
      total.failed += r.failed;
    }
    return total;
  }

  private async process(batch: ImportBatchDoc, until: number) {
    const done = { created: 0, failed: 0 };
    for (;;) {
      if (Date.now() >= until) {
        await this.batches.updateOne({ _id: batch._id }, { $unset: { leaseUntil: '' } });
        return done;
      }
      const chunk = await this.rows
        .find({ batchId: batch._id, status: 'pending' }, { sort: { row: 1 }, limit: CHUNK })
        .toArray();
      if (!chunk.length) {
        await this.batches.updateOne(
          { _id: batch._id },
          { $set: { status: 'done', finishedAt: new Date() }, $unset: { leaseUntil: '' } },
        );
        this.log.info({ batch: batch._id.toHexString(), ...batch.counts }, 'import finished');
        return done;
      }
      let created = 0;
      const errors: ImportBatchDoc['errors'] = [];
      for (const row of chunk) {
        const error = await this.createOne(batch, row);
        if (error)
          errors.push({
            row: row.row,
            ...(error.column ? { column: error.column } : {}),
            message: error.message,
          });
        else created += 1;
        await this.rows.updateOne(
          { _id: row._id },
          error
            ? { $set: { status: 'failed', error: error.message }, $unset: { input: '' } }
            : { $set: { status: 'done' }, $unset: { input: '' } },
        );
      }
      done.created += created;
      done.failed += errors.length;
      await this.batches.updateOne(
        { _id: batch._id },
        {
          $inc: { 'counts.created': created, 'counts.failed': errors.length },
          $push: { errors: { $each: errors, $slice: MAX_ERRORS } },
          $set: { leaseUntil: new Date(Date.now() + LEASE_MS) },
        },
      );
    }
  }

  private async createOne(
    batch: ImportBatchDoc,
    row: ImportRowDoc,
  ): Promise<{ column?: string; message: string } | null> {
    const password = this.crypto.decrypt(row.input.pppoePassword, `import_rows:${row._id.toHexString()}`);
    try {
      await insertSubscriber(
        this.client,
        this.db,
        this.crypto,
        {
          tenantId: batch.tenantId,
          actor: batch.createdBy,
          importBatchId: batch._id,
          // A reseller's import (level 1 only): its customers, with the reseller as their only ancestor.
          ...(batch.resellerId ? { resellerId: batch.resellerId, ancestors: [batch.resellerId] } : {}),
        },
        { ...row.input, pppoePassword: password },
      );
      return null;
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) {
        return { message: `Not created: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}` };
      }
      const mine = await this.db
        .collection<SubscriberDoc>('subscribers')
        .findOne(
          { importBatchId: batch._id, username: row.input.username },
          { projection: { _id: 1 }, collation: USERNAME_COLLATION },
        );
      if (mine) return null;
      const key = Object.keys((e as { keyPattern?: object }).keyPattern ?? {});
      return key.includes('network.staticIp')
        ? { column: 'static_ip', message: 'Static IP was taken by another subscriber meanwhile' }
        : { column: 'username', message: 'Username was taken by another subscriber meanwhile' };
    }
  }
}
