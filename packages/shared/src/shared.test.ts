import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FieldCrypto } from './field-crypto.js';
import { base32Decode, base32Encode, hotp, totpStep, verifyTotp } from './totp.js';
import { BUILT_IN_ROLES, PERMISSIONS, RESELLER_PERMISSIONS } from './permissions.js';

const key = () => randomBytes(32).toString('base64');

describe('FieldCrypto', () => {
  it('round-trips and binds to aad', () => {
    const fc = new FieldCrypto(key());
    const e = fc.encrypt('s3cret', 'nas:1');
    expect(e.keyId).toBe('k1');
    expect(fc.decrypt(e, 'nas:1')).toBe('s3cret');
    expect(() => fc.decrypt(e, 'nas:2')).toThrow();
    expect(() => fc.decrypt({ ...e, data: Buffer.from('x').toString('base64') }, 'nas:1')).toThrow();
  });

  it('rotates: new key encrypts, old key still decrypts', () => {
    const oldK = key();
    const old = new FieldCrypto(`a:${oldK}`);
    const e = old.encrypt('v', 'x');
    const rotated = new FieldCrypto(`b:${key()},a:${oldK}`);
    expect(rotated.decrypt(e, 'x')).toBe('v');
    expect(rotated.needsRotation(e)).toBe(true);
    expect(rotated.encrypt('v', 'x').keyId).toBe('b');
  });

  it('rejects short keys', () => {
    expect(() => new FieldCrypto(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('TOTP', () => {
  it('matches RFC 6238 SHA-1 vectors (6-digit truncation)', () => {
    const secret = Buffer.from('12345678901234567890');
    expect(hotp(secret, totpStep(59_000))).toBe('287082');
    expect(hotp(secret, totpStep(1_111_111_109_000))).toBe('081804');
    expect(hotp(secret, totpStep(20_000_000_000_000))).toBe('353130');
  });

  it('base32 round-trips', () => {
    const b = randomBytes(20);
    expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
  });

  it('accepts ±1 step and refuses replays', () => {
    const s = base32Encode(Buffer.from('12345678901234567890'));
    const t = 1_111_111_109_000;
    const step = totpStep(t);
    expect(verifyTotp(s, '081804', t)).toBe(step);
    expect(verifyTotp(s, '081804', t + 30_000)).toBe(step);
    expect(verifyTotp(s, '081804', t + 61_000)).toBeNull();
    expect(verifyTotp(s, '081804', t, step)).toBeNull();
    expect(verifyTotp(s, '08180', t)).toBeNull();
  });
});

describe('roles', () => {
  it('built-in roles use only known permissions; reseller roles stay within the reseller set', () => {
    for (const r of BUILT_IN_ROLES) {
      for (const p of r.permissions) expect(PERMISSIONS).toContain(p);
      if (r.scope === 'reseller') for (const p of r.permissions) expect(RESELLER_PERMISSIONS).toContain(p);
    }
  });
});
