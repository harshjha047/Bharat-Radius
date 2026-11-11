import { describe, expect, it } from 'vitest';
import { resellerPatch, toBody, type SubscriberFormValues } from '@/components/subscriber-form';
import { changedOnly, endOfDayIst, istDateInput } from './forms';
import { safeNext } from './nav';
import { actionLabel } from '@/components/audit-changes';
import { fmtBytes, fmtDuration, fmtKbps, fmtRupees, plural } from './utils';

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
    expect(plural(1, 'day')).toBe('1 day');
    expect(plural(30, 'day')).toBe('30 days');
    expect(plural(1000, 'day')).toBe('1,000 days');
  });
  it('action labels keep acronyms upper-case', () => {
    expect(actionLabel('x.fup')).toBe('FUP');
    expect(actionLabel('x.plan_change')).toBe('Plan change');
    expect(actionLabel('auth.2fa_enable')).toBe('2FA enable');
    expect(actionLabel('subscriber.password_reveal')).toBe('Password reveal');
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

describe('resellerPatch', () => {
  const a = { id: 'a1', code: 'R-0003', name: 'Test L1' };
  const b = { id: 'b2', code: 'R-0004', name: 'Test L2' };
  it('create sends the chosen owner or nothing', () => {
    expect(resellerPatch(false, undefined, a, false)).toEqual({ resellerId: 'a1' });
    expect(resellerPatch(false, undefined, null, false)).toEqual({});
  });
  it('edit never sends resellerId unless the picker was used and the owner changed', () => {
    expect(resellerPatch(true, a, null, false)).toEqual({});
    expect(resellerPatch(true, a, a, true)).toEqual({});
    expect(resellerPatch(true, null, null, true)).toEqual({});
  });
  it('edit sends the new owner, or null only after an explicit clear', () => {
    expect(resellerPatch(true, a, b, true)).toEqual({ resellerId: 'b2' });
    expect(resellerPatch(true, a, null, true)).toEqual({ resellerId: null });
    expect(resellerPatch(true, null, a, true)).toEqual({ resellerId: 'a1' });
  });
});
