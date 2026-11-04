import type { Db, ObjectId } from 'mongodb';
import type pg from 'pg';
import type { NasDeviceDoc, PlanDoc, TenantDoc } from '@isp/db-mongo';
import type { FieldCrypto } from '@isp/shared';

type Tx = pg.PoolClient;

/** Tries each statement in order until one touches a row: update by sync key → adopt a pre-existing row → insert. */
async function upsert(tx: Tx, steps: { sql: string; params: unknown[] }[]): Promise<number> {
  for (const s of steps) {
    const r = await tx.query<{ id: number }>(s.sql, s.params);
    if (r.rowCount) return r.rows[0]!.id;
  }
  throw new Error('upsert touched no row');
}

async function inTx<T>(pool: pg.Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const r = await fn(tx);
    await tx.query('COMMIT');
    return r;
  } catch (e) {
    await tx.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    tx.release();
  }
}

/**
 * Writes the current MongoDB state of one entity into the RADIUS database (BACKEND_SCHEMA §2.1).
 * Idempotent: replaying any number of times converges to the same rows. Rows created before sync existed
 * (Step 1 installer, manual seeds) are adopted by their natural key when they have no external_id yet.
 */
export class RadiusSync {
  constructor(
    private readonly pool: pg.Pool,
    private readonly db: Db,
    private readonly crypto: FieldCrypto,
  ) {}

  private async tenantPgId(tx: Tx, tenantId: ObjectId): Promise<number> {
    const r = await tx.query<{ id: number }>('SELECT id FROM tenants WHERE external_id = $1', [
      tenantId.toHexString(),
    ]);
    if (r.rowCount) return r.rows[0]!.id;
    const t = await this.db.collection<TenantDoc>('tenants').findOne({ _id: tenantId });
    if (!t) throw new Error(`tenant ${tenantId.toHexString()} missing in MongoDB`);
    return this.writeTenant(tx, t);
  }

  private async writeTenant(tx: Tx, t: TenantDoc): Promise<number> {
    const p = [
      t._id.toHexString(),
      t.slug,
      t.name,
      t.status === 'active' ? 'active' : 'suspended',
      t.radius.expiredRate,
      t.radius.expiredAddressList,
      t.radius.expiredSessionSecs,
      t.radius.interimInterval,
    ];
    const cols = `slug = $2, name = $3, status = $4, expired_rate = $5, expired_address_list = $6,
                  expired_session_secs = $7, interim_interval = $8, updated_at = now()`;
    return upsert(tx, [
      { sql: `UPDATE tenants SET ${cols} WHERE external_id = $1 RETURNING id`, params: p },
      {
        sql: `UPDATE tenants SET external_id = $1, ${cols} WHERE slug = $2 AND external_id IS NULL RETURNING id`,
        params: p,
      },
      {
        sql: `INSERT INTO tenants (external_id, slug, name, status, expired_rate, expired_address_list,
                                   expired_session_secs, interim_interval)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        params: p,
      },
    ]);
  }

  async tenant(id: ObjectId): Promise<'synced' | 'gone'> {
    const t = await this.db.collection<TenantDoc>('tenants').findOne({ _id: id });
    if (!t) return 'gone';
    const pgId = await inTx(this.pool, (tx) => this.writeTenant(tx, t));
    await this.db.collection<TenantDoc>('tenants').updateOne({ _id: id }, { $set: { radiusId: pgId } });
    return 'synced';
  }

  async nas(id: ObjectId): Promise<'synced' | 'gone'> {
    const col = this.db.collection<NasDeviceDoc>('nas_devices');
    const n = await col.findOne({ _id: id });
    const ext = id.toHexString();
    if (!n || n.status !== 'active' || !n.ip) {
      await this.pool.query('DELETE FROM nas WHERE external_id = $1', [ext]);
      if (n?.radiusId !== undefined) await col.updateOne({ _id: id }, { $unset: { radiusId: '' } });
      return 'gone';
    }
    const secret = this.crypto.decrypt(n.radiusSecret, `nas.secret:${ext}`);
    const pgId = await inTx(this.pool, async (tx) => {
      const p = [
        ext,
        await this.tenantPgId(tx, n.tenantId),
        n.ip,
        n.name.slice(0, 64),
        secret,
        n.coaPort,
        n.location?.popName ?? n.description ?? null,
      ];
      const cols = `tenant_id = $2, nasname = $3::inet, shortname = $4, secret = $5, coa_port = $6, description = $7,
                    updated_at = now()`;
      return upsert(tx, [
        { sql: `UPDATE nas SET ${cols} WHERE external_id = $1 RETURNING id`, params: p },
        {
          sql: `UPDATE nas SET external_id = $1, ${cols} WHERE nasname = $3::inet AND external_id IS NULL RETURNING id`,
          params: p,
        },
        {
          sql: `INSERT INTO nas (external_id, tenant_id, nasname, shortname, secret, coa_port, description)
                VALUES ($1, $2, $3::inet, $4, $5, $6, $7) RETURNING id`,
          params: p,
        },
      ]);
    });
    await col.updateOne({ _id: id }, { $set: { radiusId: pgId } });
    return 'synced';
  }

  async plan(id: ObjectId): Promise<'synced' | 'gone'> {
    const col = this.db.collection<PlanDoc>('plans');
    const plan = await col.findOne({ _id: id });
    if (!plan) return 'gone';
    const ext = id.toHexString();
    const pgId = await inTx(this.pool, async (tx) => {
      const p = [
        ext,
        await this.tenantPgId(tx, plan.tenantId),
        plan.name,
        plan.rateLimit,
        plan.fupRate ?? null,
        plan.ipPool ?? null,
        plan.simUse,
        plan.status,
      ];
      const cols = `tenant_id = $2, name = $3, rate_limit = $4, fup_rate = $5, ip_pool = $6, sim_use = $7, status = $8,
                    updated_at = now()`;
      const planId = await upsert(tx, [
        { sql: `UPDATE plans SET ${cols} WHERE external_id = $1 RETURNING id`, params: p },
        {
          sql: `UPDATE plans SET external_id = $1, ${cols} WHERE tenant_id = $2 AND name = $3 AND external_id IS NULL RETURNING id`,
          params: p,
        },
        {
          sql: `INSERT INTO plans (external_id, tenant_id, name, rate_limit, fup_rate, ip_pool, sim_use, status)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          params: p,
        },
      ]);
      await tx.query('DELETE FROM plan_attributes WHERE plan_id = $1', [planId]);
      if (plan.extraAttributes.length) {
        await tx.query(
          `INSERT INTO plan_attributes (plan_id, attribute, op, value)
           SELECT $1, a, o, v FROM unnest($2::text[], $3::text[], $4::text[]) AS t(a, o, v)`,
          [
            planId,
            plan.extraAttributes.map((a) => a.attribute),
            plan.extraAttributes.map((a) => a.op),
            plan.extraAttributes.map((a) => a.value),
          ],
        );
      }
      return planId;
    });
    await col.updateOne({ _id: id }, { $set: { radiusId: pgId } });
    return 'synced';
  }
}
