import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import '@fontsource/dm-sans/latin-400.css';
import '@fontsource/dm-sans/latin-500.css';
import '@fontsource/outfit/latin-500.css';
import '@fontsource/outfit/latin-600.css';
import '@fontsource/outfit/latin-700.css';
import { BrandLockup, BrandMark, DIV_PRODUCT_URL } from '@/components/brand';
import { cn } from '@/lib/utils';

export const metadata: Metadata = {
  title: { absolute: 'BharatRadius · All-in-one digital management platform for ISPs' },
  description:
    'Subscribers, plans, partners, billing and network monitoring for ISPs, partners and enterprises. Hosted in India, DPDP compliant.',
  robots: { index: true, follow: true },
};

// Read SALES_PHONE at request time, so the number can change without a rebuild.
export const dynamic = 'force-dynamic';

function contact() {
  const phone = process.env.SALES_PHONE?.trim();
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  return {
    phone,
    tel: `tel:+${digits}`,
    whatsapp: `https://wa.me/${digits}?text=${encodeURIComponent('Hello, I would like to know more about BharatRadius.')}`,
  };
}

const NAV = [
  'Dashboard',
  'Subscribers',
  'Resellers',
  'System Settings',
  'Networking',
  'Packages',
  'User Permissions',
  'Reports',
];
const STATS = [
  { label: 'Total reseller sites', value: '4', note: 'Managed nodes', tint: 'bg-[#EAF6EC]' },
  { label: 'Active sites', value: '4', note: 'Inactive 0', tint: 'bg-[#FFF3E6]' },
  { label: 'Subscribers', value: '300', note: 'Live connections', tint: 'bg-[#E6EEFB]' },
  { label: 'Bandwidth pool', value: '10 Gbps', note: 'Core gateway', tint: 'bg-[#EDEAF9]' },
];
const ROWS = [
  ['D1', 'Demo Site One', 'Demo Networks Pvt Ltd', '90000 00001'],
  ['D2', 'Demo Site Two', 'Sample Broadband Co', '90000 00002'],
  ['D3', 'Demo Site Three', 'Example Internet Services', '90000 00003'],
  ['D4', 'Demo Site Four', 'Test Fiber Enterprises', '90000 00004'],
];
const BARS = [38, 52, 44, 61, 55, 72, 64, 80, 71, 88, 76, 94, 84, 100];
const PILLARS = [
  ['Scalable & Reliable', 'Built to grow with your business.'],
  ['Secure & Trusted', 'Enterprise-grade security at every layer.'],
  ['Future Ready', 'Innovative features for tomorrow’s needs.'],
  ['24/7 Support', 'Always here when you need us.'],
];

const link = 'text-[#10214F] hover:text-[#E8760F]';
const pill = 'rounded-full font-outfit font-medium transition-colors';
const eyebrow =
  'inline-flex items-center gap-2 rounded-full px-4 py-1.5 font-outfit text-[12.5px] font-semibold tracking-[0.1em] uppercase';
const miniHead = 'text-[9.5px] tracking-[0.09em] text-[#8A93B0] uppercase';

function Cta({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  const external = href.startsWith('http');
  return (
    <a
      href={href}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      className={cn(
        pill,
        'bg-[#E8760F] text-white shadow-[0_12px_26px_-12px_rgba(232,118,15,0.7)] hover:bg-[#10214F] hover:text-white',
        className,
      )}
    >
      {children}
    </a>
  );
}

function Feature({
  icon,
  color,
  title,
  body,
  children,
}: {
  icon: string;
  color: string;
  title: string;
  body: string;
  children: ReactNode;
}) {
  return (
    <article className="flex flex-col rounded-[18px] border border-[#ECEEF5] bg-[#F7F8FB] p-2 transition-colors hover:border-[#DDE1EC]">
      <div className="px-5 pt-[22px] pb-[18px]">
        <div className="flex items-center gap-[11px]">
          <span
            aria-hidden
            className={cn(
              'grid size-[30px] place-items-center rounded-[9px] font-outfit text-[13px] font-semibold text-white',
              color,
            )}
          >
            {icon}
          </span>
          <h3 className="font-outfit text-[18.5px] font-semibold tracking-[-0.01em] text-[#10214F]">
            {title}
          </h3>
        </div>
        <p className="mt-3 text-[15px] leading-[1.6] text-pretty text-[#4A5578]">{body}</p>
      </div>
      <div className="mt-auto grid gap-[9px] rounded-xl border border-[#ECEEF5] bg-white p-3.5" aria-hidden>
        {children}
      </div>
    </article>
  );
}

function ProductMock() {
  return (
    <div
      className="rounded-[20px] border border-white/90 bg-white/60 p-2.5 shadow-[0_40px_90px_-40px_rgba(16,33,79,0.45)] backdrop-blur-[6px]"
      role="img"
      aria-label="BharatRadius admin panel: dashboard with reseller sites, subscribers and bandwidth"
    >
      <div className="overflow-hidden rounded-[14px] border border-[#ECEEF5] bg-white" aria-hidden>
        <div className="flex items-center gap-[7px] border-b border-[#F1F3F8] px-3.5 py-[11px]">
          <span className="size-[9px] rounded-full bg-[#E8760F]" />
          <span className="size-[9px] rounded-full bg-[#F2C46B]" />
          <span className="size-[9px] rounded-full bg-[#2E9B3F]" />
        </div>
        <div className="grid min-h-[520px] bg-[#F7F8FB] text-[13px] md:grid-cols-[216px_minmax(0,1fr)]">
          <aside className="flex flex-col gap-5 border-r border-[#ECEEF5] bg-white px-3 py-4 max-md:hidden">
            <div className="flex items-center gap-2.5 px-1.5">
              <BrandMark className="h-[30px]" />
              <div className="leading-tight">
                <div className="font-outfit text-[13px] font-semibold">Bharat Radius</div>
                <div className="text-[10.5px] text-[#8A93B0]">Management Suite</div>
              </div>
            </div>
            <div className="grid gap-0.5">
              {NAV.map((label, i) => (
                <div
                  key={label}
                  className={cn(
                    'flex items-center gap-2.5 rounded-[9px] px-2.5 py-[9px] text-[12.5px]',
                    i === 0 ? 'bg-[#FFF3E6] font-semibold text-[#C4610C]' : 'text-[#4A5578]',
                  )}
                >
                  <span
                    className={cn('size-4 shrink-0 rounded-[5px]', i === 0 ? 'bg-[#E8760F]' : 'bg-[#E4E7F0]')}
                  />
                  {label}
                </div>
              ))}
            </div>
            <div className="mt-auto flex items-center gap-[7px] border-t border-[#F1F3F8] px-2.5 pt-2.5 pb-0.5 text-[10.5px] text-[#8A93B0]">
              <span className="size-1.5 rounded-full bg-[#2E9B3F]" />
              v2.1 · Clean Light UI
            </div>
          </aside>

          <div className="flex min-w-0 flex-col">
            <div className="flex items-center gap-3.5 border-b border-[#ECEEF5] bg-white px-[18px] py-3">
              <div className="grid w-4 shrink-0 gap-[3px]">
                <span className="h-0.5 rounded-sm bg-[#10214F]" />
                <span className="h-0.5 rounded-sm bg-[#10214F]" />
                <span className="h-0.5 rounded-sm bg-[#10214F]" />
              </div>
              <div className="truncate font-outfit text-sm font-semibold tracking-[-0.01em]">
                ISP Multi-Tenant Portal
              </div>
              <div className="ml-auto flex items-center gap-2.5">
                <span className="rounded-full border border-[#ECEEF5] px-3 py-1.5 text-[11.5px] whitespace-nowrap text-[#4A5578] max-sm:hidden">
                  Wallet <strong className="text-[#10214F]">₹12,480</strong>
                </span>
                <span className="flex items-center gap-2 rounded-full border border-[#ECEEF5] py-1 pr-3 pl-1">
                  <span className="grid size-6 place-items-center rounded-full bg-[#FFF3E6] font-outfit text-[11px] font-semibold text-[#C4610C]">
                    BR
                  </span>
                  <span className="text-[11.5px]">BharatRadius</span>
                </span>
              </div>
            </div>

            <div className="grid min-w-0 gap-4 px-[18px] py-5">
              <div className="flex flex-wrap items-end gap-4">
                <div>
                  <div className="font-outfit text-[19px] font-semibold tracking-[-0.015em]">
                    Client Portal Dashboard
                  </div>
                  <p className="mt-1 text-xs text-[#6C7799]">
                    Reseller branches, site network and subscriber nodes.
                  </p>
                </div>
                <span className="ml-auto inline-flex items-center gap-[7px] rounded-full bg-[#EAF6EC] px-[13px] py-1.5 text-[11.5px] font-medium text-[#1F7A2E]">
                  <span className="size-1.5 rounded-full bg-[#2E9B3F]" />
                  Portal online
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {STATS.map((s) => (
                  <div key={s.label} className="rounded-xl border border-[#ECEEF5] bg-white p-3.5">
                    <div className="flex items-center gap-2">
                      <span className={cn('size-[22px] shrink-0 rounded-[7px]', s.tint)} />
                      <span className="text-[11.5px] text-[#6C7799]">{s.label}</span>
                    </div>
                    <div className="mt-2.5 font-outfit text-[26px] font-semibold tracking-[-0.02em]">
                      {s.value}
                    </div>
                    <div className="mt-1 text-[11px] text-[#8A93B0]">{s.note}</div>
                  </div>
                ))}
              </div>

              <div className="overflow-x-auto rounded-xl border border-[#ECEEF5] bg-white">
                <div className="min-w-[520px]">
                  <div className="flex items-center gap-3 border-b border-[#F1F3F8] px-4 py-[13px]">
                    <span className="font-outfit text-[13.5px] font-semibold">Reseller site nodes</span>
                    <span className="ml-auto text-[11px] text-[#8A93B0]">4 registered sites</span>
                  </div>
                  <div
                    className={cn(
                      'grid grid-cols-[1.5fr_1.4fr_1fr_0.7fr] border-b border-[#F1F3F8] bg-[#FAFBFD] px-4 py-[9px]',
                      miniHead,
                    )}
                  >
                    <span>Site &amp; owner</span>
                    <span>Company</span>
                    <span>Contact</span>
                    <span className="text-right">Status</span>
                  </div>
                  {ROWS.map(([init, name, company, phone]) => (
                    <div
                      key={init}
                      className="grid grid-cols-[1.5fr_1.4fr_1fr_0.7fr] items-center border-b border-[#F5F6FA] px-4 py-[11px] text-xs"
                    >
                      <span className="flex min-w-0 items-center gap-[9px]">
                        <span className="grid size-6 shrink-0 place-items-center rounded-lg bg-[#F1F3F8] text-[10px] font-semibold text-[#4A5578]">
                          {init}
                        </span>
                        <span className="truncate">{name}</span>
                      </span>
                      <span className="truncate text-[#4A5578]">{company}</span>
                      <span className="text-[#6C7799]">{phone}</span>
                      <span className="text-right">
                        <span className="rounded-full bg-[#EAF6EC] px-2.5 py-[3px] text-[10.5px] text-[#1F7A2E]">
                          Active
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Landing() {
  const c = contact();
  const getInTouch = c?.whatsapp ?? '#contact';
  return (
    <div className="min-h-dvh overflow-x-hidden bg-white font-dm text-[#10214F] antialiased [font-feature-settings:normal]">
      <div className="relative bg-white">
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 h-[760px]"
          style={{
            background:
              'radial-gradient(70% 90% at 18% 6%, #FFD9A8 0%, rgba(255,217,168,0) 62%), radial-gradient(60% 80% at 82% 4%, #FFC38A 0%, rgba(255,195,138,0) 60%), radial-gradient(80% 70% at 50% -10%, #FBE3C4 0%, rgba(251,227,196,0) 70%), radial-gradient(50% 60% at 92% 34%, #BFE9C6 0%, rgba(191,233,198,0) 66%), radial-gradient(45% 55% at 6% 40%, #CFE6D3 0%, rgba(207,230,211,0) 70%), linear-gradient(180deg,#FFF6EA 0%, #FFFFFF 82%)',
          }}
        />
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 h-[760px] bg-[linear-gradient(180deg,rgba(255,255,255,0)_55%,#FFFFFF_96%)]"
        />

        <header className="relative z-20">
          <div className="mx-auto flex max-w-[1180px] items-center gap-6 px-6 py-5">
            <Link href="/" aria-label="BharatRadius home" className="shrink-0">
              <BrandLockup className="h-[42px]" />
            </Link>
            <nav
              aria-label="Sections"
              className="mx-auto flex gap-1.5 rounded-full border border-[#10214F]/[0.08] bg-white/70 p-1.5 text-[14.5px] backdrop-blur-[10px] max-md:hidden"
            >
              {(
                [
                  ['#features', 'Features'],
                  ['#platform', 'Platform'],
                  ['#trust', 'Why us'],
                ] as const
              ).map(([href, label]) => (
                <a key={href} href={href} className={cn(link, 'rounded-full px-4 py-2 hover:bg-white')}>
                  {label}
                </a>
              ))}
            </nav>
            <div className="flex shrink-0 items-center gap-2 max-md:ml-auto">
              <Link
                href="/login"
                className={cn(
                  link,
                  'rounded-full px-4 py-[11px] font-outfit text-sm font-medium max-sm:hidden',
                )}
              >
                Log in
              </Link>
              <a
                href={getInTouch}
                {...(c ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                className={cn(
                  pill,
                  'bg-[#10214F] px-[22px] py-[11px] text-sm text-white hover:bg-[#E8760F] hover:text-white',
                )}
              >
                Get in touch
              </a>
            </div>
          </div>
        </header>

        <section className="relative z-10 mx-auto max-w-[1180px] px-6 pt-14 text-center">
          <div className="inline-flex items-center gap-2.5 rounded-full border border-[#10214F]/[0.09] bg-white/80 py-1.5 pr-2 pl-1.5 text-[13.5px] text-[#3F4A70] backdrop-blur-[8px]">
            <span className="rounded-full bg-[#E8760F] px-[11px] py-1 font-outfit text-xs font-semibold tracking-[0.03em] text-white">
              All-in-One
            </span>
            <span className="pr-2">Digital Management Platform</span>
          </div>
          <h1 className="mt-[26px] font-outfit text-[clamp(38px,5.8vw,68px)] leading-[1.02] font-bold tracking-[-0.03em] text-balance text-[#10214F]">
            One Platform.
            <br />
            Infinite Possibilities.
          </h1>
          <p className="mx-auto mt-5 max-w-[26em] text-[clamp(16px,1.7vw,19px)] leading-[1.55] text-pretty text-[#4A5578]">
            Powerful features. Seamless operations. Future ready.
            <br />
            For ISPs, Partners &amp; Enterprises.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Cta href={getInTouch} className="px-7 py-3.5 text-[15.5px]">
              Get in touch
            </Cta>
            <a
              href="#features"
              className={cn(
                pill,
                'border border-[#10214F]/[0.12] bg-white/85 text-[#10214F] hover:text-[#10214F] px-7 py-3.5 text-[15.5px] hover:border-[#10214F]',
              )}
            >
              View features
            </a>
          </div>
        </section>

        <section id="platform" className="relative z-10 mx-auto max-w-[1080px] scroll-mt-6 px-6 pt-[52px]">
          <ProductMock />
        </section>
      </div>

      <section id="features" className="mx-auto max-w-[1180px] scroll-mt-6 px-6 pt-[92px] pb-10 text-center">
        <span className={cn(eyebrow, 'bg-[#FFF3E6] text-[#C4610C]')}>Features</span>
        <h2 className="mx-auto mt-5 max-w-[18em] font-outfit text-[clamp(28px,3.8vw,46px)] leading-[1.08] font-bold tracking-[-0.025em] text-balance text-[#10214F]">
          Powerful features.
          <br />
          Seamless operations.
        </h2>
        <div className="mt-12 grid grid-cols-[repeat(auto-fit,minmax(min(290px,100%),1fr))] gap-5 text-left">
          <Feature
            icon="U"
            color="bg-[#E8760F]"
            title="User Management"
            body="Create, manage & control users with role-based access and permissions."
          >
            <div className={cn('flex items-center gap-2.5', miniHead)}>
              <span>Subscriber</span>
              <span className="ml-auto">Role</span>
            </div>
            {(
              [
                ['DA', 'Demo Admin', 'Admin'],
                ['DO', 'Demo Operator', 'Operator'],
                ['DV', 'Demo Viewer', 'Viewer'],
              ] as const
            ).map(([init, name, role]) => (
              <div key={init} className="flex items-center gap-2.5 border-t border-[#F5F6FA] pt-[9px]">
                <span className="grid size-[22px] shrink-0 place-items-center rounded-[7px] bg-[#F1F3F8] text-[9.5px] font-semibold text-[#4A5578]">
                  {init}
                </span>
                <span className="truncate text-xs">{name}</span>
                <span className="ml-auto shrink-0 rounded-full bg-[#F1F3F8] px-[9px] py-[3px] text-[10px] text-[#4A5578]">
                  {role}
                </span>
              </div>
            ))}
          </Feature>

          <Feature
            icon="P"
            color="bg-[#C4610C]"
            title="Plan Management"
            body="Create, customize & manage plans, packages and offers with ease."
          >
            <div className={cn('flex items-center gap-2.5', miniHead)}>
              <span>Package</span>
              <span className="ml-auto">Speed · Price</span>
            </div>
            {(
              [
                ['Home 100', '100 / 50', '₹599'],
                ['Home 200', '200 / 100', '₹899'],
                ['Business 500', '500 / 250', '₹2,499'],
              ] as const
            ).map(([name, speed, price]) => (
              <div key={name} className="flex items-center gap-2.5 border-t border-[#F5F6FA] pt-[9px]">
                <span className="size-[22px] shrink-0 rounded-[7px] bg-[#FFF3E6]" />
                <span className="text-xs">{name}</span>
                <span className="ml-auto text-[11.5px] text-[#6C7799]">{speed}</span>
                <span className="font-outfit text-xs font-semibold">{price}</span>
              </div>
            ))}
          </Feature>

          <Feature
            icon="Pt"
            color="bg-[#2E9B3F]"
            title="Partner Management"
            body="Onboard, manage & grow your partner network effortlessly."
          >
            <div className="grid gap-[11px]">
              {(
                [
                  ['MSR #1', 'Demo Networks Pvt Ltd', 'Level 1', false],
                  ['MSR #2', 'Sample Broadband Co', 'Level 2', true],
                  ['MSR #5', 'Example Internet Services', 'Level 2', true],
                  ['MSR #7', 'Test Fiber Enterprises', 'Level 2', true],
                ] as const
              ).map(([msr, name, level, indent]) => (
                <div key={msr} className={cn('flex items-center gap-[9px]', indent && 'ml-3.5')}>
                  <span className="shrink-0 rounded-md bg-[#F1F3F8] px-[7px] py-0.5 text-[9.5px] text-[#4A5578]">
                    {msr}
                  </span>
                  <span className="truncate text-xs">{name}</span>
                  <span className="ml-auto shrink-0 rounded-full bg-[#EAF6EC] px-[9px] py-[3px] text-[10px] text-[#1F7A2E]">
                    {level}
                  </span>
                </div>
              ))}
            </div>
          </Feature>

          <Feature
            icon="A"
            color="bg-[#6B4FC8]"
            title="Advanced Authentication"
            body="Secure access with multi-factor authentication and SSO support."
          >
            <div className="grid justify-items-center gap-[13px] py-1.5">
              <span className="text-[11.5px] text-[#6C7799]">Verification code</span>
              <div className="flex gap-[7px]">
                {['4', '1', '7', '2', '', ''].map((d, i) => (
                  <span
                    key={i}
                    className={cn(
                      'grid h-9 w-[30px] place-items-center rounded-lg border border-[#E4E7F0] font-outfit text-[15px] font-semibold',
                      i === 3 && 'border-[1.5px] border-[#6B4FC8] text-[#6B4FC8]',
                    )}
                  >
                    {d}
                  </span>
                ))}
              </div>
              <span className="rounded-full bg-[#EAF6EC] px-3 py-1 text-[11px] text-[#1F7A2E]">
                SSO enabled · Google Workspace
              </span>
            </div>
          </Feature>

          <Feature
            icon="N"
            color="bg-[#1F5FBF]"
            title="Network Monitoring"
            body="Real-time network visibility, alerts, and performance analytics."
          >
            <div className="flex items-baseline gap-2">
              <span className="font-outfit text-[17px] font-semibold">6.4 Gbps</span>
              <span className="text-[10.5px] text-[#8A93B0]">of 10 Gbps pool</span>
              <span className="ml-auto inline-flex items-center gap-1.5 text-[10.5px] text-[#1F7A2E]">
                <span className="size-1.5 rounded-full bg-[#2E9B3F]" />
                Live
              </span>
            </div>
            <div className="mt-1 flex h-16 items-end gap-[5px]">
              {BARS.map((h, i) => (
                <span
                  key={i}
                  className={cn(
                    'flex-1 rounded-t-[3px]',
                    i >= BARS.length - 3 ? 'bg-[#1F5FBF]' : 'bg-[#DCE6F7]',
                  )}
                  style={{ height: `${h}%` }}
                />
              ))}
            </div>
          </Feature>

          <Feature
            icon="D"
            color="bg-[#0F8FA0]"
            title="DPDP Compliant"
            body="Built with data privacy by design and fully DPDP Act compliant."
          >
            <div className="grid gap-3 py-0.5">
              {[
                'Data hosted in India',
                'Consent & purpose logging',
                'Encrypted at rest and in transit',
                'Audit trail on every record',
              ].map((t) => (
                <div key={t} className="flex items-center gap-2.5 text-xs">
                  <span className="grid size-[17px] shrink-0 place-items-center rounded-full bg-[#E6F4F6] text-[10px] text-[#0F8FA0]">
                    ✓
                  </span>
                  {t}
                </div>
              ))}
            </div>
          </Feature>
        </div>
      </section>

      <section id="trust" className="mx-auto max-w-[1180px] scroll-mt-6 px-6 pt-[60px] pb-24">
        <div className="relative overflow-hidden rounded-[26px] bg-[#10214F] p-[clamp(30px,4.5vw,60px)] text-white">
          <div
            aria-hidden
            className="absolute inset-0"
            style={{
              background:
                'radial-gradient(60% 80% at 88% 8%, rgba(232,118,15,0.4) 0%, rgba(232,118,15,0) 62%), radial-gradient(55% 70% at 6% 96%, rgba(46,155,63,0.38) 0%, rgba(46,155,63,0) 66%)',
            }}
          />
          <div className="relative text-center">
            <span className={cn(eyebrow, 'border border-white/20 bg-white/[0.12] text-[#FFE0BC]')}>
              Sovereign Cloud
            </span>
            <h2 className="mx-auto mt-[22px] max-w-[22em] font-outfit text-[clamp(27px,3.6vw,44px)] leading-[1.06] font-bold tracking-[-0.025em] text-balance text-white">
              Hosted on Indian infrastructure for complete data sovereignty.
            </h2>
          </div>
          <div className="relative mt-11 grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3.5">
            {PILLARS.map(([title, body]) => (
              <div key={title} className="rounded-2xl border border-white/15 bg-white/[0.07] p-[22px]">
                <h3 className="mb-2 font-outfit text-[17px] font-semibold text-[#FFB562]">{title}</h3>
                <p className="text-[14.5px] leading-[1.6] text-pretty text-[#D7DCEE]">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="contact" className="mx-auto max-w-[1180px] scroll-mt-6 px-6 pb-24 text-center">
        <h2 className="mx-auto max-w-[20em] font-outfit text-[clamp(30px,4.4vw,54px)] leading-[1.04] font-bold tracking-[-0.03em] text-balance text-[#10214F]">
          One Platform.
          <br />
          Infinite Possibilities.
        </h2>
        <p className="mx-auto mt-[18px] max-w-[28em] text-[17px] leading-[1.6] text-[#4A5578]">
          All-in-One Digital Management Platform for ISPs, Partners &amp; Enterprises
        </p>
        {c ? (
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            <Cta href={c.whatsapp} className="px-8 py-[15px] text-base">
              Chat on WhatsApp
            </Cta>
            <a
              href={c.tel}
              className={cn(
                pill,
                'border border-[#10214F]/[0.12] bg-white text-[#10214F] hover:text-[#10214F] px-8 py-[15px] text-base hover:border-[#10214F]',
              )}
            >
              Call {c.phone}
            </a>
          </div>
        ) : (
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/login"
              className={cn(
                pill,
                'bg-[#E8760F] px-8 py-[15px] text-base text-white hover:bg-[#10214F] hover:text-white',
              )}
            >
              Log in
            </Link>
          </div>
        )}
      </section>

      <footer className="border-t border-[#ECEEF5]">
        <div className="mx-auto flex max-w-[1180px] flex-wrap items-center gap-x-10 gap-y-5 px-6 py-10">
          <BrandLockup className="h-[50px]" />
          <p className="max-w-[26em] text-[14.5px] leading-[1.6] text-[#5B658A]">
            All-in-One Digital Management Platform for ISPs, Partners &amp; Enterprises
          </p>
          <div className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-[#8A93B0]">
            <Link href="/login" className={link}>
              Staff login
            </Link>
            <Link href="/portal/login" className={link}>
              Customer login
            </Link>
            <a href={DIV_PRODUCT_URL} className={link}>
              Bharat Radius by DIV
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
