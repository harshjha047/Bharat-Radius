'use client';
import { Tabs as T } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const Tabs = T.Root;
export const TabsList = ({ className, ...p }: ComponentProps<typeof T.List>) => (
  <T.List className={cn('flex gap-1 overflow-x-auto border-b', className)} {...p} />
);
export const TabsTrigger = ({ className, ...p }: ComponentProps<typeof T.Trigger>) => (
  <T.Trigger
    className={cn(
      'h-10 px-3 text-sm font-medium whitespace-nowrap text-body hover:text-foreground data-[state=active]:font-bold data-[state=active]:text-primary data-[state=active]:shadow-[inset_0_-2px_0_var(--primary)]',
      className,
    )}
    {...p}
  />
);
export const TabsContent = ({ className, ...p }: ComponentProps<typeof T.Content>) => (
  <T.Content className={cn('pt-4', className)} {...p} />
);

/** Segmented control: switches views of one list. */
export const SegmentedList = ({ className, ...p }: ComponentProps<typeof T.List>) => (
  <T.List
    className={cn('inline-flex gap-0.5 self-start overflow-x-auto rounded-xl bg-muted p-1', className)}
    {...p}
  />
);
export const SegmentedTrigger = ({ className, ...p }: ComponentProps<typeof T.Trigger>) => (
  <T.Trigger
    className={cn(
      'h-8 rounded-[9px] px-3.5 text-[13px] font-medium whitespace-nowrap text-body data-[state=active]:bg-card data-[state=active]:font-bold data-[state=active]:text-foreground data-[state=active]:shadow-[0_1px_2px_rgba(36,23,42,0.08)]',
      className,
    )}
    {...p}
  />
);
