import type { Metadata } from 'next';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';

export const metadata: Metadata = { title: 'Recharge your connection' };

/** Walled-garden landing for expired customers. Online recharge goes through the portal (OTP pay page: WP 4.2). */
export default function PayPage() {
  return (
    <main className="grid min-h-dvh place-items-center bg-subtle px-4 py-10">
      <div className="w-full max-w-sm space-y-4 rounded-xl border bg-card p-6 text-center shadow-sm">
        <h1 className="text-lg font-semibold">Your internet plan has expired</h1>
        <p className="text-sm text-muted-foreground">
          Recharge online, or with your internet provider or their local partner. Your connection returns to
          full speed as soon as the recharge is recorded; you do not need to restart your router.
        </p>
        <Link href="/portal/login" className={buttonVariants({ size: 'lg', className: 'w-full' })}>
          Recharge online
        </Link>
        <p className="text-xs text-muted-foreground">
          Sign in with the username and password of your internet connection.
        </p>
        <p className="text-sm text-muted-foreground" lang="hi">
          आपका इंटरनेट प्लान समाप्त हो गया है। पूरी स्पीड वापस पाने के लिए अपने इंटरनेट प्रदाता से रिचार्ज
          कराएँ।
        </p>
      </div>
    </main>
  );
}
