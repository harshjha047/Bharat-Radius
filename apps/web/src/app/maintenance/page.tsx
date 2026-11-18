import type { Metadata } from 'next';
import { PoweredBy } from '@/components/brand';

export const metadata: Metadata = { title: 'Scheduled maintenance', robots: { index: false, follow: true } };

export default function MaintenancePage() {
  return (
    <main className="grid min-h-dvh place-items-center bg-subtle px-4 py-10">
      <div className="w-full max-w-sm space-y-4 rounded-xl border bg-card p-6 text-center shadow-sm">
        <h1 className="text-lg font-semibold">Scheduled maintenance</h1>
        <p className="text-sm text-muted-foreground">
          We are doing some scheduled maintenance. Please check back in a few minutes. Your internet
          connection is not affected.
        </p>
        <p className="text-sm text-muted-foreground" lang="hi">
          नियमित रखरखाव चल रहा है। कृपया कुछ मिनट बाद फिर देखें। आपका इंटरनेट कनेक्शन चालू है।
        </p>
        <PoweredBy medium="login" className="justify-center" />
      </div>
    </main>
  );
}
