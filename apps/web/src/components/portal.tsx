'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ApiError, unwrap, type ApiData } from '@/lib/api';
import { fmtDate } from '@/lib/utils';

export type PortalMe = ApiData<'/api/v1/portal/me'>;
export type PortalPlan = ApiData<'/api/v1/portal/plans'>['items'][number];

export const portalKeys = {
  me: ['portal', 'me'] as const,
  plans: ['portal', 'plans'] as const,
  usage: ['portal', 'usage'] as const,
  sessions: ['portal', 'sessions'] as const,
  invoices: ['portal', 'invoices'] as const,
  payments: ['portal', 'payments'] as const,
};

/** The signed-in customer; refetched when they come back from the payment page. */
export function usePortalMe() {
  return useQuery({
    queryKey: portalKeys.me,
    queryFn: () => unwrap(api.GET('/api/v1/portal/me')),
    refetchOnWindowFocus: true,
    retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
  });
}

/** Opens the gateway's payment page for a recharge (prepaid) or an invoice. */
export function usePortalPay() {
  return useMutation({
    mutationFn: (b: { planId?: string; invoiceId?: string }) =>
      unwrap(api.POST('/api/v1/portal/pay', { body: b })),
    onSuccess: (p) => {
      if (p.linkUrl) window.location.assign(p.linkUrl);
    },
  });
}

export type ConnectionState = { label: string; tone: 'success' | 'warning' | 'danger'; detail: string };

export function connectionState(me: PortalMe): ConnectionState {
  if (me.status === 'suspended')
    return {
      label: 'Suspended',
      tone: 'danger',
      detail:
        me.suspendReason === 'overdue'
          ? 'Your bill is overdue. Pay it to reconnect.'
          : 'Contact your provider to reconnect.',
    };
  if (me.status === 'disabled')
    return { label: 'Disabled', tone: 'danger', detail: 'Contact your provider.' };
  if (me.expired)
    return {
      label: 'Expired',
      tone: 'danger',
      detail: 'Recharge to get full speed back. No router restart needed.',
    };
  if (me.billingType === 'prepaid' && me.expiresAt) {
    const days = Math.ceil((new Date(me.expiresAt).getTime() - Date.now()) / 86_400_000);
    if (days <= 3)
      return {
        label: `Expires in ${days} day${days === 1 ? '' : 's'}`,
        tone: 'warning',
        detail: `Valid until ${fmtDate(me.expiresAt)}`,
      };
    return { label: 'Active', tone: 'success', detail: `Valid until ${fmtDate(me.expiresAt)}` };
  }
  return { label: 'Active', tone: 'success', detail: 'Billed monthly' };
}
