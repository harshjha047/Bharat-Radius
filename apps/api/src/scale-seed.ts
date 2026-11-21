/**
 * Scale test (Step 2 gate: 100,000 subscribers, search under 1 s). Test subscribers are tagged "scale-test", built
 * exactly like real ones (shared buildSubscriberDoc) and synced to Radius through the normal outbox; --remove deletes
 * them from MongoDB and lets the worker delete their Radius rows.
 */
import { randomBytes } from 'node:crypto';
import { ObjectId, type Db, type Filter } from 'mongodb';
import { FieldCrypto } from '@isp/shared';
import {
  buildSubscriberDoc,
  formatCustomerNo,
  reserveCustomerNos,
  subscriberOutboxRow,
  type OutboxDoc,
  type PlanDoc,
  type SubscriberDoc,
  type TenantDoc,
} from '@isp/db-mongo';

export const SCALE_TAG = 'scale-test';
const BATCH = 2000;

const FIRST = [
  'Ramesh',
  'Sunita',
  'Arif',
  'Priya',
  'Vikram',
  'Anjali',
  'Deepak',
  'Kavita',
  'Rahul',
  'Pooja',
  'Imran',
  'Neha',
  'Suresh',
  'Meena',
  'Amit',
  'Fatima',
  'Sanjay',
  'Rekha',
  'Manoj',
  'Shabnam',
  'Ajay',
  'Geeta',
  'Vijay',
  'Nisha',
  'Rajesh',
  'Sarita',
  'Mukesh',
  'Anita',
  'Dinesh',
  'Seema',
  'Harish',
  'Asha',
  'Naveen',
  'Ritu',
  'Pankaj',
  'Lata',
];
const LAST = [
  'Kumar',
  'Devi',
  'Khan',
  'Sharma',
  'Singh',
  'Verma',
  'Yadav',
  'Gupta',
  'Mishra',
  'Ansari',
  'Chauhan',
  'Pandey',
  'Tiwari',
  'Saxena',
  'Agarwal',
  'Jain',
  'Rawat',
  'Thakur',
  'Qureshi',
  'Malik',
  'Srivastava',
  'Dubey',
];
const CITIES = ['Noida', 'Ghaziabad', 'Meerut', 'Greater Noida', 'Hapur', 'Bulandshahr'];

async function tenantBySlug(db: Db, slug: string) {
  const t = await db.collection<TenantDoc>('tenants').findOne({ slug: slug.toLowerCase() });
  if (!t) throw new Error(`tenant ${slug} not found`);
  return t;
}

export async function seedScale(
  db: Db,
  slug: string,
  count: number,
  planName: string,
  log: (s: string) => void,
) {
  const key = process.env.FIELD_ENCRYPTION_KEY;
  if (!key) throw new Error('FIELD_ENCRYPTION_KEY is required (run inside the api container)');
  const crypto = new FieldCrypto(key);
  const tenant = await tenantBySlug(db, slug);
  const plan = await db
    .collection<PlanDoc>('plans')
    .findOne({ tenantId: tenant._id, name: planName, status: 'active' });
  if (!plan) throw new Error(`no active plan named "${planName}" in ${slug}`);
  const subs = db.collection<SubscriberDoc>('subscribers');
  if (await subs.findOne({ tenantId: tenant._id, tags: SCALE_TAG }, { projection: { _id: 1 } }))
    throw new Error('scale-test subscribers already exist; run with --remove first');

  const firstSeq = await reserveCustomerNos(db, tenant._id, count);
  const ctx = { tenantId: tenant._id, actor: 'cli:seed-scale' };
  const expiresAt = new Date(Date.now() + 60 * 86_400_000);
  const t0 = Date.now();
  for (let from = 0; from < count; from += BATCH) {
    const now = new Date();
    const docs: SubscriberDoc[] = [];
    for (let i = from; i < Math.min(from + BATCH, count); i++) {
      const n = i + 1;
      docs.push(
        buildSubscriberDoc(
          crypto,
          ctx,
          {
            username: `scale.${String(n).padStart(6, '0')}`,
            pppoePassword: randomBytes(6).toString('base64url'),
            name: `${FIRST[n % FIRST.length]} ${LAST[(n * 7) % LAST.length]}`,
            phone: `+91${8_000_000_000 + n}`,
            address: {
              line1: `${n % 400} Sector ${(n % 90) + 1}`,
              city: CITIES[n % CITIES.length]!,
              state: 'Uttar Pradesh',
              stateCode: '09',
              pincode: String(201_000 + (n % 300)),
            },
            billingType: 'prepaid',
            planId: plan._id,
            expiresAt,
            network: {},
            tags: [SCALE_TAG],
          },
          formatCustomerNo(firstSeq + i),
          new ObjectId(),
          now,
        ),
      );
    }
    await subs.insertMany(docs, { ordered: false });
    await db.collection<OutboxDoc>('outbox').insertMany(
      docs.map((d) => subscriberOutboxRow(tenant._id, d._id, now)),
      { ordered: false },
    );
    const done = Math.min(from + BATCH, count);
    if (done % 10_000 === 0 || done === count)
      log(`${done.toLocaleString('en-IN')} created (${Math.round((done / (Date.now() - t0)) * 1000)}/s)`);
  }
  log(
    `done in ${Math.round((Date.now() - t0) / 1000)} s; the worker now syncs them to Radius (watch isp_outbox_pending)`,
  );
}

export async function removeScale(db: Db, slug: string, log: (s: string) => void) {
  const tenant = await tenantBySlug(db, slug);
  const subs = db.collection<SubscriberDoc>('subscribers');
  let total = 0;
  for (;;) {
    const ids = (
      await subs
        .find({ tenantId: tenant._id, tags: SCALE_TAG }, { projection: { _id: 1 }, limit: 5000 })
        .toArray()
    ).map((d) => d._id);
    if (!ids.length) break;
    await subs.deleteMany({ _id: { $in: ids } });
    // A missing subscriber makes the worker delete its Radius row.
    const now = new Date();
    await db.collection<OutboxDoc>('outbox').insertMany(
      ids.map((id) => subscriberOutboxRow(tenant._id, id, now)),
      { ordered: false },
    );
    total += ids.length;
    log(`${total.toLocaleString('en-IN')} removed`);
  }
  log(total ? 'done; the worker removes their Radius rows' : 'no scale-test subscribers found');
}

/** Times the panel's own subscriber search (same filter, sort and page size) for typical and worst-case input. */
export async function benchSearch(db: Db, slug: string, log: (s: string) => void) {
  const tenant = await tenantBySlug(db, slug);
  const subs = db.collection<SubscriberDoc>('subscribers');
  const total = await subs.countDocuments({ tenantId: tenant._id, status: { $ne: 'deleted' } });
  log(`${total.toLocaleString('en-IN')} subscribers in ${slug}`);
  // Real values from the middle of the seeded set (fall back to any subscriber).
  const sample =
    (await subs.findOne(
      { tenantId: tenant._id, tags: SCALE_TAG },
      { skip: Math.floor((await subs.countDocuments({ tenantId: tenant._id, tags: SCALE_TAG })) / 2) },
    )) ?? (await subs.findOne({ tenantId: tenant._id }));
  if (!sample) throw new Error('no subscribers to search');
  const cases: [string, string | null][] = [
    ['first page, no search', null],
    ['exact username', sample.username!.toLowerCase()],
    ['customer number', sample.customerNo.toLowerCase()],
    ['full phone number', sample.phone.replace(/^\+91/, '')],
    ['name word', sample.name.split(' ')[0]!.toLowerCase()],
    ['2-letter prefix', sample.name.slice(0, 2).toLowerCase()],
    ['phone prefix (4 digits)', sample.phone.replace(/^\+91/, '').slice(0, 4)],
    ['1 digit (worst case)', sample.phone.replace(/^\+91/, '').slice(0, 1)],
    ['no match', 'zzzz'],
  ];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let worst = 0;
  for (const [label, term] of cases) {
    const f: Filter<SubscriberDoc> = { tenantId: tenant._id, status: { $ne: 'deleted' } };
    if (term) f.search = { $regex: `^${esc(term)}` };
    const run = () => subs.find(f, { sort: { _id: -1 }, limit: 51 }).toArray();
    await run();
    const times: number[] = [];
    let rows = 0;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      rows = (await run()).length;
      times.push(performance.now() - t);
    }
    const ms = times.sort((a, b) => a - b)[1]!;
    worst = Math.max(worst, ms);
    const ex = (await subs.find(f, { sort: { _id: -1 }, limit: 51 }).explain('executionStats')) as {
      executionStats?: { totalKeysExamined?: number; totalDocsExamined?: number };
    };
    const st = ex.executionStats ?? {};
    log(
      `${label.padEnd(26)} ${String(Math.round(ms)).padStart(5)} ms  ${String(rows).padStart(2)} rows  ` +
        `keys ${st.totalKeysExamined ?? '?'}  docs ${st.totalDocsExamined ?? '?'}`,
    );
  }
  log(
    worst < 1000
      ? `PASS: slowest search ${Math.round(worst)} ms (< 1 s)`
      : `FAIL: slowest search ${Math.round(worst)} ms`,
  );
}
