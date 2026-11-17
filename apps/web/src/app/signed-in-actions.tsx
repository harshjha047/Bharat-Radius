'use client';
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useSignedIn } from '@/lib/session';
import { cn } from '@/lib/utils';

/**
 * The landing page is cached HTML for everyone, so it renders the signed-out actions (Log in,
 * Book a demo). In the browser, a signed-in staff member or customer gets a single link back into
 * their panel or portal instead.
 */
export function SignedInSwap({ children, className }: { children: ReactNode; className?: string }) {
  const { optimistic } = useSignedIn();
  if (!optimistic) return <>{children}</>;
  return (
    <Link
      href={optimistic.href}
      className={cn(
        'inline-flex items-center gap-2 rounded-full bg-[#10214F] font-outfit font-medium text-white transition-colors hover:bg-[#E8760F] hover:text-white',
        className,
      )}
    >
      {optimistic.label}
      <ArrowRight aria-hidden className="size-4" />
    </Link>
  );
}
