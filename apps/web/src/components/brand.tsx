import { cn } from '@/lib/utils';

/** The "b" mark. Size it by height (`h-*`); width follows the 242×298 artwork. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <img
      src="/brand/mark.png"
      alt=""
      aria-hidden
      width={242}
      height={298}
      className={cn('h-[30px] w-auto shrink-0 select-none', className)}
      draggable={false}
    />
  );
}

/** Full lockup: mark, "bharat radius" and "A product of DIV Pvt. Ltd." (924×494). */
export function BrandLockup({ className }: { className?: string }) {
  return (
    <img
      src="/brand/lockup.png"
      alt="Bharat Radius, a product of DIV Pvt. Ltd."
      width={924}
      height={494}
      className={cn('h-[72px] w-auto shrink-0 select-none', className)}
      draggable={false}
    />
  );
}

/** Where every DIV credit points: the product page on the agency site (see CLAUDE.md, "DIV credit"). */
export const DIV_PRODUCT_URL = 'https://thediv.in/isp-products/bharat-radius';

/**
 * "Powered by <Div/>": the agency credit, kept on every surface. Inside the panel and portal it is
 * a tracked link (UTM) so DIV can count visits from ISP staff, resellers and customers.
 */
export function PoweredBy({
  className,
  medium = 'panel',
}: {
  className?: string;
  /** utm_medium: where the credit sits (panel, portal, login). */
  medium?: 'panel' | 'portal' | 'login';
}) {
  return (
    <a
      href={`${DIV_PRODUCT_URL}?utm_source=bharat-radius&utm_medium=${medium}&utm_campaign=powered-by`}
      target="_blank"
      rel="noopener"
      className={cn(
        'font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline',
        className,
      )}
    >
      Powered by &lt;Div/&gt;
    </a>
  );
}
