import {
  Activity,
  BarChart3,
  Building2,
  Gauge,
  Headset,
  IndianRupee,
  KeyRound,
  MapPin,
  Network,
  Package,
  Radio,
  ReceiptText,
  Router,
  ScrollText,
  Server,
  Users,
  Wifi,
  type LucideIcon,
} from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import '@fontsource/dm-sans/latin-400.css';
import '@fontsource/dm-sans/latin-500.css';
import '@fontsource/outfit/latin-500.css';
import '@fontsource/outfit/latin-600.css';
import '@fontsource/outfit/latin-700.css';
import { BrandLockup, BrandMark, DIV_PRODUCT_URL } from '@/components/brand';
import {
  DIV,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_TITLE,
  SUBSCRIBER_BANDS,
  canonicalOrigin,
  demoUrl,
  salesContact,
} from '@/lib/site';
import { cn } from '@/lib/utils';
import { ContactForm } from './contact-form';
import { SignedInSwap } from './signed-in-actions';

export function generateMetadata(): Metadata {
  const origin = canonicalOrigin();
  return {
    metadataBase: new URL(origin),
    title: { absolute: SITE_TITLE },
    description: SITE_DESCRIPTION,
    // Every ISP install serves this page; all copies point at the official site (see lib/site.ts).
    alternates: { canonical: '/' },
    robots: { index: true, follow: true },
    openGraph: {
      type: 'website',
      siteName: SITE_NAME,
      locale: 'en_IN',
      url: '/',
      title: SITE_TITLE,
      description: SITE_DESCRIPTION,
    },
    twitter: { card: 'summary_large_image', title: SITE_TITLE, description: SITE_DESCRIPTION },
  };
}

// Cached for 5 minutes instead of rendered on every hit; SALES_PHONE and CANONICAL_ORIGIN are
// re-read on each regeneration, so changing them needs no rebuild.
export const revalidate = 300;

// Same icons as the real panel sidebar (components/shell.tsx).
const NAV: Array<[string, LucideIcon]> = [
  ['Dashboard', Gauge],
  ['Subscribers', Users],
  ['Resellers', Network],
  ['Plans & FUP', Package],
  ['Invoices', ReceiptText],
  ['Routers', Router],
  ['Online now', Radio],
  ['Reports', BarChart3],
];
const STATS = [
  {
    label: 'Reseller / LCO sites',
    value: '4',
    note: 'Wallet-based',
    icon: Network,
    tint: 'bg-[#EAF6EC] text-[#2E9B3F]',
  },
  {
    label: 'Online sessions',
    value: '1,184',
    note: 'PPPoE, live',
    icon: Radio,
    tint: 'bg-[#FFF3E6] text-[#E8760F]',
  },
  {
    label: 'Subscribers',
    value: '1,312',
    note: '42 expiring this week',
    icon: Users,
    tint: 'bg-[#E6EEFB] text-[#1F5FBF]',
  },
  {
    label: 'Collected this month',
    value: '₹7.9L',
    note: 'Razorpay + cash',
    icon: IndianRupee,
    tint: 'bg-[#EDEAF9] text-[#6B4FC8]',
  },
];
const ROWS = [
  ['LN', 'Laxmi Nagar LCO', 'Franchise · Level 1', '98xxx xxx01'],
  ['S6', 'Sector 62 Partner', 'Reseller · Level 2', '98xxx xxx02'],
  ['KR', 'Karol Bagh Node', 'Reseller · Level 2', '98xxx xxx03'],
  ['DW', 'Dwarka Fiber Point', 'Franchise · Level 1', '98xxx xxx04'],
];
const BARS = [38, 52, 44, 61, 55, 72, 64, 80, 71, 88, 76, 94, 84, 100];

const TRUST: Array<[string, string, LucideIcon]> = [
  ['Custom Radius engine', 'Built in-house, PostgreSQL-backed', Server],
  ['Tested at 100,000 subscribers', 'Search in under 1 s on a 4-vCPU server', Gauge],
  ['Hosted in India', 'Data stays on Indian servers', MapPin],
  ['Built and supported by DIV', 'One team for hosting, setup and help', Headset],
];

const PROBLEMS = [
  [
    'Manual billing and missed renewals',
    'Prepaid validity and postpaid invoices run on their own. Customers get payment links and pay online; expiry and suspension happen on time.',
  ],
  [
    'Revenue leakage',
    'Expired subscribers drop to a low speed and are redirected to a payment page instead of browsing for free.',
  ],
  [
    'Reseller and LCO chaos',
    'Each partner gets a login, a prepaid wallet and their own rates. You see every recharge and every rupee.',
  ],
  [
    'DoT and CERT-In log requests',
    'Session, login and NAT logs are archived in India, sealed daily and searchable by IP and time when a request comes in.',
  ],
] as const;

const MORE = [
  [
    'Customer self-care portal',
    'Customers sign in with their PPPoE username to see usage, download bills, recharge and raise tickets.',
  ],
  [
    'Support tickets',
    'Complaints from the portal or staff, with priorities, assignment and status from open to closed.',
  ],
  [
    'Excel bulk import',
    'Move subscribers and plans from other Radius software or spreadsheets in one upload, checked row by row.',
  ],
  [
    'Staff roles and 2FA',
    'Role-based permissions for staff and resellers, TOTP two-factor sign-in and a full audit trail.',
  ],
  ['Multi-tenant', 'Run several ISP brands or franchises from one installation, each on its own domain.'],
  [
    'REST API',
    'The API behind the panel is documented as an OpenAPI spec, so you can connect your own tools.',
  ],
] as const;

const INTEGRATIONS = [
  ['MikroTik RouterOS', 'PPPoE, CoA, NAT logging; setup script included'],
  ['Other NAS vendors', 'Standard Radius protocol support (ask us)'],
  ['Razorpay', 'Payment links, auto-settlement by webhook'],
  ['Cashfree', 'Payment links and sandbox for testing'],
  ['SMS (DLT templates)', 'Expiry and payment reminders'],
  ['Grafana & Prometheus', 'Server, Radius and log-archive alerts'],
] as const;

type Cell = string | true | false;
const COMPARE: Array<[string, Cell, Cell, Cell]> = [
  ['Radius authentication (PPPoE)', 'Custom engine', true, false],
  ['Modern web panel, mobile-friendly', true, 'Dated PHP UI', false],
  ['Prepaid + postpaid billing', true, 'Basic', 'Manual'],
  ['GST invoices (CGST/SGST/IGST) + GSTR-1 export', true, false, 'Manual'],
  ['Online payment links (Razorpay, Cashfree)', true, false, false],
  ['Reseller / LCO wallets and rates', true, 'Limited', 'Manual'],
  ['Customer portal (usage, bills, recharge, tickets)', true, false, false],
  ['Live plan change without reconnect (CoA)', true, 'DIY', false],
  ['DoT / CERT-In log archive (sessions + NAT)', true, 'DIY', false],
  ['Hosting, updates and support', 'DIV', 'Self-managed', 'Self-managed'],
];

const FAQ = [
  [
    'What is Bharat Radius?',
    'Bharat Radius is Radius and billing software for Indian broadband ISPs. It authenticates PPPoE subscribers through our own custom Radius engine, runs prepaid and postpaid billing with GST invoices, manages resellers and LCOs with wallets, and keeps the session and NAT logs DoT asks for. DIV builds, hosts and supports it.',
  ],
  [
    'Does Bharat Radius work with MikroTik?',
    'Yes. MikroTik RouterOS is the main supported NAS. A setup script configures PPPoE authentication, accounting, change of authorization (CoA) for live plan changes and NAT logging. Other NAS that speak standard Radius can work too; tell us your hardware in the demo.',
  ],
  [
    'Is it an alternative to other Radius software?',
    'Yes. It runs on our own custom Radius engine, built and tuned for Indian ISPs. On top it adds what ISPs need day to day: GST billing, online payments, reseller wallets, a customer portal, support tickets and a compliance log archive, in a modern panel.',
  ],
  [
    'Can I migrate from other Radius software or Excel?',
    'Yes. Subscribers and plans can be imported from Excel in bulk. A dry run checks every row before anything is saved, so you see and fix errors first. We plan the migration with you in the demo.',
  ],
  [
    'Does it generate GST invoices?',
    'Yes. Invoices are numbered per financial year, apply CGST + SGST or IGST based on the customer’s state, and can be downloaded as PDF. A GSTR-1 export is built in for your accountant.',
  ],
  [
    'Does it keep the logs DoT and CERT-In require?',
    'Radius sessions are never deleted, login attempts are kept for about three years, and NAT translations from your routers are archived on Indian servers. Each day’s files are sealed with SHA-256 so tampering is detectable. Retention settings are your choice; take legal advice for your licence.',
  ],
  [
    'Can resellers and LCOs have their own logins?',
    'Yes. Each reseller or LCO gets a login, a prepaid wallet and their own plan rates. They can add and recharge only their own subscribers, and every action is in the audit log.',
  ],
  [
    'How many subscribers can Bharat Radius handle?',
    'It has been tested with over 100,000 subscribers on a single 4-vCPU server: searching by username, customer number or phone answers in milliseconds.',
  ],
  [
    'Where is my data hosted?',
    'On servers in India. Data is encrypted in transit, sensitive fields are encrypted at rest, and backups are encrypted. Each ISP runs on its own domain.',
  ],
  [
    'How is Bharat Radius priced?',
    'Pricing depends on the number of subscribers you manage. Hosting, updates and support from DIV are included. Book a demo with your subscriber count and we will send a quote.',
  ],
] as const;

const link = 'text-[#10214F] hover:text-[#E8760F]';
const pill = 'rounded-full font-outfit font-medium transition-colors';
const eyebrow =
  'inline-flex items-center gap-2 rounded-full px-4 py-1.5 font-outfit text-[12.5px] font-semibold tracking-[0.1em] uppercase';
const miniHead = 'text-[9.5px] tracking-[0.09em] text-[#8A93B0] uppercase';
const h2 =
  'mx-auto mt-5 max-w-[20em] font-outfit text-[clamp(28px,3.8vw,46px)] leading-[1.08] font-bold tracking-[-0.025em] text-balance text-[#10214F]';
const lead = 'mx-auto mt-4 max-w-[38em] text-[17px] leading-[1.6] text-pretty text-[#4A5578]';

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

function Ghost({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  const external = href.startsWith('http');
  return (
    <a
      href={href}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      className={cn(
        pill,
        'border border-[#10214F]/[0.12] bg-white/85 text-[#10214F] hover:border-[#10214F] hover:text-[#10214F]',
        className,
      )}
    >
      {children}
    </a>
  );
}

function Feature({
  icon: Icon,
  color,
  title,
  body,
  points,
  children,
}: {
  icon: LucideIcon;
  color: string;
  title: string;
  body: string;
  points: readonly string[];
  children: ReactNode;
}) {
  return (
    <article className="flex flex-col rounded-[18px] border border-[#ECEEF5] bg-[#F7F8FB] p-2 transition-colors hover:border-[#DDE1EC]">
      <div className="px-5 pt-[22px] pb-[18px]">
        <div className="flex items-center gap-[11px]">
          <span
            aria-hidden
            className={cn('grid size-[30px] shrink-0 place-items-center rounded-[9px] text-white', color)}
          >
            <Icon strokeWidth={2.2} className="size-4" />
          </span>
          <h3 className="font-outfit text-[18.5px] font-semibold tracking-[-0.01em] text-[#10214F]">
            {title}
          </h3>
        </div>
        <p className="mt-3 text-[15px] leading-[1.6] text-pretty text-[#4A5578]">{body}</p>
        <ul className="mt-3 grid gap-1.5 text-[14px] leading-[1.5] text-[#3F4A70]">
          {points.map((p) => (
            <li key={p} className="flex gap-2">
              <span aria-hidden className="mt-[7px] size-1.5 shrink-0 rounded-full bg-[#E8760F]" />
              {p}
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-auto grid gap-[9px] rounded-xl border border-[#ECEEF5] bg-white p-3.5" aria-hidden>
        {children}
      </div>
    </article>
  );
}

function Mark({ value }: { value: Cell }) {
  if (value === true)
    return (
      <span className="inline-grid size-6 place-items-center rounded-full bg-[#EAF6EC] text-[13px] text-[#1F7A2E]">
        ✓<span className="sr-only">Yes</span>
      </span>
    );
  if (value === false)
    return (
      <span className="inline-grid size-6 place-items-center rounded-full bg-[#F1F3F8] text-[13px] text-[#8A93B0]">
        –<span className="sr-only">No</span>
      </span>
    );
  return <span className="text-[13.5px] text-[#4A5578]">{value}</span>;
}

function ProductMock() {
  return (
    <div
      className="rounded-[20px] border border-white/90 bg-white/60 p-2.5 shadow-[0_40px_90px_-40px_rgba(16,33,79,0.45)] backdrop-blur-[6px]"
      role="img"
      aria-label="Bharat Radius ISP admin panel: dashboard with online PPPoE sessions, subscribers, collections and reseller sites"
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
                <div className="text-[10.5px] text-[#8A93B0]">ISP Management Suite</div>
              </div>
            </div>
            <div className="grid gap-0.5">
              {NAV.map(([label, Icon], i) => (
                <div
                  key={label}
                  className={cn(
                    'flex items-center gap-2.5 rounded-[9px] px-2.5 py-[9px] text-[12.5px]',
                    i === 0 ? 'bg-[#FFF3E6] font-semibold text-[#C4610C]' : 'text-[#4A5578]',
                  )}
                >
                  <Icon
                    aria-hidden
                    className={cn('size-4 shrink-0', i === 0 ? 'text-[#E8760F]' : 'text-[#8A93B0]')}
                  />
                  {label}
                </div>
              ))}
            </div>
            <div className="mt-auto flex items-center gap-[7px] border-t border-[#F1F3F8] px-2.5 pt-2.5 pb-0.5 text-[10.5px] text-[#8A93B0]">
              <span className="size-1.5 rounded-full bg-[#2E9B3F]" />
              Radius online
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
                Your ISP · Admin
              </div>
              <div className="ml-auto flex items-center gap-2.5">
                <span className="rounded-full border border-[#ECEEF5] px-3 py-1.5 text-[11.5px] whitespace-nowrap text-[#4A5578] max-sm:hidden">
                  Wallets <strong className="text-[#10214F]">₹12,480</strong>
                </span>
                <span className="flex items-center gap-2 rounded-full border border-[#ECEEF5] py-1 pr-3 pl-1">
                  <span className="grid size-6 place-items-center rounded-full bg-[#FFF3E6] font-outfit text-[11px] font-semibold text-[#C4610C]">
                    BR
                  </span>
                  <span className="text-[11.5px]">Admin</span>
                </span>
              </div>
            </div>

            <div className="grid min-w-0 gap-4 px-[18px] py-5">
              <div className="flex flex-wrap items-end gap-4">
                <div>
                  <div className="font-outfit text-[19px] font-semibold tracking-[-0.015em]">Dashboard</div>
                  <p className="mt-1 text-xs text-[#6C7799]">
                    Sessions, subscribers, collections and partners.
                  </p>
                </div>
                <span className="ml-auto inline-flex items-center gap-[7px] rounded-full bg-[#EAF6EC] px-[13px] py-1.5 text-[11.5px] font-medium text-[#1F7A2E]">
                  <span className="size-1.5 rounded-full bg-[#2E9B3F]" />
                  All routers up
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {STATS.map((s) => (
                  <div key={s.label} className="rounded-xl border border-[#ECEEF5] bg-white p-3.5">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn('grid size-[22px] shrink-0 place-items-center rounded-[7px]', s.tint)}
                      >
                        <s.icon aria-hidden strokeWidth={2.2} className="size-3.5" />
                      </span>
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
                    <span className="font-outfit text-[13.5px] font-semibold">Resellers &amp; LCOs</span>
                    <span className="ml-auto text-[11px] text-[#8A93B0]">4 partners</span>
                  </div>
                  <div
                    className={cn(
                      'grid grid-cols-[1.5fr_1.4fr_1fr_0.7fr] border-b border-[#F1F3F8] bg-[#FAFBFD] px-4 py-[9px]',
                      miniHead,
                    )}
                  >
                    <span>Partner</span>
                    <span>Type</span>
                    <span>Contact</span>
                    <span className="text-right">Status</span>
                  </div>
                  {ROWS.map(([init, name, type, phone]) => (
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
                      <span className="truncate text-[#4A5578]">{type}</span>
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

function jsonLd() {
  const origin = canonicalOrigin();
  const org = {
    '@type': 'Organization',
    '@id': `${DIV.url}/#organization`,
    name: 'DIV Pvt. Ltd.',
    legalName: 'Development Innovation Vector Pvt. Ltd.',
    url: DIV.url,
  };
  return {
    '@context': 'https://schema.org',
    '@graph': [
      org,
      {
        '@type': 'SoftwareApplication',
        '@id': `${origin}/#software`,
        name: 'Bharat Radius',
        alternateName: 'Bharat Radius',
        url: `${origin}/`,
        description: SITE_DESCRIPTION,
        applicationCategory: 'BusinessApplication',
        applicationSubCategory: 'ISP billing and Radius management',
        operatingSystem: 'Web',
        inLanguage: 'en-IN',
        areaServed: { '@type': 'Country', name: 'India' },
        featureList: [
          'PPPoE Radius authentication on a custom Radius engine',
          'Prepaid and postpaid billing with GST invoices',
          'FUP and bandwidth plans',
          'Reseller and LCO wallets',
          'Razorpay and Cashfree payment links',
          'Customer self-care portal and support tickets',
          'DoT and CERT-In log archive with NAT logs',
          'MikroTik CoA for live plan changes',
        ],
        publisher: { '@id': org['@id'] },
        provider: { '@id': org['@id'] },
      },
      {
        '@type': 'FAQPage',
        '@id': `${origin}/#faq`,
        mainEntity: FAQ.map(([q, a]) => ({
          '@type': 'Question',
          name: q,
          acceptedAnswer: { '@type': 'Answer', text: a },
        })),
      },
    ],
  };
}

export default function Landing() {
  const c = salesContact();
  return (
    <div className="min-h-dvh overflow-x-hidden bg-white font-dm text-[#10214F] antialiased [font-feature-settings:normal]">
      <script
        type="application/ld+json"
        // JSON.stringify output with "<" escaped cannot close the script tag.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd()).replace(/</g, '\\u003c') }}
      />
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
            <Link href="/" aria-label="Bharat Radius home" className="shrink-0">
              <BrandLockup className="h-[42px]" />
            </Link>
            <nav
              aria-label="Sections"
              className="mx-auto flex gap-1 rounded-full border border-[#10214F]/[0.08] bg-white/70 p-1.5 text-[14.5px] backdrop-blur-[10px] max-lg:hidden"
            >
              {(
                [
                  ['#features', 'Features'],
                  ['#compare', 'Compare'],
                  ['#pricing', 'Pricing'],
                  ['#faq', 'FAQ'],
                ] as const
              ).map(([href, label]) => (
                <a key={href} href={href} className={cn(link, 'rounded-full px-4 py-2 hover:bg-white')}>
                  {label}
                </a>
              ))}
            </nav>
            <div className="flex shrink-0 items-center gap-2 max-lg:ml-auto">
              <SignedInSwap className="px-[22px] py-[11px] text-sm">
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
                  href="#contact"
                  className={cn(
                    pill,
                    'bg-[#10214F] px-[22px] py-[11px] text-sm text-white hover:bg-[#E8760F] hover:text-white',
                  )}
                >
                  Book a demo
                </a>
              </SignedInSwap>
            </div>
          </div>
        </header>

        <section className="relative z-10 mx-auto max-w-[1180px] px-6 pt-14 text-center">
          <div className="inline-flex items-center gap-2.5 rounded-full border border-[#10214F]/[0.09] bg-white/80 py-1.5 pr-2 pl-1.5 text-[13.5px] text-[#3F4A70] backdrop-blur-[8px]">
            <span className="rounded-full bg-[#E8760F] px-[11px] py-1 font-outfit text-xs font-semibold tracking-[0.03em] text-white">
              One Platform
            </span>
            <span className="pr-2">Infinite Possibilities</span>
          </div>
          <h1 className="mx-auto mt-[26px] max-w-[17em] font-outfit text-[clamp(34px,5.2vw,62px)] leading-[1.05] font-bold tracking-[-0.03em] text-balance text-[#10214F]">
            Radius &amp; ISP billing software for Indian broadband operators
          </h1>
          <p className="mx-auto mt-5 max-w-[36em] text-[clamp(16px,1.7vw,19px)] leading-[1.55] text-pretty text-[#4A5578]">
            Authenticate PPPoE subscribers, bill prepaid and postpaid customers with GST invoices, enforce FUP
            plans and run your resellers and LCOs from one panel. Custom Radius engine, hosted in India.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Cta href="#contact" className="px-7 py-3.5 text-[15.5px]">
              Book a free demo
            </Cta>
            {c ? (
              <Ghost href={c.whatsapp} className="px-7 py-3.5 text-[15.5px]">
                WhatsApp us
              </Ghost>
            ) : (
              <Ghost href="#features" className="px-7 py-3.5 text-[15.5px]">
                See features
              </Ghost>
            )}
          </div>
          <p className="mt-5 text-[14px] text-[#5B658A]">
            <a
              href={DIV_PRODUCT_URL}
              className="underline decoration-[#10214F]/25 underline-offset-4 hover:text-[#E8760F]"
            >
              Built and supported by DIV
            </a>
            , the team that hosts, sets up and runs it with you.
          </p>
          <ul className="mx-auto mt-9 grid max-w-[1000px] grid-cols-2 gap-3 text-left lg:grid-cols-4">
            {TRUST.map(([title, note, Icon]) => (
              <li
                key={title}
                className="flex gap-3 rounded-2xl border border-[#10214F]/[0.07] bg-white/75 px-4 py-3.5 backdrop-blur-[6px]"
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-[#FFF3E6] text-[#E8760F]">
                  <Icon aria-hidden strokeWidth={2.2} className="size-4" />
                </span>
                <span>
                  <span className="block font-outfit text-[15px] font-semibold text-[#10214F]">{title}</span>
                  <span className="mt-0.5 block text-[13px] leading-[1.45] text-[#6C7799]">{note}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section
          id="platform"
          aria-label="Admin panel preview"
          className="relative z-10 mx-auto max-w-[1080px] scroll-mt-6 px-6 pt-[52px]"
        >
          <ProductMock />
        </section>
      </div>

      <section id="problems" className="mx-auto max-w-[1180px] scroll-mt-6 px-6 pt-[92px] text-center">
        <span className={cn(eyebrow, 'bg-[#EAF6EC] text-[#1F7A2E]')}>Why switch</span>
        <h2 className={h2}>ISP billing software that fixes what costs local ISPs money</h2>
        <div className="mt-12 grid grid-cols-[repeat(auto-fit,minmax(min(250px,100%),1fr))] gap-4 text-left">
          {PROBLEMS.map(([title, body]) => (
            <div key={title} className="rounded-[18px] border border-[#ECEEF5] p-6">
              <h3 className="font-outfit text-[17.5px] font-semibold text-[#10214F]">{title}</h3>
              <p className="mt-2 text-[15px] leading-[1.6] text-pretty text-[#4A5578]">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="features" className="mx-auto max-w-[1180px] scroll-mt-6 px-6 pt-[92px] pb-10 text-center">
        <span className={cn(eyebrow, 'bg-[#FFF3E6] text-[#C4610C]')}>Features</span>
        <h2 className={h2}>Radius, billing and reseller management in one ISP panel</h2>
        <div className="mt-12 grid grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))] gap-5 text-left">
          <Feature
            icon={KeyRound}
            color="bg-[#E8760F]"
            title="PPPoE Radius authentication"
            body="Our Radius engine checks every login against your subscriber list and plan, and records every session."
            points={[
              'MikroTik setup script for PPPoE, accounting and CoA',
              'Live speed and plan changes without reconnecting (CoA)',
              'Static IPs, IP pools and MAC lock per subscriber',
            ]}
          >
            <div className={cn('flex items-center gap-2.5', miniHead)}>
              <span>PPPoE user</span>
              <span className="ml-auto">Session</span>
            </div>
            {(
              [
                ['ra', 'rahul.sharma', 'Online · 3h 12m'],
                ['pk', 'pk.traders', 'Online · 41m'],
                ['an', 'anita.d', 'Expired → walled garden'],
              ] as const
            ).map(([init, name, state], i) => (
              <div key={init} className="flex items-center gap-2.5 border-t border-[#F5F6FA] pt-[9px]">
                <span className="grid size-[22px] shrink-0 place-items-center rounded-[7px] bg-[#F1F3F8] text-[9.5px] font-semibold text-[#4A5578]">
                  {init}
                </span>
                <span className="truncate font-mono text-xs">{name}</span>
                <span
                  className={cn(
                    'ml-auto shrink-0 rounded-full px-[9px] py-[3px] text-[10px]',
                    i === 2 ? 'bg-[#FFF3E6] text-[#C4610C]' : 'bg-[#EAF6EC] text-[#1F7A2E]',
                  )}
                >
                  {state}
                </span>
              </div>
            ))}
          </Feature>

          <Feature
            icon={Package}
            color="bg-[#C4610C]"
            title="Plans, FUP and bandwidth control"
            body="Speed, validity, data caps and post-FUP speed per plan, for prepaid and postpaid customers."
            points={[
              'FUP data caps that drop to a reduced speed',
              'Different rates per reseller for the same plan',
              'Import all your plans from Excel in one upload',
            ]}
          >
            <div className={cn('flex items-center gap-2.5', miniHead)}>
              <span>Plan</span>
              <span className="ml-auto">Speed · FUP · Price</span>
            </div>
            {(
              [
                ['Home 100', '100M · 1 TB', '₹599'],
                ['Home 200', '200M · 2 TB', '₹899'],
                ['Business 500', '500M · none', '₹2,499'],
              ] as const
            ).map(([name, speed, price]) => (
              <div key={name} className="flex items-center gap-2.5 border-t border-[#F5F6FA] pt-[9px]">
                <span className="grid size-[22px] shrink-0 place-items-center rounded-[7px] bg-[#FFF3E6] text-[#C4610C]">
                  {name.startsWith('Business') ? (
                    <Building2 aria-hidden strokeWidth={2.2} className="size-3.5" />
                  ) : (
                    <Wifi aria-hidden strokeWidth={2.2} className="size-3.5" />
                  )}
                </span>
                <span className="text-xs">{name}</span>
                <span className="ml-auto text-[11.5px] text-[#6C7799]">{speed}</span>
                <span className="font-outfit text-xs font-semibold">{price}</span>
              </div>
            ))}
          </Feature>

          <Feature
            icon={Network}
            color="bg-[#2E9B3F]"
            title="Reseller, LCO and franchise management"
            body="Give every partner a login and a prepaid wallet; they recharge their own customers, you keep control."
            points={[
              'Multi-level resellers with their own plan rates',
              'Wallet top-ups, debits and statements per partner',
              'Partners see only their own subscribers',
            ]}
          >
            <div className="grid gap-[11px]">
              {(
                [
                  ['L1', 'Laxmi Nagar LCO', '₹48,200', false],
                  ['L2', 'Sector 62 Partner', '₹9,750', true],
                  ['L2', 'Karol Bagh Node', '₹15,300', true],
                  ['L1', 'Dwarka Fiber Point', '₹31,900', false],
                ] as const
              ).map(([level, name, wallet, indent]) => (
                <div key={name} className={cn('flex items-center gap-[9px]', indent && 'ml-3.5')}>
                  <span className="shrink-0 rounded-md bg-[#F1F3F8] px-[7px] py-0.5 text-[9.5px] text-[#4A5578]">
                    {level}
                  </span>
                  <span className="truncate text-xs">{name}</span>
                  <span className="ml-auto shrink-0 rounded-full bg-[#EAF6EC] px-[9px] py-[3px] text-[10px] text-[#1F7A2E]">
                    {wallet}
                  </span>
                </div>
              ))}
            </div>
          </Feature>

          <Feature
            icon={ReceiptText}
            color="bg-[#6B4FC8]"
            title="GST billing and online payments"
            body="Prepaid recharges and monthly postpaid invoices, collected online and settled automatically."
            points={[
              'GST invoices: CGST + SGST or IGST, numbered per financial year',
              'Razorpay and Cashfree payment links, settled by webhook',
              'GSTR-1 export for your accountant',
            ]}
          >
            <div className={cn('flex items-center gap-2.5', miniHead)}>
              <span>Invoice</span>
              <span className="ml-auto">Amount · Status</span>
            </div>
            {(
              [
                ['INV/2627/00412', '₹1,060', 'Paid · UPI'],
                ['INV/2627/00413', '₹707', 'Link sent'],
                ['INV/2627/00414', '₹2,949', 'Paid · Card'],
              ] as const
            ).map(([no, amt, st]) => (
              <div key={no} className="flex items-center gap-2.5 border-t border-[#F5F6FA] pt-[9px]">
                <span className="truncate font-mono text-[11px]">{no}</span>
                <span className="ml-auto font-outfit text-xs font-semibold">{amt}</span>
                <span
                  className={cn(
                    'shrink-0 rounded-full px-[9px] py-[3px] text-[10px]',
                    st.startsWith('Paid') ? 'bg-[#EAF6EC] text-[#1F7A2E]' : 'bg-[#EDEAF9] text-[#6B4FC8]',
                  )}
                >
                  {st}
                </span>
              </div>
            ))}
          </Feature>

          <Feature
            icon={Activity}
            color="bg-[#1F5FBF]"
            title="Live sessions and usage reports"
            body="See who is online, what they use and what you collect, with alerts when something breaks."
            points={[
              '31-day download and upload per subscriber',
              'Revenue, collections and expiring-customer reports',
              'Server and Radius health alerts (Grafana)',
            ]}
          >
            <div className="flex items-baseline gap-2">
              <span className="font-outfit text-[17px] font-semibold">6.4 Gbps</span>
              <span className="text-[10.5px] text-[#8A93B0]">peak today</span>
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
            icon={ScrollText}
            color="bg-[#0F8FA0]"
            title="DoT and CERT-In log archive"
            body="The logs licensing rules ask for, kept on Indian servers and ready when a request arrives."
            points={[
              'Radius session logs kept, never deleted',
              'NAT logs: who used which public IP and port, when',
              'Day files sealed with SHA-256; edits are detectable',
            ]}
          >
            <div className="grid gap-3 py-0.5">
              {[
                'Data hosted in India',
                'NTP-synced timestamps',
                'Encrypted backups',
                'Audit trail on every change',
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

        <h3 className="mt-16 font-outfit text-[22px] font-semibold text-[#10214F]">Also included</h3>
        <div className="mt-6 grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-x-8 gap-y-6 text-left">
          {MORE.map(([title, body]) => (
            <div key={title} className="border-l-2 border-[#E8760F]/40 pl-4">
              <h4 className="font-outfit text-[16.5px] font-semibold text-[#10214F]">{title}</h4>
              <p className="mt-1 text-[14.5px] leading-[1.55] text-[#4A5578]">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="integrations" className="mx-auto max-w-[1180px] scroll-mt-6 px-6 pt-[72px] text-center">
        <span className={cn(eyebrow, 'bg-[#E6EEFB] text-[#1F5FBF]')}>Integrations</span>
        <h2 className={h2}>Works with MikroTik, Razorpay, Cashfree and SMS</h2>
        <ul className="mt-10 grid grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))] gap-3 text-left">
          {INTEGRATIONS.map(([name, note]) => (
            <li key={name} className="rounded-2xl border border-[#ECEEF5] bg-[#F7F8FB] px-5 py-4">
              <div className="font-outfit text-[16px] font-semibold text-[#10214F]">{name}</div>
              <div className="mt-0.5 text-[14px] text-[#5B658A]">{note}</div>
            </li>
          ))}
        </ul>
        <p className="mt-5 text-[14px] text-[#6C7799]">
          Need TR-069 to configure customer routers remotely? DIV also offers a TR-069 ACS that runs alongside
          Bharat Radius.
        </p>
      </section>

      <section id="compare" className="mx-auto max-w-[1180px] scroll-mt-6 px-6 pt-[92px] text-center">
        <span className={cn(eyebrow, 'bg-[#EDEAF9] text-[#6B4FC8]')}>Compare</span>
        <h2 className={h2}>An alternative to other Radius software: custom Radius core, modern panel</h2>
        <p className={lead}>
          Bharat Radius runs on its own custom Radius engine and adds the billing, partner and compliance
          tools that other Radius software and spreadsheets leave to you.
        </p>
        <div className="relative mt-10 overflow-x-auto rounded-[18px] border border-[#ECEEF5]">
          <table className="w-full min-w-[680px] border-collapse text-left text-[14.5px]">
            <caption className="sr-only">
              Bharat Radius compared with other Radius software and Excel billing
            </caption>
            <thead>
              <tr className="bg-[#FAFBFD] font-outfit text-[14px] text-[#10214F]">
                <th scope="col" className="px-5 py-4 font-semibold">
                  &nbsp;
                </th>
                <th scope="col" className="bg-[#FFF3E6] px-5 py-4 text-center font-semibold text-[#C4610C]">
                  Bharat Radius
                </th>
                <th scope="col" className="px-5 py-4 text-center font-semibold">
                  Other Radius
                </th>
                <th scope="col" className="px-5 py-4 text-center font-semibold">
                  Excel / legacy billing
                </th>
              </tr>
            </thead>
            <tbody>
              {COMPARE.map(([row, br, dalo, excel]) => (
                <tr key={row} className="border-t border-[#F1F3F8]">
                  <th scope="row" className="px-5 py-3.5 font-normal text-[#3F4A70]">
                    {row}
                  </th>
                  <td className="bg-[#FFF8F0] px-5 py-3.5 text-center">
                    <Mark value={br} />
                  </td>
                  <td className="px-5 py-3.5 text-center">
                    <Mark value={dalo} />
                  </td>
                  <td className="px-5 py-3.5 text-center">
                    <Mark value={excel} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section id="pricing" className="mx-auto max-w-[1180px] scroll-mt-6 px-6 pt-[92px]">
        <div className="relative overflow-hidden rounded-[26px] bg-[#10214F] p-[clamp(30px,4.5vw,60px)] text-white">
          <div
            aria-hidden
            className="absolute inset-0"
            style={{
              background:
                'radial-gradient(60% 80% at 88% 8%, rgba(232,118,15,0.4) 0%, rgba(232,118,15,0) 62%), radial-gradient(55% 70% at 6% 96%, rgba(46,155,63,0.38) 0%, rgba(46,155,63,0) 66%)',
            }}
          />
          <div className="relative grid gap-10 lg:grid-cols-[1.1fr_1fr] lg:items-center">
            <div>
              <span className={cn(eyebrow, 'border border-white/20 bg-white/[0.12] text-[#FFE0BC]')}>
                Pricing
              </span>
              <h2 className="mt-[22px] max-w-[18em] font-outfit text-[clamp(27px,3.6vw,44px)] leading-[1.06] font-bold tracking-[-0.025em] text-balance text-white">
                ISP billing software priced by subscriber count
              </h2>
              <p className="mt-4 max-w-[32em] text-[16.5px] leading-[1.6] text-[#D7DCEE]">
                You pay for the number of subscribers you manage. Hosting in India, updates and support from
                DIV are included.
              </p>
              <div className="mt-7 flex flex-wrap gap-3">
                <Cta href="#contact" className="px-7 py-3.5 text-[15.5px]">
                  Get a quote
                </Cta>
              </div>
            </div>
            <ul className="grid gap-2.5">
              {SUBSCRIBER_BANDS.map((b) => (
                <li
                  key={b}
                  className="flex items-center justify-between rounded-2xl border border-white/15 bg-white/[0.07] px-5 py-3.5"
                >
                  <span className="font-outfit text-[16px] font-semibold text-[#FFB562]">{b}</span>
                  <span className="text-[14px] text-[#D7DCEE]">subscribers · quote in the demo</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section id="faq" className="mx-auto max-w-[880px] scroll-mt-6 px-6 pt-[92px]">
        <div className="text-center">
          <span className={cn(eyebrow, 'bg-[#FFF3E6] text-[#C4610C]')}>FAQ</span>
          <h2 className={h2}>Questions ISPs ask about Bharat Radius</h2>
        </div>
        <div className="mt-10 divide-y divide-[#ECEEF5] rounded-[18px] border border-[#ECEEF5]">
          {FAQ.map(([q, a]) => (
            <details key={q} className="group px-6 py-5 [&_summary::-webkit-details-marker]:hidden">
              <summary className="flex cursor-pointer list-none items-center gap-4 font-outfit text-[17px] font-semibold text-[#10214F]">
                <h3 className="text-left">{q}</h3>
                <span
                  aria-hidden
                  className="ml-auto grid size-7 shrink-0 place-items-center rounded-full bg-[#F1F3F8] text-[16px] transition-transform group-open:rotate-45"
                >
                  +
                </span>
              </summary>
              <p className="mt-3 text-[15.5px] leading-[1.65] text-pretty text-[#4A5578]">{a}</p>
            </details>
          ))}
        </div>
      </section>

      <section id="contact" className="mx-auto max-w-[1180px] scroll-mt-6 px-6 pt-[92px] pb-24">
        <div className="grid gap-10 rounded-[26px] border border-[#ECEEF5] bg-[#FBFBFD] p-[clamp(24px,4vw,52px)] lg:grid-cols-[0.9fr_1.1fr]">
          <div>
            <span className={cn(eyebrow, 'bg-[#EAF6EC] text-[#1F7A2E]')}>Free demo</span>
            <h2 className="mt-5 font-outfit text-[clamp(28px,3.6vw,42px)] leading-[1.08] font-bold tracking-[-0.025em] text-balance text-[#10214F]">
              Book a free Bharat Radius demo
            </h2>
            <p className="mt-4 text-[16.5px] leading-[1.6] text-[#4A5578]">
              In 30 minutes we show the panel with your kind of setup, answer migration questions and send a
              quote for your subscriber count.
            </p>
            <ul className="mt-6 grid gap-2.5 text-[15px] text-[#3F4A70]">
              {[
                'Live walkthrough: subscribers, plans, billing, resellers',
                'Your routers and NAS checked for compatibility',
                'Migration plan from other Radius software or Excel',
              ].map((t) => (
                <li key={t} className="flex gap-2.5">
                  <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-[#EAF6EC] text-[11px] text-[#1F7A2E]">
                    ✓
                  </span>
                  {t}
                </li>
              ))}
            </ul>
            <div className="mt-8 flex flex-wrap gap-3">
              {c ? (
                <>
                  <Cta href={c.whatsapp} className="px-6 py-3 text-[15px]">
                    Chat on WhatsApp
                  </Cta>
                  <Ghost href={c.tel} className="px-6 py-3 text-[15px]">
                    Call {c.phone}
                  </Ghost>
                </>
              ) : (
                <Ghost href={demoUrl('contact-section')} className="px-6 py-3 text-[15px]">
                  Contact DIV directly
                </Ghost>
              )}
            </div>
          </div>
          <div className="relative">
            <ContactForm />
          </div>
        </div>
      </section>

      <footer className="border-t border-[#ECEEF5]">
        <div className="mx-auto flex max-w-[1180px] flex-wrap items-center gap-x-10 gap-y-5 px-6 py-10">
          <BrandLockup className="h-[50px]" />
          <p className="max-w-[28em] text-[14.5px] leading-[1.6] text-[#5B658A]">
            Radius &amp; ISP billing software for Indian broadband operators, resellers and LCOs.
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
