import { ObjectId, type ClientSession, type Db } from 'mongodb';
import type { PlanDoc, ResellerDoc, SubscriberDoc, TenantDoc } from '../types.js';
import { GST_STATES } from './gstr1.js';
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

const STATE_CODES = new Map(Object.entries(GST_STATES).map(([code, name]) => [name.toLowerCase(), code]));
/** GST state code from a state name ("Uttar Pradesh" → "09") or a code typed as the state; null if unknown. */
export const gstStateCode = (state: string | undefined): string | null => {
  const s = state?.trim().toLowerCase();
  if (!s) return null;
  if (/^\d{2}$/.test(s) && GST_STATES[s]) return s;
  return STATE_CODES.get(s) ?? null;
};

/** Top of the customer's reseller chain (level 1), or null for the ISP's own customers. */
export const l1Of = (s: Pick<SubscriberDoc, 'resellerId' | 'ancestors'>): ObjectId | null =>
  s.ancestors[0] ?? s.resellerId ?? null;

/**
 * Number prefixes of an L1's own series, 5 characters so numbers stay within GST's 16 (R0001/2627/00001):
 * invoices R + last 4 digits of its code, credit notes C + the same digits.
 */
export const resellerSeries = (code: string) => {
  const d = code.replace(/\D/g, '').slice(-4).padStart(4, '0');
  return { invoice: `R${d}`, creditNote: `C${d}` };
};

/** The L1 as the GST seller; its state decides intra/inter-state (ISP state if the L1 has none recorded). */
export const resellerSellerOf = (r: ResellerDoc, fallbackState: string): GstParty => ({
  name: r.name,
  ...(r.gstin ? { gstin: r.gstin } : {}),
  stateCode: gstStateCode(r.address?.state) ?? fallbackState,
  address: partyAddress(r.address ?? {}),
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
  /** Units of ratePaise (recharge quantity); default 1. */
  qty?: number;
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
 * Issues one GST invoice (TRD §6.5): consecutive number per financial year per seller from an atomic counter;
 * CGST+SGST when the customer's state is the seller's GST state, otherwise IGST. Never edited after issue.
 * Customers under a reseller are invoiced by their L1 reseller (its name, GSTIN, state and own series);
 * the ISP's own customers by the ISP.
 */
export async function issueInvoice(db: Db, session: ClientSession, i: InvoiceInput): Promise<InvoiceDoc> {
  const issueDate = i.issueDate ?? new Date();
  const fy = financialYear(issueDate);
  const b = billingOf(i.tenant);
  const l1Id = l1Of(i.subscriber);
  const l1 = l1Id
    ? await db
        .collection<ResellerDoc>('resellers')
        .findOne({ _id: l1Id, tenantId: i.tenant._id }, { session })
    : null;
  const seller = l1 ? resellerSellerOf(l1, i.tenant.stateCode) : sellerOf(i.tenant);
  const buyer = buyerOf(i.subscriber, i.tenant.stateCode);
  const lines: GstLine[] = [
    gstLine({
      description: i.description,
      hsnSac: i.plan.hsnSac,
      ratePaise: i.ratePaise,
      ...(i.qty ? { qty: i.qty } : {}),
      gstRatePercent: i.plan.gstRatePercent,
      intraState: buyer.stateCode === seller.stateCode,
    }),
  ];
  const totals = gstTotals(lines);
  const seq = await nextSeq(
    db,
    l1
      ? `invoice:${i.tenant._id.toHexString()}:r:${l1._id.toHexString()}:${fy}`
      : `invoice:${i.tenant._id.toHexString()}:${fy}`,
    session,
  );
  const paid = Math.min(i.paidPaise ?? 0, totals.totalPaise);
  const now = new Date();
  const doc: InvoiceDoc = {
    _id: new ObjectId(),
    tenantId: i.tenant._id,
    subscriberId: i.subscriber._id,
    ancestors: i.subscriber.ancestors,
    number: documentNumber(l1 ? resellerSeries(l1.code).invoice : b.invoicePrefix, fy, seq),
    financialYear: fy,
    type: i.type,
    ...(i.periodStart ? { periodStart: i.periodStart } : {}),
    ...(i.periodEnd ? { periodEnd: i.periodEnd } : {}),
    issueDate,
    dueDate: i.dueDate ?? issueDate,
    seller,
    ...(l1 ? { sellerResellerId: l1._id } : {}),
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
  const byL1 = inv.sellerResellerId
    ? await db
        .collection<ResellerDoc>('resellers')
        .findOne({ _id: inv.sellerResellerId }, { session, projection: { code: 1 } })
    : null;
  const seq = await nextSeq(
    db,
    inv.sellerResellerId
      ? `creditnote:${input.tenant._id.toHexString()}:r:${inv.sellerResellerId.toHexString()}:${fy}`
      : `creditnote:${input.tenant._id.toHexString()}:${fy}`,
    session,
  );
  const doc: CreditNoteDoc = {
    _id: new ObjectId(),
    tenantId: inv.tenantId,
    invoiceId: inv._id,
    subscriberId: inv.subscriberId,
    ancestors: inv.ancestors,
    number: documentNumber(byL1 ? resellerSeries(byL1.code).creditNote : 'CN', fy, seq),
    financialYear: fy,
    reason: input.reason,
    seller: inv.seller,
    ...(inv.sellerResellerId ? { sellerResellerId: inv.sellerResellerId } : {}),
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
