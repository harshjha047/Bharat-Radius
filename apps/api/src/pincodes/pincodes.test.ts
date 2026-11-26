import { describe, expect, it } from 'vitest';
import { GST_STATES } from '@isp/db-mongo';
import { DISTRICTS, PACKED, STATES } from './data.js';
import { lookupPincode } from './pincodes.js';

describe('PIN code lookup', () => {
  it('finds district, state and GST state code', () => {
    expect(lookupPincode('110001')).toEqual({
      pincode: '110001',
      district: expect.stringMatching(/Delhi/),
      state: 'Delhi',
      stateCode: '07',
    });
    expect(lookupPincode('201301')).toMatchObject({ state: 'Uttar Pradesh', stateCode: '09' });
    expect(lookupPincode('790102')).toMatchObject({ state: 'Arunachal Pradesh', stateCode: '12' });
  });

  it('returns null for an unknown PIN', () => {
    expect(lookupPincode('000000')).toBeNull();
  });

  it('data is well formed and uses the GST portal state names', () => {
    const entries = PACKED.split(';');
    expect(entries.length).toBeGreaterThan(19_000);
    for (const e of entries) {
      const m = /^(\d{6})([0-9a-f]+)\.([0-9a-f]+)$/.exec(e);
      expect(m, e).not.toBeNull();
      expect(DISTRICTS[parseInt(m![2]!, 16)], e).toBeDefined();
      expect(STATES[parseInt(m![3]!, 16)], e).toBeDefined();
    }
    for (const [name, code] of STATES) expect(GST_STATES[code]).toBe(name);
  });
});
