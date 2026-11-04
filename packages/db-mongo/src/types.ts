import type { ObjectId } from 'mongodb';
import type { EncryptedField, RoleScope } from '@isp/shared';

export type UserType = 'superadmin' | 'staff' | 'reseller' | 'customer';
export type UserStatus = 'active' | 'locked' | 'disabled';

interface Standard {
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  updatedBy: string;
}

export interface TenantDoc extends Standard {
  _id: ObjectId;
  slug: string;
  name: string;
  legalName: string;
  status: 'active' | 'suspended' | 'deleted';
  stateCode: string;
  gstin?: string;
  address: { line1: string; line2?: string; city: string; district?: string; state: string; pincode: string };
  contact?: { phone?: string; email?: string };
  branding?: { logoKey?: string; primaryColor?: string; domain?: string; subdomain?: string };
  radius: {
    expiredRate: string;
    expiredAddressList: string;
    expiredSessionSecs: number;
    interimInterval: number;
  };
  /** Required from Step 3 (wallets); optional until then. */
  walletId?: ObjectId;
  version: number;
}

export interface UserDoc extends Standard {
  _id: ObjectId;
  tenantId: ObjectId | null;
  type: UserType;
  resellerId?: ObjectId;
  subscriberId?: ObjectId;
  name: string;
  phone?: string;
  email?: string;
  passwordHash?: string;
  totp?: {
    secret?: EncryptedField;
    enabled: boolean;
    enabledAt?: Date;
    pending?: EncryptedField;
    lastUsedStep?: number;
  };
  roleIds: ObjectId[];
  status: UserStatus;
  failedLogins: number;
  lockedUntil?: Date;
  lastLoginAt?: Date;
  /** Bumped on password change, disable, lock, logout-all: invalidates every access and refresh token. */
  tokenVersion: number;
  passwordChangedAt?: Date;
}

export interface RoleDoc {
  _id: ObjectId;
  tenantId: ObjectId | null;
  name: string;
  scope: RoleScope;
  permissions: string[];
  builtIn: boolean;
  requireMfa: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface RefreshTokenDoc {
  _id: ObjectId;
  userId: ObjectId;
  tenantId: ObjectId | null;
  tokenHash: string;
  familyId: string;
  tokenVersion: number;
  mfa: 'ok' | 'enroll';
  userAgent?: string;
  ip?: string;
  createdAt: Date;
  expiresAt: Date;
  familyExpiresAt: Date;
  revokedAt?: Date;
  revokedReason?: 'rotated' | 'logout' | 'reuse' | 'password' | 'admin';
}

export interface RateLimitDoc {
  _id: string;
  count: number;
  expiresAt: Date;
}
