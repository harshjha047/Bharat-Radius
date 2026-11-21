import { describe, expect, it } from 'vitest';
import { isZeroValue, smoothPath, sparkPoints, splitValue, statAriaLabel } from './stat-card';

describe('StatCard helpers', () => {
  it('splits at the first dot, keeping decimals and unit together', () => {
    expect(splitValue('₹5,805.60')).toEqual(['₹5,805', '.60']);
    expect(splitValue('3.47 TB')).toEqual(['3', '.47 TB']);
    expect(splitValue('441')).toEqual(['441', '']);
  });
  it('treats values without 1–9 as zero', () => {
    expect(isZeroValue('0')).toBe(true);
    expect(isZeroValue('₹0.00')).toBe(true);
    expect(isZeroValue('—')).toBe(true);
    expect(isZeroValue('₹0.10')).toBe(false);
    expect(isZeroValue('106')).toBe(false);
  });
  it('maps the series into the 100×40 box', () => {
    expect(sparkPoints([1, 3, 2])).toEqual([
      [0, 36],
      [50, 8],
      [100, 22],
    ]);
    expect(sparkPoints([5, 5])).toEqual([
      [0, 36],
      [100, 36],
    ]);
  });
  it('draws one cubic segment per gap, clamped at the ends', () => {
    const d = smoothPath([
      [0, 36],
      [50, 8],
      [100, 22],
    ]);
    expect(d.startsWith('M0 36 C8.33 31.33')).toBe(true);
    expect(d.match(/C/g)).toHaveLength(2);
    expect(d.endsWith('100 22')).toBe(true);
  });
  it('reads one sentence', () => {
    expect(
      statAriaLabel({
        label: 'Expiring today',
        value: '1',
        today: '₹1',
        todayLabel: 'to renew',
        trend: '4.3%',
        trendDir: 'down',
        period: 'Past 30 days',
      }),
    ).toBe('Expiring today: 1, ₹1 to renew, down 4.3% Past 30 days');
    expect(statAriaLabel({ label: 'Online now', value: '0' })).toBe('Online now: 0');
  });
});
