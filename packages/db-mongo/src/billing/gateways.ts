import { createHmac, timingSafeEqual } from 'node:crypto';
import { MoneyError } from './money.js';

/** Base URLs; overridable for tests and sandbox (env RAZORPAY_API_URL / CASHFREE_API_URL). */
export const GATEWAY_URLS = {
  razorpay: () => process.env.RAZORPAY_API_URL ?? 'https://api.razorpay.com',
  cashfree: (sandbox: boolean) =>
    process.env.CASHFREE_API_URL ?? (sandbox ? 'https://sandbox.cashfree.com' : 'https://api.cashfree.com'),
};
const CASHFREE_VERSION = '2023-08-01';
const TIMEOUT_MS = 10_000;

export interface LinkRequest {
  /** Our payment id: Razorpay reference_id / Cashfree link_id. */
  ref: string;
  amountPaise: number;
  purpose: string;
  customer: { name: string; phone: string };
  expiresAt: Date;
}
export interface LinkResult {
  linkId: string;
  url: string;
}
export interface LinkStatus {
  paid: boolean;
  amountPaidPaise: number;
  paymentId?: string;
  method?: string;
}

export interface Gateway {
  createLink(r: LinkRequest): Promise<LinkResult>;
  linkStatus(linkId: string): Promise<LinkStatus>;
}

async function call<T>(url: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new MoneyError(502, 'GATEWAY_ERROR', `Payment gateway unreachable: ${(e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { error?: { description?: string }; message?: string };
      msg = j.error?.description ?? j.message ?? msg;
    } catch {
      /* not JSON */
    }
    throw new MoneyError(502, 'GATEWAY_ERROR', `Payment gateway refused: ${msg}`);
  }
  return JSON.parse(text) as T;
}

export class RazorpayGateway implements Gateway {
  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
    private readonly base = GATEWAY_URLS.razorpay(),
  ) {}

  private get headers() {
    return {
      authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`,
      'content-type': 'application/json',
    };
  }

  async createLink(r: LinkRequest): Promise<LinkResult> {
    const j = await call<{ id: string; short_url: string }>(`${this.base}/v1/payment_links`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        amount: r.amountPaise,
        currency: 'INR',
        reference_id: r.ref,
        description: r.purpose.slice(0, 2048),
        customer: { name: r.customer.name, contact: r.customer.phone },
        notify: { sms: false, email: false },
        expire_by: Math.floor(r.expiresAt.getTime() / 1000),
        notes: { ref: r.ref },
      }),
    });
    return { linkId: j.id, url: j.short_url };
  }

  async linkStatus(linkId: string): Promise<LinkStatus> {
    const j = await call<{
      status: string;
      amount_paid: number;
      payments?: { payment_id: string; status: string; method?: string }[] | null;
    }>(`${this.base}/v1/payment_links/${encodeURIComponent(linkId)}`, { headers: this.headers });
    const p = (j.payments ?? []).find((x) => x.status === 'captured');
    return {
      paid: j.status === 'paid',
      amountPaidPaise: j.amount_paid,
      ...(p ? { paymentId: p.payment_id } : {}),
      ...(p?.method ? { method: p.method } : {}),
    };
  }
}

export class CashfreeGateway implements Gateway {
  constructor(
    private readonly appId: string,
    private readonly secretKey: string,
    private readonly base: string,
  ) {}

  private get headers() {
    return {
      'x-client-id': this.appId,
      'x-client-secret': this.secretKey,
      'x-api-version': CASHFREE_VERSION,
      'content-type': 'application/json',
    };
  }

  async createLink(r: LinkRequest): Promise<LinkResult> {
    const phone = r.customer.phone.replace(/^\+91/, '');
    const j = await call<{ link_id: string; link_url: string }>(`${this.base}/pg/links`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        link_id: r.ref,
        link_amount: r.amountPaise / 100,
        link_currency: 'INR',
        link_purpose: r.purpose.slice(0, 500),
        customer_details: { customer_phone: phone, customer_name: r.customer.name },
        link_notify: { send_sms: false, send_email: false },
        link_expiry_time: r.expiresAt.toISOString(),
      }),
    });
    return { linkId: j.link_id, url: j.link_url };
  }

  async linkStatus(linkId: string): Promise<LinkStatus> {
    const id = encodeURIComponent(linkId);
    const j = await call<{ link_status: string; link_amount_paid: number }>(`${this.base}/pg/links/${id}`, {
      headers: this.headers,
    });
    const paid = j.link_status === 'PAID';
    let paymentId: string | undefined;
    if (paid) {
      const orders = await call<{ order_id: string; order_status: string }[]>(
        `${this.base}/pg/links/${id}/orders`,
        {
          headers: this.headers,
        },
      );
      paymentId = orders.find((o) => o.order_status === 'PAID')?.order_id;
    }
    return {
      paid,
      amountPaidPaise: Math.round(Number(j.link_amount_paid) * 100),
      ...(paymentId ? { paymentId } : {}),
    };
  }
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Razorpay: hex HMAC-SHA256 of the raw body with the webhook secret (header X-Razorpay-Signature). */
export const verifyRazorpay = (raw: string, signature: string | undefined, secret: string) =>
  !!signature && safeEqual(createHmac('sha256', secret).update(raw).digest('hex'), signature);

/** Cashfree: base64 HMAC-SHA256 of timestamp + raw body with the secret key (x-webhook-signature/-timestamp). */
export const verifyCashfree = (
  raw: string,
  signature: string | undefined,
  timestamp: string | undefined,
  secret: string,
) =>
  !!signature &&
  !!timestamp &&
  safeEqual(
    createHmac('sha256', secret)
      .update(timestamp + raw)
      .digest('base64'),
    signature,
  );

interface Decrypter {
  decrypt(f: import('@isp/shared').EncryptedField, aad: string): string;
}
type GatewayTenant = { _id: import('mongodb').ObjectId; gateways?: import('./types.js').TenantGateways };

/** AAD binding each stored gateway secret to its tenant and field. */
export const gatewayAad = (tenantId: import('mongodb').ObjectId, field: string) =>
  `tenants.gateways:${tenantId.toHexString()}:${field}`;

export function gatewayFor(t: GatewayTenant, method: 'razorpay' | 'cashfree', crypto: Decrypter): Gateway {
  if (method === 'razorpay') {
    const g = t.gateways?.razorpay;
    if (!g?.enabled) throw new MoneyError(409, 'GATEWAY_ERROR', 'Razorpay is not set up for this ISP');
    return new RazorpayGateway(g.keyId, crypto.decrypt(g.keySecret, gatewayAad(t._id, 'razorpay.keySecret')));
  }
  const g = t.gateways?.cashfree;
  if (!g?.enabled) throw new MoneyError(409, 'GATEWAY_ERROR', 'Cashfree is not set up for this ISP');
  return new CashfreeGateway(
    g.appId,
    crypto.decrypt(g.secretKey, gatewayAad(t._id, 'cashfree.secretKey')),
    GATEWAY_URLS.cashfree(g.sandbox),
  );
}

/** Secret that signs the gateway's webhooks (Razorpay: its webhook secret; Cashfree: the secret key). */
export function webhookSecretFor(
  t: GatewayTenant,
  method: 'razorpay' | 'cashfree',
  crypto: Decrypter,
): string | null {
  if (method === 'razorpay') {
    const g = t.gateways?.razorpay;
    return g ? crypto.decrypt(g.webhookSecret, gatewayAad(t._id, 'razorpay.webhookSecret')) : null;
  }
  const g = t.gateways?.cashfree;
  return g ? crypto.decrypt(g.secretKey, gatewayAad(t._id, 'cashfree.secretKey')) : null;
}
