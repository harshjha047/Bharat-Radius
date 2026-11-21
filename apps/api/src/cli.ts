import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { ObjectId } from 'mongodb';
import {
  connectMongo,
  migrate,
  pendingMigrations,
  postpaidInvoices,
  postpaidOverdue,
  reconcileWallets,
  type AuditLogDoc,
  type RefreshTokenDoc,
  type RoleDoc,
  type TenantDoc,
  type UserDoc,
} from '@isp/db-mongo';
import { FieldCrypto } from '@isp/shared';
import { PLATFORM_SLUG } from './auth/auth.service.js';
import { hashPassword, passwordSchema } from './auth/passwords.js';
import { formatKycReport, importKycFiles } from './documents/import.js';
import { formatReport, importLegacy, snapshotSchema } from './migration/legacy.js';
import { filesFromEnv } from './storage/storage.js';
import { benchSearch, removeScale, seedScale } from './scale-seed.js';
import { email as emailSchema, phone as phoneSchema } from './http/schemas.js';

const USAGE = `usage: node dist/cli.js <command> [options]   (MONGO_URL from the environment)

  migrate                         apply pending MongoDB migrations and sync built-in roles
  status                          list pending migrations
  create-tenant  --slug <s> --name <n> --legal-name <n> --state-code <NN> --city <c> --state <s>
                 --pincode <p> --line1 <addr> [--domain <host>]
  create-user    --tenant <slug|platform> --name <n> (--email <e> | --phone <p>) [--role "ISP Admin"]
                 password: prompted, or piped on stdin
  seed-scale     --tenant <slug> [--count 100000] [--plan "Home 50"]   add scale-test subscribers (synced to Radius)
  seed-scale     --tenant <slug> --bench        time the panel's subscriber search
  seed-scale     --tenant <slug> --remove       delete scale-test subscribers (and their Radius rows)
  reset-password --tenant <slug|platform> (--email <e> | --phone <p>) [--reset-2fa]
                 new password prompted (or stdin); unlocks the account and signs it out everywhere
  run-job        <postpaid-invoice|postpaid-overdue|reconcile-wallets> [--at <ISO date>]
                 run a billing job now (all ISPs); --at pretends it is that time (staging tests)
  import-legacy  --tenant <slug> [--sites 2,5] [--apply]
                 old Bharat Radius snapshot (legacy-export.sql) on stdin; dry run unless --apply;
                 re-runnable (second run = delta: password, plan, validity, status, owner)
  import-kyc     --tenant <slug> --dir <path> [--apply]
                 old CAF / ID files (JPEG, PNG, WebP, PDF) matched by username, customer no., phone or old id
                 in the folder or file name; stored encrypted; dry run unless --apply; re-runnable`;

async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    let s = '';
    for await (const chunk of process.stdin) s += chunk;
    return s.replace(/\r?\n$/, '');
  }
  // Prompt on stderr directly; readline echoes into a sink so the password never shows.
  process.stderr.write('password: ');
  const sink = new Writable({ write: (_c, _e, cb) => cb() });
  const rl = createInterface({ input: process.stdin, output: sink, terminal: true });
  return new Promise((resolve) => {
    rl.question('', (pw) => {
      rl.close();
      process.stderr.write('\n');
      resolve(pw);
    });
  });
}

function need(v: Record<string, string | undefined>, ...keys: string[]): void {
  const missing = keys.filter((k) => !v[k]);
  if (missing.length) throw new Error(`missing --${missing.join(', --')}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = new Set(rest.filter((a) => ['--reset-2fa', '--remove', '--bench', '--apply'].includes(a)));
  const resetMfa = flags.has('--reset-2fa');
  const { values: v, positionals } = parseArgs({
    args: rest.filter((a) => !flags.has(a)),
    options: Object.fromEntries(
      [
        'slug',
        'name',
        'legal-name',
        'state-code',
        'city',
        'state',
        'pincode',
        'line1',
        'domain',
        'tenant',
        'email',
        'phone',
        'role',
        'count',
        'plan',
        'at',
        'sites',
        'dir',
      ].map((k) => [k, { type: 'string' as const }]),
    ),
    allowPositionals: true,
  }) as { values: Record<string, string | undefined>; positionals: string[] };
  if (!cmd || !process.env.MONGO_URL) throw new Error(USAGE);

  const { client, db } = await connectMongo(process.env.MONGO_URL, 2);
  try {
    if (cmd === 'migrate') {
      const applied = await migrate(db, (m) => console.log(m));
      console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
      return;
    }
    if (cmd === 'status') {
      const p = await pendingMigrations(db);
      console.log(p.length ? `pending: ${p.join(', ')}` : 'up to date');
      return;
    }
    const pending = await pendingMigrations(db);
    if (pending.length) throw new Error('run "migrate" first');
    const now = new Date();

    if (cmd === 'create-tenant') {
      need(v, 'slug', 'name', 'legal-name', 'state-code', 'city', 'state', 'pincode', 'line1');
      if (v.slug === PLATFORM_SLUG) throw new Error(`"${PLATFORM_SLUG}" is reserved`);
      const doc: TenantDoc = {
        _id: new ObjectId(),
        slug: v.slug!.toLowerCase(),
        name: v.name!,
        legalName: v['legal-name']!,
        status: 'active',
        stateCode: v['state-code']!,
        address: { line1: v.line1!, city: v.city!, state: v.state!, pincode: v.pincode! },
        ...(v.domain ? { branding: { domain: v.domain.toLowerCase() } } : {}),
        radius: {
          expiredRate: '256k/256k',
          expiredAddressList: 'expired',
          expiredSessionSecs: 3600,
          interimInterval: 300,
        },
        version: 0,
        createdAt: now,
        updatedAt: now,
        createdBy: 'cli',
        updatedBy: 'cli',
      };
      await db.collection<TenantDoc>('tenants').insertOne(doc);
      console.log(`tenant ${doc.slug} = ${doc._id.toHexString()}`);
      return;
    }

    if (cmd === 'create-user') {
      need(v, 'tenant', 'name');
      if (!v.email && !v.phone) throw new Error('give --email or --phone');
      const platform = v.tenant === PLATFORM_SLUG;
      const tenant = platform
        ? null
        : await db.collection<TenantDoc>('tenants').findOne({ slug: v.tenant!.toLowerCase() });
      if (!platform && !tenant) throw new Error(`tenant ${v.tenant} not found`);
      const roleIds: ObjectId[] = [];
      if (!platform) {
        const roleName = v.role ?? 'ISP Admin';
        const role = await db
          .collection<RoleDoc>('roles')
          .findOne({ name: roleName, tenantId: { $in: [tenant!._id, null] }, scope: 'tenant' });
        if (!role) throw new Error(`role "${roleName}" not found`);
        roleIds.push(role._id);
      }
      const pw = passwordSchema.safeParse(await readPassword());
      if (!pw.success) throw new Error(`password ${pw.error.issues[0]!.message}`);
      const doc: UserDoc = {
        _id: new ObjectId(),
        tenantId: tenant?._id ?? null,
        type: platform ? 'superadmin' : 'staff',
        name: v.name!,
        ...(v.email ? { email: emailSchema.parse(v.email) } : {}),
        ...(v.phone ? { phone: phoneSchema.parse(v.phone) } : {}),
        passwordHash: await hashPassword(pw.data),
        roleIds,
        status: 'active',
        failedLogins: 0,
        tokenVersion: 0,
        createdAt: now,
        updatedAt: now,
        createdBy: 'cli',
        updatedBy: 'cli',
      };
      await db.collection<UserDoc>('users').insertOne(doc);
      console.log(`user ${doc._id.toHexString()} (${doc.type}); two-factor setup is asked at first sign-in`);
      return;
    }
    if (cmd === 'seed-scale') {
      need(v, 'tenant');
      const out = (m: string) => console.log(m);
      if (flags.has('--remove')) return await removeScale(db, v.tenant!, out);
      if (flags.has('--bench')) return await benchSearch(db, v.tenant!, out);
      const count = Number(v.count ?? 100_000);
      if (!Number.isInteger(count) || count < 1 || count > 500_000)
        throw new Error('--count must be 1..500000');
      await seedScale(db, v.tenant!, count, v.plan ?? 'Home 50', out);
      return;
    }

    if (cmd === 'run-job') {
      const [job] = positionals;
      const at = v.at ? new Date(v.at) : new Date();
      if (Number.isNaN(at.getTime()))
        throw new Error('--at must be an ISO date, e.g. 2026-12-01T10:00:00+05:30');
      const run: Record<string, () => Promise<unknown>> = {
        'postpaid-invoice': () => postpaidInvoices(client, db, at),
        'postpaid-overdue': () => postpaidOverdue(client, db, at),
        'reconcile-wallets': () => reconcileWallets(db),
      };
      if (!job || !run[job]) throw new Error(`run-job needs one of: ${Object.keys(run).join(', ')}`);
      console.log(JSON.stringify(await run[job]()));
      return;
    }

    if (cmd === 'import-kyc') {
      need(v, 'tenant', 'dir');
      const key = process.env.FIELD_ENCRYPTION_KEY;
      if (!key) throw new Error('FIELD_ENCRYPTION_KEY is required (run inside the api container)');
      const report = await importKycFiles(db, filesFromEnv(process.env, new FieldCrypto(key)), {
        tenant: v.tenant!,
        dir: v.dir!,
        apply: flags.has('--apply'),
        log: (m) => console.log(m),
      });
      console.log(formatKycReport(report));
      if (report.rejected.length) process.exitCode = 2;
      return;
    }

    if (cmd === 'import-legacy') {
      need(v, 'tenant');
      if (process.stdin.isTTY)
        throw new Error('pipe the snapshot in: psql ... -f legacy-export.sql | ... import-legacy');
      let raw = '';
      for await (const chunk of process.stdin) raw += chunk;
      const parsed = snapshotSchema.safeParse(JSON.parse(raw));
      raw = '';
      if (!parsed.success)
        throw new Error(
          `snapshot not recognised: ${parsed.error.issues[0]!.path.join('.')} ${parsed.error.issues[0]!.message}`,
        );
      const sites = (v.sites ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .map(Number);
      if (sites.some((n) => !Number.isInteger(n)))
        throw new Error('--sites takes old site numbers, e.g. 2,5');
      const report = await importLegacy(client, db, parsed.data, {
        tenant: v.tenant!,
        apply: flags.has('--apply'),
        sites,
        log: (m) => console.log(m),
      });
      const inScope = parsed.data.subscribers.filter(
        (x) => !sites.length || parsed.data.sites.some((st) => st.id === x.siteId && sites.includes(st.msr)),
      ).length;
      console.log(formatReport(report, { subscribers: inScope }));
      if (!report.dryRun && report.mismatches.length) process.exitCode = 2;
      return;
    }

    if (cmd === 'reset-password') {
      need(v, 'tenant');
      if (!v.email && !v.phone) throw new Error('give --email or --phone');
      const platform = v.tenant === PLATFORM_SLUG;
      const tenant = platform
        ? null
        : await db.collection<TenantDoc>('tenants').findOne({ slug: v.tenant!.toLowerCase() });
      if (!platform && !tenant) throw new Error(`tenant ${v.tenant} not found`);
      const users = db.collection<UserDoc>('users');
      const user = await users.findOne({
        tenantId: tenant?._id ?? null,
        ...(v.email ? { email: emailSchema.parse(v.email) } : { phone: phoneSchema.parse(v.phone) }),
      });
      if (!user) throw new Error(`no account with that ${v.email ? 'email' : 'phone'} in ${v.tenant}`);
      const pw = passwordSchema.safeParse(await readPassword());
      if (!pw.success) throw new Error(`password ${pw.error.issues[0]!.message}`);
      await users.updateOne(
        { _id: user._id },
        {
          $set: {
            passwordHash: await hashPassword(pw.data),
            failedLogins: 0,
            updatedAt: now,
            updatedBy: 'cli',
          },
          $inc: { tokenVersion: 1 },
          $unset: { lockedUntil: '', ...(resetMfa ? { totp: '' } : {}) },
        },
      );
      await db
        .collection<RefreshTokenDoc>('refresh_tokens')
        .updateMany(
          { userId: user._id, revokedAt: { $exists: false } },
          { $set: { revokedAt: now, revokedReason: 'admin' } },
        );
      const actor = { id: 'cli', type: 'system', name: 'server command line' };
      const entity = { type: 'user', id: user._id.toHexString() };
      await db.collection<AuditLogDoc>('audit_logs').insertMany([
        {
          _id: new ObjectId(),
          tenantId: user.tenantId,
          actor,
          action: 'user.password_reset',
          entity,
          after: { password: '[redacted]' },
          createdAt: now,
        },
        ...(resetMfa
          ? [
              {
                _id: new ObjectId(),
                tenantId: user.tenantId,
                actor,
                action: 'user.2fa_reset',
                entity,
                createdAt: now,
              },
            ]
          : []),
      ]);
      console.log(
        `password set for ${user.name}; signed out everywhere${resetMfa ? '; two-factor removed (set up again at sign-in)' : ''}`,
      );
      return;
    }
    throw new Error(USAGE);
  } finally {
    await client.close();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
