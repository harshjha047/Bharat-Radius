import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const Card = ({ className, ...p }: ComponentProps<'div'>) => (
  <div className={cn('rounded-lg border bg-card shadow-xs', className)} {...p} />
);
export const CardHeader = ({ className, ...p }: ComponentProps<'div'>) => (
  <div className={cn('flex flex-col gap-1 p-4 pb-2 sm:p-5 sm:pb-2', className)} {...p} />
);
export const CardTitle = ({ className, ...p }: ComponentProps<'h2'>) => (
  <h2 className={cn('text-base font-semibold', className)} {...p} />
);
export const CardDescription = ({ className, ...p }: ComponentProps<'p'>) => (
  <p className={cn('text-sm text-muted-foreground', className)} {...p} />
);
export const CardContent = ({ className, ...p }: ComponentProps<'div'>) => (
  <div className={cn('p-4 pt-2 sm:p-5 sm:pt-2', className)} {...p} />
);
