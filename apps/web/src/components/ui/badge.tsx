import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

const badge = cva(
  'inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'bg-muted text-[#5d5462]',
        primary: 'bg-accent text-accent-foreground',
        info: 'bg-info-bg text-info-text',
        success: 'bg-success-bg text-success-text',
        warning: 'bg-warning-bg text-warning-text',
        danger: 'bg-danger-bg text-danger-text',
      },
      dot: { true: 'before:size-1.5 before:shrink-0 before:rounded-full before:bg-current', false: '' },
    },
    defaultVariants: { tone: 'neutral', dot: true },
  },
);

export function Badge({ className, tone, dot, ...p }: ComponentProps<'span'> & VariantProps<typeof badge>) {
  return <span className={cn(badge({ tone, dot }), className)} {...p} />;
}

/** Square tag for codes and plan names: `R-0004`, `Home 100 Mbps`. */
export function Tag({ className, mono, ...p }: ComponentProps<'span'> & { mono?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center rounded-lg px-2 whitespace-nowrap',
        mono ? 'bg-muted font-mono text-[11px] text-body' : 'border text-xs font-semibold text-foreground',
        className,
      )}
      {...p}
    />
  );
}
