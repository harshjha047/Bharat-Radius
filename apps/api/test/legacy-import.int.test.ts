import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  pppoeAad,
  reconcileWallets,
  type NasDeviceDoc,
  type OutboxDoc,
  type PlanDoc,
  type ResellerDoc,
  type SubscriberDoc,
  type WalletDoc,
} from '@isp/db-mongo';
import { importLegacy, type Snapshot } from '../src/migration/legacy.js';
import { seedNas, seedTenant, startHarness, type Harness } from './harness.js';

let h: Harness;
let tenant: ObjectId;
const log = () => {};

const S = (
  id: string,
  msr: number,
  parentMsr: number | null,
  level: number,
  name: string,
  balance: string | null,
) => ({
  id,
  parentId: null,
  msr,
  parentMsr,
  level,
  name,
  company: '',
  email: '',
  mobile: '9876500000',
  address: 'Shop',
  city: 'Indore',
  state: 'Madhya Pradesh',
  zip: '452001',
  active: true,
  deleted: false,
  balance,
});
const P = (id: string, siteId: string, name: string, mbps: string, price: string) => ({
  id,
  siteId,
  name,
  download: mbps,
  downloadUnit: 'Mbps',
  upload: mbps,
  uploadUnit: 'Mbps',
  price,
  validity: 1,
  validityType: 'Months',
  active: true,
});
const U = (id: string, siteId: string, username: string, planId: string, extra: object = {}) => ({
  id,
  siteId,
  nasId: 'n1',
  planId,
  name: `Cust ${username}`,
  company: '',
  mobile: '9876543210',
  email: '',
  address: '1 Road',
  city: 'Noida',
  state: 'Uttar Pradesh',
  zip: '201301',
  gstin: '',
  comment: '',
  username,
  password: `pw-${username}`,
  mac: '',
  staticIp: '',
  connectionEnabled: true,
  expireDate: '2026-12-13T18:29:59+00:00',
  createdAt: '2026-01-01T00:00:00Z',
  ...extra,
});
const snapshot = (): Snapshot => ({
  exportedAt: '2026-11-17T09:57:00Z',
  sites: [
    S('top', 1, null, 1, 'Fab Five', '-10830.00'),
    S('a', 2, 1, 2, 'Rohit', '98.00'),
    S('b', 5, 1, 2, 'Ajay', '7741.50'),
  ],
  plans: [
    P('pa30', 'a', 'FAB5-30MB', '30', '1'),
    P('pb30', 'b', 'FAB5-30MB', '30', '1'),
    P('pb50', 'b', 'FAB5-50MB', '50', '1'),
  ],
  nas: [
    { id: 'n1', siteId: 'a', name: 'Noida Nas', ip: '43.228.166.246', coaPort: 3799, enabled: true },
    { id: 'n2', siteId: 'b', name: 'Xtreme fiber', ip: '103.109.222.166', coaPort: 3799, enabled: true },
  ],
  subscribers: [
    U('u1', 'a', 'one@123', 'pa30'),
    U('u2', 'a', 'two@123', 'pa30', { connectionEnabled: false }),
    U('u3', 'b', 'three@123', 'pb50', { expireDate: null, mobile: '' }),
    U('u4', 'b', 'bad user', 'pb30'),
  ],
});

beforeAll(async () => {
  h = await startHarness();
  process.env.FIELD_ENCRYPTION_KEY = h.config.FIELD_ENCRYPTION_KEY;
  tenant = await seedTenant(h.db, 'legacy');
  await seedNas(h, tenant, '103.109.222.166');
});
afterAll(() => h?.close());

const run = (apply: boolean, snap = snapshot(), sites: number[] = []) =>
  importLegacy(h.client, h.db, snap, { tenant: 'legacy', apply, sites, log });

describe('import-legacy', () => {
  it('dry run reports and writes nothing', async () => {
    const r = await run(false);
    expect(r.counts.reseller.created).toBe(3);
    expect(r.counts.plan.created).toBe(2);
    expect(r.counts.nas).toMatchObject({ created: 1, unchanged: 1 });
    expect(r.counts.subscriber).toMatchObject({ created: 3, failed: 1 });
    expect(await h.db.collection('resellers').countDocuments({ tenantId: tenant })).toBe(0);
    expect(await h.db.collection('subscribers').countDocuments({ tenantId: tenant })).toBe(0);
    expect(await h.db.collection('legacy_map').countDocuments()).toBe(0);
  });

  it('apply creates the tree, plans, routers, subscribers and opening balances, and reconciles', async () => {
    const r = await run(true);
    expect(r.mismatches).toEqual(['subscribers: 1 not imported']);
    expect(r.rowErrors).toEqual([{ username: 'bad user', message: 'invalid PPPoE username' }]);

    const rs = await h.db.collection<ResellerDoc>('resellers').find({ tenantId: tenant }).toArray();
    const top = rs.find((x) => x.name === 'Fab Five')!;
    expect(rs.filter((x) => x.parentId?.equals(top._id))).toHaveLength(2);

    const plans = await h.db.collection<PlanDoc>('plans').find({ tenantId: tenant }).toArray();
    expect(plans.map((p) => [p.name, p.downloadKbps, p.validityDays, p.pricePaise]).sort()).toEqual([
      ['FAB5-30MB', 30_000, 30, 100],
      ['FAB5-50MB', 50_000, 30, 100],
    ]);
    const nas = await h.db.collection<NasDeviceDoc>('nas_devices').find({ tenantId: tenant }).toArray();
    expect(nas.map((n) => n.ip).sort()).toEqual(['103.109.222.166', '43.228.166.246']);

    const subs = await h.db.collection<SubscriberDoc>('subscribers').find({ tenantId: tenant }).toArray();
    expect(subs).toHaveLength(3);
    const one = subs.find((x) => x.username === 'one@123')!;
    expect(h.crypto.decrypt(one.pppoePassword, pppoeAad(one._id))).toBe('pw-one@123');
    expect(one.expiresAt!.toISOString()).toBe('2026-12-13T18:29:59.000Z');
    expect(one.network.popName).toBe('Noida Nas');
    expect(subs.find((x) => x.username === 'two@123')!.status).toBe('disabled');
    const three = subs.find((x) => x.username === 'three@123')!;
    expect(three.tags).toContain('legacy-fix');
    expect(three.expiresAt!.getTime()).toBeLessThan(Date.now());
    expect(
      await h.db.collection<OutboxDoc>('outbox').countDocuments({ tenantId: tenant, entity: 'subscriber' }),
    ).toBeGreaterThanOrEqual(3);

    const wallet = async (name: string) =>
      (await h.db
        .collection<WalletDoc>('wallets')
        .findOne({ ownerId: rs.find((x) => x.name === name)!._id }))!.balancePaise;
    expect(await wallet('Fab Five')).toBe(0);
    expect(await wallet('Rohit')).toBe(9800);
    expect(await wallet('Ajay')).toBe(774150);
    const master = await h.db.collection<WalletDoc>('wallets').findOne({ ownerId: tenant });
    expect(master!.balancePaise).toBe(-(9800 + 774150));
    expect(await reconcileWallets(h.db)).toMatchObject({ mismatches: 0, frozen: 0 });
  });

  it('a second run changes nothing; a later snapshot applies only the delta', async () => {
    const again = await run(true);
    expect(again.counts.subscriber).toMatchObject({ created: 0, updated: 0, unchanged: 3 });
    expect(again.counts.wallet.unchanged).toBe(3);

    const snap = snapshot();
    snap.subscribers[0]!.password = 'changed-pw';
    snap.subscribers[0]!.expireDate = '2027-01-13T18:29:59+00:00';
    snap.subscribers[0]!.planId = 'pb50';
    snap.sites[1]!.balance = '198.00';
    const delta = await run(true, snap);
    expect(delta.counts.subscriber).toMatchObject({ updated: 1, unchanged: 2 });
    expect(delta.counts.wallet.updated).toBe(1);
    expect(delta.mismatches).toEqual(['subscribers: 1 not imported']);
    const one = (await h.db.collection<SubscriberDoc>('subscribers').findOne({ username: 'one@123' }))!;
    expect(h.crypto.decrypt(one.pppoePassword, pppoeAad(one._id))).toBe('changed-pw');
    expect(one.expiresAt!.toISOString()).toBe('2027-01-13T18:29:59.000Z');
    expect(await h.db.collection('subscribers').countDocuments({ tenantId: tenant })).toBe(3);

    const set = new Date('2027-02-01T18:29:59Z');
    await h.db.collection('subscribers').updateOne({ username: 'three@123' }, { $set: { expiresAt: set } });
    const later = await run(true, snap);
    expect(later.counts.subscriber).toMatchObject({ updated: 0, unchanged: 3 });
    expect(
      (await h.db.collection<SubscriberDoc>('subscribers').findOne({ username: 'three@123' }))!.expiresAt,
    ).toEqual(set);
  });

  it('refuses a username already used outside the import', async () => {
    const snap = snapshot();
    snap.subscribers.push(U('u9', 'b', 'one@123', 'pb30'));
    const r = await run(false, snap, [5]);
    expect(r.rowErrors.some((e) => e.username === 'one@123' && /already used/.test(e.message))).toBe(true);
  });
});
