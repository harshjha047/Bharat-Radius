import { randomBytes } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ObjectId, type Db, type MongoClient } from 'mongodb';
import { pino } from 'pino';
import { connectMongo, migrate, type RoleDoc, type TenantDoc, type UserDoc } from '@isp/db-mongo';
import { FieldCrypto, base32Decode, base32Encode, hotp, totpStep } from '@isp/shared';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/passwords.js';
import { loadConfig, type Config } from '../src/config.js';

export const HOST = 'new.example.test';
export const ORIGIN = `https://${HOST}`;
export const PASSWORD = 'Monsoon-Fibre-42';

export interface Harness {
  app: NestFastifyApplication;
  db: Db;
  client: MongoClient;
  config: Config;
  crypto: FieldCrypto;
  close(): Promise<void>;
}

/** Fresh database per test file; dropped on close. */
export async function startHarness(over: Record<string, string> = {}): Promise<Harness> {
  const base = process.env.MONGO_URL;
  if (!base) throw new Error('MONGO_URL is required for integration tests');
  const url = new URL(base);
  url.pathname = `/isp_test_${randomBytes(4).toString('hex')}`;
  const config = loadConfig({
    NODE_ENV: 'test',
    MONGO_URL: url.toString(),
    JWT_SIGNING_KEY: randomBytes(32).toString('hex'),
    REFRESH_TOKEN_PEPPER: randomBytes(32).toString('hex'),
    FIELD_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    PUBLIC_BASE_URL: ORIGIN,
    SESSION_CACHE_TTL_MS: '0',
    LOG_LEVEL: 'fatal',
    ...(process.env.RADIUS_DB_URL ? { RADIUS_DB_URL: process.env.RADIUS_DB_URL } : {}),
    ...over,
  });
  const { client, db } = await connectMongo(config.MONGO_URL, 5);
  await migrate(db);
  const app = await createApp(config, pino({ level: 'silent' }));
  return {
    app,
    db,
    client,
    config,
    crypto: new FieldCrypto(config.FIELD_ENCRYPTION_KEY),
    async close() {
      await app.close();
      await db.dropDatabase();
      await client.close();
    },
  };
}

export async function seedTenant(db: Db, slug: string, domain?: string): Promise<ObjectId> {
  const now = new Date();
  const _id = new ObjectId();
  await db.collection<TenantDoc>('tenants').insertOne({
    _id,
    slug,
    name: slug,
    legalName: `${slug} Pvt Ltd`,
    status: 'active',
    stateCode: '07',
    address: { line1: '1 Road', city: 'Delhi', state: 'Delhi', pincode: '110001' },
    ...(domain ? { branding: { domain } } : {}),
    radius: {
      expiredRate: '256k/256k',
      expiredAddressList: 'expired',
      expiredSessionSecs: 3600,
      interimInterval: 300,
    },
    version: 0,
    createdAt: now,
    updatedAt: now,
    createdBy: 'test',
    updatedBy: 'test',
  });
  return _id;
}

export async function roleId(db: Db, name: string, tenantId: ObjectId | null = null): Promise<ObjectId> {
  const r = await db.collection<RoleDoc>('roles').findOne({ name, tenantId });
  if (!r) throw new Error(`role ${name} missing`);
  return r._id;
}

export interface SeededUser {
  _id: ObjectId;
  email: string;
  totpSecret?: string;
}

export async function seedUser(
  h: Harness,
  o: { tenantId: ObjectId | null; email: string; roles?: ObjectId[]; totp?: boolean; type?: UserDoc['type'] },
): Promise<SeededUser> {
  const now = new Date();
  const _id = new ObjectId();
  const totpSecret = o.totp ? base32Encode(randomBytes(20)) : undefined;
  await h.db.collection<UserDoc>('users').insertOne({
    _id,
    tenantId: o.tenantId,
    type: o.type ?? (o.tenantId ? 'staff' : 'superadmin'),
    name: o.email.split('@')[0]!,
    email: o.email,
    passwordHash: await hashPassword(PASSWORD),
    roleIds: o.roles ?? [],
    status: 'active',
    failedLogins: 0,
    tokenVersion: 0,
    ...(totpSecret
      ? {
          totp: {
            enabled: true,
            secret: h.crypto.encrypt(totpSecret, `users.totp:${_id.toHexString()}`),
            enabledAt: now,
          },
        }
      : {}),
    createdAt: now,
    updatedAt: now,
    createdBy: 'test',
    updatedBy: 'test',
  });
  return { _id, email: o.email, ...(totpSecret ? { totpSecret } : {}) };
}

export const totpNow = (secret: string, offsetSteps = 0) =>
  hotp(base32Decode(secret), totpStep(Date.now()) + offsetSteps);

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';

/** Browser-like client: cookie jar, Origin header, CSRF header from the readable cookie. */
export class Client {
  readonly jar = new Map<string, string>();
  constructor(
    private readonly h: Harness,
    private readonly origin: string | null = ORIGIN,
  ) {}

  async req(method: Method, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const csrf = this.jar.get('isp_csrf');
    const res = await this.h.app.inject({
      method,
      url,
      headers: {
        host: HOST,
        ...(this.origin && method !== 'GET' ? { origin: this.origin } : {}),
        ...(this.jar.size ? { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...(csrf && method !== 'GET' ? { 'x-csrf-token': decodeURIComponent(csrf) } : {}),
        ...headers,
      },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    for (const c of res.cookies as { name: string; value: string; expires?: Date; maxAge?: number }[]) {
      const gone =
        c.value === '' || c.maxAge === 0 || (c.expires !== undefined && c.expires.getTime() < Date.now());
      if (gone) this.jar.delete(c.name);
      else this.jar.set(c.name, c.value);
    }
    return {
      status: res.statusCode,
      body: res.body ? (safeJson(res.body) as Record<string, any>) : {},
      headers: res.headers,
    };
  }
}

const safeJson = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return { raw: s };
  }
};

/** Signs in through the real endpoints (password, then TOTP if the user has it). */
export async function signIn(h: Harness, user: SeededUser, tenant?: string): Promise<Client> {
  const c = new Client(h);
  const r = await c.req('POST', '/api/v1/auth/login', {
    login: user.email,
    password: PASSWORD,
    ...(tenant ? { tenant } : {}),
  });
  if (r.body.status === 'mfa_required') {
    await h.db.collection('users').updateOne({ _id: user._id }, { $unset: { 'totp.lastUsedStep': '' } });
    const v = await c.req('POST', '/api/v1/auth/2fa/verify', { code: totpNow(user.totpSecret!) });
    if (v.status !== 200) throw new Error(`2fa failed: ${JSON.stringify(v.body)}`);
  } else if (r.status !== 200) {
    throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return c;
}

export async function seedNas(h: Harness, tenantId: ObjectId, ip: string): Promise<ObjectId> {
  const now = new Date();
  const _id = new ObjectId();
  await h.db.collection('nas_devices').insertOne({
    _id,
    tenantId,
    name: `router-${ip}`,
    ip,
    radiusSecret: h.crypto.encrypt('Seeded-Secret-1234', `nas.secret:${_id.toHexString()}`),
    coaPort: 3799,
    status: 'active',
    version: 0,
    createdAt: now,
    updatedAt: now,
    createdBy: 'test',
    updatedBy: 'test',
  });
  return _id;
}

export async function seedPlan(h: Harness, tenantId: ObjectId, name: string): Promise<ObjectId> {
  const now = new Date();
  const _id = new ObjectId();
  await h.db.collection('plans').insertOne({
    _id,
    tenantId,
    name,
    downloadKbps: 50_000,
    uploadKbps: 50_000,
    rateLimit: '50M/50M',
    validityDays: 30,
    simUse: 1,
    billingTypes: ['prepaid'],
    pricePaise: 50_000,
    gstRatePercent: 18,
    hsnSac: '998422',
    extraAttributes: [],
    status: 'active',
    version: 0,
    createdAt: now,
    updatedAt: now,
    createdBy: 'test',
    updatedBy: 'test',
  });
  return _id;
}

export async function seedSubscriber(h: Harness, tenantId: ObjectId, username: string): Promise<ObjectId> {
  const now = new Date();
  const _id = new ObjectId();
  await h.db.collection('subscribers').insertOne({
    _id,
    tenantId,
    resellerId: null,
    ancestors: [],
    customerNo: `C${username}`,
    username,
    pppoePassword: h.crypto.encrypt('seeded-pw', `subscribers.pppoe:${_id.toHexString()}`),
    name: 'Seeded Subscriber',
    phone: '+919812345678',
    address: { line1: 'x', city: 'Delhi', state: 'Delhi', stateCode: '07', pincode: '110001' },
    billingType: 'prepaid',
    status: 'active',
    network: {},
    kyc: { status: 'pending' },
    tags: [],
    search: [username],
    syncStatus: 'synced',
    version: 0,
    createdAt: now,
    updatedAt: now,
    createdBy: 'test',
    updatedBy: 'test',
  });
  return _id;
}
