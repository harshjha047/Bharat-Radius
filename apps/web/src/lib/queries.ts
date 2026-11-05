'use client';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api, unwrap, type Item } from './api';
import { useCan } from './auth';

export type Plan = Item<'/api/v1/plans'>;
export type Nas = Item<'/api/v1/nas'>;
export type Subscriber = Item<'/api/v1/subscribers'>;
export type Session = Item<'/api/v1/sessions/live'>;
export type StaffUser = Item<'/api/v1/users'>;

/** All plans once (an ISP has tens, not thousands); shared by lists, forms and filters. */
export function usePlans() {
  const can = useCan();
  const q = useQuery({
    queryKey: ['plans', 'all'],
    queryFn: () => unwrap(api.GET('/api/v1/plans', { params: { query: { limit: 200 } } })),
    staleTime: 5 * 60_000,
    enabled: can('plans.read'),
  });
  const byId = useMemo(() => new Map((q.data?.items ?? []).map((p) => [p.id, p])), [q.data]);
  return { ...q, plans: q.data?.items ?? [], byId };
}

export function useRoles(enabled = true) {
  const q = useQuery({
    queryKey: ['roles'],
    queryFn: () => unwrap(api.GET('/api/v1/roles')),
    staleTime: 5 * 60_000,
    enabled,
  });
  const byId = useMemo(() => new Map((q.data ?? []).map((r) => [r.id, r])), [q.data]);
  return { ...q, roles: q.data ?? [], byId };
}
