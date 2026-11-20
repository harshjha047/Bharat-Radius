'use client';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Toaster } from 'sileo';
import { toast } from '@/lib/toast';
import { ApiError } from '@/lib/api';

const retry = (count: number, e: unknown) => !(e instanceof ApiError && e.status < 500) && count < 2;

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, retry, refetchOnWindowFocus: false },
          mutations: { retry: false },
        },
        // Every failed action shows the server's message unless the form handles it itself.
        mutationCache: new MutationCache({
          onError: (e, _v, _c, m) => {
            if (m.meta?.silent) return;
            toast.error(e instanceof Error ? e.message : 'Something went wrong');
          },
        }),
      }),
  );
  return (
    <QueryClientProvider client={client}>
      {children}
      <Toaster position="top-center" offset={{ top: 16 }} />
    </QueryClientProvider>
  );
}

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: { silent?: boolean };
  }
}
