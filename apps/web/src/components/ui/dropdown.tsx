'use client';
import { DropdownMenu as M } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const Menu = M.Root;
export const MenuTrigger = M.Trigger;
export const MenuSeparator = () => <M.Separator className="-mx-1 my-1 h-px bg-border" />;
export const MenuLabel = ({ className, ...p }: ComponentProps<typeof M.Label>) => (
  <M.Label className={cn('px-2 py-1.5 text-xs text-muted-foreground', className)} {...p} />
);

export function MenuContent({ className, ...p }: ComponentProps<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content
        sideOffset={4}
        align="end"
        className={cn('z-50 min-w-44 rounded-md border bg-card p-1 shadow-md', className)}
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
        'flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted [&_svg]:size-4',
        destructive && 'text-danger-text',
        className,
      )}
      {...p}
    />
  );
}
