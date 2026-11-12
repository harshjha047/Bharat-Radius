'use client';
import { Dialog as D } from 'radix-ui';
import { X } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

/** Action bar pinned to the bottom of a dialog's scroll area, so Save/Cancel never scroll out of view. */
export const dialogActions =
  'sticky -bottom-6 z-10 -mx-6 -mb-6 mt-6 flex justify-end gap-2 border-t bg-card px-6 py-4';

export function DialogContent({
  className,
  children,
  title,
  description,
  wide,
  ...p
}: ComponentProps<typeof D.Content> & { title: ReactNode; description?: ReactNode; wide?: boolean }) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-[#24172a]/45" />
      <D.Content
        className={cn(
          'fixed inset-x-0 bottom-0 z-50 max-h-[92dvh] overflow-y-auto rounded-t-3xl border bg-card p-6 shadow-[0_16px_40px_rgba(36,23,42,0.18)] sm:inset-auto sm:top-1/2 sm:left-1/2 sm:w-full sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl',
          wide ? 'sm:max-w-2xl' : 'sm:max-w-md',
          className,
        )}
        {...(description ? {} : { 'aria-describedby': undefined })}
        {...p}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="space-y-1">
            <D.Title className="text-xl font-extrabold tracking-tight text-foreground">{title}</D.Title>
            {description ? (
              <D.Description className="text-sm text-muted-foreground">{description}</D.Description>
            ) : null}
          </div>
          <D.Close
            className="grid size-9 place-items-center rounded-[10px] text-muted-foreground hover:bg-muted"
            aria-label="Close"
          >
            <X className="size-4" />
          </D.Close>
        </div>
        {children}
      </D.Content>
    </D.Portal>
  );
}
