import { Inject, Injectable } from '@nestjs/common';
import type { MongoHandle, RateLimitDoc } from '@isp/db-mongo';
import { MONGO } from '../infra/infra.module.js';

/** Fixed-window counters in MongoDB (TTL-expired): shared by every API replica, no Redis needed at this scale. */
@Injectable()
export class RateLimiter {
  constructor(@Inject(MONGO) private readonly mongo: MongoHandle) {}

  private get col() {
    return this.mongo.db.collection<RateLimitDoc>('rate_limits');
  }

  async hit(key: string, windowSecs: number): Promise<{ count: number; retryAfterSecs: number }> {
    const now = new Date();
    const fresh = new Date(now.getTime() + windowSecs * 1000);
    const live = { $gt: ['$expiresAt', now] };
    const doc = await this.col.findOneAndUpdate(
      { _id: key },
      [
        {
          $set: {
            count: { $cond: [live, { $add: ['$count', 1] }, 1] },
            expiresAt: { $cond: [live, '$expiresAt', fresh] },
          },
        },
      ],
      { upsert: true, returnDocument: 'after', includeResultMetadata: false },
    );
    return { count: doc!.count, retryAfterSecs: retryAfter(doc!.expiresAt, now) };
  }

  async peek(key: string): Promise<{ count: number; retryAfterSecs: number }> {
    const now = new Date();
    const doc = await this.col.findOne({ _id: key, expiresAt: { $gt: now } });
    return doc
      ? { count: doc.count, retryAfterSecs: retryAfter(doc.expiresAt, now) }
      : { count: 0, retryAfterSecs: 0 };
  }

  async reset(key: string): Promise<void> {
    await this.col.deleteOne({ _id: key });
  }
}

const retryAfter = (exp: Date, now: Date) => Math.max(1, Math.ceil((exp.getTime() - now.getTime()) / 1000));
