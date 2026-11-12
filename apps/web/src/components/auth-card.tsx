import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { BrandLockup, PoweredBy } from '@/components/brand';

const COPY = {
  staff: {
    headline: 'Run your network, billing and partners from one panel.',
    points: ['See who is online right now', 'Recharge and bill in seconds', 'Every change is audited'],
  },
  customer: {
    headline: 'Your internet, your bills, your help — in one place.',
    points: [
      'Recharge in two taps with UPI',
      'See how much data you used',
      'Report a problem and track the reply',
    ],
  },
} as const;

export function AuthCard({
  title,
  description,
  children,
  audience = 'staff',
  footer,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  audience?: keyof typeof COPY;
  footer?: ReactNode;
}) {
  const c = COPY[audience];
  return (
    <main className="flex min-h-dvh flex-wrap bg-background">
      <section className="flex flex-[1_1_420px] flex-col gap-7 bg-primary p-8 text-white max-md:hidden lg:p-14">
        <span className="self-start rounded-2xl bg-white px-[18px] py-3.5">
          <BrandLockup className="block h-[72px]" />
        </span>
        <h1 className="mt-auto max-w-[480px] text-[44px] leading-[1.1] font-extrabold tracking-[-0.04em] text-white">
          {c.headline}
        </h1>
        <ul className="flex flex-col gap-3 text-base text-[#dce3f7]">
          {c.points.map((p) => (
            <li key={p} className="flex items-center gap-2.5">
              <Check className="size-[18px] text-[#f7a23b]" strokeWidth={2.4} aria-hidden />
              {p}
            </li>
          ))}
        </ul>
        <PoweredBy medium="login" className="text-[#c9d2f2] hover:text-white" />
      </section>
      <section className="flex flex-[1_1_420px] items-center justify-center px-6 py-14">
        <div className="flex w-full max-w-[400px] flex-col gap-6">
          <BrandLockup className="h-auto w-[210px] self-center md:hidden" />
          <div className="space-y-1.5">
            <h2 className="text-[30px] font-extrabold tracking-[-0.03em]">{title}</h2>
            {description ? <p className="text-base text-body">{description}</p> : null}
          </div>
          {children}
          {footer}
        </div>
      </section>
    </main>
  );
}

export function FormError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-xl bg-danger-bg px-3.5 py-2.5 text-sm font-semibold text-danger-text">
      {children}
    </p>
  );
}
