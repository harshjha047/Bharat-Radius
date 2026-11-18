import { describe, expect, it } from 'vitest';
import {
  mapSubscriber,
  stateCodeOf,
  toKbps,
  toPaise,
  toValidityDays,
  type TenantDefaults,
} from './legacy.js';

const t: TenantDefaults = {
  stateCode: '09',
  city: 'Noida',
  state: 'Uttar Pradesh',
  pincode: '201301',
  line1: 'HQ',
};
const site = {
  id: 's',
  msr: 2,
  level: 2,
  name: 'Rohit Gupta',
  company: '',
  email: '',
  mobile: '9876500001',
  address: 'Shop 1',
  city: 'Indore',
  state: 'Madhya Pradesh',
  zip: '452001',
  active: true,
  deleted: false,
};
const sub = {
  id: 'x',
  siteId: 's',
  name: 'Asha',
  company: '',
  mobile: '9876543210',
  email: 'A@B.in',
  address: '12 MG Road',
  city: 'Itanagar',
  state: 'Arunachal Pradesh',
  zip: '791111',
  gstin: '',
  comment: '',
  username: 'asha@123',
  password: 'pw12',
  mac: 'aa-bb-cc-dd-ee-ff',
  staticIp: '',
  connectionEnabled: true,
  expireDate: '2026-12-13T18:29:59+00:00',
  createdAt: '2026-01-01T00:00:00Z',
};
const now = new Date('2026-11-18T06:00:00Z');

describe('legacy mapping', () => {
  it('converts money, speed and validity exactly', () => {
    expect(toPaise('98.00')).toBe(9800);
    expect(toPaise('1')).toBe(100);
    expect(toPaise('-10830.5')).toBe(-1083050);
    expect(toPaise('2359')).toBe(235900);
    expect(toKbps('100', 'Mbps')).toBe(100_000);
    expect(toKbps('512', 'Kbps')).toBe(512);
    expect(toKbps('1', 'Gbps')).toBe(1_000_000);
    expect(toValidityDays(1, 'Months')).toBe(30);
    expect(toValidityDays(30, 'Days')).toBe(30);
    expect(stateCodeOf('Arunachal Pradesh')).toBe('12');
    expect(stateCodeOf(' uttar  pradesh ')).toBe('09');
    expect(stateCodeOf('Narnia')).toBeUndefined();
  });

  it('keeps a complete record as it is', () => {
    const m = mapSubscriber(sub, site, t, now);
    expect(m.error).toBeUndefined();
    expect(m.filled).toEqual([]);
    expect(m.input).toMatchObject({
      username: 'asha@123',
      pppoePassword: 'pw12',
      phone: '+919876543210',
      email: 'a@b.in',
      address: { stateCode: '12', pincode: '791111', city: 'Itanagar' },
      network: { macLock: 'AA:BB:CC:DD:EE:FF' },
      tags: ['legacy'],
    });
    expect(m.input.expiresAt!.toISOString()).toBe('2026-12-13T18:29:59.000Z');
  });

  it('fills missing fields from the reseller, then the ISP, and tags them', () => {
    const m = mapSubscriber(
      { ...sub, mobile: '123', zip: '', city: '', state: '', address: '', expireDate: null },
      site,
      t,
      now,
    );
    expect(m.filled.sort()).toEqual(['address', 'city', 'expiry', 'phone', 'pincode', 'state']);
    expect(m.input.phone).toBe('+919876500001');
    expect(m.input.address).toMatchObject({
      city: 'Indore',
      state: 'Madhya Pradesh',
      stateCode: '23',
      pincode: '452001',
    });
    expect(m.input.tags).toEqual(['legacy', 'legacy-fix']);
    expect(m.input.expiresAt!.getTime()).toBeLessThan(now.getTime());
    const noSite = mapSubscriber({ ...sub, mobile: '', zip: 'x' }, undefined, t, now);
    expect(noSite.input.address.pincode).toBe('201301');
  });

  it('drops invalid optional values and refuses rows that cannot log in', () => {
    const m = mapSubscriber(
      { ...sub, email: 'nope', mac: 'zz', gstin: 'bad', staticIp: '999.1.1.1' },
      site,
      t,
      now,
    );
    expect(m.dropped.sort()).toEqual(['email', 'gstin', 'mac', 'static_ip']);
    expect(m.input.email).toBeUndefined();
    expect(mapSubscriber({ ...sub, password: 'has space' }, site, t, now).error).toMatch(/password/);
    expect(mapSubscriber({ ...sub, username: 'a b' }, site, t, now).error).toMatch(/username/);
    expect(mapSubscriber({ ...sub, connectionEnabled: false }, site, t, now).disabled).toBe(true);
  });
});
