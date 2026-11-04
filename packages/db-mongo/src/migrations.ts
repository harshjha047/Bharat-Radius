import { ensureCollection, ensureIndexes, type Migration } from './helpers.js';

const oid = { bsonType: 'objectId' };
const oidOrNull = { bsonType: ['objectId', 'null'] };
const str = { bsonType: 'string' };
const date = { bsonType: 'date' };
const int = { bsonType: ['int', 'long'] };
const encrypted = {
  bsonType: 'object',
  required: ['iv', 'tag', 'data', 'keyId'],
  properties: { iv: str, tag: str, data: str, keyId: str },
};
const standard = { createdAt: date, updatedAt: date, createdBy: str, updatedBy: str };
const standardRequired = ['createdAt', 'updatedAt', 'createdBy', 'updatedBy'];

const identity: Migration = {
  id: '001_identity',
  async up(db) {
    await ensureCollection(db, 'tenants', {
      bsonType: 'object',
      required: [
        'slug',
        'name',
        'legalName',
        'status',
        'stateCode',
        'address',
        'radius',
        'version',
        ...standardRequired,
      ],
      properties: {
        slug: { bsonType: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,39}$' },
        name: str,
        legalName: str,
        status: { enum: ['active', 'suspended', 'deleted'] },
        stateCode: { bsonType: 'string', pattern: '^[0-9]{2}$' },
        gstin: { bsonType: 'string', pattern: '^[0-9A-Z]{15}$' },
        address: { bsonType: 'object', required: ['line1', 'city', 'state', 'pincode'] },
        radius: {
          bsonType: 'object',
          required: ['expiredRate', 'expiredAddressList', 'expiredSessionSecs', 'interimInterval'],
        },
        walletId: oid,
        version: int,
        ...standard,
      },
    });
    await ensureIndexes(db, 'tenants', [
      { key: { slug: 1 }, unique: true },
      {
        key: { 'branding.domain': 1 },
        unique: true,
        partialFilterExpression: { 'branding.domain': { $type: 'string' } },
      },
    ]);

    await ensureCollection(db, 'users', {
      bsonType: 'object',
      required: [
        'tenantId',
        'type',
        'name',
        'roleIds',
        'status',
        'failedLogins',
        'tokenVersion',
        ...standardRequired,
      ],
      properties: {
        tenantId: oidOrNull,
        type: { enum: ['superadmin', 'staff', 'reseller', 'customer'] },
        resellerId: oid,
        subscriberId: oid,
        name: { bsonType: 'string', minLength: 1, maxLength: 120 },
        phone: { bsonType: 'string', pattern: '^\\+[1-9][0-9]{7,14}$' },
        email: { bsonType: 'string', pattern: '^[^A-Z\\s@]+@[^A-Z\\s@]+$' },
        passwordHash: { bsonType: 'string', pattern: '^\\$argon2id\\$' },
        totp: {
          bsonType: 'object',
          required: ['enabled'],
          properties: {
            enabled: { bsonType: 'bool' },
            secret: encrypted,
            pending: encrypted,
            lastUsedStep: int,
          },
        },
        roleIds: { bsonType: 'array', items: oid },
        status: { enum: ['active', 'locked', 'disabled'] },
        failedLogins: int,
        tokenVersion: int,
        lockedUntil: date,
        lastLoginAt: date,
        ...standard,
      },
    });
    await ensureIndexes(db, 'users', [
      {
        key: { tenantId: 1, phone: 1 },
        unique: true,
        partialFilterExpression: { phone: { $type: 'string' } },
      },
      {
        key: { tenantId: 1, email: 1 },
        unique: true,
        partialFilterExpression: { email: { $type: 'string' } },
      },
      { key: { tenantId: 1, type: 1, name: 1 } },
      { key: { resellerId: 1 }, partialFilterExpression: { resellerId: { $exists: true } } },
      { key: { subscriberId: 1 }, partialFilterExpression: { subscriberId: { $exists: true } } },
      { key: { roleIds: 1 } },
    ]);

    await ensureCollection(db, 'roles', {
      bsonType: 'object',
      required: [
        'tenantId',
        'name',
        'scope',
        'permissions',
        'builtIn',
        'requireMfa',
        'createdAt',
        'updatedAt',
      ],
      properties: {
        tenantId: oidOrNull,
        name: { bsonType: 'string', minLength: 1, maxLength: 60 },
        scope: { enum: ['tenant', 'reseller'] },
        permissions: { bsonType: 'array', items: str },
        builtIn: { bsonType: 'bool' },
        requireMfa: { bsonType: 'bool' },
        createdAt: date,
        updatedAt: date,
      },
    });
    await ensureIndexes(db, 'roles', [{ key: { tenantId: 1, name: 1 }, unique: true }]);

    await ensureCollection(db, 'refresh_tokens', {
      bsonType: 'object',
      required: [
        'userId',
        'tenantId',
        'tokenHash',
        'familyId',
        'tokenVersion',
        'mfa',
        'createdAt',
        'expiresAt',
        'familyExpiresAt',
      ],
      properties: {
        userId: oid,
        tenantId: oidOrNull,
        tokenHash: { bsonType: 'string', pattern: '^[0-9a-f]{64}$' },
        familyId: str,
        tokenVersion: int,
        mfa: { enum: ['ok', 'enroll'] },
        expiresAt: date,
        familyExpiresAt: date,
        revokedAt: date,
        revokedReason: { enum: ['rotated', 'logout', 'reuse', 'password', 'admin'] },
      },
    });
    await ensureIndexes(db, 'refresh_tokens', [
      { key: { tokenHash: 1 }, unique: true },
      { key: { familyId: 1 } },
      { key: { userId: 1, revokedAt: 1 } },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
    ]);

    await ensureCollection(db, 'rate_limits');
    await ensureIndexes(db, 'rate_limits', [{ key: { expiresAt: 1 }, expireAfterSeconds: 0 }]);
  },
};

export const MIGRATIONS: readonly Migration[] = [identity];
