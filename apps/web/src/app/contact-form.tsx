'use client';

import { useActionState } from 'react';
import { SUBSCRIBER_BANDS } from '@/lib/site';
import { cn } from '@/lib/utils';
import { type LeadState, submitLead } from './lead-action';

const input =
  'w-full rounded-xl border border-[#E1E5EF] bg-white px-4 py-3 text-[15px] text-[#10214F] placeholder:text-[#9AA3BF] outline-none transition-colors focus:border-[#E8760F] focus:ring-2 focus:ring-[#E8760F]/20 aria-[invalid=true]:border-[#C2410C]';
const label = 'mb-1.5 block text-left text-[13.5px] font-medium text-[#3F4A70]';

function Field({
  id,
  text,
  error,
  optional,
  children,
}: {
  id: string;
  text: string;
  error?: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className={label}>
        {text}
        {optional && <span className="font-normal text-[#8A93B0]"> (optional)</span>}
      </label>
      {children}
      {error && (
        <p id={`${id}-error`} className="mt-1.5 text-left text-[13px] text-[#C2410C]">
          {error}
        </p>
      )}
    </div>
  );
}

export function ContactForm() {
  const [state, action, pending] = useActionState<LeadState, FormData>(submitLead, { status: 'idle' });
  const err = state.status === 'error' ? (state.fields ?? {}) : {};
  const aria = (k: keyof typeof err) =>
    err[k] ? { 'aria-invalid': true as const, 'aria-describedby': `lead-${k}-error` } : {};

  if (state.status === 'sent') {
    return (
      <div role="status" className="rounded-2xl border border-[#CDEBD3] bg-[#F1FAF3] p-8 text-center">
        <p className="font-outfit text-[22px] font-semibold text-[#10214F]">
          Thank you{state.name ? `, ${state.name}` : ''}. We have your request.
        </p>
        <p className="mt-2 text-[15.5px] text-[#4A5578]">
          The DIV team will call you to set up your 30-minute demo.
        </p>
      </div>
    );
  }

  return (
    <form action={action} noValidate className="grid gap-4 sm:grid-cols-2" aria-label="Book a free demo">
      <Field id="lead-name" text="Your name" error={err.name}>
        <input id="lead-name" name="name" autoComplete="name" required className={input} {...aria('name')} />
      </Field>
      <Field id="lead-company" text="ISP / company name" error={err.company}>
        <input
          id="lead-company"
          name="company"
          autoComplete="organization"
          required
          className={input}
          {...aria('company')}
        />
      </Field>
      <Field id="lead-phone" text="Mobile (WhatsApp)" error={err.phone}>
        <input
          id="lead-phone"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="+91 98765 43210"
          required
          className={input}
          {...aria('phone')}
        />
      </Field>
      <Field id="lead-email" text="Email" error={err.email} optional>
        <input
          id="lead-email"
          name="email"
          type="email"
          autoComplete="email"
          className={input}
          {...aria('email')}
        />
      </Field>
      <Field id="lead-subscribers" text="Subscribers today" error={err.subscribers}>
        <select
          id="lead-subscribers"
          name="subscribers"
          required
          defaultValue=""
          className={cn(input, 'appearance-none')}
          {...aria('subscribers')}
        >
          <option value="" disabled>
            Select…
          </option>
          {SUBSCRIBER_BANDS.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </Field>
      <Field id="lead-city" text="City / state" error={err.city} optional>
        <input id="lead-city" name="city" autoComplete="address-level2" className={input} {...aria('city')} />
      </Field>
      <div className="sm:col-span-2">
        <Field id="lead-message" text="What do you use today?" error={err.message} optional>
          <textarea
            id="lead-message"
            name="message"
            rows={3}
            placeholder="e.g. daloRADIUS + Excel billing, 3 MikroTik routers, 12 LCOs"
            className={cn(input, 'resize-y')}
            {...aria('message')}
          />
        </Field>
      </div>
      {/* Honeypot for bots; hidden from people and screen readers. */}
      <div aria-hidden className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label htmlFor="lead-website">Website</label>
        <input id="lead-website" name="website" tabIndex={-1} autoComplete="off" />
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 sm:col-span-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-[#E8760F] px-8 py-[15px] font-outfit text-base font-medium text-white shadow-[0_12px_26px_-12px_rgba(232,118,15,0.7)] transition-colors hover:bg-[#10214F] disabled:opacity-60"
        >
          {pending ? 'Sending…' : 'Book my free demo'}
        </button>
        <p className="text-left text-[13px] text-[#6C7799]">
          30-minute call. We only use your details to contact you about BharatRadius.
        </p>
      </div>
      {state.status === 'error' && (
        <p role="alert" className="text-left text-[14px] text-[#C2410C] sm:col-span-2">
          {state.message}
        </p>
      )}
    </form>
  );
}
