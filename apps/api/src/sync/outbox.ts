import { Inject, Injectable } from '@nestjs/common';
import { ObjectId, type ClientSession } from 'mongodb';
import type { MongoHandle, OutboxDoc, OutboxEntity } from '@isp/db-mongo';
import { MONGO } from '../infra/infra.module.js';

/**
 * Writes that must reach RADIUS run inside one MongoDB transaction together with their outbox row (TRD §6.3):
 * either both commit or neither does, so PostgreSQL can never silently miss a change.
 */
@Injectable()
export class Outbox {
  constructor(@Inject(MONGO) private readonly mongo: MongoHandle) {}

  async tx<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
    return this.mongo.client.withSession((s) =>
      s.withTransaction(() => fn(s), { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }),
    );
  }

  async enqueue(
    session: ClientSession,
    tenantId: ObjectId,
    entity: OutboxEntity,
    entityId: ObjectId,
    coa?: OutboxDoc['coa'],
  ): Promise<void> {
    const now = new Date();
    await this.mongo.db.collection<OutboxDoc>('outbox').insertOne(
      {
        _id: new ObjectId(),
        tenantId,
        entity,
        entityId,
        ...(coa ? { coa } : {}),
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now,
        createdAt: now,
      },
      { session },
    );
  }
}
