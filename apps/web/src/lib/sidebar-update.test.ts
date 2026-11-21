import { describe, expect, it } from 'vitest';
import { activeSidebarUpdate, SIDEBAR_UPDATE } from './sidebar-update';

const u = {
  imageUrl: '/u.png',
  alt: 'New plans',
  href: 'https://example.com',
  from: '2026-11-01T00:00:00+05:30',
  until: '2026-12-01T00:00:00+05:30',
};

describe('activeSidebarUpdate', () => {
  it('is empty when nothing is set', () => {
    expect(activeSidebarUpdate(new Date(), null)).toBeNull();
  });
  it('the configured update is served from /public and links out over https', () => {
    expect(SIDEBAR_UPDATE?.imageUrl).toMatch(/^\/brand\//);
    expect(SIDEBAR_UPDATE?.href).toMatch(/^https:\/\//);
  });
  it('shows only inside its window', () => {
    expect(activeSidebarUpdate(new Date('2026-10-31T12:00:00+05:30'), u)).toBeNull();
    expect(activeSidebarUpdate(new Date('2026-11-21T12:00:00+05:30'), u)).toBe(u);
    expect(activeSidebarUpdate(new Date('2026-12-01T00:00:00+05:30'), u)).toBeNull();
  });
});
