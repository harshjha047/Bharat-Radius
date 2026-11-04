import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// Production: Caddy sends /api/* to isp-api on the same origin. Development: proxy to a local API.
const apiOrigin = process.env.API_ORIGIN;

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  poweredByHeader: false,
  reactStrictMode: true,
  images: { unoptimized: true },
  experimental: { optimizePackageImports: ['lucide-react', 'radix-ui', 'recharts'] },
  ...(apiOrigin
    ? { rewrites: async () => [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }] }
    : {}),
};

export default config;
