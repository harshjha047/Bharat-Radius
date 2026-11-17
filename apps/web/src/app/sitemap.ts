import type { MetadataRoute } from 'next';
import { headers } from 'next/headers';
import { canonicalOrigin, isCanonicalHost } from '@/lib/site';

// Per request: only the official site lists the landing page; ISP installs serve an empty sitemap.
export const dynamic = 'force-dynamic';

/** Bump when the landing page copy changes, so `lastmod` stays truthful. */
const LANDING_UPDATED = '2026-11-17';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const h = await headers();
  if (!isCanonicalHost(h.get('x-forwarded-host') ?? h.get('host'))) return [];
  return [
    { url: `${canonicalOrigin()}/`, lastModified: LANDING_UPDATED, changeFrequency: 'monthly', priority: 1 },
  ];
}
