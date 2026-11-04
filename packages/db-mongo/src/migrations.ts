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

const config: Migration = {
  id: '002_network_config',
  async up(db) {
    await ensureCollection(db, 'nas_devices', {
      bsonType: 'object',
      required: ['tenantId', 'name', 'radiusSecret', 'coaPort', 'status', 'version', ...standardRequired],
      properties: {
        tenantId: oid,
        name: { bsonType: 'string', minLength: 1, maxLength: 64 },
        ip: str,
        deletedIp: str,
        radiusSecret: encrypted,
        coaPort: { bsonType: 'int', minimum: 1, maximum: 65535 },
        routerOsVersion: { enum: ['6', '7'] },
        status: { enum: ['active', 'disabled', 'deleted'] },
        radiusId: int,
        version: int,
        ...standard,
      },
    });
    await ensureIndexes(db, 'nas_devices', [
      { key: { ip: 1 }, unique: true, partialFilterExpression: { ip: { $type: 'string' } } },
      {
        key: { tenantId: 1, name: 1 },
        unique: true,
        partialFilterExpression: { status: { $in: ['active', 'disabled'] } },
      },
      { key: { tenantId: 1, status: 1 } },
    ]);

    const money = { bsonType: ['int', 'long'], minimum: 0 };
    const kbps = { bsonType: 'int', minimum: 8 };
    await ensureCollection(db, 'plans', {
      bsonType: 'object',
      required: [
        'tenantId',
        'name',
        'downloadKbps',
        'uploadKbps',
        'rateLimit',
        'validityDays',
        'simUse',
        'billingTypes',
        'pricePaise',
        'gstRatePercent',
        'hsnSac',
        'extraAttributes',
        'status',
        'version',
        ...standardRequired,
      ],
      properties: {
        tenantId: oid,
        name: { bsonType: 'string', minLength: 1, maxLength: 64 },
        downloadKbps: kbps,
        uploadKbps: kbps,
        rateLimit: { bsonType: 'string', pattern: '^[0-9]+[kM]?/[0-9]+[kM]?( |$)' },
        dataCapBytes: { bsonType: ['int', 'long', 'double'], minimum: 1 },
        fupRate: str,
        validityDays: { bsonType: 'int', minimum: 1, maximum: 3660 },
        simUse: { bsonType: 'int', minimum: 1, maximum: 10 },
        billingTypes: { bsonType: 'array', minItems: 1, items: { enum: ['prepaid', 'postpaid'] } },
        pricePaise: money,
        gstRatePercent: { bsonType: ['int', 'double', 'decimal'], minimum: 0, maximum: 28 },
        hsnSac: { bsonType: 'string', pattern: '^[0-9]{4,8}$' },
        extraAttributes: {
          bsonType: 'array',
          items: {
            bsonType: 'object',
            required: ['attribute', 'op', 'value'],
            properties: { attribute: str, op: { enum: [':=', '=', '+='] }, value: str },
          },
        },
        status: { enum: ['active', 'archived'] },
        radiusId: int,
        version: int,
        ...standard,
      },
    });
    await ensureIndexes(db, 'plans', [
      { key: { tenantId: 1, name: 1 }, unique: true },
      { key: { tenantId: 1, status: 1 } },
    ]);

    await ensureCollection(db, 'outbox', {
      bsonType: 'object',
      required: ['tenantId', 'entity', 'entityId', 'status', 'attempts', 'nextAttemptAt', 'createdAt'],
      properties: {
        tenantId: oid,
        entity: { enum: ['tenant', 'nas', 'plan', 'subscriber'] },
        entityId: oid,
        status: { enum: ['pending', 'processing', 'done'] },
        attempts: int,
        nextAttemptAt: date,
        lockedUntil: date,
        lastError: str,
        createdAt: date,
        doneAt: date,
      },
    });
    await ensureIndexes(db, 'outbox', [
      { key: { status: 1, nextAttemptAt: 1 } },
      { key: { entity: 1, entityId: 1, createdAt: 1 } },
      { key: { doneAt: 1 }, expireAfterSeconds: 30 * 24 * 3600 },
    ]);
  },
};

export const MIGRATIONS: readonly Migration[] = [identity, config];
