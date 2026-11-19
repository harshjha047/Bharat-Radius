import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, newNonce } from './csp';

describe('CSP', () => {
  it('scripts only by nonce in production, never unsafe-inline or unsafe-eval', () => {
    const n = newNonce();
    const csp = contentSecurityPolicy(n, false);
    const script = csp.split('; ').find((d) => d.startsWith('script-src'))!;
    expect(script).toBe(`script-src 'self' 'nonce-${n}' 'strict-dynamic'`);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(contentSecurityPolicy(n, true)).toContain("'unsafe-eval'");
  });
  it('nonces are random base64', () => {
    const a = newNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(newNonce()).not.toBe(a);
  });
});
