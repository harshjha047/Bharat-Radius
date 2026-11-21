/**
 * Public-site settings for the landing page, robots.txt and sitemap.xml.
 *
 * Every ISP install serves the same landing page on its own domain. To avoid duplicate content,
 * all copies point their canonical URL at the official product site (CANONICAL_ORIGIN). Only the
 * official site lists the page in its sitemap; installs still carry the followed DIV credit link.
 */

const DEFAULT_CANONICAL_ORIGIN = 'https://new.bharatradius.com';

function origin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value.trim()).origin;
  } catch {
    return null;
  }
}

/** The official product site, e.g. "https://bharatradius.com". */
export function canonicalOrigin(): string {
  return origin(process.env.CANONICAL_ORIGIN) ?? DEFAULT_CANONICAL_ORIGIN;
}

/** True when `host` (a Host header) is the official site rather than an ISP install. */
export function isCanonicalHost(host: string | null | undefined): boolean {
  if (!host) return false;
  return new URL(canonicalOrigin()).host === host.toLowerCase();
}

export const SITE_NAME = 'Bharat Radius';
export const SITE_TITLE = 'Radius & ISP Billing Software for Indian ISPs | Bharat Radius';
export const SITE_DESCRIPTION =
  'PPPoE Radius, prepaid & postpaid billing, GST invoices, FUP plans, reseller/LCO management and DoT log archive for Indian broadband ISPs. Custom Radius engine, hosted in India. Book a free demo.';

/** DIV, the company that builds and supports Bharat Radius. */
export const DIV = {
  name: 'DIV (Development Innovation Vector Pvt. Ltd.)',
  url: 'https://thediv.in',
  contactUrl: 'https://thediv.in/contact',
} as const;

/** Sales phone for call / WhatsApp buttons, read at render time. Null hides those buttons. */
export function salesContact() {
  const phone = process.env.SALES_PHONE?.trim();
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10) return null;
  return {
    phone,
    tel: `tel:+${digits}`,
    whatsapp: `https://wa.me/${digits}?text=${encodeURIComponent('Hello, I would like a demo of Bharat Radius for my ISP.')}`,
  };
}

/** A tracked link to DIV's contact page, so demo requests from this page can be counted. */
export function demoUrl(content: string): string {
  return `${DIV.contactUrl}?utm_source=bharat-radius&utm_medium=landing&utm_campaign=book-demo&utm_content=${content}`;
}

/** Subscriber-count bands on the contact form (also how plans are quoted). */
export const SUBSCRIBER_BANDS = [
  'Under 500',
  '500 – 2,000',
  '2,000 – 10,000',
  '10,000 – 50,000',
  'Over 50,000',
] as const;
