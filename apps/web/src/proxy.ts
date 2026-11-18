import { existsSync } from 'node:fs';
import { NextResponse, type NextRequest } from 'next/server';

/** Set by the host's disk guard (disk >= 85 %); mounted read-only into the container. */
const FLAG = `${process.env.GUARD_DIR ?? '/run/isp-guard'}/maintenance`;
let cached = { at: 0, on: false };

function maintenance(): boolean {
  const now = Date.now();
  if (now - cached.at > 5_000) cached = { at: now, on: existsSync(FLAG) };
  return cached.on;
}

/** Staff, reseller and customer screens show the maintenance page; the landing page and /pay stay up. */
export function proxy(req: NextRequest) {
  if (!maintenance()) return NextResponse.next();
  const res = NextResponse.rewrite(new URL('/maintenance', req.url));
  res.headers.set('retry-after', '300');
  res.headers.set('cache-control', 'no-store');
  return res;
}

export const config = {
  matcher: ['/admin/:path*', '/account/:path*', '/super/:path*', '/portal/:path*', '/login', '/setup-2fa'],
};
