import type { MetadataRoute } from 'next';
import { headers } from 'next/headers';

// Per request: the sitemap URL must name the host that was asked (official site or an ISP install).
export const dynamic = 'force-dynamic';

export default async function robots(): Promise<MetadataRoute.Robots> {
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host');
  const proto = h.get('x-forwarded-proto') ?? 'https';
  return {
    // One rule for every crawler, AI search bots included (GPTBot, Google-Extended, PerplexityBot…).
    rules: {
      userAgent: '*',
      allow: ['/', '/login', '/portal/login'],
      // Signed-in areas. Login pages stay crawlable: they are `noindex, follow` so the DIV credit counts.
      disallow: ['/admin', '/super', '/account', '/portal/', '/pay', '/setup-2fa', '/api/'],
    },
    ...(host ? { sitemap: `${proto}://${host}/sitemap.xml` } : {}),
  };
}
