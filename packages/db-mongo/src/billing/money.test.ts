import { describe, expect, it } from 'vitest';
import {
  documentNumber,
  endOfIstDay,
  financialYear,
  grossPrice,
  gstLine,
  gstTotals,
  rechargePeriod,
  renewedExpiry,
  rupees,
  taxableForGross,
} from './money.js';
import { sharePaise } from './settle.js';

describe('GST', () => {
  it('splits CGST/SGST in state and IGST out of state, rounding half up to the paisa', () => {
    const intra = gstLine({
      description: 'x',
      hsnSac: '998422',
      ratePaise: 49_900,
      gstRatePercent: 18,
      intraState: true,
    });
    expect(intra).toMatchObject({
      taxablePaise: 49_900,
      cgstPaise: 4491,
      sgstPaise: 4491,
      igstPaise: 0,
      totalPaise: 58_882,
    });
    const inter = gstLine({
      description: 'x',
      hsnSac: '998422',
      ratePaise: 49_900,
      gstRatePercent: 18,
      intraState: false,
    });
    expect(inter).toMatchObject({ cgstPaise: 0, sgstPaise: 0, igstPaise: 8982, totalPaise: 58_882 });
    // 0.5 paisa rounds up
    expect(
      gstLine({ description: '', hsnSac: '', ratePaise: 25, gstRatePercent: 18, intraState: true }).cgstPaise,
    ).toBe(2);
  });

  it('rounds the document total to the rupee with an explicit round-off', () => {
    const t = gstTotals([
      gstLine({ description: '', hsnSac: '', ratePaise: 49_900, gstRatePercent: 18, intraState: true }),
    ]);
    expect(t).toMatchObject({ totalPaise: 58_900, roundOffPaise: 18 });
    expect(grossPrice(10_000, 18)).toBe(11_800);
    expect(grossPrice(12_000, 18)).toBe(14_200);
  });
});

describe('dates', () => {
  it('prepaid renewal: expired → today + validity − 1 at 23:59:59 IST; active → current expiry + validity', () => {
    const now = new Date('2026-11-07T20:00:00Z'); // 8 Nov 01:30 IST
    const e = renewedExpiry(new Date('2026-11-01T18:29:59Z'), 30, now);
    expect(e.toISOString()).toBe('2026-12-07T18:29:59.000Z'); // 7 Dec 23:59:59 IST
    const cur = new Date('2026-11-20T18:29:59Z');
    expect(renewedExpiry(cur, 30, now).toISOString()).toBe('2026-12-20T18:29:59.000Z');
    expect(endOfIstDay(new Date('2026-11-07T18:30:00Z')).toISOString()).toBe('2026-11-08T18:29:59.000Z');
  });

  it('recharge period: starts at the current expiry while in service, else now; N periods', () => {
    const now = new Date('2026-11-07T20:00:00Z');
    const cur = new Date('2026-11-20T18:29:59Z');
    const p = rechargePeriod(cur, 30, 3, now);
    expect(p.start).toEqual(cur);
    expect(p.end.toISOString()).toBe('2027-02-18T18:29:59.000Z');
    const e = rechargePeriod(new Date('2026-11-01T18:29:59Z'), 30, 1, now);
    expect(e.start).toEqual(now);
    expect(e.end.toISOString()).toBe('2026-12-07T18:29:59.000Z');
  });

  it('financial year and invoice numbers (≤ 16 characters)', () => {
    expect(financialYear(new Date('2026-03-31T18:29:59Z'))).toBe('2025-26');
    expect(financialYear(new Date('2026-03-31T18:30:00Z'))).toBe('2026-27');
    expect(documentNumber('INV', '2026-27', 1)).toBe('INV/2627/00001');
    expect(documentNumber('BR', '2026-27', 1_234_567)).toBe('BR/2627/1234567');
    expect(() => documentNumber('ABC', '2026-27', 12_345_678)).toThrow();
  });

  it('formats rupees with Indian grouping', () => {
    expect(rupees(10_000_000)).toBe('Rs. 1,00,000.00');
    expect(rupees(-5_050)).toBe('-Rs. 50.50');
  });
});

describe('F-7 money helpers', () => {
  it('revenue share rounds half up to the paisa', () => {
    expect(sharePaise(50_000, 4000)).toBe(20_000);
    expect(sharePaise(49_900, 3333)).toBe(16_632);
    expect(sharePaise(1, 5000)).toBe(1);
  });
  it('a hand-set total incl. GST maps back to a taxable amount that invoices to exactly that total', () => {
    for (const [gross, rate] of [
      [59_000, 18],
      [10_000, 18],
      [100, 18],
      [99_900, 5],
      [0, 18],
    ] as const) {
      expect(grossPrice(taxableForGross(gross, rate), rate)).toBe(gross);
    }
    expect(taxableForGross(59_000, 18)).toBe(50_000);
    expect(() => taxableForGross(10_050, 18)).toThrow(/whole rupees/);
  });
});
