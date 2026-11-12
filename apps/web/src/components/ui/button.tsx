import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import { Loader2 } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold transition-colors disabled:pointer-events-none disabled:bg-muted disabled:text-muted-foreground disabled:border-transparent [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary-hover hover:text-primary-foreground',
        brand:
          'rounded-full bg-brand font-extrabold text-brand-foreground hover:bg-brand-hover hover:text-brand-foreground [&_svg]:size-[18px]',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-destructive/90 hover:text-destructive-foreground',
        'destructive-outline':
          'border border-danger-border bg-card text-danger-text hover:bg-danger-bg hover:text-danger-text',
        outline: 'border border-input bg-card text-foreground hover:bg-subtle hover:text-foreground',
        secondary: 'border border-accent-border bg-card text-primary hover:bg-accent',
        ghost: 'text-primary hover:bg-accent hover:text-primary',
        link: 'h-auto px-0 text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-4',
        sm: 'h-9 rounded-[10px] px-3 text-[13px]',
        lg: 'h-[52px] px-7 text-base',
        xl: 'h-14 w-full rounded-[14px] text-[17px]',
        icon: 'size-10',
        'icon-sm': 'size-9 rounded-[10px]',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

type Props = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean; loading?: boolean };

export function Button({ className, variant, size, asChild, loading, disabled, children, ...props }: Props) {
  const cls = cn(buttonVariants({ variant, size }), className);
  // Slot needs exactly one child element.
  if (asChild)
    return (
      <Slot.Root className={cls} {...props}>
        {children}
      </Slot.Root>
    );
  return (
    <button className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
      {loading ? <Loader2 className="animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
}
