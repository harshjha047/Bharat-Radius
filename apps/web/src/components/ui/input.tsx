'use client';
import { useState, type ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const fieldClass =
  'flex h-10 w-full rounded-xl border border-input bg-card px-3 py-1 text-sm text-foreground transition-colors placeholder:text-muted-foreground focus-visible:border-[1.5px] focus-visible:border-primary disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground aria-invalid:border-[1.5px] aria-invalid:border-destructive';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(fieldClass, 'file:border-0 file:bg-transparent file:text-sm', className)}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(fieldClass, 'h-auto min-h-20 py-2', className)} {...props} />;
}

/** Native select: accessible, fast, and right on phones. */
export function Select({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        fieldClass,
        "appearance-none bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%236f6573' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E\")] bg-[length:16px] bg-[position:right_12px_center] bg-no-repeat pr-9",
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return (
    <label className={cn('text-[13px] leading-none font-semibold text-foreground', className)} {...props} />
  );
}

export function Checkbox({ className, ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  return (
    <input
      type="checkbox"
      className={cn('size-4 rounded border-input accent-[#15245e]', className)}
      {...props}
    />
  );
}

/** Password field with a Show/Hide toggle. */
export function PasswordInput({ className, ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input type={show ? 'text' : 'password'} className={cn(fieldClass, 'pr-16', className)} {...props} />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        aria-pressed={show}
        className="absolute inset-y-0 right-0 rounded-r-xl px-3.5 text-sm font-bold text-primary"
      >
        {show ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}
