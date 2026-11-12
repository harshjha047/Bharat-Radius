'use client';
import { DropdownMenu as M } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const Menu = M.Root;
export const MenuTrigger = M.Trigger;
export const MenuSeparator = () => <M.Separator className="-mx-1 my-1 h-px bg-border" />;
export const MenuLabel = ({ className, ...p }: ComponentProps<typeof M.Label>) => (
  <M.Label className={cn('px-2.5 py-1.5 text-xs text-muted-foreground', className)} {...p} />
);

export function MenuContent({ className, ...p }: ComponentProps<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content
        sideOffset={4}
        align="end"
        className={cn(
          'z-50 min-w-48 rounded-xl border bg-card p-1.5 shadow-[0_6px_16px_rgba(36,23,42,0.10)]',
          className,
        )}
        {...p}
      />
    </M.Portal>
  );
}

export function MenuItem({
  className,
  destructive,
  ...p
}: ComponentProps<typeof M.Item> & { destructive?: boolean }) {
  return (
    <M.Item
      className={cn(
        'flex h-9 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-sm text-foreground outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent [&_svg]:size-4 [&_svg]:text-muted-foreground',
        destructive && 'text-danger-text [&_svg]:text-danger-text',
        className,
      )}
      {...p}
    />
  );
}
