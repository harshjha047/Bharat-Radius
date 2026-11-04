import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error('invalid base32');
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const TOTP_PERIOD = 30;
const DIGITS = 6;

export const newTotpSecret = (): string => base32Encode(randomBytes(20));

export const totpStep = (atMs: number): number => Math.floor(atMs / 1000 / TOTP_PERIOD);

/** RFC 6238 / 4226: HMAC-SHA1, 6 digits, 30 s — what every authenticator app defaults to. */
export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const o = h[h.length - 1]! & 0xf;
  const n = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * Returns the matched time step, or null. Accepts ±1 step for clock drift; steps at or below `lastUsedStep`
 * are refused so a code cannot be replayed (caller persists the returned step atomically).
 */
export function verifyTotp(secretB32: string, code: string, nowMs: number, lastUsedStep = -1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secretB32);
  const now = totpStep(nowMs);
  const want = Buffer.from(code);
  let matched: number | null = null;
  for (const step of [now - 1, now, now + 1]) {
    const ok = timingSafeEqual(Buffer.from(hotp(key, step)), want);
    if (ok && step > lastUsedStep && matched === null) matched = step;
  }
  return matched;
}

export function otpauthUrl(secretB32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({ secret: secretB32, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${q.toString()}`;
}
