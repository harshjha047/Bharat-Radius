import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Client,
  PASSWORD,
  roleId,
  seedTenant,
  seedUser,
  startHarness,
  type Harness,
  type SeededUser,
} from './harness.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const NEW_PASSWORD = 'Brand-New-Fibre-77';

let h: Harness;
let admin: SeededUser;

beforeAll(async () => {
  h = await startHarness();
  const t = await seedTenant(h.db, 'clitest', 'new.example.test');
  admin = await seedUser(h, {
    tenantId: t,
    email: 'a@cli.in',
    roles: [await roleId(h.db, 'ISP Admin')],
    totp: true,
  });
});
afterAll(() => h?.close());

const login = (password: string) =>
  new Client(h).req('POST', '/api/v1/auth/login', { login: 'a@cli.in', password });

describe('cli reset-password', () => {
  it('sets a new password, removes 2FA on request, unlocks, and records it', async () => {
    await h.db
      .collection('users')
      .updateOne({ _id: admin._id }, { $set: { lockedUntil: new Date(Date.now() + 9e5) } });
    const out = execFileSync(
      process.execPath,
      [CLI, 'reset-password', '--tenant', 'clitest', '--email', 'A@cli.in', '--reset-2fa'],
      {
        input: `${NEW_PASSWORD}\n`,
        env: { ...process.env, MONGO_URL: h.config.MONGO_URL },
        encoding: 'utf8',
      },
    );
    expect(out).toContain('two-factor removed');

    expect((await login(PASSWORD)).status).toBe(401);
    const ok = await login(NEW_PASSWORD);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('mfa_enroll_required');

    const audit = await h.db
      .collection('audit_logs')
      .find({ 'entity.id': admin._id.toHexString() })
      .toArray();
    expect(audit.map((a) => a.action).sort()).toEqual(['user.2fa_reset', 'user.password_reset']);
    expect(JSON.stringify(audit)).not.toContain(NEW_PASSWORD);
  });

  it('refuses unknown accounts and short passwords', () => {
    const run = (args: string[], input: string) =>
      execFileSync(process.execPath, [CLI, 'reset-password', ...args], {
        input,
        env: { ...process.env, MONGO_URL: h.config.MONGO_URL },
        encoding: 'utf8',
        stdio: 'pipe',
      });
    expect(() => run(['--tenant', 'clitest', '--email', 'nobody@cli.in'], `${NEW_PASSWORD}\n`)).toThrow(
      /no account/,
    );
    expect(() => run(['--tenant', 'clitest', '--email', 'a@cli.in'], 'short\n')).toThrow(/password/);
  });
});
