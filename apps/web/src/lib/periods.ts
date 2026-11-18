/** IST calendar day of a Date, as YYYY-MM-DD. */
export const istDate = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);

/** Report date ranges (inclusive IST days). */
export function periodPresets(): Record<string, [string, string]> {
  const today = istDate(new Date());
  const [y, m] = today.split('-').map(Number) as [number, number];
  const pad = (n: number) => String(n).padStart(2, '0');
  const lastMonthEnd = istDate(new Date(Date.UTC(y, m - 1, 0, 12)));
  const fyStart = m >= 4 ? `${y}-04-01` : `${y - 1}-04-01`;
  return {
    Today: [today, today],
    'This month': [`${y}-${pad(m)}-01`, today],
    'Last month': [`${lastMonthEnd.slice(0, 8)}01`, lastMonthEnd],
    'Last 7 days': [istDate(new Date(Date.now() - 6 * 86_400_000)), today],
    'Last 30 days': [istDate(new Date(Date.now() - 29 * 86_400_000)), today],
    'This financial year': [fyStart, today],
    'This year': [`${y}-01-01`, today],
  };
}
