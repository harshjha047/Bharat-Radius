'use client';
import { useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { api, unwrap } from './api';

export type SignedIn =
  { kind: 'staff'; href: string; label: string } | { kind: 'customer'; href: string; label: string };

/** The CSRF cookies are readable by the page and exist only while a session does (cleared on sign-out). */
function hasCookie(name: string): boolean {
  return new RegExp(`(?:^|;\\s*)${name}=`).test(document.cookie);
}

const noSubscribe = () => () => {};
/** "s" = staff CSRF cookie present, "c" = customer portal CSRF cookie present. */
const cookieFlags = () => (hasCookie('isp_csrf') ? 's' : '') + (hasCookie('isp_pcsrf') ? 'c' : '');

/**
 * Who is signed in on this browser, without asking the API when there is clearly no session.
 *
 * `optimistic` is the cookie-only guess, available right after mount so the UI can switch without a
 * visible flash; `confirmed` is set once the API has answered (null = not signed in after all).
 * `checking` is true while a cookie exists but the API has not answered yet.
 */
export function useSignedIn(
  which: 'staff' | 'customer' | 'any' = 'any',
  /** Turn off once this page starts its own sign-in, so the new session is not mistaken for an old one. */
  enabled = true,
) {
  // Read on the client only; the server (and cached HTML) always renders the signed-out view.
  const flags = useSyncExternalStore(noSubscribe, cookieFlags, () => null);
  const cookies = flags === null ? null : { staff: flags.includes('s'), customer: flags.includes('c') };

  const wantStaff = enabled && which !== 'customer' && !!cookies?.staff;
  const wantCustomer = enabled && which !== 'staff' && !!cookies?.customer && !wantStaff;

  // Own keys, not useMe's: the panel must always load its own fresh answer (2FA state, permissions).
  const staff = useQuery({
    queryKey: ['session-check', 'staff'],
    queryFn: () => unwrap(api.GET('/api/v1/auth/me')),
    enabled: wantStaff,
    gcTime: 0,
    retry: false,
  });
  const customer = useQuery({
    queryKey: ['session-check', 'customer'],
    queryFn: () => unwrap(api.GET('/api/v1/portal/me')),
    enabled: wantCustomer,
    gcTime: 0,
    retry: false,
  });

  const optimistic: SignedIn | null = wantStaff
    ? { kind: 'staff', href: '/admin', label: 'Go to dashboard' }
    : wantCustomer
      ? { kind: 'customer', href: '/portal', label: 'My account' }
      : null;

  const active = wantStaff ? staff : wantCustomer ? customer : null;
  const checking = enabled && (cookies === null || (active !== null && active.isPending));
  let confirmed = !active || active.isError || !active.data ? null : optimistic;
  if (confirmed?.kind === 'staff' && staff.data?.user.type === 'superadmin') {
    confirmed = { ...confirmed, href: '/super/tenants' };
  }

  return { optimistic: active?.isError ? null : (confirmed ?? optimistic), confirmed, checking };
}
