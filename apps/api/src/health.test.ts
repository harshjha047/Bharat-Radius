import { describe, expect, it } from 'vitest';
import { createHealth } from './health.js';

describe('health', () => {
  it('reports ok when all checks pass', async () => {
    const h = createHealth({ a: async () => ({ x: 1 }) }, 't');
    const r = await h();
    expect(r.status).toBe('ok');
    expect(r.checks.a).toMatchObject({ ok: true, detail: { x: 1 } });
  });

  it('degrades on failure or timeout', async () => {
    const h = createHealth(
      {
        bad: async () => {
          throw new Error('down');
        },
        slow: () => new Promise((r) => setTimeout(() => r({}), 200)),
      },
      't',
      0,
      50,
    );
    const r = await h();
    expect(r.status).toBe('degraded');
    expect(r.checks.bad?.error).toBe('down');
    expect(r.checks.slow?.error).toMatch(/timeout/);
  });

  it('caches results within the TTL', async () => {
    let calls = 0;
    const h = createHealth({ a: async () => ({ n: ++calls }) }, 't', 10_000);
    await h();
    await h();
    expect(calls).toBe(1);
  });
});
