import type { ObjectId } from 'mongodb';
import type { Permission } from '@isp/shared';
import type { Scope, UserType } from '@isp/db-mongo';

export interface AuthContext {
  userId: ObjectId;
  tenantId: ObjectId | null;
  type: UserType;
  name: string;
  resellerId?: ObjectId;
  /** Portal sessions only: the signed-in customer. Every portal query filters on it. */
  subscriberId?: ObjectId;
  permissions: ReadonlySet<Permission>;
  familyId: string;
  mfa: 'ok' | 'enroll';
  scope: Scope;
  /** Staff or a parent reseller working inside a child reseller's panel (X-View-As). userId stays the real user. */
  viewAs?: { resellerId: ObjectId; code: string; name: string; byName: string };
}

export function scopeFor(u: { tenantId: ObjectId | null; type: UserType; resellerId?: ObjectId }): Scope {
  if (u.type === 'superadmin') return { kind: 'platform' };
  if (!u.tenantId) throw new Error('non-superadmin user without tenant');
  if (u.type === 'reseller') {
    if (!u.resellerId) throw new Error('reseller user without resellerId');
    return { kind: 'branch', tenantId: u.tenantId, resellerId: u.resellerId };
  }
  return { kind: 'tenant', tenantId: u.tenantId };
}
