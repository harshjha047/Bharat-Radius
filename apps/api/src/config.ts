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
    MFA_ISSUER: z.string().default('BharatRadius'),

    LOGIN_WINDOW_SECS: z.coerce.number().int().min(60).default(900),
    LOGIN_MAX_FAILURES_ACCOUNT: z.coerce.number().int().min(3).default(5),
    /** Per source IP, failures only. Higher than the per-account limit: staff often share one office/CGNAT IP. */
    LOGIN_MAX_FAILURES_IP: z.coerce.number().int().min(5).default(20),
    SESSION_CACHE_TTL_MS: z.coerce.number().int().min(0).max(60_000).default(30_000),
  })
  .transform((c) => {
    const prod = c.NODE_ENV === 'production';
    const origins = new Set([new URL(c.PUBLIC_BASE_URL).origin]);
    for (const o of (c.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean))
      origins.add(new URL(o).origin);
    return {
      ...c,
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
