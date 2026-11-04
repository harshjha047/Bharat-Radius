'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CopyButton, Field } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';

export function TotpSetup({
  setup,
  loading,
  error,
  onSubmit,
}: {
  setup: { secret: string; otpauthUrl: string } | undefined;
  loading: boolean;
  error?: string | undefined;
  onSubmit: (e: FormEvent<HTMLFormElement>, code: string) => void;
}) {
  const [qr, setQr] = useState<string>();
  useEffect(() => {
    if (!setup) return;
    let live = true;
    // QR library only loads on this screen.
    void import('qrcode').then((q) =>
      q.toString(setup.otpauthUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then((svg) => {
        if (live) setQr(svg);
      }),
    );
    return () => {
      live = false;
    };
  }, [setup]);

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => onSubmit(e, String(new FormData(e.currentTarget).get('code')).replace(/\s/g, ''))}
    >
      <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        <li>Scan the code with your authenticator app.</li>
        <li>Enter the 6-digit code it shows.</li>
      </ol>
      <div className="mx-auto size-48 overflow-hidden rounded-md bg-white p-2">
        {qr ? (
          <div
            role="img"
            aria-label="QR code for your authenticator app"
            className="[&>svg]:size-full"
            dangerouslySetInnerHTML={{ __html: qr }}
          />
        ) : (
          <Skeleton className="size-full" />
        )}
      </div>
      {setup ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            Can&apos;t scan? Enter the key instead
          </summary>
          <div className="mt-2 flex items-center gap-2 rounded-md bg-muted px-3 py-1">
            <code className="flex-1 font-mono text-xs break-all">{setup.secret}</code>
            <CopyButton value={setup.secret} label="Copy key" />
          </div>
        </details>
      ) : null}
      <Field label="6-digit code" htmlFor="code" error={error}>
        <Input
          id="code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={7}
          required
          className="text-center font-mono text-lg tracking-[0.4em]"
        />
      </Field>
      <Button type="submit" className="w-full" loading={loading} disabled={!setup}>
        Turn on
      </Button>
    </form>
  );
}
