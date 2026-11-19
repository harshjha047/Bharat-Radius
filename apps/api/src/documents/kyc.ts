import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ObjectId } from 'mongodb';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import {
  ScopedDb,
  type KycDocumentDoc,
  type KycKind,
  type MongoHandle,
  type SubscriberDoc,
  type TenantDoc,
} from '@isp/db-mongo';
import { AuditService, noteChange } from '../audit/audit.js';
import type { AuthContext } from '../auth/context.js';
import { AppError, notFound } from '../errors.js';
import { Ctx, Endpoint } from '../http/endpoint.js';
import { idParams } from '../http/schemas.js';
import { MONGO } from '../infra/infra.module.js';
import { Files, sha256Hex, sniff, type FileType } from '../storage/storage.js';

export const KYC_KINDS = [
  'aadhaar',
  'pan',
  'voter_id',
  'passport',
  'driving_licence',
  'photo',
  'caf_signed',
  'address_proof',
  'other',
] as const satisfies readonly KycKind[];
export const KYC_TYPES: readonly FileType[] = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
export const MAX_KYC_BYTES = 5 * 1024 * 1024;
const MAX_DOCS = 30;

/** Paths that take a raw file body (checked in app.ts before the JSON-only rule). */
export const KYC_UPLOAD_PATH =
  /^\/api\/v1\/(subscribers\/[0-9a-f]{24}\/kyc\/documents|portal\/kyc\/documents)$/;

const uploadQuery = z.object({
  kind: z.enum(KYC_KINDS),
  /** Document number; stored masked (last 4 visible). Aadhaar: give only what you have, it is masked anyway. */
  number: z
    .string()
    .trim()
    .max(30)
    .regex(/^[A-Za-z0-9 -]*$/, 'letters, digits, spaces and dashes only')
    .optional(),
});
const portalUploadQuery = uploadQuery.pick({ kind: true });
const verifyBody = z.object({
  status: z.enum(['verified', 'rejected', 'pending']),
  note: z.string().trim().max(300).optional(),
  cafNo: z.string().trim().max(40).optional(),
});
const removeBody = z.object({ reason: z.string().trim().min(3).max(200) });

const docView = z.object({
  id: z.string(),
  kind: z.enum(KYC_KINDS),
  mimeType: z.string(),
  sizeBytes: z.number(),
  fileName: z.string().nullable(),
  maskedNumber: z.string().nullable(),
  uploadedVia: z.enum(['staff', 'reseller', 'portal', 'import']),
  createdAt: z.string(),
});
const kycView = z.object({
  status: z.enum(['pending', 'verified', 'rejected']),
  cafNo: z.string().nullable(),
  aadhaarLast4: z.string().nullable(),
  note: z.string().nullable(),
  decidedAt: z.string().nullable(),
  documents: z.array(docView),
  /** Kinds still missing for a complete file: identity proof, address proof, photo, signed CAF. */
  missing: z.array(z.string()),
  canView: z.boolean(),
  canUpload: z.boolean(),
  canVerify: z.boolean(),
});
const portalKycView = kycView.pick({ status: true, documents: true, missing: true });

const IDENTITY: readonly KycKind[] = ['aadhaar', 'pan', 'voter_id', 'passport', 'driving_licence'];
const ADDRESS: readonly KycKind[] = ['aadhaar', 'voter_id', 'passport', 'driving_licence', 'address_proof'];

export function missingKinds(kinds: ReadonlySet<KycKind>): string[] {
  const out: string[] = [];
  if (!IDENTITY.some((k) => kinds.has(k))) out.push('identity proof');
  if (!ADDRESS.some((k) => kinds.has(k))) out.push('address proof');
  if (!kinds.has('photo')) out.push('photo');
  if (!kinds.has('caf_signed')) out.push('signed CAF');
  return out;
}

/** Last 4 characters visible, the rest X, in groups of 4 (XXXX-XXXX-1234). */
export function maskNumber(raw: string): string | undefined {
  const c = raw.replace(/[\s-]/g, '').toUpperCase();
  if (!c) return undefined;
  const shown = c.slice(-4);
  const hidden = 'X'.repeat(Math.max(0, c.length - 4));
  return (hidden + shown).replace(/(.{4})(?=.)/g, '$1-');
}

const ext = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
} as const;

@Injectable()
export class KycService {
  constructor(
    @Inject(MONGO) private readonly mongo: MongoHandle,
    @Inject(Files) private readonly files: Files,
  ) {}

  private get db() {
    return this.mongo.db;
  }

  private docs = () => this.db.collection<KycDocumentDoc>('kyc_documents');

  /** The subscriber, if the caller's scope (ISP or branch) reaches it. */
  async subscriber(ctx: AuthContext, id: ObjectId): Promise<SubscriberDoc> {
    const s = await new ScopedDb(this.db, ctx.scope)
      .collection<SubscriberDoc>('subscribers')
      .findOne({ _id: id, status: { $ne: 'deleted' } });
    if (!s) throw notFound('Subscriber');
    return s;
  }

  private async active(s: SubscriberDoc) {
    return this.docs()
      .find(
        { tenantId: s.tenantId, subscriberId: s._id, removed: { $exists: false } },
        { sort: { createdAt: -1 } },
      )
      .toArray();
  }

  private toView = (d: KycDocumentDoc): z.output<typeof docView> => ({
    id: d._id.toHexString(),
    kind: d.kind,
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    fileName: d.fileName ?? null,
    maskedNumber: d.maskedNumber ?? null,
    uploadedVia: d.uploadedVia,
    createdAt: d.createdAt.toISOString(),
  });

  async view(ctx: AuthContext | null, s: SubscriberDoc): Promise<z.output<typeof kycView>> {
    const docs = await this.active(s);
    const p = ctx?.permissions;
    return {
      status: s.kyc.status,
      cafNo: s.kyc.cafNo ?? null,
      aadhaarLast4: s.kyc.aadhaarLast4 ?? null,
      note: s.kyc.note ?? null,
      decidedAt: s.kyc.decidedAt?.toISOString() ?? null,
      documents: docs.map(this.toView),
      missing: missingKinds(new Set(docs.map((d) => d.kind))),
      canView: !!p?.has('kyc.view'),
      canUpload: !!p?.has('kyc.upload'),
      canVerify: !!p?.has('kyc.verify'),
    };
  }

  /** Stores one file (type checked by content), encrypted, under kyc/<tenant>/<subscriber>/<doc>.<ext>. */
  async upload(
    actor: string,
    via: KycDocumentDoc['uploadedVia'],
    s: SubscriberDoc,
    body: unknown,
    q: { kind: KycKind; number?: string | undefined },
    fileName?: string,
  ) {
    if (!Buffer.isBuffer(body) || body.length === 0)
      throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the file itself (JPEG, PNG, WebP or PDF)');
    if (body.length > MAX_KYC_BYTES) throw new AppError(413, 'VALIDATION_FAILED', 'Files up to 5 MB');
    const type = sniff(body, KYC_TYPES);
    if (!type) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Only JPEG, PNG, WebP or PDF files');
    const count = await this.docs().countDocuments({
      tenantId: s.tenantId,
      subscriberId: s._id,
      removed: { $exists: false },
    });
    if (count >= MAX_DOCS) throw new AppError(409, 'CONFLICT', `At most ${MAX_DOCS} documents per customer`);
    const id = new ObjectId();
    const key = `kyc/${s.tenantId.toHexString()}/${s._id.toHexString()}/${id.toHexString()}.${ext[type as keyof typeof ext]}`;
    await this.files.put(key, body);
    const masked = q.number ? maskNumber(q.number) : undefined;
    const doc: KycDocumentDoc = {
      _id: id,
      tenantId: s.tenantId,
      subscriberId: s._id,
      ancestors: s.ancestors,
      kind: q.kind,
      storageKey: key,
      sha256: sha256Hex(body),
      mimeType: type,
      sizeBytes: body.length,
      ...(fileName ? { fileName: fileName.replace(/[^\w .()-]/g, '_').slice(0, 120) } : {}),
      ...(masked ? { maskedNumber: masked } : {}),
      uploadedBy: actor,
      uploadedVia: via,
      createdAt: new Date(),
    };
    try {
      await this.docs().insertOne(doc);
    } catch (e) {
      await this.files.delete(key).catch(() => undefined);
      throw e;
    }
    if (q.kind === 'aadhaar' && masked) {
      await this.db
        .collection<SubscriberDoc>('subscribers')
        .updateOne({ _id: s._id, tenantId: s.tenantId }, { $set: { 'kyc.aadhaarLast4': masked.slice(-4) } });
    }
    noteChange({
      after: {
        documentId: id.toHexString(),
        kind: doc.kind,
        sha256: doc.sha256,
        maskedNumber: masked ?? null,
      },
      entityId: s._id,
    });
    return this.toView(doc);
  }

  async staffUpload(
    ctx: AuthContext,
    id: ObjectId,
    body: unknown,
    q: z.output<typeof uploadQuery>,
    name?: string,
  ) {
    const s = await this.subscriber(ctx, id);
    return this.upload(
      ctx.userId.toHexString(),
      ctx.type === 'reseller' ? 'reseller' : 'staff',
      s,
      body,
      q,
      name,
    );
  }

  /** The decrypted file; the caller logs who opened it. */
  async file(ctx: AuthContext, docId: ObjectId) {
    const d = await new ScopedDb(this.db, ctx.scope)
      .collection<KycDocumentDoc>('kyc_documents')
      .findOne({ _id: docId, removed: { $exists: false } });
    if (!d) throw notFound('Document');
    const data = await this.files.get(d.storageKey);
    if (!data) throw new AppError(410, 'NOT_FOUND', 'The file is missing from storage');
    return { d, data };
  }

  async remove(ctx: AuthContext, docId: ObjectId, reason: string) {
    const d = await new ScopedDb(this.db, ctx.scope)
      .collection<KycDocumentDoc>('kyc_documents')
      .findOne({ _id: docId, removed: { $exists: false } });
    if (!d) throw notFound('Document');
    const removed = { by: ctx.userId.toHexString(), at: new Date(), reason };
    await this.docs().updateOne({ _id: d._id, removed: { $exists: false } }, { $set: { removed } });
    await this.files.delete(d.storageKey);
    noteChange({ before: { kind: d.kind, sha256: d.sha256 }, after: { removed }, entityId: d.subscriberId });
    return { ok: true as const };
  }

  async verify(ctx: AuthContext, id: ObjectId, b: z.output<typeof verifyBody>) {
    const s = await this.subscriber(ctx, id);
    if (b.status === 'verified') {
      const missing = missingKinds(new Set((await this.active(s)).map((d) => d.kind)));
      if (missing.length)
        throw new AppError(400, 'VALIDATION_FAILED', `Cannot verify: missing ${missing.join(', ')}`);
    }
    if (b.status === 'rejected' && !b.note)
      throw new AppError(400, 'VALIDATION_FAILED', 'Give the reason for rejecting');
    const kyc: SubscriberDoc['kyc'] = {
      ...s.kyc,
      status: b.status,
      ...(b.cafNo ? { cafNo: b.cafNo } : {}),
      decidedBy: ctx.userId.toHexString(),
      decidedAt: new Date(),
    };
    if (b.note) kyc.note = b.note;
    else delete kyc.note;
    await this.db
      .collection<SubscriberDoc>('subscribers')
      .updateOne(
        { _id: s._id, tenantId: s.tenantId },
        { $set: { kyc, updatedAt: new Date(), updatedBy: ctx.userId.toHexString() }, $inc: { version: 1 } },
      );
    noteChange({ before: { kyc: s.kyc }, after: { kyc }, entityId: s._id });
    return this.view(ctx, { ...s, kyc });
  }

  /** CAF number, assigned once per subscriber: CAF/<customerNo>. */
  private async cafNo(s: SubscriberDoc): Promise<string> {
    if (s.kyc.cafNo) return s.kyc.cafNo;
    const no = `CAF/${s.customerNo}`;
    await this.db
      .collection<SubscriberDoc>('subscribers')
      .updateOne(
        { _id: s._id, tenantId: s.tenantId, 'kyc.cafNo': { $exists: false } },
        { $set: { 'kyc.cafNo': no } },
      );
    return no;
  }

  /** Customer Application Form, pre-filled, to print, sign and upload back as `caf_signed`. */
  async caf(ctx: AuthContext, id: ObjectId): Promise<{ name: string; data: Buffer }> {
    const s = await this.subscriber(ctx, id);
    const [tenant, plan] = await Promise.all([
      this.db.collection<TenantDoc>('tenants').findOne({ _id: s.tenantId }),
      s.planId
        ? this.db
            .collection<{ _id: ObjectId; name: string }>('plans')
            .findOne({ _id: s.planId }, { projection: { name: 1 } })
        : null,
    ]);
    const no = await this.cafNo(s);
    const data = await renderCaf({
      isp: {
        name: tenant?.legalName || tenant?.name || '',
        address: tenant
          ? [
              tenant.address.line1,
              tenant.address.line2,
              tenant.address.city,
              tenant.address.state,
              tenant.address.pincode,
            ]
              .filter(Boolean)
              .join(', ')
          : '',
        gstin: tenant?.gstin ?? null,
      },
      cafNo: no,
      customerNo: s.customerNo,
      name: s.name,
      phone: s.phone,
      altPhone: s.altPhone ?? '',
      email: s.email ?? '',
      address: [
        s.address.line1,
        s.address.line2,
        s.address.city,
        s.address.district,
        s.address.state,
        s.address.pincode,
      ]
        .filter(Boolean)
        .join(', '),
      username: s.username ?? '',
      plan: plan?.name ?? '',
      aadhaar: s.kyc.aadhaarLast4 ? `XXXX-XXXX-${s.kyc.aadhaarLast4}` : '',
      date: new Date(),
    });
    return { name: `${no.replace(/\//g, '-')}.pdf`, data };
  }

  /* ---------- portal (the customer, own file only, upload only) ---------- */

  private async portalSelf(ctx: AuthContext) {
    const s = await this.db
      .collection<SubscriberDoc>('subscribers')
      .findOne({ _id: ctx.subscriberId!, tenantId: ctx.tenantId!, status: { $ne: 'deleted' } });
    if (!s) throw notFound('Account');
    return s;
  }

  async portalView(ctx: AuthContext) {
    const v = await this.view(null, await this.portalSelf(ctx));
    return { status: v.status, documents: v.documents, missing: v.missing };
  }

  async portalUpload(ctx: AuthContext, body: unknown, q: z.output<typeof portalUploadQuery>, name?: string) {
    const s = await this.portalSelf(ctx);
    if (s.kyc.status === 'verified')
      throw new AppError(409, 'CONFLICT', 'Your KYC is already verified; contact your ISP to change it');
    return this.upload(`subscriber:${s._id.toHexString()}`, 'portal', s, body, q, name);
  }
}

const IST = 330 * 60_000;
const istDate = (d: Date) =>
  new Date(d.getTime() + IST).toISOString().slice(0, 10).split('-').reverse().join('-');

interface CafData {
  isp: { name: string; address: string; gstin: string | null };
  cafNo: string;
  customerNo: string;
  name: string;
  phone: string;
  altPhone: string;
  email: string;
  address: string;
  username: string;
  plan: string;
  aadhaar: string;
  date: Date;
}

export function renderCaf(c: CafData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 40,
      info: { Title: `Customer Application Form ${c.cafNo}` },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (b: Buffer) => chunks.push(b));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const W = doc.page.width - 80;
    doc.font('Helvetica-Bold').fontSize(14).text(c.isp.name);
    doc.font('Helvetica').fontSize(9).text(c.isp.address, { width: 330 });
    if (c.isp.gstin) doc.text(`GSTIN: ${c.isp.gstin}`);
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(13).text('CUSTOMER APPLICATION FORM (CAF)', { align: 'center' });
    doc
      .font('Helvetica')
      .fontSize(9)
      .text(`CAF No. ${c.cafNo}    Customer No. ${c.customerNo}    Date ${istDate(c.date)}`, {
        align: 'center',
      });
    // Photo box
    const photoTop = doc.y + 10;
    doc.rect(40 + W - 100, photoTop, 100, 120).stroke();
    doc.fontSize(8).text('Affix recent passport-size photo and sign across', 40 + W - 96, photoTop + 50, {
      width: 92,
      align: 'center',
    });
    doc.y = photoTop;
    const row = (label: string, value: string) => {
      const y = doc.y + 6;
      doc.font('Helvetica-Bold').fontSize(9).text(label, 40, y, { width: 150 });
      doc.font('Helvetica').text(value || ' ', 195, y, { width: W - 310 });
      const end = Math.max(doc.y, y + 12);
      doc
        .moveTo(195, end + 2)
        .lineTo(40 + W - 110, end + 2)
        .dash(1, { space: 2 })
        .stroke()
        .undash();
      doc.y = end + 2;
    };
    row('Name of applicant', c.name);
    row("Father's / Husband's name", '');
    row('Date of birth', '');
    row('Installation address', c.address);
    row('Mobile', c.phone);
    row('Alternate mobile', c.altPhone);
    row('Email', c.email);
    doc.y = Math.max(doc.y, photoTop + 130);
    const full = (label: string, value: string) => {
      const y = doc.y + 6;
      doc.font('Helvetica-Bold').fontSize(9).text(label, 40, y, { width: 150 });
      doc.font('Helvetica').text(value || ' ', 195, y, { width: W - 155 });
      const end = Math.max(doc.y, y + 12);
      doc
        .moveTo(195, end + 2)
        .lineTo(40 + W, end + 2)
        .dash(1, { space: 2 })
        .stroke()
        .undash();
      doc.y = end + 2;
    };
    full('Service', 'Broadband internet (PPPoE)');
    full('Plan', c.plan);
    full('Username', c.username);
    full('Proof of identity (type, no.)', c.aadhaar ? `Aadhaar ${c.aadhaar}` : '');
    full('Proof of address (type, no.)', '');
    full('Nationality', 'Indian');
    doc.moveDown(1.2);
    doc.font('Helvetica-Bold').fontSize(10).text('Declaration', 40);
    doc
      .font('Helvetica')
      .fontSize(8.5)
      .text(
        'I declare that the particulars given above are true and that the attached documents are mine. I will not ' +
          'use the connection for any unlawful purpose, resell or share it outside the installation address, and I ' +
          'accept that usage and connection records are kept as required by the Department of Telecommunications. ' +
          'I consent to my personal data being processed by the service provider to provide, bill and support this ' +
          'service and to meet legal obligations; I may ask for it to be corrected or erased where the law allows.',
        { width: W, align: 'justify' },
      );
    doc.moveDown(3);
    const sy = doc.y;
    doc.moveTo(40, sy).lineTo(220, sy).stroke();
    doc
      .moveTo(40 + W - 180, sy)
      .lineTo(40 + W, sy)
      .stroke();
    doc.fontSize(8.5).text('Signature of applicant', 40, sy + 4);
    doc.text('Verified by (name, signature, date)', 40 + W - 180, sy + 4, { width: 180 });
    doc.moveDown(2);
    doc
      .fontSize(7.5)
      .fillColor('#555')
      .text(
        'Attach self-attested copies of identity and address proof. Upload the signed form to the customer record.',
        40,
        undefined,
        {
          width: W,
          align: 'center',
        },
      );
    doc.end();
  });
}

const fileNameOf = (req: FastifyRequest) => {
  const raw = req.headers['x-file-name'];
  if (typeof raw !== 'string') return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
};

@Controller()
export class KycController {
  constructor(
    @Inject(KycService) private readonly s: KycService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get('subscribers/:id/kyc')
  @Endpoint({
    access: 'subscriber',
    summary: 'KYC status, CAF number and the list of documents (no files)',
    tags: ['kyc'],
    permission: 'subscribers.read',
    params: idParams,
    response: kycView,
  })
  async get(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }) {
    return this.s.view(ctx, await this.s.subscriber(ctx, p.id));
  }

  /** Body: the file itself (Content-Type image/jpeg, image/png, image/webp or application/pdf), up to 5 MB. */
  @Post('subscribers/:id/kyc/documents')
  @Endpoint({
    summary: 'Upload one KYC / CAF document (type checked by content; stored encrypted)',
    tags: ['kyc'],
    audit: 'kyc.upload',
    permission: 'kyc.upload',
    params: idParams,
    query: uploadQuery,
    response: docView,
  })
  upload(
    @Ctx() ctx: AuthContext,
    @Param() p: { id: ObjectId },
    @Query() q: z.output<typeof uploadQuery>,
    @Req() req: FastifyRequest,
  ) {
    return this.s.staffUpload(ctx, p.id, req.body, q, fileNameOf(req));
  }

  @Get('kyc-documents/:id/file')
  @Endpoint({
    summary: 'Open one document (every view is written to the audit log)',
    tags: ['kyc'],
    permission: 'kyc.view',
    params: idParams,
  })
  async file(
    @Ctx() ctx: AuthContext,
    @Param() p: { id: ObjectId },
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const { d, data } = await this.s.file(ctx, p.id);
    await this.audit.record({
      tenantId: d.tenantId,
      actor: { id: ctx.userId.toHexString(), type: ctx.type, name: ctx.name },
      action: 'kyc.view',
      entity: { type: 'subscriber', id: d.subscriberId.toHexString() },
      after: { documentId: d._id.toHexString(), kind: d.kind },
      req,
    });
    void reply
      .header('content-type', d.mimeType)
      .header('content-disposition', `inline; filename="${d.kind}-${d._id.toHexString()}"`)
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .header(
        'content-security-policy',
        "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      )
      .send(data);
  }

  @Post('kyc-documents/:id/remove')
  @HttpCode(200)
  @Endpoint({
    summary: 'Remove a wrong document (file deleted; the record stays for the audit trail)',
    tags: ['kyc'],
    audit: 'kyc.remove',
    permission: 'kyc.verify',
    params: idParams,
    body: removeBody,
    response: z.object({ ok: z.literal(true) }),
  })
  remove(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }, @Body() b: z.output<typeof removeBody>) {
    return this.s.remove(ctx, p.id, b.reason);
  }

  @Post('subscribers/:id/kyc/verify')
  @HttpCode(200)
  @Endpoint({
    summary:
      'Mark KYC verified (needs identity, address, photo, signed CAF), rejected (with reason) or pending',
    tags: ['kyc'],
    audit: 'kyc.verify',
    permission: 'kyc.verify',
    params: idParams,
    body: verifyBody,
    response: kycView,
  })
  verify(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }, @Body() b: z.output<typeof verifyBody>) {
    return this.s.verify(ctx, p.id, b);
  }

  @Get('subscribers/:id/caf')
  @Endpoint({
    access: 'subscriber',
    summary: 'Pre-filled Customer Application Form (PDF) to print and sign; assigns the CAF number once',
    tags: ['kyc'],
    permission: 'subscribers.read',
    params: idParams,
  })
  async caf(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }, @Res() reply: FastifyReply) {
    const { name, data } = await this.s.caf(ctx, p.id);
    void reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="${name}"`)
      .header('cache-control', 'private, no-store')
      .send(data);
  }

  @Get('portal/kyc')
  @Endpoint({
    summary: 'My KYC status and uploaded documents',
    tags: ['portal'],
    auth: 'portal',
    response: portalKycView,
  })
  portalGet(@Ctx() ctx: AuthContext) {
    return this.s.portalView(ctx);
  }

  @Post('portal/kyc/documents')
  @Endpoint({
    summary: 'Upload one of my KYC documents (raw file body, up to 5 MB)',
    tags: ['portal'],
    auth: 'portal',
    audit: 'kyc.upload',
    query: portalUploadQuery,
    response: docView,
  })
  portalUpload(
    @Ctx() ctx: AuthContext,
    @Query() q: z.output<typeof portalUploadQuery>,
    @Req() req: FastifyRequest,
  ) {
    return this.s.portalUpload(ctx, req.body, q, fileNameOf(req));
  }
}
