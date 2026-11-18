import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Flags written by the host's disk guard (deploy/ubuntu/disk/disk-guard.sh), mounted read-only. */
const cache = new Map<string, { at: number; on: boolean }>();

export function guardFlag(name: 'maintenance' | 'pause-heavy'): boolean {
  const hit = cache.get(name);
  const now = Date.now();
  if (hit && now - hit.at < Number(process.env.GUARD_TTL_MS ?? 5_000)) return hit.on;
  const on = existsSync(join(process.env.GUARD_DIR ?? '/run/isp-guard', name));
  cache.set(name, { at: now, on });
  return on;
}
