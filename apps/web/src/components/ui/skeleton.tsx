import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const Skeleton = ({ className, ...p }: ComponentProps<'div'>) => (
  <div aria-hidden className={cn('animate-shimmer rounded-md bg-muted', className)} {...p} />
);
