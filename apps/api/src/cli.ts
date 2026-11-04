import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { ObjectId } from 'mongodb';
import {
  connectMongo,
  migrate,
  pendingMigrations,
  type RoleDoc,
  type TenantDoc,
  type UserDoc,
} from '@isp/db-mongo';
import { PLATFORM_SLUG } from './auth/auth.service.js';
import { hashPassword, passwordSchema } from './auth/passwords.js';
import { email as emailSchema, phone as phoneSchema } from './http/schemas.js';

const USAGE = `usage: node dist/cli.js <command> [options]   (MONGO_URL from the environment)

  migrate                         apply pending MongoDB migrations and sync built-in roles
  status                          list pending migrations
  create-tenant  --slug <s> --name <n> --legal-name <n> --state-code <NN> --city <c> --state <s>
                 --pincode <p> --line1 <addr> [--domain <host>]
  create-user    --tenant <slug|platform> --name <n> (--email <e> | --phone <p>) [--role "ISP Admin"]
                 password: prompted, or piped on stdin`;

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
  const { values: v } = parseArgs({
    args: rest,
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
      ].map((k) => [k, { type: 'string' as const }]),
    ),
  }) as { values: Record<string, string | undefined> };
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
    throw new Error(USAGE);
  } finally {
    await client.close();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
