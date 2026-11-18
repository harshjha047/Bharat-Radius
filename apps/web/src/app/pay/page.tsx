import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PayFlow } from './pay-flow';

export const metadata: Metadata = {
  title: 'Recharge your connection',
  robots: { index: false, follow: true },
};

/** Walled-garden landing for expired customers (router :8089 → /api/v1/pay/entry → here with ?t=). */
export default function PayPage() {
  return (
    <main className="grid min-h-dvh place-items-center bg-subtle px-4 py-10">
      <div className="w-full max-w-sm space-y-4 rounded-xl border bg-card p-6 shadow-sm">
        <Suspense fallback={null}>
          <PayFlow />
        </Suspense>
      </div>
    </main>
  );
}
