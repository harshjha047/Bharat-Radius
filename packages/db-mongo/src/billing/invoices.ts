import { ObjectId, type ClientSession, type Db } from 'mongodb';
import type { PlanDoc, SubscriberDoc, TenantDoc } from '../types.js';
import {
  DEFAULT_BILLING,
  MoneyError,
  documentNumber,
  financialYear,
  gstLine,
  gstTotals,
  istDate,
  partyAddress,
} from './money.js';
import type { CreditNoteDoc, GstLine, GstParty, InvoiceDoc, TenantBilling } from './types.js';

export type BillingTenant = TenantDoc & { billing?: Partial<TenantBilling> };

export const billingOf = (t: BillingTenant): TenantBilling => ({ ...DEFAULT_BILLING, ...(t.billing ?? {}) });

export const invoices = (db: Db) => db.collection<InvoiceDoc>('invoices');
export const creditNotes = (db: Db) => db.collection<CreditNoteDoc>('credit_notes');

async function nextSeq(db: Db, key: string, session: ClientSession): Promise<number> {
  const c = await db
    .collection<{ _id: string; seq: number }>('counters')
    .findOneAndUpdate(
      { _id: key },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after', includeResultMetadata: false, session },
    );
  return c!.seq;
}

export const sellerOf = (t: TenantDoc): GstParty => ({
  name: t.legalName,
  ...(t.gstin ? { gstin: t.gstin } : {}),
  stateCode: t.stateCode,
  address: partyAddress(t.address),
});

export const buyerOf = (s: SubscriberDoc, fallbackState: string): GstParty => ({
  name: s.name,
  ...(s.gstin ? { gstin: s.gstin } : {}),
  stateCode: s.address.stateCode || fallbackState,
  address: partyAddress(s.address),
});

export interface InvoiceInput {
  tenant: BillingTenant;
  subscriber: SubscriberDoc;
  plan: Pick<PlanDoc, 'name' | 'hsnSac' | 'gstRatePercent'>;
  /** Taxable price per unit (excl. GST). */
  ratePaise: number;
  /** Fractional quantity for pro-rated postpaid months (rounded to the paisa via ratePaise). */
  description: string;
  type: InvoiceDoc['type'];
  issueDate?: Date;
  dueDate?: Date;
  periodStart?: Date;
  periodEnd?: Date;
  rechargeId?: ObjectId;
  /** Already settled (prepaid recharges are paid at the time). */
  paidPaise?: number;
  actor: string;
}

/**
 * Issues one GST invoice (TRD §6.5): consecutive number per financial year per ISP from an atomic counter;
 * CGST+SGST when the customer's state is the ISP's GST state, otherwise IGST. Never edited after issue.
 */
export async function issueInvoice(db: Db, session: ClientSession, i: InvoiceInput): Promise<InvoiceDoc> {
  const issueDate = i.issueDate ?? new Date();
  const fy = financialYear(issueDate);
  const b = billingOf(i.tenant);
  const seller = sellerOf(i.tenant);
  const buyer = buyerOf(i.subscriber, i.tenant.stateCode);
  const lines: GstLine[] = [
    gstLine({
      description: i.description,
      hsnSac: i.plan.hsnSac,
      ratePaise: i.ratePaise,
      gstRatePercent: i.plan.gstRatePercent,
      intraState: buyer.stateCode === seller.stateCode,
    }),
  ];
  const totals = gstTotals(lines);
  const seq = await nextSeq(db, `invoice:${i.tenant._id.toHexString()}:${fy}`, session);
  const paid = Math.min(i.paidPaise ?? 0, totals.totalPaise);
  const now = new Date();
  const doc: InvoiceDoc = {
    _id: new ObjectId(),
    tenantId: i.tenant._id,
    subscriberId: i.subscriber._id,
    ancestors: i.subscriber.ancestors,
    number: documentNumber(b.invoicePrefix, fy, seq),
    financialYear: fy,
    type: i.type,
    ...(i.periodStart ? { periodStart: i.periodStart } : {}),
    ...(i.periodEnd ? { periodEnd: i.periodEnd } : {}),
    issueDate,
    dueDate: i.dueDate ?? issueDate,
    seller,
    buyer,
    placeOfSupply: buyer.stateCode,
    lines,
    ...totals,
    paidPaise: paid,
    creditedPaise: 0,
    balancePaise: totals.totalPaise - paid,
    status: paid >= totals.totalPaise ? 'paid' : paid > 0 ? 'partially_paid' : 'issued',
    ...(i.rechargeId ? { rechargeId: i.rechargeId } : {}),
    createdAt: now,
    updatedAt: now,
    createdBy: i.actor,
  };
  await invoices(db).insertOne(doc, { session });
  return doc;
}

/** Records money received against an invoice; returns the updated invoice. */
export async function payInvoice(
  db: Db,
  session: ClientSession,
  invoiceId: ObjectId,
  tenantId: ObjectId,
  amountPaise: number,
): Promise<InvoiceDoc> {
  const cur = await invoices(db).findOne({ _id: invoiceId, tenantId }, { session });
  if (!cur) throw new MoneyError(404, 'NOT_FOUND', 'Invoice not found');
  if (cur.status === 'cancelled') throw new MoneyError(409, 'CONFLICT', 'This invoice is cancelled');
  const paid = cur.paidPaise + amountPaise;
  const balance = Math.max(0, cur.totalPaise - cur.creditedPaise - paid);
  const u = await invoices(db).findOneAndUpdate(
    { _id: invoiceId, tenantId, paidPaise: cur.paidPaise },
    {
      $set: {
        paidPaise: paid,
        balancePaise: balance,
        status: balance === 0 ? 'paid' : 'partially_paid',
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after', session },
  );
  if (!u) throw new MoneyError(409, 'CONFLICT', 'The invoice changed at the same time; try again');
  return u;
}

/** Full credit note against an invoice (own consecutive series); the invoice is closed, never edited. */
export async function issueCreditNote(
  db: Db,
  session: ClientSession,
  input: { tenant: BillingTenant; invoice: InvoiceDoc; reason: string; actor: string },
): Promise<CreditNoteDoc> {
  const inv = input.invoice;
  if (inv.creditedPaise > 0) throw new MoneyError(409, 'CONFLICT', 'This invoice already has a credit note');
  const now = new Date();
  const fy = financialYear(now);
  const seq = await nextSeq(db, `creditnote:${input.tenant._id.toHexString()}:${fy}`, session);
  const doc: CreditNoteDoc = {
    _id: new ObjectId(),
    tenantId: inv.tenantId,
    invoiceId: inv._id,
    subscriberId: inv.subscriberId,
    ancestors: inv.ancestors,
    number: documentNumber('CN', fy, seq),
    financialYear: fy,
    reason: input.reason,
    seller: inv.seller,
    buyer: inv.buyer,
    placeOfSupply: inv.placeOfSupply,
    lines: inv.lines.map((l) => ({
      ...l,
      description: `${l.description} (against ${inv.number} of ${istDate(inv.issueDate)})`,
    })),
    taxablePaise: inv.taxablePaise,
    cgstPaise: inv.cgstPaise,
    sgstPaise: inv.sgstPaise,
    igstPaise: inv.igstPaise,
    roundOffPaise: inv.roundOffPaise,
    totalPaise: inv.totalPaise,
    createdAt: now,
    createdBy: input.actor,
  };
  await creditNotes(db).insertOne(doc, { session });
  await invoices(db).updateOne(
    { _id: inv._id },
    {
      $set: {
        creditedPaise: inv.totalPaise,
        balancePaise: 0,
        status: 'cancelled',
        updatedAt: now,
      },
    },
    { session },
  );
  return doc;
}
