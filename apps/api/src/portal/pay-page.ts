import { createHmac, timingSafeEqual } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Injectable, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ObjectId } from 'mongodb';
import type pg from 'pg';
import { z } from 'zod';
import type { BillingTenant, MongoHandle, NasDeviceDoc, PlanDoc, SubscriberDoc } from '@isp/db-mongo';
import { RateLimiter } from '../auth/rate-limit.js';
import { paymentView } from '../billing/payments.js';
import { CONFIG, type Config } from '../config.js';
import { AppError, notFound, tooMany } from '../errors.js';
import { Endpoint } from '../http/endpoint.js';
import { MONGO, RADIUS_DB } from '../infra/infra.module.js';
import { PortalService } from './portal.js';

/** A pay-page link stays usable this long after the router redirect. */
const TOKEN_TTL_MS = 30 * 60_000;
const LOOKUPS_PER_15_MIN = 10;

interface Ticket {
  /** ISP (tenant) id. */
  t: string;
  /** Router the customer was redirected from. */
  n: string;
  /** Subscriber, once known. */
  s?: string;
  exp: number;
}

const tokenQuery = z.object({ t: z.string().min(10).max(400) });
const lookupBody = z.object({
  t: z.string().min(10).max(400),
  /** PPPoE username, customer number or registered mobile. */
  login: z.string().trim().min(3).max(64),
});
const orderBody = z.object({ t: z.string().min(10).max(400) });

const payPlan = z.object({
  name: z.string(),
  downloadKbps: z.number(),
  uploadKbps: z.number(),
  validityDays: z.number(),
  /** What the customer pays, GST included. */
  pricePaise: z.number(),
});
const payContext = z.object({
  isp: z.object({ name: z.string(), phone: z.string().nullable() }),
  online: z.boolean(),
  subscriber: z
    .object({
      /** Masked: only the first letter of each word. */
      name: z.string(),
      customerNo: z.string(),
      username: z.string().nullable(),
      expired: z.boolean(),
      expiresAt: z.string().nullable(),
      plan: payPlan.nullable(),
    })
    .nullable(),
  /** Token to use from here on (carries the subscriber after a lookup). */
  t: z.string(),
});

export const maskName = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `${w[0]}${'•'.repeat(Math.min(Math.max(w.length - 1, 2), 6))}`)
    .join(' ');

const b64 = (b: Buffer) => b.toString('base64url');

@Injectable()
export class PayPageService {
  private readonly key: Buffer;

  constructor(
    @Inject(MONGO) private readonly mongo: MongoHandle,
    @Inject(RADIUS_DB) private readonly pool: pg.Pool | null,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(PortalService) private readonly portal: PortalService,
  ) {
    this.key = createHmac('sha256', config.JWT_SIGNING_KEY).update('walled-garden-pay-page:v1').digest();
  }

  private get db() {
    return this.mongo.db;
  }

  sign(x: Omit<Ticket, 'exp'>, now = Date.now()): string {
    const body = b64(Buffer.from(JSON.stringify({ ...x, exp: now + TOKEN_TTL_MS })));
    return `${body}.${b64(createHmac('sha256', this.key).update(body).digest())}`;
  }

  verify(token: string): Ticket {
    const [body, sig] = token.split('.');
    const bad = () => new AppError(410, 'LINK_EXPIRED', 'This page has expired. Open any website again.');
    if (!body || !sig) throw bad();
    const want = createHmac('sha256', this.key).update(body).digest();
    const got = Buffer.from(sig, 'base64url');
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw bad();
    const x = JSON.parse(Buffer.from(body, 'base64url').toString()) as Ticket;
    if (!(x.exp > Date.now()) || !ObjectId.isValid(x.t) || !ObjectId.isValid(x.n)) throw bad();
    return x;
  }

  /**
   * Router redirect (`:8089`). The request comes from the router's public address (customer traffic is
   * masqueraded), so the router is known but not the customer; if exactly one expired customer is online behind
   * it, that is who is asking.
   */
  async entry(ip: string): Promise<string> {
    const base = `${this.config.PUBLIC_BASE_URL.replace(/\/$/, '')}/pay`;
    const nas = await this.db
      .collection<NasDeviceDoc>('nas_devices')
      .findOne({ ip: ip.toLowerCase() }, { projection: { tenantId: 1 } });
    if (!nas) return base;
    const expired = await this.expiredOnline(nas.tenantId, ip, 2);
    const t = this.sign({
      t: nas.tenantId.toHexString(),
      n: nas._id.toHexString(),
      ...(expired.length === 1 ? { s: expired[0] } : {}),
    });
    return `${base}?t=${encodeURIComponent(t)}`;
  }

  /** Subscriber ids (Mongo) online on this router whose validity is over. */
  private async expiredOnline(tenantId: ObjectId, nasIp: string, limit: number, username?: string) {
    if (!this.pool) return [];
    const params: unknown[] = [tenantId.toHexString(), nasIp, limit];
    const r = await this.pool.query<{ external_id: string }>(
      `SELECT DISTINCT s.external_id
         FROM radacct a
         JOIN tenants t ON t.id = a.tenant_id
         JOIN subscribers s ON s.tenant_id = a.tenant_id AND lower(s.username) = lower(a.username)
        WHERE t.external_id = $1 AND a.nasipaddress = $2::inet AND a.acctstoptime IS NULL
          AND a.acctupdatetime > now() - make_interval(secs => 3 * t.interim_interval)
          AND s.external_id IS NOT NULL
          ${username ? `AND lower(a.username) = lower($${params.push(username)})` : 'AND (s.plan_id IS NULL OR s.expires_at <= now())'}
        LIMIT $3`,
      params,
    );
    return r.rows.map((x) => x.external_id);
  }

  private async nasOf(x: Ticket) {
    const nas = await this.db
      .collection<NasDeviceDoc>('nas_devices')
      .findOne({ _id: new ObjectId(x.n), tenantId: new ObjectId(x.t) }, { projection: { ip: 1 } });
    if (!nas?.ip) throw notFound('Router');
    return nas.ip;
  }

  private async subscriber(x: Ticket): Promise<SubscriberDoc | null> {
    if (!x.s || !ObjectId.isValid(x.s)) return null;
    return this.db
      .collection<SubscriberDoc>('subscribers')
      .findOne({ _id: new ObjectId(x.s), tenantId: new ObjectId(x.t), status: { $ne: 'deleted' } });
  }

  async context(token: string): Promise<z.output<typeof payContext>> {
    const x = this.verify(token);
    const tenantId = new ObjectId(x.t);
    const [tenant, s] = await Promise.all([
      this.db
        .collection<BillingTenant & { contact?: { phone?: string } }>('tenants')
        .findOne({ _id: tenantId }, { projection: { name: 1, contact: 1, gateways: 1 } }),
      this.subscriber(x),
    ]);
    if (!tenant) throw notFound('Provider');
    const online = !!(tenant.gateways?.razorpay?.enabled || tenant.gateways?.cashfree?.enabled);
    let subscriber: z.output<typeof payContext>['subscriber'] = null;
    if (s) {
      const plan = s.planId
        ? await this.db.collection<PlanDoc>('plans').findOne({ _id: s.planId, tenantId })
        : null;
      const priced = plan ? (await this.portal.priced(s, [plan]))[0] : undefined;
      subscriber = {
        name: maskName(s.name),
        customerNo: s.customerNo,
        username: s.username ?? null,
        expired: s.billingType === 'prepaid' && (!s.expiresAt || s.expiresAt <= new Date()),
        expiresAt: s.expiresAt?.toISOString() ?? null,
        plan:
          priced && s.billingType === 'prepaid'
            ? {
                name: priced.name,
                downloadKbps: priced.downloadKbps,
                uploadKbps: priced.uploadKbps,
                validityDays: priced.validityDays,
                pricePaise: priced.pricePaise,
              }
            : null,
      };
    }
    return {
      isp: { name: tenant.name ?? '', phone: tenant.contact?.phone ?? null },
      online,
      subscriber,
      t: token,
    };
  }

  /** "That's not me": find the customer by username, customer no. or mobile, if they are online behind this router. */
  async lookup(b: z.output<typeof lookupBody>, ip: string) {
    const x = this.verify(b.t);
    const hit = await this.limiter.hit(`pay:lookup:${ip}`, 900);
    if (hit.count > LOOKUPS_PER_15_MIN) throw tooMany(hit.retryAfterSecs);
    const tenantId = new ObjectId(x.t);
    const login = b.login.trim();
    const digits = login.replace(/\D/g, '');
    const or: object[] = [{ username: login }, { customerNo: login.toUpperCase() }];
    if (digits.length >= 10) or.push({ phone: `+91${digits.slice(-10)}` });
    const candidates = await this.db
      .collection<SubscriberDoc>('subscribers')
      .find(
        { tenantId, status: { $ne: 'deleted' }, $or: or },
        { collation: { locale: 'en', strength: 2 }, limit: 5, projection: { _id: 1, username: 1 } },
      )
      .toArray();
    const nasIp = await this.nasOf(x);
    for (const c of candidates) {
      if (!c.username) continue;
      if ((await this.expiredOnline(tenantId, nasIp, 1, c.username)).length)
        return this.context(this.sign({ t: x.t, n: x.n, s: c._id.toHexString() }));
    }
    throw new AppError(
      404,
      'NOT_FOUND',
      'No connection with those details is online here. Check the username, or ask your provider.',
    );
  }

  /** Online payment link to renew the current plan. */
  async order(b: z.output<typeof orderBody>) {
    const x = this.verify(b.t);
    const s = await this.subscriber(x);
    if (!s) throw new AppError(400, 'VALIDATION_FAILED', 'Find your connection first');
    if (s.billingType !== 'prepaid' || !s.planId)
      throw new AppError(409, 'CONFLICT', 'Ask your provider to recharge this connection.');
    return this.portal.payFor(s, { planId: s.planId });
  }
}

@Controller('pay')
export class PayPageController {
  constructor(@Inject(PayPageService) private readonly s: PayPageService) {}

  @Get('entry')
  @Endpoint({
    summary: 'Walled-garden redirect target (router :8089): sends the browser to the pay page',
    tags: ['pay'],
    auth: 'public',
  })
  async entry(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const to = await this.s.entry(req.ip);
    void reply.header('cache-control', 'no-store').redirect(to, 302);
  }

  @Get('context')
  @Endpoint({
    summary: 'Pay page: provider, and the customer if known (masked)',
    tags: ['pay'],
    auth: 'public',
    query: tokenQuery,
    response: payContext,
  })
  context(@Query() q: z.output<typeof tokenQuery>) {
    return this.s.context(q.t);
  }

  @Post('lookup')
  @HttpCode(200)
  @Endpoint({
    summary: 'Pay page: find a customer online behind the same router',
    tags: ['pay'],
    auth: 'public',
    body: lookupBody,
    response: payContext,
  })
  lookup(@Body() b: z.output<typeof lookupBody>, @Req() req: FastifyRequest) {
    return this.s.lookup(b, req.ip);
  }

  @Post('order')
  @HttpCode(200)
  @Endpoint({
    summary: 'Pay page: payment link to renew the current plan',
    tags: ['pay'],
    auth: 'public',
    body: orderBody,
    response: paymentView,
  })
  order(@Body() b: z.output<typeof orderBody>) {
    return this.s.order(b);
  }
}
