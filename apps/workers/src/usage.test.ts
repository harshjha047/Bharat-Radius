import { describe, expect, it } from 'vitest';
import { cycleStart, istDate } from './usage.js';

const now = new Date('2026-11-04T20:00:00Z'); // 5 Nov 01:30 IST

describe('IST dates', () => {
  it('uses the Indian calendar day', () => {
    expect(istDate(now)).toBe('2026-11-05');
    expect(istDate(new Date('2026-11-04T18:29:59Z'))).toBe('2026-11-04');
  });
});

describe('cycleStart', () => {
  const plan = { fupCycle: 'billing_cycle' as const, validityDays: 30 };
  it('billing cycle starts when the paid period began', () => {
    const expiresAt = new Date('2026-11-20T18:29:59Z'); // 20 Nov 23:59:59 IST
    expect(cycleStart(plan, { billingType: 'prepaid', expiresAt }, now)).toBe('2026-10-21');
  });
  it('calendar month, postpaid or unknown expiry → 1st of the IST month', () => {
    expect(
      cycleStart(
        { ...plan, fupCycle: 'calendar_month' },
        { billingType: 'prepaid', expiresAt: new Date() },
        now,
      ),
    ).toBe('2026-11-01');
    expect(cycleStart(plan, { billingType: 'postpaid' }, now)).toBe('2026-11-01');
    expect(cycleStart(plan, { billingType: 'prepaid' }, now)).toBe('2026-11-01');
  });
  it('a period that has not started yet falls back to the month', () => {
    const expiresAt = new Date('2027-02-01T00:00:00Z');
    expect(cycleStart(plan, { billingType: 'prepaid', expiresAt }, now)).toBe('2026-11-01');
  });
});
