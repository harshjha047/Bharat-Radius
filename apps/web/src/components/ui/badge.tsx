import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

const badge = cva(
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'bg-muted text-foreground/80',
        primary: 'bg-accent text-accent-foreground',
        success: 'bg-success/15 text-success-text',
        warning: 'bg-warning/20 text-foreground',
        danger: 'bg-destructive/12 text-danger-text',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export function Badge({ className, tone, ...p }: ComponentProps<'span'> & VariantProps<typeof badge>) {
  return <span className={cn(badge({ tone }), className)} {...p} />;
}
