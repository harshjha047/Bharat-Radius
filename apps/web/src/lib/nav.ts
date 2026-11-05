/** Only same-site paths; blocks open redirects like //evil.example or /\evil. */
export function safeNext(next: string | null | undefined, fallback = '/admin'): string {
  return next && /^\/(?![/\\])/.test(next) ? next : fallback;
}
