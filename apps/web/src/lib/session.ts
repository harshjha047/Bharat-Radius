'use client';
import { useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { api, unwrap } from './api';
import { ME_KEY } from './auth';

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
export function useSignedIn(which: 'staff' | 'customer' | 'any' = 'any') {
  // Read on the client only; the server (and cached HTML) always renders the signed-out view.
  const flags = useSyncExternalStore(noSubscribe, cookieFlags, () => null);
  const cookies = flags === null ? null : { staff: flags.includes('s'), customer: flags.includes('c') };

  const wantStaff = which !== 'customer' && !!cookies?.staff;
  const wantCustomer = which !== 'staff' && !!cookies?.customer && !wantStaff;

  // Same key as useMe, so the panel reuses the answer after navigation.
  const staff = useQuery({
    queryKey: ME_KEY,
    queryFn: () => unwrap(api.GET('/api/v1/auth/me')),
    enabled: wantStaff,
    staleTime: 60_000,
    retry: false,
  });
  const customer = useQuery({
    queryKey: ['portal', 'me'],
    queryFn: () => unwrap(api.GET('/api/v1/portal/me')),
    enabled: wantCustomer,
    retry: false,
  });

  const optimistic: SignedIn | null = wantStaff
    ? { kind: 'staff', href: '/admin', label: 'Go to dashboard' }
    : wantCustomer
      ? { kind: 'customer', href: '/portal', label: 'My account' }
      : null;

  const active = wantStaff ? staff : wantCustomer ? customer : null;
  const checking = cookies === null || (active !== null && active.isPending);
  let confirmed = !active || active.isError || !active.data ? null : optimistic;
  if (confirmed?.kind === 'staff' && staff.data?.user.type === 'superadmin') {
    confirmed = { ...confirmed, href: '/super/tenants' };
  }

  return { optimistic: active?.isError ? null : (confirmed ?? optimistic), confirmed, checking };
}
