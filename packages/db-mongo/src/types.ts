import type { ObjectId } from 'mongodb';
import type { EncryptedField, RoleScope } from '@isp/shared';
import type { TenantBilling, TenantGateways, TenantSms } from './billing/types.js';

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
  /** Panel options set by the ISP admin. `showUpdates`: the sidebar Updates banner for all staff and resellers. */
  ui?: { showUpdates?: boolean };
  radius: {
    /** Absent = `reject`. */
    expiredMode?: 'reject' | 'walled';
    expiredRate: string;
    expiredAddressList: string;
    expiredSessionSecs: number;
    interimInterval: number;
  };
  radiusId?: number;
  /** The Master wallet (also found by `wallets.ownerId`). */
  walletId?: ObjectId;
  billing?: Partial<TenantBilling>;
  gateways?: TenantGateways;
  sms?: TenantSms;
  /** DPDP: the privacy notice customers accept; a new text is a new version. */
  privacy?: { notice: string; version: number; updatedAt: Date; updatedBy: string };
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
  /** Panel preferences (dashboard configuration). */
  prefs?: { dashboardHidden?: string[]; dashboardOrder?: string[] };
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

export interface NasDeviceDoc extends Standard {
  _id: ObjectId;
  tenantId: ObjectId;
  /** Reseller that added it (absent = the ISP's own); it and its ancestors manage it. */
  resellerId?: ObjectId;
  /** Root → parent of `resellerId`. */
  ancestors?: ObjectId[];
  name: string;
  /** Source IP of RADIUS packets; unset when deleted (kept in deletedIp) so the IP can be reused. */
  ip?: string;
  deletedIp?: string;
  radiusSecret: EncryptedField;
  coaPort: number;
  routerOsVersion?: '6' | '7';
  location?: { popName?: string; address?: string; lat?: number; lng?: number };
  description?: string;
  status: 'active' | 'disabled' | 'deleted';
  deletedAt?: Date;
  lastSeenAt?: Date;
  radiusId?: number;
  /** RouterOS API login for live graphs, ping and live speed (password encrypted, AAD `nas.api:<id>`). */
  api?: {
    enabled: boolean;
    host?: string;
    port: number;
    tls: boolean;
    username: string;
    password: EncryptedField;
  };
  /** Router ports shown with a live graph (uplink, OLT VLAN …). */
  monitorPorts?: { interface: string; label?: string }[];
  version: number;
}

export interface PlanDoc extends Standard {
  _id: ObjectId;
  tenantId: ObjectId;
  name: string;
  description?: string;
  downloadKbps: number;
  uploadKbps: number;
  burst?: {
    downloadKbps: number;
    uploadKbps: number;
    thresholdDownloadKbps: number;
    thresholdUploadKbps: number;
    timeSecs: number;
  };
  /** MikroTik rate string sent as Mikrotik-Rate-Limit, derived from the speeds above. */
  rateLimit: string;
  dataCapBytes?: number;
  fup?: { downloadKbps: number; uploadKbps: number };
  fupRate?: string;
  fupCycle?: 'billing_cycle' | 'calendar_month';
  validityDays: number;
  ipPool?: string;
  simUse: number;
  billingTypes: ('prepaid' | 'postpaid')[];
  pricePaise: number;
  gstRatePercent: number;
  hsnSac: string;
  extraAttributes: { attribute: string; op: ':=' | '=' | '+='; value: string }[];
  status: 'active' | 'archived';
  radiusId?: number;
  version: number;
}

export type OutboxEntity = 'tenant' | 'nas' | 'plan' | 'subscriber';

/**
 * A change that must reach PostgreSQL. The worker reads the entity's current MongoDB state when it processes the
 * row (latest state wins), so rows carry no copy of the data and no secrets.
 */
export interface OutboxDoc {
  _id: ObjectId;
  tenantId: ObjectId;
  entity: OutboxEntity;
  entityId: ObjectId;
  coa?: { action: 'update' | 'disconnect'; reason: CoaReason };
  status: 'pending' | 'processing' | 'done';
  attempts: number;
  nextAttemptAt: Date;
  lockedUntil?: Date;
  lastError?: string;
  createdAt: Date;
  doneAt?: Date;
}

export type ResellerStatus = 'active' | 'suspended' | 'deleted';

export interface ResellerDoc extends Standard {
  _id: ObjectId;
  tenantId: ObjectId;
  /** null = directly under the ISP. */
  parentId: ObjectId | null;
  /** Root → parent; [] at the top level. */
  ancestors: ObjectId[];
  /** ancestors.length + 1 */
  level: number;
  /** R-0001, unique within the tenant. */
  code: string;
  name: string;
  ownerName: string;
  phone?: string;
  email?: string;
  gstin?: string;
  address?: { line1?: string; city?: string; district?: string; state?: string; pincode?: string };
  /** Created with the wallet (WP 3.3). */
  walletId?: ObjectId;
  creditLimitPaise: number;
  canCreateSubResellers: boolean;
  /**
   * How this reseller's wallet pays for a recharge, set by its parent (staff for level 1). Absent = `prepaid`:
   * the per-plan wallet price. `revenue_share`: `shareBp` / 10,000 of the plan price (excl. GST).
   */
  walletModel?: 'prepaid' | 'revenue_share';
  /** Basis points debited under revenue share (4000 = 40 %). */
  shareBp?: number;
  /**
   * Level 1 only, set by ISP staff: its users may bulk-import customers from Excel (no wallet charge). Meant for
   * moving an existing customer base in; switched off again once the migration is done.
   */
  importEnabled?: boolean;
  /** F-8: name and logo shown in this reseller's panel and to its customers (inherited by sub-resellers). */
  branding?: { name?: string; logo?: { key: string; mimeType: string; sha256: string } };
  /** Suspended blocks the reseller's panel and new recharges in its whole branch; customers stay online. */
  status: ResellerStatus;
  suspendReason?: string;
  deletedAt?: Date;
  version: number;
}

export type SubscriberStatus = 'active' | 'suspended' | 'disabled' | 'deleted';

/**
 * How the customer connects (WP 5.9): `pppoe` username/password over PPP; `hotspot` MikroTik Hotspot login page;
 * `static` static IP over IPoE, authorised by MAC (`network.macLock` and `network.staticIp` required).
 */
export type ConnectionType = 'pppoe' | 'hotspot' | 'static';
export const CONNECTION_TYPES: readonly ConnectionType[] = ['pppoe', 'hotspot', 'static'];
/** Documents written before connection types have none: they are PPPoE. */
export const connectionTypeOf = (s: { connectionType?: ConnectionType | undefined }): ConnectionType =>
  s.connectionType ?? 'pppoe';

export interface SubscriberDoc extends Standard {
  _id: ObjectId;
  tenantId: ObjectId;
  resellerId: ObjectId | null;
  ancestors: ObjectId[];
  customerNo: string;
  /** Login username (PPPoE / Hotspot; account id for static IP); moved to deletedUsername on delete. */
  username?: string;
  deletedUsername?: string;
  pppoePassword: EncryptedField;
  name: string;
  phone: string;
  altPhone?: string;
  email?: string;
  address: {
    line1: string;
    line2?: string;
    city: string;
    district?: string;
    state: string;
    stateCode: string;
    pincode: string;
    lat?: number;
    lng?: number;
  };
  gstin?: string;
  billingType: 'prepaid' | 'postpaid';
  planId?: ObjectId;
  expiresAt?: Date;
  status: SubscriberStatus;
  suspendReason?: string;
  /** Absent = `pppoe` (see connectionTypeOf). */
  connectionType?: ConnectionType;
  network: { staticIp?: string; macLock?: string; simUse?: number; popName?: string };
  fup?: { active: boolean; cycleStart?: Date; usedBytes?: number };
  kyc: {
    status: 'pending' | 'verified' | 'rejected';
    cafNo?: string;
    aadhaarLast4?: string;
    /** Who verified or rejected, when, and why (rejection reason / remark). */
    decidedBy?: string;
    decidedAt?: Date;
    note?: string;
  };
  tags: string[];
  notes?: string;
  /** Lower-case prefix tokens (name words, username, phone, customer no.) for indexed search. */
  search: string[];
  radiusId?: number;
  syncStatus: 'synced' | 'pending' | 'error';
  importBatchId?: ObjectId;
  /** Customer portal (Step 4). No passwordHash = sign in with the PPPoE password until one is set. */
  portal?: SubscriberPortal;
  /** DPDP consent: the privacy notice version accepted, when and how. */
  consent?: {
    version: number;
    at: Date;
    via: 'portal' | 'caf' | 'staff';
    ip?: string;
    by?: string;
    note?: string;
  };
  deletedAt?: Date;
  version: number;
}

export interface SubscriberPortal {
  passwordHash?: string;
  /** Bumped on password set/reset; ends every portal session. */
  tokenVersion: number;
  failedLogins?: number;
  lockedUntil?: Date;
  lastLoginAt?: Date;
}

/** One signed-in portal browser. The cookie holds a random token; only its peppered HMAC is stored. */
export interface PortalSessionDoc {
  _id: ObjectId;
  tenantId: ObjectId;
  subscriberId: ObjectId;
  tokenHash: string;
  tokenVersion: number;
  ip: string;
  userAgent?: string;
  createdAt: Date;
  lastSeenAt: Date;
  /** Sliding idle expiry, capped at createdAt + absolute lifetime; TTL index removes the row. */
  expiresAt: Date;
}

export type TicketStatus = 'open' | 'in_progress' | 'waiting_customer' | 'resolved' | 'closed';
export type TicketCategory =
  'no_internet' | 'slow_speed' | 'billing' | 'plan_change' | 'relocation' | 'other';
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface TicketActor {
  type: 'staff' | 'reseller' | 'customer' | 'superadmin' | 'system';
  id: string;
  name: string;
}

/** Support ticket (WP 4.3). `ancestors` = the customer's reseller chain, so a reseller sees its branch's tickets. */
export interface TicketDoc {
  _id: ObjectId;
  tenantId: ObjectId;
  number: string;
  subscriberId: ObjectId | null;
  ancestors: ObjectId[];
  subject: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  assignee: { id: ObjectId; name: string } | null;
  source: 'portal' | 'staff' | 'reseller';
  openedBy: TicketActor;
  messageCount: number;
  lastActivityAt: Date;
  /** First reply visible to the customer from staff or a reseller (response-time reports). */
  firstResponseAt?: Date;
  resolvedAt?: Date;
  closedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

/** Ticket timeline: messages, internal notes and status/assignment changes. Customers never see internal rows. */
export interface TicketEventDoc {
  _id: ObjectId;
  tenantId: ObjectId;
  ticketId: ObjectId;
  kind: 'message' | 'note' | 'status' | 'assign' | 'priority';
  body?: string;
  from?: string;
  to?: string;
  author: TicketActor;
  createdAt: Date;
}

export type CoaReason =
  'plan_change' | 'renewal' | 'fup' | 'kick' | 'suspend' | 'network' | 'password' | 'delete' | 'expired';

export interface CoaLogDoc {
  _id: ObjectId;
  tenantId: ObjectId;
  subscriberId: ObjectId;
  username: string;
  nasIp: string;
  type: 'coa' | 'disconnect';
  attributes?: Record<string, string>;
  /** `skipped_unsupported`: static IP (DHCP) sessions take no CoA; the next lease renewal (≤ 1 h) applies it. */
  result: 'ack' | 'nak' | 'timeout' | 'skipped_offline' | 'skipped_unsupported' | 'error';
  errorCause?: number;
  latencyMs?: number;
  trigger: { type: CoaReason; refId?: ObjectId };
  createdAt: Date;
}

export interface ImportBatchDoc {
  _id: ObjectId;
  tenantId: ObjectId;
  /** Set when a reseller imported: every row becomes its customer. Absent = ISP-level customers. */
  resellerId?: ObjectId;
  source: 'excel';
  fileName: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  counts: { read: number; valid: number; created: number; failed: number };
  /** First 10,000 problems: validation at upload, then creation failures. Excel row numbers. */
  errors: { row: number; column?: string; message: string }[];
  leaseUntil?: Date;
  createdBy: string;
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
}

export interface ImportRowDoc {
  _id: ObjectId;
  batchId: ObjectId;
  tenantId: ObjectId;
  row: number;
  /** Validated input; the PPPoE password is field-encrypted while it waits. */
  input: Omit<import('./subscriber-write.js').NewSubscriber, 'pppoePassword'> & {
    pppoePassword: EncryptedField;
  };
  status: 'pending' | 'done' | 'failed';
  error?: string;
  createdAt: Date;
}

/** Append-only (BACKEND_SCHEMA §4.6). Only changed fields are kept; secrets are replaced before writing. */
export interface AuditLogDoc {
  _id: ObjectId;
  tenantId: ObjectId | null;
  actor: { id: string; type: string; name: string };
  action: string;
  entity: { type: string; id: string | null };
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  requestId?: string;
  createdAt: Date;
}

export type KycKind =
  | 'aadhaar'
  | 'pan'
  | 'voter_id'
  | 'passport'
  | 'driving_licence'
  | 'photo'
  | 'caf_signed'
  | 'address_proof'
  | 'other';

/** One identity/CAF file of a subscriber. The file lives encrypted in the private store under `storageKey`. */
export interface KycDocumentDoc {
  _id: ObjectId;
  tenantId: ObjectId;
  subscriberId: ObjectId;
  /** The subscriber's owner chain (reseller ancestors + owner) for branch scoping. */
  ancestors: ObjectId[];
  kind: KycKind;
  storageKey: string;
  sha256: string;
  mimeType: string;
  sizeBytes: number;
  fileName?: string;
  /** e.g. XXXX-XXXX-1234; full Aadhaar numbers are never stored. */
  maskedNumber?: string;
  uploadedBy: string;
  uploadedVia: 'staff' | 'reseller' | 'portal' | 'import';
  /** Removed from view (wrong file); the object is deleted from storage, the row stays for the audit trail. */
  removed?: { by: string; at: Date; reason: string };
  createdAt: Date;
}
