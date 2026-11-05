import { describe, expect, it } from 'vitest';
import { toBody, type SubscriberFormValues } from '@/components/subscriber-form';
import { changedOnly, endOfDayIst, istDateInput } from './forms';
import { safeNext } from './nav';
import { fmtBytes, fmtDuration, fmtKbps, fmtRupees } from './utils';

describe('formatters', () => {
  it('bytes, speeds, durations and rupees the way staff read them', () => {
    expect(fmtBytes(0)).toBe('0 B');
    expect(fmtBytes(1_500_000)).toBe('1.5 MB');
    expect(fmtBytes(312e9)).toBe('312 GB');
    expect(fmtKbps(50_000)).toBe('50 Mbps');
    expect(fmtKbps(1_000_000)).toBe('1 Gbps');
    expect(fmtKbps(512)).toBe('512 kbps');
    expect(fmtDuration(3 * 86400 + 4 * 3600)).toBe('3d 4h');
    expect(fmtDuration(600)).toBe('10m');
    expect(fmtRupees(49900)).toBe('₹499.00');
  });
});

describe('safeNext', () => {
  it('allows only same-site paths', () => {
    expect(safeNext('/admin/plans')).toBe('/admin/plans');
    expect(safeNext('//evil.example')).toBe('/admin');
    expect(safeNext('/\\evil.example')).toBe('/admin');
    expect(safeNext('https://evil.example')).toBe('/admin');
    expect(safeNext(null)).toBe('/admin');
  });
});

describe('dates in IST', () => {
  it('valid-until means end of that day in India', () => {
    expect(new Date(endOfDayIst('2026-11-30')).toISOString()).toBe('2026-11-30T18:29:59.000Z');
    expect(istDateInput('2026-11-30T18:29:59.000Z')).toBe('2026-11-30');
    expect(istDateInput('2026-11-30T18:30:00.000Z')).toBe('2026-12-01');
  });
});

describe('PATCH bodies', () => {
  it('changedOnly keeps differing top-level fields', () => {
    expect(changedOnly({ a: 1, b: { c: 2 }, d: null }, { a: 1, b: { c: 3 }, d: 'x' })).toEqual({
      b: { c: 2 },
      d: null,
    });
  });

  const base: SubscriberFormValues = {
    username: 'ramesh100',
    pppoePassword: '',
    name: 'Ramesh',
    phone: '9876543210',
    altPhone: '',
    email: '',
    line1: '12 Gandhi Nagar',
    line2: '',
    city: 'Noida',
    district: '',
    state: 'UP',
    pincode: '201301',
    gstin: '',
    billingType: 'prepaid',
    planId: '',
    expiresAt: '',
    staticIp: '',
    macLock: '',
    simUse: '',
    popName: '',
    tags: 'vip, fibre',
    notes: '',
  };

  it('create sends filled fields and omits empty optional ones', () => {
    expect(toBody(base, null)).toEqual({
      username: 'ramesh100',
      name: 'Ramesh',
      phone: '9876543210',
      address: { line1: '12 Gandhi Nagar', city: 'Noida', state: 'UP', pincode: '201301' },
      billingType: 'prepaid',
      network: {},
      tags: ['vip', 'fibre'],
    });
  });

  it('edit sends only what changed and clears emptied fields with null', () => {
    const body = toBody(
      { ...base, name: 'Ramesh Kumar', staticIp: '', email: '' },
      { name: true, staticIp: true, email: true },
    );
    expect(body).toEqual({ name: 'Ramesh Kumar', email: null, network: { staticIp: null } });
  });
});
