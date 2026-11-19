import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Injectable,
  Param,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { ScopedDb, type MongoHandle, type ResellerDoc } from '@isp/db-mongo';
import { noteChange } from '../audit/audit.js';
import type { AuthContext } from '../auth/context.js';
import { AppError, notFound } from '../errors.js';
import { Ctx, Endpoint } from '../http/endpoint.js';
import { idParams } from '../http/schemas.js';
import { MONGO } from '../infra/infra.module.js';
import { Files, sha256Hex, sniff, type FileType } from '../storage/storage.js';

export const LOGO_UPLOAD_PATH = /^\/api\/v1\/resellers\/[0-9a-f]{24}\/branding\/logo$/;
const LOGO_TYPES: readonly FileType[] = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_LOGO_BYTES = 512 * 1024;

export const brandingView = z.object({
  /** Shown instead of the ISP name in the panel header and to customers. */
  name: z.string().nullable(),
  /** Public, cache-busted URL; null = no logo. */
  logoUrl: z.string().nullable(),
  /** Reseller the branding comes from (itself or the nearest parent that set one). */
  fromResellerId: z.string().nullable(),
});
export type BrandingView = z.output<typeof brandingView>;

const ownView = z.object({
  name: z.string().nullable(),
  logoUrl: z.string().nullable(),
  effective: brandingView,
});
const nameBody = z.object({ name: z.string().trim().max(60).nullable() });

const logoUrl = (r: Pick<ResellerDoc, '_id' | 'branding'>) =>
  r.branding?.logo
    ? `/api/v1/branding/${r._id.toHexString()}/logo?v=${r.branding.logo.sha256.slice(0, 12)}`
    : null;

/** Nearest own-or-parent branding for a reseller chain (root → … → reseller). One query. */
export async function effectiveBranding(
  db: MongoHandle['db'],
  tenantId: ObjectId,
  chain: readonly ObjectId[],
): Promise<BrandingView | null> {
  if (!chain.length) return null;
  const rs = await db
    .collection<ResellerDoc>('resellers')
    .find(
      { _id: { $in: [...chain] }, tenantId, branding: { $exists: true } },
      { projection: { branding: 1 } },
    )
    .toArray();
  const by = new Map(rs.map((r) => [r._id.toHexString(), r]));
  for (const id of [...chain].reverse()) {
    const r = by.get(id.toHexString());
    if (r?.branding && (r.branding.name || r.branding.logo)) {
      return { name: r.branding.name ?? null, logoUrl: logoUrl(r), fromResellerId: r._id.toHexString() };
    }
  }
  return null;
}

@Injectable()
export class BrandingService {
  constructor(
    @Inject(MONGO) private readonly mongo: MongoHandle,
    @Inject(Files) private readonly files: Files,
  ) {}

  private get db() {
    return this.mongo.db;
  }

  /** Staff: any reseller of the ISP. Reseller: itself or a reseller below it. */
  private async reseller(ctx: AuthContext, id: ObjectId) {
    const r = await new ScopedDb(this.db, ctx.scope)
      .collection<ResellerDoc>('resellers')
      .findOne({ _id: id });
    if (!r) throw notFound('Reseller');
    return r;
  }

  private async view(r: ResellerDoc) {
    return {
      name: r.branding?.name ?? null,
      logoUrl: logoUrl(r),
      effective: (await effectiveBranding(this.db, r.tenantId, [...r.ancestors, r._id])) ?? {
        name: null,
        logoUrl: null,
        fromResellerId: null,
      },
    };
  }

  async get(ctx: AuthContext, id: ObjectId) {
    return this.view(await this.reseller(ctx, id));
  }

  private async save(ctx: AuthContext, r: ResellerDoc, branding: ResellerDoc['branding']) {
    const set = { updatedAt: new Date(), updatedBy: ctx.userId.toHexString() };
    const empty = !branding?.name && !branding?.logo;
    await this.db
      .collection<ResellerDoc>('resellers')
      .updateOne(
        { _id: r._id, tenantId: r.tenantId },
        empty
          ? { $set: set, $unset: { branding: '' }, $inc: { version: 1 } }
          : { $set: { ...set, branding }, $inc: { version: 1 } },
      );
    noteChange({
      before: { branding: r.branding ?? null },
      after: { branding: empty ? null : branding },
      entityId: r._id,
    });
    const next: ResellerDoc = { ...r };
    if (empty) delete next.branding;
    else next.branding = branding;
    return this.view(next);
  }

  async setName(ctx: AuthContext, id: ObjectId, name: string | null) {
    const r = await this.reseller(ctx, id);
    const b = { ...(r.branding ?? {}) };
    if (name) b.name = name;
    else delete b.name;
    return this.save(ctx, r, b);
  }

  async setLogo(ctx: AuthContext, id: ObjectId, body: unknown) {
    const r = await this.reseller(ctx, id);
    if (!Buffer.isBuffer(body) || !body.length)
      throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the image itself (PNG, JPEG or WebP)');
    if (body.length > MAX_LOGO_BYTES) throw new AppError(413, 'VALIDATION_FAILED', 'Logo up to 512 KB');
    const type = sniff(body, LOGO_TYPES);
    if (!type) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Logo must be PNG, JPEG or WebP');
    const sha256 = sha256Hex(body);
    const key = `branding/${r.tenantId.toHexString()}/${r._id.toHexString()}/${sha256.slice(0, 16)}`;
    await this.files.put(key, body);
    const old = r.branding?.logo?.key;
    const v = await this.save(ctx, r, { ...(r.branding ?? {}), logo: { key, mimeType: type, sha256 } });
    if (old && old !== key) await this.files.delete(old).catch(() => undefined);
    return v;
  }

  async removeLogo(ctx: AuthContext, id: ObjectId) {
    const r = await this.reseller(ctx, id);
    const b = { ...(r.branding ?? {}) };
    const old = b.logo?.key;
    delete b.logo;
    const v = await this.save(ctx, r, b);
    if (old) await this.files.delete(old).catch(() => undefined);
    return v;
  }

  /** Public: logos are shown on login and portal pages and are not personal data. */
  async logo(id: ObjectId) {
    const r = await this.db
      .collection<ResellerDoc>('resellers')
      .findOne({ _id: id, 'branding.logo': { $exists: true } }, { projection: { branding: 1 } });
    const l = r?.branding?.logo;
    if (!l) throw notFound('Logo');
    const data = await this.files.get(l.key);
    if (!data) throw notFound('Logo');
    return { data, mimeType: l.mimeType, etag: `"${l.sha256.slice(0, 32)}"` };
  }
}

@Controller()
export class BrandingController {
  constructor(@Inject(BrandingService) private readonly s: BrandingService) {}

  @Get('resellers/:id/branding')
  @Endpoint({
    summary: 'Name and logo set on this reseller, and what its panel and customers actually see',
    tags: ['resellers'],
    permission: 'resellers.read',
    params: idParams,
    response: ownView,
  })
  get(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }) {
    return this.s.get(ctx, p.id);
  }

  @Put('resellers/:id/branding')
  @Endpoint({
    summary: 'Set (or clear with null) the name shown to this reseller and its customers',
    tags: ['resellers'],
    audit: 'reseller.branding',
    permission: 'branding.manage',
    params: idParams,
    body: nameBody,
    response: ownView,
  })
  setName(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }, @Body() b: z.output<typeof nameBody>) {
    return this.s.setName(ctx, p.id, b.name);
  }

  /** Body: the image itself (Content-Type image/png, image/jpeg or image/webp), up to 512 KB. */
  @Put('resellers/:id/branding/logo')
  @Endpoint({
    summary: 'Upload this reseller’s logo',
    tags: ['resellers'],
    audit: 'reseller.branding',
    permission: 'branding.manage',
    params: idParams,
    response: ownView,
  })
  setLogo(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }, @Req() req: FastifyRequest) {
    return this.s.setLogo(ctx, p.id, req.body);
  }

  @Delete('resellers/:id/branding/logo')
  @Endpoint({
    summary: 'Remove this reseller’s logo',
    tags: ['resellers'],
    audit: 'reseller.branding',
    permission: 'branding.manage',
    params: idParams,
    response: ownView,
  })
  removeLogo(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }) {
    return this.s.removeLogo(ctx, p.id);
  }

  @Get('branding/:id/logo')
  @Endpoint({
    summary: 'Reseller logo image (public, cached; ?v= changes with the image)',
    tags: ['resellers'],
    auth: 'public',
    params: idParams,
    query: z.object({ v: z.string().max(40).optional() }),
  })
  async logo(
    @Param() p: { id: ObjectId },
    @Query() q: { v?: string },
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const l = await this.s.logo(p.id);
    void reply
      .header('etag', l.etag)
      .header('cache-control', q.v ? 'public, max-age=31536000, immutable' : 'public, max-age=300')
      .header('x-content-type-options', 'nosniff');
    if (req.headers['if-none-match'] === l.etag) return void reply.status(304).send();
    void reply.header('content-type', l.mimeType).send(l.data);
  }
}
