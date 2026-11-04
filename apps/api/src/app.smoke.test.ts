import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { InjectOptions } from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { testEnv } from './unit.test.js';

/** Boots the real Nest/Fastify app with MongoDB stubbed: proves wiring, prefixing, guard and error format without a DB. */
vi.mock('@isp/db-mongo', async (orig) => {
  const real = await orig<typeof import('@isp/db-mongo')>();
  const empty = { find: () => ({ toArray: async () => real.MIGRATIONS.map((m) => ({ _id: m.id })) }) };
  return {
    ...real,
    connectMongo: async () => ({ client: { close: async () => {} }, db: { collection: () => empty } }),
  };
});

let app: NestFastifyApplication;
const inject = (o: InjectOptions) => app.getHttpAdapter().getInstance().inject(o);

beforeAll(async () => {
  const { createApp } = await import('./app.js');
  app = await createApp(loadConfig(testEnv()), pino({ level: 'silent' }));
});
afterAll(() => app?.close());

describe('app wiring', () => {
  it('serves livez outside the API prefix', async () => {
    const r = await inject({ method: 'GET', url: '/livez' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-request-id']).toBeTruthy();
  });

  it('protected routes answer 401 in the standard error format', async () => {
    const r = await inject({ method: 'GET', url: '/api/v1/users' });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('validates bodies before handlers run', async () => {
    const r = await inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: 'ab' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses unsafe requests from foreign origins', async () => {
    const r = await inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'https://evil.example' },
      payload: { login: 'a@b.in', password: 'x' },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('CSRF_FAILED');
  });

  it('rejects forged access cookies', async () => {
    const r = await inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: 'isp_at=eyJhbGciOiJub25lIn0.e30.' },
    });
    expect(r.statusCode).toBe(401);
  });

  it('unknown routes are 404 JSON; non-JSON bodies are refused', async () => {
    expect((await inject({ method: 'GET', url: '/api/v1/nope' })).json().error.code).toBe('NOT_FOUND');
    const r = await inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'text/plain' },
      payload: 'login=x',
    });
    expect(r.statusCode).toBe(415);
  });

  it('publishes OpenAPI in non-production', async () => {
    const r = await inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(r.statusCode).toBe(200);
    expect(r.json().openapi).toBe('3.1.0');
  });
});
