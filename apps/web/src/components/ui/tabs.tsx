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
      '-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium whitespace-nowrap text-muted-foreground hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground',
      className,
    )}
    {...p}
  />
);
export const TabsContent = ({ className, ...p }: ComponentProps<typeof T.Content>) => (
  <T.Content className={cn('pt-4', className)} {...p} />
);
