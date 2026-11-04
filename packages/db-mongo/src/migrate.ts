import { hostname } from 'node:os';
import type { Db } from 'mongodb';
import { BUILT_IN_ROLES } from '@isp/shared';
import { MIGRATIONS } from './migrations.js';

const LOCK_TTL_MS = 10 * 60_000;

/** Built-in roles live in code; every migrate run makes the database match. */
export async function syncBuiltInRoles(db: Db): Promise<void> {
  const now = new Date();
  await db.collection('roles').bulkWrite(
    BUILT_IN_ROLES.map((r) => ({
      updateOne: {
        filter: { tenantId: null, name: r.name },
        update: {
          $set: {
            scope: r.scope,
            permissions: [...r.permissions],
            requireMfa: r.requireMfa,
            builtIn: true,
            updatedAt: now,
          },
          $setOnInsert: { tenantId: null, name: r.name, createdAt: now },
        },
        upsert: true,
      },
    })),
  );
}

export async function pendingMigrations(db: Db): Promise<string[]> {
  const done = new Set(
    (await db.collection<{ _id: string }>('_migrations').find({}).toArray()).map((d) => d._id),
  );
  return MIGRATIONS.filter((m) => !done.has(m.id)).map((m) => m.id);
}

/** Applies pending migrations in order under a lock (safe with several API replicas or a deploy race). */
export async function migrate(db: Db, log: (msg: string) => void = () => {}): Promise<string[]> {
  const locks = db.collection<{ _id: string; owner: string; expiresAt: Date }>('_locks');
  const owner = `${hostname()}:${process.pid}:${Date.now()}`;
  const now = new Date();
  try {
    await locks.updateOne(
      { _id: 'migrate', expiresAt: { $lt: now } },
      { $set: { owner, expiresAt: new Date(now.getTime() + LOCK_TTL_MS) } },
      { upsert: true },
    );
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw new Error('another migration run holds the lock');
    throw e;
  }
  try {
    const applied: string[] = [];
    const done = new Set(
      (await db.collection<{ _id: string }>('_migrations').find({}).toArray()).map((d) => d._id),
    );
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      log(`applying ${m.id}`);
      await m.up(db);
      await db.collection<{ _id: string; at: Date }>('_migrations').insertOne({ _id: m.id, at: new Date() });
      applied.push(m.id);
    }
    await syncBuiltInRoles(db);
    return applied;
  } finally {
    await locks.deleteOne({ _id: 'migrate', owner });
  }
}
