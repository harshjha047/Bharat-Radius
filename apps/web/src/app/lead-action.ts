'use server';

import { headers } from 'next/headers';
import { z } from 'zod';
import { SUBSCRIBER_BANDS } from '@/lib/site';

/** What the landing page contact form sends back to the browser. */
export type LeadState =
  | { status: 'idle' }
  | { status: 'sent'; name: string }
  | { status: 'error'; message: string; fields?: Partial<Record<keyof LeadInput, string>> };

const leadSchema = z.object({
  name: z.string().trim().min(2, 'Please enter your name').max(80),
  company: z.string().trim().min(2, 'Please enter your ISP or company name').max(120),
  phone: z
    .string()
    .trim()
    .transform((v) => v.replace(/[\s()-]/g, ''))
    .pipe(z.string().regex(/^\+?\d{10,13}$/, 'Please enter a valid mobile number')),
  email: z.union([z.literal(''), z.string().trim().email('Please enter a valid email').max(160)]),
  subscribers: z.enum(SUBSCRIBER_BANDS, { message: 'Please pick your subscriber count' }),
  city: z.string().trim().max(80),
  message: z.string().trim().max(1000),
});
type LeadInput = z.infer<typeof leadSchema>;

// Small in-memory limit per client IP; the web container is a single process.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const recent = new Map<string, number[]>();

function limited(ip: string): boolean {
  const now = Date.now();
  const hits = (recent.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.size > 5000) recent.clear();
  if (hits.length >= MAX_PER_WINDOW) {
    recent.set(ip, hits);
    return true;
  }
  hits.push(now);
  recent.set(ip, hits);
  return false;
}

/**
 * Delivers a lead to LEAD_WEBHOOK_URL as JSON (works with Slack incoming webhooks, Zapier, Make,
 * n8n or a Google Apps Script). The payload has a `text` line for chat tools and the full `lead`.
 */
async function deliver(lead: LeadInput & { page: string; at: string }): Promise<boolean> {
  const url = process.env.LEAD_WEBHOOK_URL?.trim();
  if (!url) return false;
  const text =
    `New BharatRadius demo request: ${lead.name} (${lead.company}), ${lead.phone}` +
    `${lead.email ? `, ${lead.email}` : ''}, ${lead.subscribers} subscribers` +
    `${lead.city ? `, ${lead.city}` : ''}${lead.message ? ` — "${lead.message}"` : ''}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, lead }),
      signal: AbortSignal.timeout(6000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function submitLead(_prev: LeadState, form: FormData): Promise<LeadState> {
  // Honeypot: real people never see or fill this field.
  if (String(form.get('website') ?? '') !== '') return { status: 'sent', name: '' };

  const parsed = leadSchema.safeParse({
    name: form.get('name') ?? '',
    company: form.get('company') ?? '',
    phone: form.get('phone') ?? '',
    email: form.get('email') ?? '',
    subscribers: form.get('subscribers') ?? '',
    city: form.get('city') ?? '',
    message: form.get('message') ?? '',
  });
  if (!parsed.success) {
    const fields: Partial<Record<keyof LeadInput, string>> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as keyof LeadInput;
      fields[key] ??= issue.message;
    }
    return { status: 'error', message: 'Please check the highlighted fields.', fields };
  }

  const h = await headers();
  const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip') || 'unknown';
  if (limited(ip)) {
    return { status: 'error', message: 'Too many requests. Please call or WhatsApp us instead.' };
  }

  const lead = {
    ...parsed.data,
    page: h.get('x-forwarded-host') ?? h.get('host') ?? '',
    at: new Date().toISOString(),
  };
  const delivered = await deliver(lead);
  if (!delivered) {
    // Never lose a lead: without a working webhook it goes to the container log (`docker logs isp-web`).
    console.warn(JSON.stringify({ event: 'landing.lead.undelivered', lead }));
  }
  return { status: 'sent', name: parsed.data.name.split(' ')[0] ?? '' };
}
