import { cn } from '@/lib/utils';

/** Brand mark. Swap the tile for the logo image once it is in /public. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative grid size-[30px] shrink-0 place-items-center rounded-[9px] bg-primary text-[11px] font-extrabold tracking-tight text-white',
        className,
      )}
    >
      BR
      <span className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-card bg-brand" />
    </span>
  );
}

export function PoweredBy({ className }: { className?: string }) {
  return (
    <span className={cn('font-mono text-[11px] text-muted-foreground', className)}>
      Powered by &lt;Div/&gt;
    </span>
  );
}
