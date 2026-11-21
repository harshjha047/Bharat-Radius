import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { searchTokens } from '@isp/db-mongo';
import { benchSearch, removeScale, SCALE_TAG, seedScale } from '../src/scale-seed.js';
import { seedPlan, seedTenant, startHarness, type Harness } from './harness.js';

let h: Harness;
let tenantId: Awaited<ReturnType<typeof seedTenant>>;
const lines: string[] = [];
const log = (s: string) => void lines.push(s);

beforeAll(async () => {
  h = await startHarness();
  process.env.FIELD_ENCRYPTION_KEY = h.config.FIELD_ENCRYPTION_KEY;
  tenantId = await seedTenant(h.db, 'scale');
  await seedPlan(h, tenantId, 'Home 50');
});
afterAll(() => h?.close());

describe('scale-test seeder', () => {
  it('creates subscribers exactly like real ones, each queued for RADIUS', async () => {
    await seedScale(h.db, 'scale', 3000, 'Home 50', log);
    const subs = h.db.collection('subscribers');
    expect(await subs.countDocuments({ tenantId, tags: SCALE_TAG })).toBe(3000);
    const s = (await subs.findOne({ tenantId, username: 'scale.000042' }))!;
    expect(s.search).toEqual(
      searchTokens({ name: s.name, username: s.username, phone: s.phone, customerNo: s.customerNo }),
    );
    expect(s.status).toBe('active');
    expect(s.syncStatus).toBe('pending');
    expect(h.crypto.decrypt(s.pppoePassword, `subscribers.pppoe:${s._id.toHexString()}`)).toMatch(
      /^[\w-]{8}$/,
    );
    expect(await h.db.collection('outbox').countDocuments({ tenantId, entity: 'subscriber' })).toBe(3000);
    const nos = new Set(
      (await subs.find({ tenantId }, { projection: { customerNo: 1 } }).toArray()).map((d) => d.customerNo),
    );
    expect(nos.size).toBe(3000);
  });

  it('refuses to seed twice', async () => {
    await expect(seedScale(h.db, 'scale', 10, 'Home 50', log)).rejects.toThrow(/already exist/);
  });

  it('benchmarks the panel search', async () => {
    lines.length = 0;
    await benchSearch(h.db, 'scale', log);
    expect(lines.at(-1)).toMatch(/^PASS/);
    expect(lines.find((l) => l.startsWith('exact username'))).toMatch(/ 1 rows/);
  });

  it('removes them and queues RADIUS deletion', async () => {
    await removeScale(h.db, 'scale', log);
    expect(await h.db.collection('subscribers').countDocuments({ tenantId, tags: SCALE_TAG })).toBe(0);
    expect(await h.db.collection('outbox').countDocuments({ tenantId, entity: 'subscriber' })).toBe(6000);
  });

  it('needs the field key', async () => {
    const k = process.env.FIELD_ENCRYPTION_KEY;
    delete process.env.FIELD_ENCRYPTION_KEY;
    await expect(seedScale(h.db, 'scale', 1, 'Home 50', log)).rejects.toThrow(/FIELD_ENCRYPTION_KEY/);
    process.env.FIELD_ENCRYPTION_KEY = k ?? randomBytes(32).toString('base64');
  });
});
