/**
 * "Login as site": the chain of reseller panels opened from this tab (top = current). Kept per tab in
 * sessionStorage so another tab stays in the admin's own panel. Sent as X-View-As on every staff API call.
 */
export interface ViewAsEntry {
  id: string;
  code: string;
  name: string;
}

const KEY = 'isp.viewAs';

export function viewAsStack(): ViewAsEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const v = JSON.parse(window.sessionStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? (v as ViewAsEntry[]) : [];
  } catch {
    return [];
  }
}

export const currentViewAs = (): string | null => viewAsStack().at(-1)?.id ?? null;

function save(stack: ViewAsEntry[]) {
  try {
    if (stack.length) window.sessionStorage.setItem(KEY, JSON.stringify(stack));
    else window.sessionStorage.removeItem(KEY);
  } catch {
    // Storage blocked: the panel keeps working as the real user.
  }
}

export function enterViewAs(e: ViewAsEntry) {
  const s = viewAsStack().filter((x) => x.id !== e.id);
  save([...s, e]);
}

/** One level back; returns the entry now shown, or null for the admin's own panel. */
export function leaveViewAs(): ViewAsEntry | null {
  const s = viewAsStack().slice(0, -1);
  save(s);
  return s.at(-1) ?? null;
}

export const clearViewAs = () => save([]);
