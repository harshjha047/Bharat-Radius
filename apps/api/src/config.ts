import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')
  .optional();

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_HOST: z.string().default('127.0.0.1'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4100),
    APP_VERSION: z.string().default('dev'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    MONGO_URL: z.string().startsWith('mongodb'),
    MONGO_POOL_MAX: z.coerce.number().int().min(2).max(500).default(20),
    RADIUS_DB_URL: z.string().startsWith('postgres').optional(),
    RADIUS_DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    /** Which RADIUS instance RADIUS_DB_URL feeds (default: from its database name); shown to staff. */
    RADIUS_INSTANCE: z.enum(['production', 'staging']).optional(),
    /** Public IP or name routers send RADIUS to (Routers page, setup instructions). */
    RADIUS_PUBLIC_HOST: z.string().trim().min(1).optional(),
    RADIUS_AUTH_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    RADIUS_ACCT_PORT: z.coerce.number().int().min(1).max(65535).optional(),

    JWT_SIGNING_KEY: z.string().min(32, 'JWT_SIGNING_KEY must be at least 32 characters'),
    REFRESH_TOKEN_PEPPER: z.string().min(32, 'REFRESH_TOKEN_PEPPER must be at least 32 characters'),
    FIELD_ENCRYPTION_KEY: z.string().min(40),

    PUBLIC_BASE_URL: z.url(),
    /** Extra origins allowed to make state-changing requests (comma separated); PUBLIC_BASE_URL is always allowed. */
    ALLOWED_ORIGINS: z.string().optional(),
    /** Fastify trustProxy: CIDRs of the reverse proxy (Caddy) whose X-Forwarded-For is believed. */
    TRUST_PROXY: z.string().default('127.0.0.1/8,::1/128'),
    COOKIE_SECURE: bool,
    OPENAPI_PUBLIC: bool,
    MFA_ISSUER: z.string().default('Bharat Radius'),

    LOGIN_WINDOW_SECS: z.coerce.number().int().min(60).default(900),
    LOGIN_MAX_FAILURES_ACCOUNT: z.coerce.number().int().min(3).default(5),
    /** Per source IP, failures only. Higher than the per-account limit: staff often share one office/CGNAT IP. */
    LOGIN_MAX_FAILURES_IP: z.coerce.number().int().min(5).default(20),
    SESSION_CACHE_TTL_MS: z.coerce.number().int().min(0).max(60_000).default(30_000),
    /** Read-only NAT log archive (/var/log/isp-archive/nat mounted into the container); unset = NAT lookup off. */
    NAT_ARCHIVE_DIR: z.string().optional(),
    /** Private files (KYC, CAF, logos), encrypted before storage. Bucket when FILES_S3_* is set, else this dir. */
    FILES_DIR: z.string().default('/var/lib/isp-files'),
    FILES_S3_ENDPOINT: z.url().optional(),
    FILES_S3_REGION: z.string().trim().min(1).optional(),
    FILES_S3_BUCKET: z.string().trim().min(3).optional(),
    FILES_S3_KEY_ID: z.string().trim().min(1).optional(),
    FILES_S3_SECRET: z.string().trim().min(1).optional(),
    FILES_S3_PREFIX: z.string().trim().default('isp-files'),
  })
  .refine(
    (c) =>
      [c.FILES_S3_ENDPOINT, c.FILES_S3_REGION, c.FILES_S3_BUCKET, c.FILES_S3_KEY_ID, c.FILES_S3_SECRET].every(
        (v) => v === undefined,
      ) ||
      [c.FILES_S3_ENDPOINT, c.FILES_S3_REGION, c.FILES_S3_BUCKET, c.FILES_S3_KEY_ID, c.FILES_S3_SECRET].every(
        (v) => v !== undefined,
      ),
    {
      message: 'set all of FILES_S3_ENDPOINT, _REGION, _BUCKET, _KEY_ID, _SECRET or none',
      path: ['FILES_S3_BUCKET'],
    },
  )
  .transform((c) => {
    const prod = c.NODE_ENV === 'production';
    const origins = new Set([new URL(c.PUBLIC_BASE_URL).origin]);
    for (const o of (c.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean))
      origins.add(new URL(o).origin);
    const instance =
      c.RADIUS_INSTANCE ?? (/\/radius_staging(\?|$)/.test(c.RADIUS_DB_URL ?? '') ? 'staging' : 'production');
    const staging = instance === 'staging';
    return {
      ...c,
      radiusTarget: {
        instance,
        host: c.RADIUS_PUBLIC_HOST ?? null,
        authPort: c.RADIUS_AUTH_PORT ?? (staging ? 11812 : 1812),
        acctPort: c.RADIUS_ACCT_PORT ?? (staging ? 11813 : 1813),
      },
      COOKIE_SECURE: c.COOKIE_SECURE ?? prod,
      OPENAPI_PUBLIC: c.OPENAPI_PUBLIC ?? !prod,
      allowedOrigins: origins as ReadonlySet<string>,
      trustProxy: c.TRUST_PROXY.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    };
  });

export type Config = z.output<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = schema.safeParse(env);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`invalid configuration:\n${lines.join('\n')}`);
  }
  return r.data;
}

export const CONFIG = Symbol('CONFIG');
