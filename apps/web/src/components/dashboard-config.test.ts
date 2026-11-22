import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ api: {}, unwrap: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
const { arrange, isResellerWidget, isStaffWidget, layoutFor, nextLayout } =
  await import('./dashboard-config');

const staff = [
  { id: 'stat-total', label: 'Total' },
  { id: 'stat-7d', label: 'Next 7 days', defaultHidden: true },
  { id: 'trends', label: 'Trends' },
];

describe('layoutFor', () => {
  it('keeps default-off widgets off until this dashboard is arranged', () => {
    const l = layoutFor(staff, [], new Set());
    expect(l.arranged).toBe(false);
    expect(staff.filter(l.isShown).map((w) => w.id)).toEqual(['stat-total', 'trends']);
  });
  it('lets the user switch a default-off widget on once saved', () => {
    const saved = nextLayout(
      { hidden: new Set(), order: [] },
      { hidden: new Set(), order: staff.map((w) => w.id) },
      isStaffWidget,
    );
    const l = layoutFor(staff, saved.order, new Set(saved.hidden));
    expect(l.arranged).toBe(true);
    expect(staff.filter(l.isShown).map((w) => w.id)).toEqual(['stat-total', 'stat-7d', 'trends']);
  });
  it('is not arranged by the other dashboard’s saved order', () => {
    expect(layoutFor(staff, ['r-network', 'r-stat-total'], new Set()).arranged).toBe(false);
  });
});

describe('nextLayout', () => {
  it('keeps the other dashboard, drops this dashboard’s stale ids', () => {
    const out = nextLayout(
      {
        hidden: new Set(['renewals', 'kpi-online', 'r-wallet']),
        order: ['r-network', 'r-stat-total', 'kpi-online'],
      },
      { hidden: new Set(['trends']), order: ['stat-total', 'trends'] },
      isStaffWidget,
    );
    expect(out.hidden).toEqual(['r-wallet', 'trends']);
    expect(out.order).toEqual(['stat-total', 'trends', 'r-network', 'r-stat-total']);
  });
  it('splits ids by dashboard', () => {
    expect(isResellerWidget('r-stat-total')).toBe(true);
    expect(isStaffWidget('stat-total')).toBe(true);
    expect(arrange(staff, ['trends']).map((w) => w.id)).toEqual(['trends', 'stat-total', 'stat-7d']);
  });
});
