'use client';
import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api, unwrap, type ApiData, type paths } from './api';

export type Me = ApiData<'/api/v1/auth/me'>;
export type Permission = NonNullable<
  paths['/api/v1/roles']['post']['requestBody']
>['content']['application/json']['permissions'][number];

export const ME_KEY = ['me'] as const;

export function useMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: () => unwrap(api.GET('/api/v1/auth/me')),
    staleTime: 60_000,
    retry: false,
  });
}

export function useCan() {
  const { data } = useMe();
  return useCallback((p: Permission) => data?.permissions.includes(p) ?? false, [data]);
}
