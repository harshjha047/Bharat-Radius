import type { ObjectId } from 'mongodb';
import type { EncryptedField } from '@isp/shared';

export interface TenantBilling {
  /** 1–3 characters; invoice number = PREFIX/2627/00001 (≤ 16 characters, GST rule). */
  invoicePrefix: string;
  /** Days before prepaid expiry on which a reminder SMS goes out. */
  reminderDaysBefore: number[];
  /** Postpaid: invoice issued on the 1st (IST) for the previous month; due this many days later. */
  dueDays: number;
  /** Postpaid: suspended this many days after the due date when unpaid. */
  graceDays: number;
  /** Default low-balance threshold for new wallets. */
  lowBalancePaise: number;
}

export interface TenantGateways {
  razorpay?: { keyId: string; keySecret: EncryptedField; webhookSecret: EncryptedField; enabled: boolean };
  cashfree?: { appId: string; secretKey: EncryptedField; sandbox: boolean; enabled: boolean };
}

export interface TenantSms {
  enabled: boolean;
  /**
   * HTTP GET URL of the SMS provider with placeholders {apiKey} {sender} {entityId} {templateId} {to} (919876543210)
   * {mobile} (9876543210) {message}
   * (each URL-encoded when filled in). RapidSMS panels give this URL under "HTTP API".
   */
  urlTemplate: string;
  apiKey?: EncryptedField;
  senderId: string;
  entityId?: string;
  /** Response body must match this (case-insensitive regex) to count as sent; default: HTTP 2xx is enough. */
  successPattern?: string;
}

export type WalletType = string; // MASTER, L1, L2, …
export type WalletTxnType = 'TOPUP' | 'ALLOCATE' | 'RECHARGE' | 'REFUND' | 'ADJUSTMENT';

export interface WalletDoc {
  _id: ObjectId;
  tenantId: ObjectId;
  ownerType: 'tenant' | 'reseller';
  ownerId: ObjectId;
  walletType: WalletType;
  parentWalletId: ObjectId | null;
  /** May go below zero only for Master (it records what it has issued) or down to −creditLimit. */
  balancePaise: number;
  creditLimitPaise: number;
  lowBalanceThresholdPaise: number;
  isActive: boolean;
  /** Set by nightly reconciliation on a mismatch: no money moves until cleared. */
  frozen: boolean;
  frozenReason?: string;
  totals: { receivedPaise: number; allocatedPaise: number; rechargedPaise: number; refundedPaise: number };
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletTxnDoc {
  _id: ObjectId;
  tenantId: ObjectId;
  walletId: ObjectId;
  fromWalletId: ObjectId | null;
  toWalletId: ObjectId | null;
  type: WalletTxnType;
  direction: 'credit' | 'debit';
  amountPaise: number;
  balanceBeforePaise: number;
  balanceAfterPaise: number;
  /** Transfer, recharge, payment or adjustment id. */
  referenceId: ObjectId;
  description: string;
  createdAt: Date;
  createdBy: string;
}

export interface WalletTransferDoc {
  _id: ObjectId;
  tenantId: ObjectId;
  fromWalletId: ObjectId;
  toWalletId: ObjectId;
  amountPaise: number;
  status: 'SUCCESS';
  receivedVia?: 'cash' | 'upi' | 'bank';
  reference?: string;
  note?: string;
  idempotencyKey: string;
  createdAt: Date;
  createdBy: string;
}

export interface ResellerRateDoc {
  _id: ObjectId;
  tenantId: ObjectId;
  /** Reseller whose wallet is debited. */
  buyerId: ObjectId;
  /** Parent reseller, or the tenant for a top-level reseller. */
  setById: ObjectId;
  planId: ObjectId;
  walletPricePaise: number;
  customerPricePaise?: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  updatedBy: string;
}

export type RechargeChannel = 'online' | 'reseller_wallet' | 'cash' | 'staff' | 'import';

export interface RechargeDoc {
  _id: ObjectId;
  tenantId: ObjectId;
  subscriberId: ObjectId;
  planId: ObjectId;
  /** Reseller whose wallet paid (the level that recharged); null for ISP staff / direct online. */
  siteResellerId: ObjectId | null;
  /** Owning reseller chain of the subscriber at the time (branch visibility). */
  ancestors: ObjectId[];
  walletId: ObjectId | null;
  walletTxnId: ObjectId | null;
  amountPaise: number;
  customerPricePaise: number;
  taxPaise: number;
  channel: RechargeChannel;
  status: 'SUCCESS' | 'REVERSED';
  rechargeDate: Date;
  oldExpiresAt: Date | null;
  newExpiresAt: Date;
  /** Start of the bought period (absent on recharges before 18 Nov 2026: derive from old expiry / date). */
  periodStart?: Date;
  /** Periods bought at once; absent = 1. amountPaise / customerPricePaise are totals. */
  quantity?: number;
  oldPlanId: ObjectId | null;
  reversal?: {
    refundTxnId: ObjectId | null;
    creditNoteId: ObjectId | null;
    reason: string;
    by: string;
    at: Date;
  };
  paymentId?: ObjectId;
  invoiceId?: ObjectId;
  actorId: string;
  idempotencyKey: string;
  createdAt: Date;
}

export interface GstLine {
  description: string;
  hsnSac: string;
  qty: number;
  ratePaise: number;
  taxablePaise: number;
  gstRatePercent: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
}

export interface GstParty {
  name: string;
  gstin?: string;
  stateCode: string;
  address: string;
}

export interface GstTotals {
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  roundOffPaise: number;
  totalPaise: number;
}

export type InvoiceStatus = 'issued' | 'partially_paid' | 'paid' | 'overdue' | 'cancelled';

export interface InvoiceDoc extends GstTotals {
  _id: ObjectId;
  tenantId: ObjectId;
  subscriberId: ObjectId;
  ancestors: ObjectId[];
  number: string;
  financialYear: string;
  type: 'prepaid_recharge' | 'postpaid_monthly';
  periodStart?: Date;
  periodEnd?: Date;
  issueDate: Date;
  dueDate: Date;
  seller: GstParty;
  buyer: GstParty;
  placeOfSupply: string;
  lines: GstLine[];
  paidPaise: number;
  creditedPaise: number;
  balancePaise: number;
  status: InvoiceStatus;
  rechargeId?: ObjectId;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
}

export interface CreditNoteDoc extends GstTotals {
  _id: ObjectId;
  tenantId: ObjectId;
  invoiceId: ObjectId;
  subscriberId: ObjectId;
  ancestors: ObjectId[];
  number: string;
  financialYear: string;
  reason: string;
  seller: GstParty;
  buyer: GstParty;
  placeOfSupply: string;
  lines: GstLine[];
  createdAt: Date;
  createdBy: string;
}

export type PaymentMethod = 'razorpay' | 'cashfree' | 'cash' | 'wallet' | 'bank_transfer';
export type PaymentStatus = 'created' | 'pending' | 'captured' | 'failed' | 'refunded';

export interface PaymentPurpose {
  type: 'recharge' | 'invoice';
  planId?: ObjectId;
  invoiceId?: ObjectId;
}

export interface PaymentDoc {
  _id: ObjectId;
  tenantId: ObjectId;
  subscriberId: ObjectId;
  ancestors: ObjectId[];
  method: PaymentMethod;
  amountPaise: number;
  status: PaymentStatus;
  purpose: PaymentPurpose;
  gateway?: {
    orderId?: string;
    linkId?: string;
    linkUrl?: string;
    paymentId?: string;
    method?: string;
    feePaise?: number;
  };
  /** Staff-recorded payments: the request's idempotency key. */
  idempotencyKey?: string;
  collectedBy?: string;
  receiptNo?: string;
  note?: string;
  failureReason?: string;
  rawEvents?: { at: Date; event: string; id?: string }[];
  rechargeId?: ObjectId;
  invoiceId?: ObjectId;
  walletTxnId?: ObjectId;
  capturedAt?: Date;
  settledAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
}

export type TemplateKey =
  'expiry_reminder' | 'expired' | 'payment_receipt' | 'invoice_issued' | 'overdue_suspended' | 'otp';

export interface MessageTemplateDoc {
  _id: ObjectId;
  tenantId: ObjectId;
  key: TemplateKey;
  channel: 'sms';
  dltTemplateId: string;
  /** DLT text with {#var#} placeholders, filled in order with the template's variables. */
  body: string;
  active: boolean;
  updatedAt: Date;
  updatedBy: string;
}

export interface NotificationDoc {
  _id: ObjectId;
  tenantId: ObjectId;
  channel: 'sms';
  to: string;
  templateKey: TemplateKey;
  vars: string[];
  status: 'queued' | 'sent' | 'failed' | 'skipped';
  attempts: number;
  nextAttemptAt: Date;
  lockedUntil?: Date;
  providerMessageId?: string;
  error?: string;
  /** Prevents the same reminder twice (e.g. `expiry:<sub>:<date>`). */
  dedupeKey?: string;
  ref?: { type: string; id: ObjectId };
  createdAt: Date;
  sentAt?: Date;
}
