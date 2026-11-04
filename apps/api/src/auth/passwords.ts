import { hash, verify, type Options } from '@node-rs/argon2';
import { z } from 'zod';

/** Algorithm.Argon2id; the package ships it as an ambient const enum, which isolatedModules cannot import. */
const ARGON2ID = 2 as NonNullable<Options['algorithm']>;

/** OWASP 2024 argon2id baseline: 19 MiB, 2 passes, 1 lane (~40 ms on the VPS, off the event loop). */
const OPTS: Options = { algorithm: ARGON2ID, memoryCost: 19_456, timeCost: 2, parallelism: 1 };
const PARAMS = `m=${OPTS.memoryCost},t=${OPTS.timeCost},p=${OPTS.parallelism}`;

export const passwordSchema = z
  .string()
  .min(10, 'must be at least 10 characters')
  .max(128, 'must be at most 128 characters')
  .refine((p) => new Set(p).size >= 5, 'is too repetitive');

export const hashPassword = (pw: string): Promise<string> => hash(pw, OPTS);

let dummy: Promise<string> | undefined;

/** Constant work whether or not the account exists, so response time does not reveal valid logins. */
export async function verifyPassword(stored: string | undefined, pw: string): Promise<boolean> {
  if (!stored) {
    dummy ??= hash('dummy-password-for-timing', OPTS);
    await verify(await dummy, pw).catch(() => false);
    return false;
  }
  return verify(stored, pw).catch(() => false);
}

export const needsRehash = (stored: string): boolean => !stored.includes(`$${PARAMS}$`);
