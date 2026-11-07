import { Body, Controller, Get, HttpCode, Inject, Injectable, Param, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ObjectId, type Filter } from 'mongodb';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import {
  ScopedDb,
  issueCreditNote,
  istDate,
  rupees,
  type BillingTenant,
  type CreditNoteDoc,
  type InvoiceDoc,
  type MongoHandle,
  type SubscriberDoc,
} from '@isp/db-mongo';
import { noteChange } from '../audit/audit.js';
import type { AuthContext } from '../auth/context.js';
import { AppError, notFound } from '../errors.js';
import { Ctx, Endpoint } from '../http/endpoint.js';
import { hexId, idParams, page, pageOf, pageQuery } from '../http/schemas.js';
import { MONGO } from '../infra/infra.module.js';
import { Outbox } from '../sync/outbox.js';
import { assertStaff, istDayRange, requireTenant } from './common.js';

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date in YYYY-MM-DD form');
const listQuery = pageQuery.extend({
  subscriberId: hexId.optional(),
  status: z.enum(['issued', 'partially_paid', 'paid', 'overdue', 'cancelled', 'unpaid']).optional(),
  type: z.enum(['prepaid_recharge', 'postpaid_monthly']).optional(),
  from: isoDay.optional(),
  to: isoDay.optional(),
  q: z.string().trim().min(1).max(20).optional(),
});
const party = z.object({
  name: z.string(),
  gstin: z.string().optional(),
  stateCode: z.string(),
  address: z.string(),
});
const line = z.object({
  description: z.string(),
  hsnSac: z.string(),
  qty: z.number(),
  ratePaise: z.number(),
  taxablePaise: z.number(),
  gstRatePercent: z.number(),
  cgstPaise: z.number(),
  sgstPaise: z.number(),
  igstPaise: z.number(),
  totalPaise: z.number(),
});
const totals = {
  taxablePaise: z.number(),
  cgstPaise: z.number(),
  sgstPaise: z.number(),
  igstPaise: z.number(),
  roundOffPaise: z.number(),
  totalPaise: z.number(),
};
const invoiceView = z.object({
  id: z.string(),
  number: z.string(),
  type: z.enum(['prepaid_recharge', 'postpaid_monthly']),
  subscriber: z.object({ id: z.string(), name: z.string(), customerNo: z.string() }),
  issueDate: z.string(),
  dueDate: z.string(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  ...totals,
  paidPaise: z.number(),
  creditedPaise: z.number(),
  balancePaise: z.number(),
  status: z.enum(['issued', 'partially_paid', 'paid', 'overdue', 'cancelled']),
});
const detailView = invoiceView.extend({
  seller: party,
  buyer: party,
  placeOfSupply: z.string(),
  lines: z.array(line),
  creditNote: z
    .object({ id: z.string(), number: z.string(), reason: z.string(), createdAt: z.string() })
    .nullable(),
});
const creditBody = z.object({ reason: z.string().trim().min(5).max(200) });

@Injectable()
export class InvoicesService {
  constructor(
    @Inject(MONGO) private readonly mongo: MongoHandle,
    @Inject(Outbox) private readonly outbox: Outbox,
  ) {}

  private scoped(ctx: AuthContext) {
    return new ScopedDb(this.mongo.db, ctx.scope);
  }

  private async subs(docs: { subscriberId: ObjectId }[]) {
    const ids = [...new Set(docs.map((d) => d.subscriberId.toHexString()))].map((x) => new ObjectId(x));
    const rows = await this.mongo.db
      .collection<SubscriberDoc>('subscribers')
      .find({ _id: { $in: ids } }, { projection: { name: 1, customerNo: 1 } })
      .toArray();
    return new Map(rows.map((r) => [r._id.toHexString(), r]));
  }

  private view(d: InvoiceDoc, s?: Pick<SubscriberDoc, 'name' | 'customerNo'>): z.output<typeof invoiceView> {
    return {
      id: d._id.toHexString(),
      number: d.number,
      type: d.type,
      subscriber: {
        id: d.subscriberId.toHexString(),
        name: s?.name ?? d.buyer.name,
        customerNo: s?.customerNo ?? '',
      },
      issueDate: d.issueDate.toISOString(),
      dueDate: d.dueDate.toISOString(),
      periodStart: d.periodStart?.toISOString() ?? null,
      periodEnd: d.periodEnd?.toISOString() ?? null,
      taxablePaise: d.taxablePaise,
      cgstPaise: d.cgstPaise,
      sgstPaise: d.sgstPaise,
      igstPaise: d.igstPaise,
      roundOffPaise: d.roundOffPaise,
      totalPaise: d.totalPaise,
      paidPaise: d.paidPaise,
      creditedPaise: d.creditedPaise,
      balancePaise: d.balancePaise,
      status: d.status,
    };
  }

  async list(ctx: AuthContext, q: z.output<typeof listQuery>) {
    const f: Filter<InvoiceDoc> = {};
    if (q.subscriberId) f.subscriberId = new ObjectId(q.subscriberId);
    if (q.status === 'unpaid') f.status = { $in: ['issued', 'partially_paid', 'overdue'] };
    else if (q.status) f.status = q.status;
    if (q.type) f.type = q.type;
    if (q.q) f.number = { $regex: `^${q.q.replace(/[^A-Za-z0-9/]/g, '')}`, $options: 'i' };
    const range = istDayRange(q.from, q.to);
    if (range) f.issueDate = range;
    if (q.cursor) f._id = { $lt: new ObjectId(q.cursor) };
    const docs = await this.scoped(ctx)
      .collection<InvoiceDoc>('invoices')
      .find(f, { sort: { _id: -1 }, limit: q.limit + 1 })
      .toArray();
    const subs = await this.subs(docs.slice(0, q.limit));
    return pageOf(docs, q.limit, (d) => this.view(d, subs.get(d.subscriberId.toHexString())));
  }

  async find(ctx: AuthContext, id: ObjectId) {
    const d = await this.scoped(ctx).collection<InvoiceDoc>('invoices').findOne({ _id: id });
    if (!d) throw notFound('Invoice');
    return d;
  }

  async get(ctx: AuthContext, id: ObjectId) {
    const d = await this.find(ctx, id);
    const [subs, cn] = await Promise.all([
      this.subs([d]),
      this.mongo.db.collection<CreditNoteDoc>('credit_notes').findOne({ invoiceId: d._id }),
    ]);
    return {
      ...this.view(d, subs.get(d.subscriberId.toHexString())),
      seller: d.seller,
      buyer: d.buyer,
      placeOfSupply: d.placeOfSupply,
      lines: d.lines,
      creditNote: cn
        ? {
            id: cn._id.toHexString(),
            number: cn.number,
            reason: cn.reason,
            createdAt: cn.createdAt.toISOString(),
          }
        : null,
    };
  }

  async creditNote(ctx: AuthContext, id: ObjectId, reason: string) {
    assertStaff(ctx, 'issue credit notes');
    const inv = await this.find(ctx, id);
    if (inv.rechargeId) {
      throw new AppError(
        409,
        'CONFLICT',
        'Refund the recharge instead: that also credits the wallet and the expiry',
      );
    }
    const tenant = (await this.mongo.db
      .collection<BillingTenant>('tenants')
      .findOne({ _id: requireTenant(ctx) }))!;
    const cn = await this.outbox.tx((session) =>
      issueCreditNote(this.mongo.db, session, {
        tenant,
        invoice: inv,
        reason,
        actor: ctx.userId.toHexString(),
      }),
    );
    noteChange({ after: cn, entityId: inv._id });
    return this.get(ctx, id);
  }

  /** A4 GST tax invoice (or credit note) rendered on demand from the stored snapshot. */
  async pdf(ctx: AuthContext, id: ObjectId): Promise<{ name: string; data: Buffer }> {
    const d = await this.find(ctx, id);
    const cn = await this.mongo.db.collection<CreditNoteDoc>('credit_notes').findOne({ invoiceId: d._id });
    return { name: `${d.number.replace(/\//g, '-')}.pdf`, data: await renderPdf(d, cn) };
  }
}

function renderPdf(d: InvoiceDoc, cn: CreditNoteDoc | null): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Tax invoice ${d.number}` } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const intra = d.igstPaise === 0;
    const r = (p: number) => rupees(p).replace('Rs. ', '');

    doc.fontSize(16).font('Helvetica-Bold').text('TAX INVOICE', { align: 'right' });
    doc.moveUp().fontSize(12).text(d.seller.name);
    doc.font('Helvetica').fontSize(9).text(d.seller.address, { width: 300 });
    if (d.seller.gstin) doc.text(`GSTIN: ${d.seller.gstin}`);
    doc.text(`State code: ${d.seller.stateCode}`);
    doc.moveDown();

    const top = doc.y;
    doc.font('Helvetica-Bold').text('Bill to', 40, top);
    doc.font('Helvetica').text(d.buyer.name).text(d.buyer.address, { width: 260 });
    if (d.buyer.gstin) doc.text(`GSTIN: ${d.buyer.gstin}`);
    doc.text(`State code: ${d.buyer.stateCode}`);
    const meta: [string, string][] = [
      ['Invoice no.', d.number],
      ['Date', istDate(d.issueDate)],
      ['Place of supply', d.placeOfSupply],
      ...(d.periodStart && d.periodEnd
        ? ([['Period', `${istDate(d.periodStart)} – ${istDate(d.periodEnd)}`]] as [string, string][])
        : []),
      ...(d.type === 'postpaid_monthly' ? ([['Due date', istDate(d.dueDate)]] as [string, string][]) : []),
    ];
    let y = top;
    for (const [k, v] of meta) {
      doc.font('Helvetica-Bold').text(k, 330, y, { width: 90 });
      doc.font('Helvetica').text(v, 420, y, { width: 135 });
      y += 14;
    }
    doc.y = Math.max(doc.y, y) + 16;

    const cols = intra
      ? [
          ['Description', 170],
          ['HSN/SAC', 55],
          ['Taxable', 70],
          ['CGST', 65],
          ['SGST', 65],
          ['Total', 90],
        ]
      : [
          ['Description', 205],
          ['HSN/SAC', 60],
          ['Taxable', 80],
          ['IGST', 80],
          ['Total', 90],
        ];
    const row = (cells: string[], bold = false) => {
      let x = 40;
      const yy = doc.y;
      let h = 0;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica');
      cells.forEach((c, i) => {
        const w = cols[i]![1] as number;
        doc.text(c, x, yy, { width: w - 6, align: i < 2 ? 'left' : 'right' });
        h = Math.max(h, doc.y - yy);
        x += w;
      });
      doc.y = yy + h + 6;
      doc
        .moveTo(40, doc.y - 3)
        .lineTo(555, doc.y - 3)
        .strokeColor('#dddddd')
        .stroke();
    };
    row(
      cols.map((c) => c[0] as string),
      true,
    );
    for (const l of d.lines) {
      const tax = intra
        ? [`${r(l.cgstPaise)}\n@${l.gstRatePercent / 2}%`, `${r(l.sgstPaise)}\n@${l.gstRatePercent / 2}%`]
        : [`${r(l.igstPaise)}\n@${l.gstRatePercent}%`];
      row([l.description, l.hsnSac, r(l.taxablePaise), ...tax, r(l.totalPaise)]);
    }
    doc.moveDown();
    const sums: [string, number][] = [
      ['Taxable value', d.taxablePaise],
      ...((intra
        ? [
            ['CGST', d.cgstPaise],
            ['SGST', d.sgstPaise],
          ]
        : [['IGST', d.igstPaise]]) as [string, number][]),
      ['Round off', d.roundOffPaise],
      ['Total (Rs.)', d.totalPaise],
      ['Paid', d.paidPaise],
      ['Balance due', d.balancePaise],
    ];
    for (const [k, v] of sums) {
      const yy = doc.y;
      doc.font(k.startsWith('Total') ? 'Helvetica-Bold' : 'Helvetica').text(k, 330, yy, { width: 120 });
      doc.text(r(v), 450, yy, { width: 105, align: 'right' });
    }
    if (cn) {
      doc
        .moveDown()
        .font('Helvetica-Bold')
        .text(`Cancelled by credit note ${cn.number} on ${istDate(cn.createdAt)}`, 40);
      doc.font('Helvetica').text(`Reason: ${cn.reason}`);
    }
    doc.moveDown(2).font('Helvetica').fontSize(8).fillColor('#666666');
    doc.text('This is a computer-generated invoice and needs no signature.', 40);
    doc.end();
  });
}

@Controller('invoices')
export class InvoicesController {
  constructor(@Inject(InvoicesService) private readonly s: InvoicesService) {}

  @Get()
  @Endpoint({
    summary: 'GST invoices (a reseller sees its branch)',
    tags: ['billing'],
    permission: 'billing.read',
    query: listQuery,
    response: page(invoiceView),
  })
  list(@Ctx() ctx: AuthContext, @Query() q: z.output<typeof listQuery>) {
    return this.s.list(ctx, q);
  }

  @Get(':id')
  @Endpoint({
    summary: 'One invoice',
    tags: ['billing'],
    permission: 'billing.read',
    params: idParams,
    response: detailView,
  })
  get(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }) {
    return this.s.get(ctx, p.id);
  }

  @Get(':id/pdf')
  @Endpoint({ summary: 'Invoice as PDF', tags: ['billing'], permission: 'billing.read', params: idParams })
  async pdf(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }, @Res() reply: FastifyReply) {
    const { name, data } = await this.s.pdf(ctx, p.id);
    void reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="${name}"`)
      .header('cache-control', 'private, no-store')
      .send(data);
  }

  @Post(':id/credit-note')
  @HttpCode(200)
  @Endpoint({
    summary: 'Cancel a postpaid invoice with a credit note (ISP staff)',
    tags: ['billing'],
    audit: 'invoice.credit_note',
    permission: 'wallets.refund',
    params: idParams,
    body: creditBody,
    response: detailView,
  })
  creditNote(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }, @Body() b: z.output<typeof creditBody>) {
    return this.s.creditNote(ctx, p.id, b.reason);
  }
}
