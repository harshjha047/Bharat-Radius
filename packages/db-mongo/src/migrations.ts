import { ensureCollection, ensureIndexes, USERNAME_COLLATION, type Migration } from './helpers.js';

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

const subscribers: Migration = {
  id: '003_subscribers',
  async up(db) {
    await ensureCollection(db, 'subscribers', {
      bsonType: 'object',
      required: [
        'tenantId',
        'resellerId',
        'ancestors',
        'customerNo',
        'pppoePassword',
        'name',
        'phone',
        'address',
        'billingType',
        'status',
        'network',
        'kyc',
        'tags',
        'search',
        'syncStatus',
        'version',
        ...standardRequired,
      ],
      properties: {
        tenantId: oid,
        resellerId: oidOrNull,
        ancestors: { bsonType: 'array', items: oid },
        customerNo: str,
        username: { bsonType: 'string', pattern: '^[A-Za-z0-9._@-]{3,64}$' },
        deletedUsername: str,
        pppoePassword: encrypted,
        name: { bsonType: 'string', minLength: 1, maxLength: 120 },
        phone: { bsonType: 'string', pattern: '^\\+[1-9][0-9]{7,14}$' },
        address: { bsonType: 'object', required: ['line1', 'city', 'state', 'stateCode', 'pincode'] },
        billingType: { enum: ['prepaid', 'postpaid'] },
        planId: oid,
        expiresAt: date,
        status: { enum: ['active', 'suspended', 'disabled', 'deleted'] },
        network: {
          bsonType: 'object',
          properties: {
            staticIp: str,
            macLock: { bsonType: 'string', pattern: '^([0-9A-F]{2}:){5}[0-9A-F]{2}$' },
            simUse: { bsonType: 'int', minimum: 1, maximum: 10 },
          },
        },
        kyc: { bsonType: 'object', required: ['status'] },
        tags: { bsonType: 'array', items: str },
        search: { bsonType: 'array', items: str },
        syncStatus: { enum: ['synced', 'pending', 'error'] },
        radiusId: int,
        version: int,
        ...standard,
      },
    });
    await ensureIndexes(db, 'subscribers', [
      {
        key: { tenantId: 1, username: 1 },
        unique: true,
        partialFilterExpression: { username: { $type: 'string' } },
      },
      { key: { tenantId: 1, customerNo: 1 }, unique: true },
      {
        key: { tenantId: 1, 'network.staticIp': 1 },
        unique: true,
        partialFilterExpression: { 'network.staticIp': { $type: 'string' } },
      },
      { key: { tenantId: 1, search: 1 } },
      { key: { tenantId: 1, status: 1, _id: -1 } },
      { key: { tenantId: 1, ancestors: 1, status: 1 } },
      { key: { tenantId: 1, resellerId: 1 } },
      { key: { tenantId: 1, planId: 1 } },
      { key: { tenantId: 1, expiresAt: 1 } },
      { key: { tenantId: 1, phone: 1 } },
      {
        key: { tenantId: 1, syncStatus: 1 },
        partialFilterExpression: { syncStatus: { $in: ['pending', 'error'] } },
      },
    ]);

    await ensureCollection(db, 'coa_log');
    await ensureIndexes(db, 'coa_log', [
      { key: { tenantId: 1, subscriberId: 1, createdAt: -1 } },
      { key: { createdAt: 1 }, expireAfterSeconds: 90 * 24 * 3600 },
    ]);
    await ensureCollection(db, 'counters');
  },
};

const imports: Migration = {
  id: '004_imports',
  async up(db) {
    await ensureCollection(db, 'import_batches', {
      bsonType: 'object',
      required: ['tenantId', 'source', 'fileName', 'status', 'counts', 'errors', 'createdBy', 'createdAt'],
      properties: {
        tenantId: oid,
        source: { enum: ['excel'] },
        status: { enum: ['queued', 'running', 'done', 'failed'] },
        errors: { bsonType: 'array', maxItems: 10_000 },
      },
    });
    await ensureIndexes(db, 'import_batches', [
      { key: { tenantId: 1, createdAt: -1 } },
      { key: { status: 1, createdAt: 1 } },
    ]);
    await ensureCollection(db, 'import_rows');
    await ensureIndexes(db, 'import_rows', [
      { key: { batchId: 1, status: 1, row: 1 } },
      // Queued rows hold encrypted passwords; nothing stays longer than two weeks.
      { key: { createdAt: 1 }, expireAfterSeconds: 14 * 24 * 3600 },
    ]);
    await ensureIndexes(db, 'subscribers', [
      {
        key: { importBatchId: 1, username: 1 },
        partialFilterExpression: { importBatchId: { $exists: true } },
      },
    ]);
  },
};

const audit: Migration = {
  id: '005_audit',
  async up(db) {
    await ensureCollection(db, 'audit_logs', {
      bsonType: 'object',
      required: ['tenantId', 'actor', 'action', 'entity', 'createdAt'],
      properties: {
        tenantId: oidOrNull,
        actor: { bsonType: 'object', required: ['id', 'type', 'name'] },
        action: { bsonType: 'string', pattern: '^[a-z0-9_.-]{3,64}$' },
        entity: { bsonType: 'object', required: ['type', 'id'] },
        createdAt: date,
      },
    });
    await ensureIndexes(db, 'audit_logs', [
      { key: { tenantId: 1, _id: -1 } },
      { key: { tenantId: 1, 'entity.type': 1, 'entity.id': 1, _id: -1 } },
      { key: { tenantId: 1, 'actor.id': 1, _id: -1 } },
      { key: { tenantId: 1, action: 1, _id: -1 } },
    ]);
  },
};

const resellers: Migration = {
  id: '006_resellers',
  async up(db) {
    await ensureCollection(db, 'resellers', {
      bsonType: 'object',
      required: [
        'tenantId',
        'parentId',
        'ancestors',
        'level',
        'code',
        'name',
        'ownerName',
        'creditLimitPaise',
        'canCreateSubResellers',
        'status',
        'version',
        ...standardRequired,
      ],
      properties: {
        tenantId: oid,
        parentId: oidOrNull,
        ancestors: { bsonType: 'array', items: oid },
        level: { bsonType: ['int', 'long'], minimum: 1 },
        code: { bsonType: 'string', pattern: '^R-[0-9]{4,}$' },
        name: str,
        ownerName: str,
        walletId: oid,
        creditLimitPaise: { bsonType: ['int', 'long'], minimum: 0 },
        canCreateSubResellers: { bsonType: 'bool' },
        status: { enum: ['active', 'suspended', 'deleted'] },
        version: int,
        ...standard,
      },
    });
    await ensureIndexes(db, 'resellers', [
      { key: { tenantId: 1, code: 1 }, unique: true },
      { key: { tenantId: 1, parentId: 1, _id: -1 } },
      { key: { tenantId: 1, ancestors: 1 } },
      { key: { tenantId: 1, _id: -1 } },
    ]);
  },
};

const money = { bsonType: ['int', 'long', 'double'] };

const billing: Migration = {
  id: '007_billing',
  async up(db) {
    await ensureCollection(db, 'wallets', {
      bsonType: 'object',
      required: [
        'tenantId',
        'ownerType',
        'ownerId',
        'walletType',
        'parentWalletId',
        'balancePaise',
        'creditLimitPaise',
        'isActive',
        'frozen',
        'version',
      ],
      properties: {
        tenantId: oid,
        ownerType: { enum: ['tenant', 'reseller'] },
        ownerId: oid,
        walletType: { bsonType: 'string', pattern: '^(MASTER|L[0-9]+)$' },
        parentWalletId: oidOrNull,
        balancePaise: money,
        creditLimitPaise: money,
        lowBalanceThresholdPaise: money,
        isActive: { bsonType: 'bool' },
        frozen: { bsonType: 'bool' },
        version: int,
      },
    });
    await ensureIndexes(db, 'wallets', [
      { key: { ownerId: 1 }, unique: true },
      { key: { tenantId: 1, parentWalletId: 1 } },
      { key: { tenantId: 1, balancePaise: 1 } },
    ]);
    await ensureCollection(db, 'wallet_txns', {
      bsonType: 'object',
      required: [
        'tenantId',
        'walletId',
        'type',
        'direction',
        'amountPaise',
        'balanceBeforePaise',
        'balanceAfterPaise',
        'referenceId',
        'description',
        'createdAt',
        'createdBy',
      ],
      properties: {
        tenantId: oid,
        walletId: oid,
        type: { enum: ['TOPUP', 'ALLOCATE', 'RECHARGE', 'REFUND', 'ADJUSTMENT'] },
        direction: { enum: ['credit', 'debit'] },
        amountPaise: { ...money, minimum: 1 },
        balanceBeforePaise: money,
        balanceAfterPaise: money,
        referenceId: oid,
        description: { bsonType: 'string', minLength: 1 },
        createdAt: date,
      },
    });
    await ensureIndexes(db, 'wallet_txns', [
      { key: { walletId: 1, createdAt: -1, _id: -1 } },
      { key: { referenceId: 1 } },
      { key: { tenantId: 1, type: 1, createdAt: -1 } },
      { key: { tenantId: 1, createdAt: -1 } },
    ]);
    await ensureCollection(db, 'wallet_transfers', {
      bsonType: 'object',
      required: [
        'tenantId',
        'fromWalletId',
        'toWalletId',
        'amountPaise',
        'status',
        'idempotencyKey',
        'createdAt',
      ],
      properties: {
        tenantId: oid,
        fromWalletId: oid,
        toWalletId: oid,
        amountPaise: { ...money, minimum: 1 },
        idempotencyKey: str,
      },
    });
    await ensureIndexes(db, 'wallet_transfers', [
      { key: { idempotencyKey: 1 }, unique: true },
      { key: { tenantId: 1, fromWalletId: 1, createdAt: -1 } },
      { key: { tenantId: 1, toWalletId: 1, createdAt: -1 } },
    ]);
    await ensureCollection(db, 'reseller_rates', {
      bsonType: 'object',
      required: [
        'tenantId',
        'buyerId',
        'setById',
        'planId',
        'walletPricePaise',
        'active',
        ...standardRequired,
      ],
      properties: {
        tenantId: oid,
        buyerId: oid,
        setById: oid,
        planId: oid,
        walletPricePaise: { ...money, minimum: 0 },
        active: { bsonType: 'bool' },
        ...standard,
      },
    });
    await ensureIndexes(db, 'reseller_rates', [
      { key: { buyerId: 1, planId: 1 }, unique: true },
      { key: { tenantId: 1, setById: 1 } },
    ]);
    await ensureCollection(db, 'recharges', {
      bsonType: 'object',
      required: [
        'tenantId',
        'subscriberId',
        'planId',
        'ancestors',
        'amountPaise',
        'channel',
        'status',
        'newExpiresAt',
        'idempotencyKey',
        'createdAt',
      ],
      properties: {
        tenantId: oid,
        subscriberId: oid,
        planId: oid,
        ancestors: { bsonType: 'array', items: oid },
        amountPaise: money,
        channel: { enum: ['online', 'reseller_wallet', 'cash', 'staff', 'import'] },
        status: { enum: ['SUCCESS', 'REVERSED'] },
        idempotencyKey: str,
      },
    });
    await ensureIndexes(db, 'recharges', [
      { key: { idempotencyKey: 1 }, unique: true },
      { key: { tenantId: 1, subscriberId: 1, _id: -1 } },
      { key: { tenantId: 1, _id: -1 } },
      { key: { tenantId: 1, ancestors: 1, _id: -1 } },
      { key: { tenantId: 1, siteResellerId: 1, _id: -1 } },
    ]);
    await ensureCollection(db, 'invoices', {
      bsonType: 'object',
      required: [
        'tenantId',
        'subscriberId',
        'ancestors',
        'number',
        'financialYear',
        'type',
        'issueDate',
        'dueDate',
        'seller',
        'buyer',
        'lines',
        'totalPaise',
        'paidPaise',
        'balancePaise',
        'status',
      ],
      properties: {
        tenantId: oid,
        subscriberId: oid,
        number: { bsonType: 'string', maxLength: 16 },
        type: { enum: ['prepaid_recharge', 'postpaid_monthly'] },
        status: { enum: ['issued', 'partially_paid', 'paid', 'overdue', 'cancelled'] },
        totalPaise: money,
      },
    });
    await ensureIndexes(db, 'invoices', [
      { key: { tenantId: 1, financialYear: 1, number: 1 }, unique: true },
      { key: { tenantId: 1, subscriberId: 1, issueDate: -1 } },
      { key: { tenantId: 1, status: 1, dueDate: 1 } },
      { key: { tenantId: 1, _id: -1 } },
      { key: { tenantId: 1, ancestors: 1, _id: -1 } },
      {
        key: { subscriberId: 1, periodStart: 1 },
        unique: true,
        partialFilterExpression: { type: 'postpaid_monthly' },
        name: 'one_postpaid_invoice_per_period',
      },
    ]);
    await ensureCollection(db, 'credit_notes', {
      bsonType: 'object',
      required: ['tenantId', 'invoiceId', 'subscriberId', 'number', 'financialYear', 'reason', 'totalPaise'],
      properties: {
        tenantId: oid,
        invoiceId: oid,
        number: { bsonType: 'string', maxLength: 16 },
        reason: { bsonType: 'string', minLength: 1 },
      },
    });
    await ensureIndexes(db, 'credit_notes', [
      { key: { tenantId: 1, financialYear: 1, number: 1 }, unique: true },
      { key: { invoiceId: 1 }, unique: true },
    ]);
    await ensureCollection(db, 'payments', {
      bsonType: 'object',
      required: ['tenantId', 'subscriberId', 'method', 'amountPaise', 'status', 'purpose', 'createdAt'],
      properties: {
        tenantId: oid,
        subscriberId: oid,
        method: { enum: ['razorpay', 'cashfree', 'cash', 'wallet', 'bank_transfer'] },
        amountPaise: { ...money, minimum: 1 },
        status: { enum: ['created', 'pending', 'captured', 'failed', 'refunded'] },
      },
    });
    await ensureIndexes(db, 'payments', [
      {
        key: { method: 1, 'gateway.paymentId': 1 },
        unique: true,
        partialFilterExpression: { 'gateway.paymentId': { $type: 'string' } },
      },
      { key: { 'gateway.linkId': 1 }, partialFilterExpression: { 'gateway.linkId': { $type: 'string' } } },
      {
        key: { idempotencyKey: 1 },
        unique: true,
        partialFilterExpression: { idempotencyKey: { $type: 'string' } },
      },
      { key: { tenantId: 1, subscriberId: 1, _id: -1 } },
      { key: { tenantId: 1, _id: -1 } },
      { key: { tenantId: 1, ancestors: 1, _id: -1 } },
      { key: { status: 1, method: 1, createdAt: 1 } },
    ]);
    await ensureCollection(db, 'message_templates', {
      bsonType: 'object',
      required: ['tenantId', 'key', 'channel', 'dltTemplateId', 'body', 'active'],
      properties: { tenantId: oid, key: str, dltTemplateId: str, body: str, active: { bsonType: 'bool' } },
    });
    await ensureIndexes(db, 'message_templates', [
      { key: { tenantId: 1, key: 1, channel: 1 }, unique: true },
    ]);
    await ensureCollection(db, 'notifications', {
      bsonType: 'object',
      required: [
        'tenantId',
        'channel',
        'to',
        'templateKey',
        'vars',
        'status',
        'attempts',
        'nextAttemptAt',
        'createdAt',
      ],
      properties: { tenantId: oid, status: { enum: ['queued', 'sent', 'failed', 'skipped'] } },
    });
    await ensureIndexes(db, 'notifications', [
      { key: { status: 1, nextAttemptAt: 1 } },
      { key: { tenantId: 1, _id: -1 } },
      { key: { dedupeKey: 1 }, unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } },
      { key: { createdAt: 1 }, expireAfterSeconds: 180 * 86_400 },
    ]);

    // Wallets for everything that exists already: Master per ISP, then resellers top-down.
    const now = new Date();
    const blank = { receivedPaise: 0, allocatedPaise: 0, rechargedPaise: 0, refundedPaise: 0 };
    for (const t of await db
      .collection('tenants')
      .find({ slug: { $ne: 'platform' } })
      .toArray()) {
      await db.collection('wallets').updateOne(
        { ownerId: t._id },
        {
          $setOnInsert: {
            tenantId: t._id,
            ownerType: 'tenant',
            ownerId: t._id,
            walletType: 'MASTER',
            parentWalletId: null,
            balancePaise: 0,
            creditLimitPaise: 0,
            lowBalanceThresholdPaise: 0,
            isActive: true,
            frozen: false,
            totals: blank,
            version: 0,
            createdAt: now,
            updatedAt: now,
          },
        },
        { upsert: true },
      );
    }
    for (const r of await db
      .collection('resellers')
      .find({ status: { $ne: 'deleted' } })
      .sort({ level: 1 })
      .toArray()) {
      const parent = await db.collection('wallets').findOne({ ownerId: r.parentId ?? r.tenantId });
      if (!parent) continue;
      await db.collection('wallets').updateOne(
        { ownerId: r._id },
        {
          $setOnInsert: {
            tenantId: r.tenantId,
            ownerType: 'reseller',
            ownerId: r._id,
            walletType: `L${r.level}`,
            parentWalletId: parent._id,
            balancePaise: 0,
            creditLimitPaise: r.creditLimitPaise ?? 0,
            lowBalanceThresholdPaise: 500_000,
            isActive: true,
            frozen: false,
            totals: blank,
            version: 0,
            createdAt: now,
            updatedAt: now,
          },
        },
        { upsert: true },
      );
    }
  },
};

const portal: Migration = {
  id: '008_portal',
  async up(db) {
    await ensureCollection(db, 'portal_sessions', {
      bsonType: 'object',
      required: [
        'tenantId',
        'subscriberId',
        'tokenHash',
        'tokenVersion',
        'createdAt',
        'lastSeenAt',
        'expiresAt',
      ],
      properties: {
        tenantId: oid,
        subscriberId: oid,
        tokenHash: { bsonType: 'string', pattern: '^[0-9a-f]{64}$' },
        tokenVersion: int,
        createdAt: date,
        lastSeenAt: date,
        expiresAt: date,
      },
    });
    await ensureIndexes(db, 'portal_sessions', [
      { key: { tokenHash: 1 }, unique: true },
      { key: { subscriberId: 1 } },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
    ]);
  },
};

const tickets: Migration = {
  id: '009_tickets',
  async up(db) {
    await ensureCollection(db, 'tickets', {
      bsonType: 'object',
      required: [
        'tenantId',
        'number',
        'subscriberId',
        'ancestors',
        'subject',
        'category',
        'priority',
        'status',
        'assignee',
        'source',
        'openedBy',
        'messageCount',
        'lastActivityAt',
        'createdAt',
        'updatedAt',
        'version',
      ],
      properties: {
        tenantId: oid,
        number: { bsonType: 'string', pattern: '^T[0-9]{6,}$' },
        subscriberId: oidOrNull,
        ancestors: { bsonType: 'array', items: oid },
        subject: { bsonType: 'string', minLength: 1, maxLength: 160 },
        category: { enum: ['no_internet', 'slow_speed', 'billing', 'plan_change', 'relocation', 'other'] },
        priority: { enum: ['low', 'normal', 'high', 'urgent'] },
        status: { enum: ['open', 'in_progress', 'waiting_customer', 'resolved', 'closed'] },
        assignee: { bsonType: ['object', 'null'] },
        source: { enum: ['portal', 'staff', 'reseller'] },
        messageCount: int,
        version: int,
      },
    });
    await ensureIndexes(db, 'tickets', [
      { key: { tenantId: 1, number: 1 }, unique: true },
      { key: { tenantId: 1, lastActivityAt: -1, _id: -1 } },
      { key: { tenantId: 1, status: 1, lastActivityAt: -1, _id: -1 } },
      { key: { tenantId: 1, 'assignee.id': 1, status: 1, lastActivityAt: -1, _id: -1 } },
      { key: { tenantId: 1, subscriberId: 1, lastActivityAt: -1, _id: -1 } },
      { key: { tenantId: 1, ancestors: 1, lastActivityAt: -1, _id: -1 } },
    ]);
    await ensureCollection(db, 'ticket_events', {
      bsonType: 'object',
      required: ['tenantId', 'ticketId', 'kind', 'author', 'createdAt'],
      properties: {
        tenantId: oid,
        ticketId: oid,
        kind: { enum: ['message', 'note', 'status', 'assign', 'priority'] },
        body: { bsonType: 'string', maxLength: 4000 },
        author: { bsonType: 'object', required: ['type', 'id', 'name'] },
        createdAt: date,
      },
    });
    await ensureIndexes(db, 'ticket_events', [{ key: { ticketId: 1, _id: 1 } }]);
  },
};

/** Date-range report scans (WP 4.4): tenant-wide and per reseller branch. */
const reportIndexes: Migration = {
  id: '010_report_indexes',
  async up(db) {
    await ensureIndexes(db, 'invoices', [
      { key: { tenantId: 1, issueDate: 1 } },
      { key: { tenantId: 1, ancestors: 1, issueDate: 1 } },
    ]);
    await ensureIndexes(db, 'credit_notes', [
      { key: { tenantId: 1, createdAt: 1 } },
      { key: { tenantId: 1, ancestors: 1, createdAt: 1 } },
    ]);
    await ensureIndexes(db, 'payments', [
      { key: { tenantId: 1, status: 1, capturedAt: 1 } },
      { key: { tenantId: 1, ancestors: 1, capturedAt: 1 } },
    ]);
    await ensureIndexes(db, 'recharges', [
      { key: { tenantId: 1, rechargeDate: 1 } },
      { key: { tenantId: 1, ancestors: 1, rechargeDate: 1 } },
    ]);
    await ensureIndexes(db, 'tickets', [{ key: { tenantId: 1, createdAt: 1 } }]);
  },
};

/** Dashboard renewal counts and the list's expiry filter: status + validity, tenant-wide and per branch. */
const renewalIndexes: Migration = {
  id: '011_renewal_indexes',
  async up(db) {
    await ensureIndexes(db, 'subscribers', [
      { key: { tenantId: 1, status: 1, expiresAt: 1 } },
      { key: { tenantId: 1, ancestors: 1, status: 1, expiresAt: 1 } },
    ]);
  },
};

/** Financial insights: new-subscriber counts by join date, and open receivables per reseller branch. */
const insightIndexes: Migration = {
  id: '012_insight_indexes',
  async up(db) {
    await ensureIndexes(db, 'subscribers', [
      { key: { tenantId: 1, createdAt: 1 } },
      { key: { tenantId: 1, ancestors: 1, createdAt: 1 } },
    ]);
    await ensureIndexes(db, 'invoices', [{ key: { tenantId: 1, ancestors: 1, status: 1, dueDate: 1 } }]);
  },
};

/** DPDP: who viewed which customer's data (WP 4.6); kept ~3 years by TTL. */
export const ACCESS_LOG_TTL_SECS = 1100 * 86_400;
const accessLogs: Migration = {
  id: '013_access_logs',
  async up(db) {
    await ensureCollection(db, 'access_logs', {
      bsonType: 'object',
      required: ['tenantId', 'actor', 'entity', 'route', 'at'],
      properties: { tenantId: oidOrNull, at: date },
    });
    await ensureIndexes(db, 'access_logs', [
      { key: { tenantId: 1, 'entity.type': 1, 'entity.id': 1, at: -1 } },
      { key: { tenantId: 1, 'actor.id': 1, at: -1 } },
      { key: { at: 1 }, expireAfterSeconds: ACCESS_LOG_TTL_SECS },
    ]);
  },
};

/** Old BharatRadius importer (WP 4.7): legacy id → new id, and one record per apply run. */
const legacyImport: Migration = {
  id: '014_legacy_import',
  async up(db) {
    await ensureIndexes(db, 'legacy_map', [{ key: { tenantId: 1, kind: 1 } }]);
    await ensureIndexes(db, 'legacy_runs', [{ key: { tenantId: 1, startedAt: -1 } }]);
  },
};

/** Usernames unique ignoring case. Fails with the clashing names (fix them first) rather than half-applying. */
const usernameCaseInsensitive: Migration = {
  id: '015_username_case_insensitive',
  async up(db) {
    const subs = db.collection('subscribers');
    const clashes = await subs
      .aggregate<{ _id: { t: unknown; u: string }; names: string[] }>([
        { $match: { username: { $type: 'string', $ne: '' } } },
        {
          $group: {
            _id: { t: '$tenantId', u: { $toLower: '$username' } },
            names: { $push: '$username' },
            n: { $sum: 1 },
          },
        },
        { $match: { n: { $gt: 1 } } },
        { $limit: 20 },
      ])
      .toArray();
    if (clashes.length) {
      throw new Error(
        `usernames differing only in case: ${clashes.map((c) => c.names.join(' / ')).join('; ')} — rename, then rerun`,
      );
    }
    const name = 'tenantId_1_username_ci';
    const existing = await subs.indexes();
    if (!existing.some((i) => i.name === name)) {
      await subs.createIndex(
        { tenantId: 1, username: 1 },
        {
          name,
          unique: true,
          collation: USERNAME_COLLATION,
          partialFilterExpression: { username: { $type: 'string' } },
        },
      );
    }
    if (existing.some((i) => i.name === 'tenantId_1_username_1'))
      await subs.dropIndex('tenantId_1_username_1');
  },
};

/** F-7: resellers ask the wallet above them for a top-up; the parent approves (a normal transfer) or rejects. */
const topupRequests: Migration = {
  id: '016_topup_requests',
  async up(db) {
    const oid = { bsonType: 'objectId' };
    await ensureCollection(db, 'topup_requests', {
      bsonType: 'object',
      required: [
        'tenantId',
        'resellerId',
        'walletId',
        'parentWalletId',
        'ancestors',
        'amountPaise',
        'status',
        'createdBy',
        'createdAt',
        'updatedAt',
      ],
      properties: {
        tenantId: oid,
        resellerId: oid,
        walletId: oid,
        parentWalletId: oid,
        ancestors: { bsonType: 'array', items: oid },
        amountPaise: { bsonType: ['int', 'long'], minimum: 1 },
        approvedPaise: { bsonType: ['int', 'long'], minimum: 1 },
        paidVia: { enum: ['cash', 'upi', 'bank'] },
        status: { enum: ['pending', 'approved', 'rejected', 'cancelled'] },
        transferId: oid,
      },
    });
    await ensureIndexes(db, 'topup_requests', [
      { key: { tenantId: 1, parentWalletId: 1, status: 1, createdAt: -1 } },
      { key: { tenantId: 1, walletId: 1, createdAt: -1 } },
    ]);
  },
};

/** WP 4.5: KYC / CAF documents (files encrypted in the private store; rows hold keys and metadata only). */
const kycDocuments: Migration = {
  id: '017_kyc_documents',
  async up(db) {
    const oid = { bsonType: 'objectId' };
    await ensureCollection(db, 'kyc_documents', {
      bsonType: 'object',
      required: [
        'tenantId',
        'subscriberId',
        'ancestors',
        'kind',
        'storageKey',
        'sha256',
        'mimeType',
        'sizeBytes',
        'uploadedBy',
        'uploadedVia',
        'createdAt',
      ],
      properties: {
        tenantId: oid,
        subscriberId: oid,
        ancestors: { bsonType: 'array', items: oid },
        kind: {
          enum: [
            'aadhaar',
            'pan',
            'voter_id',
            'passport',
            'driving_licence',
            'photo',
            'caf_signed',
            'address_proof',
            'other',
          ],
        },
        storageKey: { bsonType: 'string' },
        sizeBytes: { bsonType: ['int', 'long'], minimum: 1 },
        uploadedVia: { enum: ['staff', 'reseller', 'portal', 'import'] },
      },
    });
    await ensureIndexes(db, 'kyc_documents', [
      { key: { tenantId: 1, subscriberId: 1, createdAt: -1 } },
      { key: { tenantId: 1, ancestors: 1 } },
      { key: { storageKey: 1 }, unique: true },
    ]);
  },
};

/** Resellers add routers: a router may belong to a reseller branch. */
const resellerRouters: Migration = {
  id: '018_reseller_routers',
  async up(db) {
    await ensureIndexes(db, 'nas_devices', [
      { key: { tenantId: 1, resellerId: 1 }, partialFilterExpression: { resellerId: { $type: 'objectId' } } },
      { key: { tenantId: 1, ancestors: 1 }, partialFilterExpression: { ancestors: { $type: 'array' } } },
    ]);
  },
};

/** WP 5.9: static IP subscribers log in by MAC, so a MAC belongs to one static subscriber per ISP. */
const connectionTypes: Migration = {
  id: '019_connection_types',
  async up(db) {
    await ensureIndexes(db, 'subscribers', [
      {
        key: { tenantId: 1, 'network.macLock': 1 },
        name: 'tenantId_1_static_mac',
        unique: true,
        partialFilterExpression: { connectionType: 'static', 'network.macLock': { $type: 'string' } },
      },
    ]);
  },
};

export const MIGRATIONS: readonly Migration[] = [
  identity,
  config,
  subscribers,
  imports,
  audit,
  resellers,
  billing,
  portal,
  tickets,
  reportIndexes,
  renewalIndexes,
  insightIndexes,
  accessLogs,
  legacyImport,
  usernameCaseInsensitive,
  topupRequests,
  kycDocuments,
  resellerRouters,
  connectionTypes,
];
