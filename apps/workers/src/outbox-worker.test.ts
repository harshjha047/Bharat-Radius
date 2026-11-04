import { describe, expect, it } from 'vitest';
import { backoffMs } from './outbox-worker.js';

describe('retry backoff', () => {
  it('doubles from 5 s and caps at 5 min', () => {
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([5000, 10_000, 20_000, 40_000]);
    expect(backoffMs(20)).toBe(300_000);
  });
});
