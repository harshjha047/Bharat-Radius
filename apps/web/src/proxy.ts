import { existsSync } from 'node:fs';
import { NextResponse, type NextRequest } from 'next/server';
import { contentSecurityPolicy, newNonce } from '@/lib/csp';

/** Set by the host's disk guard (disk >= 85 %); mounted read-only into the container. */
const FLAG = `${process.env.GUARD_DIR ?? '/run/isp-guard'}/maintenance`;
let cached = { at: 0, on: false };

function maintenance(): boolean {
  const now = Date.now();
  if (now - cached.at > 5_000) cached = { at: now, on: existsSync(FLAG) };
  return cached.on;
}

/** Staff, reseller and customer screens; the landing page and /pay stay up during maintenance. */
const PAUSED = /^\/(admin|account|super|portal)(\/|$)|^\/(login|setup-2fa)$/;

/** Every page gets a nonce-based CSP; during maintenance, panel screens show the maintenance page. */
export function proxy(req: NextRequest) {
  const nonce = newNonce();
  const csp = contentSecurityPolicy(nonce);
  const headers = new Headers(req.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  const paused = maintenance() && PAUSED.test(req.nextUrl.pathname);
  const res = paused
    ? NextResponse.rewrite(new URL('/maintenance', req.url), { request: { headers } })
    : NextResponse.next({ request: { headers } });
  if (paused) {
    res.headers.set('retry-after', '300');
    res.headers.set('cache-control', 'no-store');
  }
  res.headers.set('content-security-policy', csp);
  return res;
}

export const config = {
  matcher: [
    {
      source: '/((?!api/|_next/static|_next/image|favicon.ico|icon.png|brand/|robots.txt|sitemap.xml).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
