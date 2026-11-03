#!/usr/bin/env node
import pg from 'pg';
import { RadiusCoaClient } from './client.js';
import { findOpenSessions } from './sessions.js';

const USAGE = `usage:
  coa kick <username> [--tenant <slug>]
  coa rate <username> <rate-limit> [--address-list <name>|--clear-address-list] [--tenant <slug>]
env: RADIUS_DB_URL (app_radius), COA_SOURCE_IP (optional)`;

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const tenant = arg(args, '--tenant');
  const addressList = arg(args, '--address-list');
  const clearList = args.includes('--clear-address-list');
  const positional = args.filter((a) => !a.startsWith('--'));
  const [cmd, user, rate] = positional;
  if (!cmd || !user || (cmd === 'rate' && !rate) || !['kick', 'rate'].includes(cmd)) {
    console.error(USAGE);
    return 2;
  }
  const url = process.env.RADIUS_DB_URL;
  if (!url) {
    console.error('RADIUS_DB_URL is not set');
    return 2;
  }

  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const opts: ConstructorParameters<typeof RadiusCoaClient>[0] = {};
  if (process.env.COA_SOURCE_IP) opts.sourceIp = process.env.COA_SOURCE_IP;
  const client = new RadiusCoaClient(opts);
  try {
    const sessions = await findOpenSessions(pool, user, tenant);
    if (sessions.length === 0) {
      console.log(`${user}: offline (no open session)`);
      return 3;
    }
    let failed = 0;
    for (const s of sessions) {
      const change: { rateLimit: string; addressList?: string | null } = { rateLimit: rate ?? '' };
      if (addressList !== undefined) change.addressList = addressList;
      else if (clearList) change.addressList = null;
      const r =
        cmd === 'kick'
          ? await client.disconnect(s.target, s.session)
          : await client.changeRate(s.target, s.session, change);
      if (r.result !== 'ack') failed++;
      console.log(
        `${s.tenantSlug}/${user} session ${s.session.acctSessionId} via ${s.target.host}: ${r.result}` +
          (r.errorCause ? ` (${r.errorCause} ${r.errorText})` : '') +
          ` ${r.latencyMs} ms, ${r.attempts} attempt(s)`,
      );
    }
    return failed ? 1 : 0;
  } finally {
    await client.close();
    await pool.end();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
