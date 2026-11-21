/**
 * The sidebar "Updates" card. Set SIDEBAR_UPDATE to show an announcement or ad above the user card;
 * leave it null (or let `until` pass) and the slot disappears completely.
 */
export interface SidebarUpdate {
  /** Shown 236 px wide in the sidebar; serve from /public or an allowed origin. */
  imageUrl: string;
  /** Width / height of the artwork, so it is never cropped. Default 4 / 3 (236 × 177 px). */
  aspect?: number;
  /** Real alt text: what the image says, not "banner". */
  alt: string;
  href: string;
  /** ISO times; outside this window the slot is hidden. */
  from?: string;
  until?: string;
}

export const SIDEBAR_UPDATE: SidebarUpdate | null = {
  imageUrl: '/brand/samadhan-app.webp',
  alt: 'Samadhan by Fab Five Network is available on Play Store. Search "Samadhan" on Play Store.',
  href: 'https://play.google.com/store/search?q=Samadhan%20Fab%20Five%20Network&c=apps',
  aspect: 2,
};

export function activeSidebarUpdate(now = new Date(), u: SidebarUpdate | null = SIDEBAR_UPDATE) {
  if (!u) return null;
  if (u.from && now < new Date(u.from)) return null;
  if (u.until && now >= new Date(u.until)) return null;
  return u;
}
