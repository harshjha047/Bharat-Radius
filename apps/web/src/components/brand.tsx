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
const divHref = (medium: string) =>
  `${DIV_PRODUCT_URL}?utm_source=bharat-radius&utm_medium=${medium}&utm_campaign=powered-by`;

/** Sidebar credit: "Powered by DIV · thediv.in", DIV in the brand gradient. Same tracked link as PoweredBy. */
export function PoweredByDiv({ className }: { className?: string }) {
  return (
    <a
      href={divHref('panel')}
      target="_blank"
      rel="noopener"
      className={cn(
        'relative flex items-center gap-1.5 rounded-md px-3 py-1 text-[11.5px] text-[#6B6772] transition-colors duration-200 hover:bg-[#F4F2EF] motion-reduce:transition-none',
        className,
      )}
    >
      <span>Powered by</span>
      <span className="bg-[linear-gradient(90deg,#EC4899_0%,#F97316_55%,#FBBF24_100%)] bg-clip-text font-extrabold tracking-[0.04em] text-transparent">
        DIV
      </span>
      <span className="text-[#8B8792]">· thediv.in</span>
    </a>
  );
}

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
      href={divHref(medium)}
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
