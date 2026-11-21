/**
 * The sidebar "Updates" card. Set SIDEBAR_UPDATE to show an announcement or ad above the user card;
 * leave it null (or let `until` pass) and the slot disappears completely.
 */
export interface SidebarUpdate {
  /** Image shown at 4:3 (236 × 177 px in the sidebar); serve from /public or an allowed origin. */
  imageUrl: string;
  /** Real alt text: what the image says, not "banner". */
  alt: string;
  href: string;
  /** ISO times; outside this window the slot is hidden. */
  from?: string;
  until?: string;
}

export const SIDEBAR_UPDATE: SidebarUpdate | null = null;

export function activeSidebarUpdate(now = new Date(), u: SidebarUpdate | null = SIDEBAR_UPDATE) {
  if (!u) return null;
  if (u.from && now < new Date(u.from)) return null;
  if (u.until && now >= new Date(u.until)) return null;
  return u;
}
