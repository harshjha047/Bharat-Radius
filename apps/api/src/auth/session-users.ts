import { Inject, Injectable } from '@nestjs/common';
import type { ObjectId } from 'mongodb';
import { PERMISSIONS, isPermission, type Permission } from '@isp/shared';
import type { MongoHandle, RoleDoc, TenantDoc, UserDoc } from '@isp/db-mongo';
import { CONFIG, type Config } from '../config.js';
import { MONGO } from '../infra/infra.module.js';

export interface SessionUser {
  user: UserDoc;
  permissions: ReadonlySet<Permission>;
  requireMfa: boolean;
  tenantActive: boolean;
}

const MAX_ENTRIES = 10_000;
const ALL: ReadonlySet<Permission> = new Set(PERMISSIONS);

/**
 * Resolves a user to permissions on every authenticated request. A short in-process cache keeps this off MongoDB
 * for hot sessions; changes made through this replica invalidate at once, other replicas within the TTL.
 */
@Injectable()
export class SessionUsers {
  private readonly cache = new Map<string, { at: number; value: Promise<SessionUser | null> }>();
  private readonly ttl: number;

  constructor(
    @Inject(MONGO) private readonly mongo: MongoHandle,
    @Inject(CONFIG) config: Config,
  ) {
    this.ttl = config.SESSION_CACHE_TTL_MS;
  }

  load(userId: ObjectId): Promise<SessionUser | null> {
    const key = userId.toHexString();
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < this.ttl) return hit.value;
    const value = this.resolve(userId);
    value.catch(() => this.cache.delete(key));
    if (this.cache.size >= MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { at: now, value });
    return value;
  }

  invalidate(userId: ObjectId): void {
    this.cache.delete(userId.toHexString());
  }

  async resolve(userId: ObjectId): Promise<SessionUser | null> {
    const db = this.mongo.db;
    const user = await db.collection<UserDoc>('users').findOne({ _id: userId });
    if (!user) return null;
    if (user.type === 'superadmin') return { user, permissions: ALL, requireMfa: true, tenantActive: true };
    if (!user.tenantId) return null;

    const [roles, tenant] = await Promise.all([
      user.roleIds.length
        ? db
            .collection<RoleDoc>('roles')
            .find({ _id: { $in: user.roleIds }, tenantId: { $in: [user.tenantId, null] } })
            .toArray()
        : Promise.resolve([]),
      db.collection<TenantDoc>('tenants').findOne({ _id: user.tenantId }, { projection: { status: 1 } }),
    ]);
    const wantScope = user.type === 'reseller' ? 'reseller' : 'tenant';
    const permissions = new Set<Permission>();
    let requireMfa = false;
    for (const r of roles) {
      if (r.scope !== wantScope) continue;
      requireMfa ||= r.requireMfa;
      for (const p of r.permissions) if (isPermission(p)) permissions.add(p);
    }
    return { user, permissions, requireMfa, tenantActive: tenant?.status === 'active' };
  }
}
