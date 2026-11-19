/**
 * Content-Security-Policy for every HTML page, with a per-request nonce: Next.js puts it on its own inline
 * bootstrap scripts, and 'strict-dynamic' lets those load the bundles. No 'unsafe-inline' for scripts.
 * Styles keep 'unsafe-inline': React style attributes and component libraries inject styles at runtime; style
 * injection cannot run code.
 */
export function contentSecurityPolicy(nonce: string, dev = process.env.NODE_ENV === 'development'): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${dev ? ' ws:' : ''}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

export function newNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b));
}
