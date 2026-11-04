import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Recharge your connection' };

/** Walled-garden landing for expired customers until online payments arrive (Step 3). */
export default function PayPage() {
  return (
    <main className="grid min-h-dvh place-items-center bg-muted/40 px-4 py-10">
      <div className="w-full max-w-sm space-y-4 rounded-xl border bg-card p-6 text-center shadow-sm">
        <h1 className="text-lg font-semibold">Your internet plan has expired</h1>
        <p className="text-sm text-muted-foreground">
          Recharge with your internet provider or their local partner to get full speed back. Your connection
          returns to full speed as soon as the recharge is recorded; you do not need to restart your router.
        </p>
        <p className="text-sm text-muted-foreground" lang="hi">
          आपका इंटरनेट प्लान समाप्त हो गया है। पूरी स्पीड वापस पाने के लिए अपने इंटरनेट प्रदाता से रिचार्ज
          कराएँ।
        </p>
      </div>
    </main>
  );
}
