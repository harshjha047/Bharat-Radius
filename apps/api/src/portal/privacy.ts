import { Body, Controller, Get, HttpCode, Inject, Injectable, Param, Post, Put, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { ObjectId } from 'mongodb';
import { z } from 'zod';
import { ScopedDb, type MongoHandle, type SubscriberDoc, type TenantDoc } from '@isp/db-mongo';
import { noteChange } from '../audit/audit.js';
import type { AuthContext } from '../auth/context.js';
import { AppError, notFound } from '../errors.js';
import { Ctx, Endpoint } from '../http/endpoint.js';
import { idParams } from '../http/schemas.js';
import { MONGO } from '../infra/infra.module.js';

/**
 * Starting point only: the ISP's lawyer must review it before go-live (DPDP Act 2023 notice: what is collected,
 * why, how long, rights, grievance contact). `{isp}`, `{phone}` and `{email}` are filled in when shown.
 */
export const DRAFT_NOTICE = `Privacy notice — {isp}

We collect your name, phone number, email, installation address, identity and address proof (KYC), and records of your internet sessions (login times, IP addresses, data used).

Why: to connect and bill your service, to support you, and because the Department of Telecommunications requires internet providers to verify customers and keep session records.

How long: session and KYC records are kept for the period the law requires after your connection ends; billing records as tax law requires. We do not sell your data.

Who sees it: our staff and, if you were connected through a local partner, that partner, only as needed for your service; payment and SMS providers for payments and messages; authorities when the law requires it.

Your rights: you may ask to see or correct your data, withdraw consent for anything not required by law, and ask for erasure after the legal retention period. Contact {isp} at {phone} {email}.

By accepting you consent to this processing.`;

const noticeBody = z.object({ text: z.string().trim().min(100).max(8000) });
const noticeView = z.object({
  text: z.string().nullable(),
  version: z.number(),
  updatedAt: z.string().nullable(),
  draft: z.string(),
});
const portalView = z.object({
  /** null: the ISP has not published a notice yet (nothing to accept). */
  text: z.string().nullable(),
  version: z.number(),
  acceptedVersion: z.number().nullable(),
  acceptedAt: z.string().nullable(),
  needsConsent: z.boolean(),
});
const recordBody = z.object({ via: z.enum(['caf', 'staff']), note: z.string().trim().max(200).optional() });
const consentView = z.object({
  version: z.number().nullable(),
  at: z.string().nullable(),
  via: z.enum(['portal', 'caf', 'staff']).nullable(),
  current: z.number(),
  upToDate: z.boolean(),
});

type Privacy = NonNullable<TenantDoc['privacy']>;

const fill = (text: string, t: Pick<TenantDoc, 'name' | 'contact'>) =>
  text
    .replaceAll('{isp}', t.name)
    .replaceAll('{phone}', t.contact?.phone ?? '')
    .replaceAll('{email}', t.contact?.email ?? '');

@Injectable()
export class PrivacyService {
  constructor(@Inject(MONGO) private readonly mongo: MongoHandle) {}

  private get db() {
    return this.mongo.db;
  }

  private tenant(id: ObjectId) {
    return this.db
      .collection<TenantDoc>('tenants')
      .findOne({ _id: id }, { projection: { name: 1, contact: 1, privacy: 1 } });
  }

  async notice(ctx: AuthContext) {
    const t = await this.tenant(ctx.tenantId!);
    if (!t) throw notFound('ISP');
    return {
      text: t.privacy?.notice ?? null,
      version: t.privacy?.version ?? 0,
      updatedAt: t.privacy?.updatedAt.toISOString() ?? null,
      draft: DRAFT_NOTICE,
    };
  }

  /** A new text is a new version: every customer is asked again at their next portal visit. */
  async publish(ctx: AuthContext, text: string) {
    const t = await this.tenant(ctx.tenantId!);
    if (!t) throw notFound('ISP');
    if (t.privacy?.notice === text) return this.notice(ctx);
    const privacy: Privacy = {
      notice: text,
      version: (t.privacy?.version ?? 0) + 1,
      updatedAt: new Date(),
      updatedBy: ctx.userId.toHexString(),
    };
    await this.db
      .collection<TenantDoc>('tenants')
      .updateOne({ _id: t._id }, { $set: { privacy, updatedAt: privacy.updatedAt }, $inc: { version: 1 } });
    noteChange({
      before: { version: t.privacy?.version ?? 0 },
      after: { version: privacy.version, length: text.length },
      entityId: t._id,
    });
    return this.notice(ctx);
  }

  private async self(ctx: AuthContext) {
    const s = await this.db
      .collection<SubscriberDoc>('subscribers')
      .findOne({ _id: ctx.subscriberId!, tenantId: ctx.tenantId!, status: { $ne: 'deleted' } });
    if (!s) throw notFound('Account');
    return s;
  }

  async portal(ctx: AuthContext) {
    const [s, t] = await Promise.all([this.self(ctx), this.tenant(ctx.tenantId!)]);
    const version = t?.privacy?.version ?? 0;
    return {
      text: t?.privacy ? fill(t.privacy.notice, t) : null,
      version,
      acceptedVersion: s.consent?.version ?? null,
      acceptedAt: s.consent?.at.toISOString() ?? null,
      needsConsent: version > 0 && (s.consent?.version ?? 0) < version,
    };
  }

  async accept(ctx: AuthContext, version: number, req: FastifyRequest) {
    const [s, t] = await Promise.all([this.self(ctx), this.tenant(ctx.tenantId!)]);
    const current = t?.privacy?.version ?? 0;
    if (!current) throw new AppError(409, 'CONFLICT', 'There is no privacy notice to accept');
    if (version !== current) throw new AppError(409, 'CONFLICT', 'The notice changed; read the new one');
    const consent: NonNullable<SubscriberDoc['consent']> = {
      version,
      at: new Date(),
      via: 'portal',
      ip: req.ip,
    };
    await this.db
      .collection<SubscriberDoc>('subscribers')
      .updateOne({ _id: s._id, tenantId: s.tenantId }, { $set: { consent } });
    noteChange({ before: { consent: s.consent ?? null }, after: { consent }, entityId: s._id });
    return this.portal(ctx);
  }

  async staffView(ctx: AuthContext, id: ObjectId) {
    const s = await new ScopedDb(this.db, ctx.scope)
      .collection<SubscriberDoc>('subscribers')
      .findOne({ _id: id, status: { $ne: 'deleted' } }, { projection: { consent: 1, tenantId: 1 } });
    if (!s) throw notFound('Subscriber');
    const t = await this.tenant(s.tenantId);
    const current = t?.privacy?.version ?? 0;
    return {
      version: s.consent?.version ?? null,
      at: s.consent?.at.toISOString() ?? null,
      via: s.consent?.via ?? null,
      current,
      upToDate: current === 0 || (s.consent?.version ?? 0) >= current,
    };
  }

  /** Consent given on paper (signed CAF) or in person, recorded by staff or the reseller. */
  async record(ctx: AuthContext, id: ObjectId, b: z.output<typeof recordBody>) {
    const s = await new ScopedDb(this.db, ctx.scope)
      .collection<SubscriberDoc>('subscribers')
      .findOne({ _id: id, status: { $ne: 'deleted' } });
    if (!s) throw notFound('Subscriber');
    const t = await this.tenant(s.tenantId);
    const version = t?.privacy?.version ?? 0;
    if (!version) throw new AppError(409, 'CONFLICT', 'Publish the privacy notice in ISP settings first');
    const consent: NonNullable<SubscriberDoc['consent']> = {
      version,
      at: new Date(),
      via: b.via,
      by: ctx.userId.toHexString(),
      ...(b.note ? { note: b.note } : {}),
    };
    await this.db
      .collection<SubscriberDoc>('subscribers')
      .updateOne({ _id: s._id, tenantId: s.tenantId }, { $set: { consent } });
    noteChange({ before: { consent: s.consent ?? null }, after: { consent }, entityId: s._id });
    return this.staffView(ctx, id);
  }
}

@Controller()
export class PrivacyController {
  constructor(@Inject(PrivacyService) private readonly s: PrivacyService) {}

  @Get('tenant/privacy')
  @Endpoint({
    summary: 'The privacy notice customers accept (DPDP), its version, and a draft to start from',
    tags: ['tenants'],
    permission: 'tenant.settings',
    response: noticeView,
  })
  notice(@Ctx() ctx: AuthContext) {
    return this.s.notice(ctx);
  }

  @Put('tenant/privacy')
  @Endpoint({
    summary: 'Publish the privacy notice; a changed text is a new version every customer is asked to accept',
    tags: ['tenants'],
    audit: 'tenant.privacy',
    permission: 'tenant.settings',
    body: noticeBody,
    response: noticeView,
  })
  publish(@Ctx() ctx: AuthContext, @Body() b: z.output<typeof noticeBody>) {
    return this.s.publish(ctx, b.text);
  }

  @Get('subscribers/:id/consent')
  @Endpoint({
    summary: 'Which privacy notice version the customer accepted, when and how',
    tags: ['subscribers'],
    permission: 'subscribers.read',
    params: idParams,
    response: consentView,
  })
  consent(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }) {
    return this.s.staffView(ctx, p.id);
  }

  @Post('subscribers/:id/consent')
  @HttpCode(200)
  @Endpoint({
    summary: 'Record consent given on the signed CAF or in person (current notice version)',
    tags: ['subscribers'],
    audit: 'subscriber.consent',
    permission: 'subscribers.write',
    params: idParams,
    body: recordBody,
    response: consentView,
  })
  record(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }, @Body() b: z.output<typeof recordBody>) {
    return this.s.record(ctx, p.id, b);
  }

  @Get('portal/privacy')
  @Endpoint({
    summary: 'The ISP privacy notice and whether I have accepted the current version',
    tags: ['portal'],
    auth: 'portal',
    response: portalView,
  })
  portal(@Ctx() ctx: AuthContext) {
    return this.s.portal(ctx);
  }

  @Post('portal/privacy/accept')
  @HttpCode(200)
  @Endpoint({
    summary: 'Accept the current privacy notice',
    tags: ['portal'],
    auth: 'portal',
    audit: 'subscriber.consent',
    body: z.object({ version: z.number().int().min(1) }),
    response: portalView,
  })
  accept(@Ctx() ctx: AuthContext, @Body() b: { version: number }, @Req() req: FastifyRequest) {
    return this.s.accept(ctx, b.version, req);
  }
}
