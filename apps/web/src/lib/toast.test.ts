import { describe, expect, it, vi } from 'vitest';

vi.mock('sileo', () => ({ sileo: {} }));
const { toastParts } = await import('./toast');

describe('toastParts', () => {
  it('splits the first sentence into the title', () => {
    expect(toastParts('Saved. FreeRADIUS picks it up within 30 seconds.', 'Done')).toEqual({
      title: 'Saved',
      description: 'FreeRADIUS picks it up within 30 seconds.',
    });
  });
  it('keeps a short message as the title only', () => {
    expect(toastParts('Enabled.', 'Done')).toEqual({ title: 'Enabled' });
  });
  it('moves a long single sentence into the description', () => {
    const long = 'This router belongs to the ISP and only staff can change its settings or its secret';
    expect(toastParts(long, 'Something went wrong')).toEqual({
      title: 'Something went wrong',
      description: long,
    });
  });
});
