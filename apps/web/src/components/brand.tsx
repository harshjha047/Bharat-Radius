import { cn } from '@/lib/utils';

/** The "b" mark. Size it by height (`h-*`); width follows the 224×290 artwork. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <img
      src="/brand/mark.png"
      alt=""
      aria-hidden
      width={224}
      height={290}
      className={cn('h-[30px] w-auto shrink-0 select-none', className)}
      draggable={false}
    />
  );
}

/** Full lockup: mark, "bharat radius" and "A product of DIV Pvt. Ltd." (900×453). */
export function BrandLockup({ className }: { className?: string }) {
  return (
    <img
      src="/brand/lockup.png"
      alt="BharatRadius, a product of DIV Pvt. Ltd."
      width={900}
      height={453}
      className={cn('h-[72px] w-auto shrink-0 select-none', className)}
      draggable={false}
    />
  );
}

export function PoweredBy({ className }: { className?: string }) {
  return (
    <span className={cn('font-mono text-[11px] text-muted-foreground', className)}>
      Powered by &lt;Div/&gt;
    </span>
  );
}
