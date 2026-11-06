import { z } from 'zod';
import type { RoleDoc, UserDoc } from '@isp/db-mongo';

export const userView = z.object({
  id: z.string(),
  tenantId: z.string().nullable(),
  type: z.enum(['superadmin', 'staff', 'reseller', 'customer']),
  resellerId: z.string().nullable(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  roleIds: z.array(z.string()),
  status: z.enum(['active', 'locked', 'disabled']),
  mfaEnabled: z.boolean(),
  lockedUntil: z.string().nullable(),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
});

export const toUserView = (u: UserDoc): z.output<typeof userView> => ({
  id: u._id.toHexString(),
  tenantId: u.tenantId?.toHexString() ?? null,
  type: u.type,
  resellerId: u.resellerId?.toHexString() ?? null,
  name: u.name,
  email: u.email ?? null,
  phone: u.phone ?? null,
  roleIds: u.roleIds.map((r) => r.toHexString()),
  status: u.status,
  mfaEnabled: u.totp?.enabled === true,
  lockedUntil: u.lockedUntil && u.lockedUntil > new Date() ? u.lockedUntil.toISOString() : null,
  lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
  createdAt: u.createdAt.toISOString(),
});

export const roleView = z.object({
  id: z.string(),
  tenantId: z.string().nullable(),
  name: z.string(),
  scope: z.enum(['tenant', 'reseller']),
  permissions: z.array(z.string()),
  builtIn: z.boolean(),
  requireMfa: z.boolean(),
});

export const toRoleView = (r: RoleDoc): z.output<typeof roleView> => ({
  id: r._id.toHexString(),
  tenantId: r.tenantId?.toHexString() ?? null,
  name: r.name,
  scope: r.scope,
  permissions: r.permissions,
  builtIn: r.builtIn,
  requireMfa: r.requireMfa,
});
