import { describe, expect, it } from 'vitest';
import { explain } from './radius-log.js';

describe('auth log Why?', () => {
  it('maps every logged reason to a category', () => {
    const cat = (r: string | null, ok = false) => explain(r, ok).category;
    expect(cat(null, true)).toBe('accepted');
    expect(cat('Plan expired', true)).toBe('expired');
    expect(cat('Subscriber account expired')).toBe('expired');
    expect(cat('User not found')).toBe('not_found');
    expect(cat('Wrong password')).toBe('wrong_password');
    expect(cat('Service provider suspended')).toBe('isp_suspended');
    expect(cat('Account suspended')).toBe('suspended');
    expect(cat('Account disabled')).toBe('disabled');
    expect(cat('MAC address not allowed')).toBe('mac');
    expect(cat('You are already logged in - access denied')).toBe('already_online');
    expect(cat('Rejected: Realm begins with a dot')).toBe('username_format');
    expect(cat('something new')).toBe('other');
  });
});
