import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, startHarness, type Harness } from './harness.js';

let h: Harness;
const dir = mkdtempSync(join(tmpdir(), 'guard-'));

beforeAll(async () => {
  process.env.GUARD_DIR = dir;
  process.env.GUARD_TTL_MS = '0';
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.GUARD_DIR;
  delete process.env.GUARD_TTL_MS;
});

describe('disk guard maintenance', () => {
  it('pauses staff and portal calls; webhooks, the pay page and health checks stay open', async () => {
    const c = new Client(h);
    const login = () => c.req('POST', '/api/v1/auth/login', { login: 'nobody@x.in', password: 'x' });
    expect((await login()).status).not.toBe(503);

    writeFileSync(join(dir, 'maintenance'), '');
    const paused = await login();
    expect(paused.status).toBe(503);
    expect(paused.body.error.code).toBe('MAINTENANCE');
    expect(paused.headers['retry-after']).toBe('300');
    expect((await c.req('GET', '/api/v1/portal/me')).status).toBe(503);

    expect((await c.req('GET', '/healthz')).status).toBe(200);
    expect((await c.req('GET', '/api/v1/pay/context?t=not-a-valid-token')).status).not.toBe(503);
    const hook = await c.req('POST', '/api/v1/webhooks/razorpay/000000000000000000000000', { event: 'ping' });
    expect(hook.status).not.toBe(503);

    rmSync(join(dir, 'maintenance'));
    expect((await login()).status).not.toBe(503);
  });
});
