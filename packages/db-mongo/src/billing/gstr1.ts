import type { CreditNoteDoc, GstLine, InvoiceDoc } from './types.js';

/** GST state/UT codes → names as the GST portal writes them in "Place Of Supply" (e.g. "07-Delhi"). */
export const GST_STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
};

/** Unregistered inter-state invoices above this value go to B2CL (₹1,00,000 since 1 Aug 2024), else B2CS. */
export const B2CL_LIMIT_PAISE = 100_000_00;

const SAC_NAMES: Record<string, string> = {
  '998422': 'Internet access services',
  '998421': 'Internet backbone services',
  '998412': 'Fixed telephony services',
};

export interface Gstr1Sheet {
  name: string;
  header: string[];
  rows: (string | number)[][];
}

export interface Gstr1Summary {
  invoices: number;
  creditNotes: number;
  taxablePaise: number;
  igstPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  /** Credit notes already subtracted. */
  netTaxablePaise: number;
}

export type Gstr1Invoice = Pick<
  InvoiceDoc,
  | 'number'
  | 'issueDate'
  | 'buyer'
  | 'seller'
  | 'placeOfSupply'
  | 'lines'
  | 'totalPaise'
  | 'taxablePaise'
  | 'igstPaise'
  | 'cgstPaise'
  | 'sgstPaise'
>;
export type Gstr1CreditNote = Pick<
  CreditNoteDoc,
  | 'number'
  | 'createdAt'
  | 'buyer'
  | 'seller'
  | 'placeOfSupply'
  | 'lines'
  | 'totalPaise'
  | 'taxablePaise'
  | 'igstPaise'
  | 'cgstPaise'
  | 'sgstPaise'
> & {
  /** The invoice it cancels: decides B2CL vs B2CS for unregistered buyers. */
  invoice: Pick<InvoiceDoc, 'totalPaise'> | null;
};

const r2 = (paise: number) => Math.round(paise) / 100;
const pos = (code: string) => `${code}-${GST_STATES[code] ?? 'Unknown'}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** dd-MMM-yyyy in IST, the GST offline tool's date format. */
export function gstDate(at: Date): string {
  const t = new Date(at.getTime() + 330 * 60_000);
  return `${String(t.getUTCDate()).padStart(2, '0')}-${MONTHS[t.getUTCMonth()]}-${t.getUTCFullYear()}`;
}

const interState = (d: { seller: { stateCode: string }; placeOfSupply: string }) =>
  d.placeOfSupply !== d.seller.stateCode;
const isB2cl = (
  d: { buyer: { gstin?: string }; seller: { stateCode: string }; placeOfSupply: string },
  total: number,
) => !d.buyer.gstin && interState(d) && total > B2CL_LIMIT_PAISE;

/** Lines summed per GST rate (one row per rate in B2B/B2CL/CDN sheets). */
function byRate(lines: GstLine[]) {
  const m = new Map<number, { taxable: number; igst: number; cgst: number; sgst: number }>();
  for (const l of lines) {
    const e = m.get(l.gstRatePercent) ?? { taxable: 0, igst: 0, cgst: 0, sgst: 0 };
    e.taxable += l.taxablePaise;
    e.igst += l.igstPaise;
    e.cgst += l.cgstPaise;
    e.sgst += l.sgstPaise;
    m.set(l.gstRatePercent, e);
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]);
}

/** Document series per prefix ("INV/2627/00001" → series "INV/2627/", serial 1). */
function series(numbers: string[]) {
  const m = new Map<string, { from: string; to: string; min: number; max: number; n: number }>();
  for (const no of numbers) {
    const i = no.lastIndexOf('/');
    const prefix = no.slice(0, i + 1);
    const serial = Number(no.slice(i + 1));
    const e = m.get(prefix);
    if (!e) m.set(prefix, { from: no, to: no, min: serial, max: serial, n: 1 });
    else {
      e.n++;
      if (serial < e.min) [e.min, e.from] = [serial, no];
      if (serial > e.max) [e.max, e.to] = [serial, no];
    }
  }
  return [...m.values()];
}

/**
 * GSTR-1 for one month in the GST offline tool's Excel layout: b2b, b2cl, b2cs, cdnr, cdnur, hsn(b2b),
 * hsn(b2c), docs. Credit notes to unregistered buyers on B2CS invoices reduce B2CS (no CDNUR row), as the
 * portal expects. Amounts in rupees with paise.
 */
export function gstr1(
  invoices: Gstr1Invoice[],
  creditNotes: Gstr1CreditNote[],
): {
  sheets: Gstr1Sheet[];
  summary: Gstr1Summary;
} {
  const b2b: Gstr1Sheet['rows'] = [];
  const b2cl: Gstr1Sheet['rows'] = [];
  const cdnr: Gstr1Sheet['rows'] = [];
  const cdnur: Gstr1Sheet['rows'] = [];
  const b2cs = new Map<string, { pos: string; rate: number; taxable: number }>();
  const hsn = new Map<
    string,
    {
      b2b: boolean;
      code: string;
      rate: number;
      qty: number;
      value: number;
      taxable: number;
      igst: number;
      cgst: number;
      sgst: number;
    }
  >();
  const addHsn = (registered: boolean, lines: GstLine[], sign: 1 | -1) => {
    for (const l of lines) {
      const key = `${registered ? 'b2b' : 'b2c'}|${l.hsnSac}|${l.gstRatePercent}`;
      const e = hsn.get(key) ?? {
        b2b: registered,
        code: l.hsnSac,
        rate: l.gstRatePercent,
        qty: 0,
        value: 0,
        taxable: 0,
        igst: 0,
        cgst: 0,
        sgst: 0,
      };
      e.qty += sign * l.qty;
      e.value += sign * l.totalPaise;
      e.taxable += sign * l.taxablePaise;
      e.igst += sign * l.igstPaise;
      e.cgst += sign * l.cgstPaise;
      e.sgst += sign * l.sgstPaise;
      hsn.set(key, e);
    }
  };
  const addB2cs = (code: string, lines: GstLine[], sign: 1 | -1) => {
    for (const [rate, t] of byRate(lines)) {
      const key = `${code}|${rate}`;
      const e = b2cs.get(key) ?? { pos: code, rate, taxable: 0 };
      e.taxable += sign * t.taxable;
      b2cs.set(key, e);
    }
  };

  const sum: Gstr1Summary = {
    invoices: invoices.length,
    creditNotes: creditNotes.length,
    taxablePaise: 0,
    igstPaise: 0,
    cgstPaise: 0,
    sgstPaise: 0,
    netTaxablePaise: 0,
  };

  for (const inv of [...invoices].sort((a, b) => a.number.localeCompare(b.number))) {
    sum.taxablePaise += inv.taxablePaise;
    sum.igstPaise += inv.igstPaise;
    sum.cgstPaise += inv.cgstPaise;
    sum.sgstPaise += inv.sgstPaise;
    const registered = !!inv.buyer.gstin;
    addHsn(registered, inv.lines, 1);
    if (registered) {
      for (const [rate, t] of byRate(inv.lines)) {
        b2b.push([
          inv.buyer.gstin!,
          inv.buyer.name,
          inv.number,
          gstDate(inv.issueDate),
          r2(inv.totalPaise),
          pos(inv.placeOfSupply),
          'N',
          '',
          'Regular B2B',
          '',
          rate,
          r2(t.taxable),
          0,
        ]);
      }
    } else if (isB2cl(inv, inv.totalPaise)) {
      for (const [rate, t] of byRate(inv.lines)) {
        b2cl.push([
          inv.number,
          gstDate(inv.issueDate),
          r2(inv.totalPaise),
          pos(inv.placeOfSupply),
          '',
          rate,
          r2(t.taxable),
          0,
          '',
        ]);
      }
    } else {
      addB2cs(inv.placeOfSupply, inv.lines, 1);
    }
  }

  for (const cn of [...creditNotes].sort((a, b) => a.number.localeCompare(b.number))) {
    sum.taxablePaise -= cn.taxablePaise;
    sum.igstPaise -= cn.igstPaise;
    sum.cgstPaise -= cn.cgstPaise;
    sum.sgstPaise -= cn.sgstPaise;
    const registered = !!cn.buyer.gstin;
    addHsn(registered, cn.lines, -1);
    if (registered) {
      for (const [rate, t] of byRate(cn.lines)) {
        cdnr.push([
          cn.buyer.gstin!,
          cn.buyer.name,
          cn.number,
          gstDate(cn.createdAt),
          'C',
          pos(cn.placeOfSupply),
          'N',
          'Regular B2B',
          r2(cn.totalPaise),
          '',
          rate,
          r2(t.taxable),
          0,
        ]);
      }
    } else if (isB2cl(cn, cn.invoice?.totalPaise ?? 0)) {
      for (const [rate, t] of byRate(cn.lines)) {
        cdnur.push([
          'B2CL',
          cn.number,
          gstDate(cn.createdAt),
          'C',
          pos(cn.placeOfSupply),
          r2(cn.totalPaise),
          '',
          rate,
          r2(t.taxable),
          0,
        ]);
      }
    } else {
      addB2cs(cn.placeOfSupply, cn.lines, -1);
    }
  }
  sum.netTaxablePaise = sum.taxablePaise;

  const hsnRows = (b2bSide: boolean) =>
    [...hsn.values()]
      .filter((e) => e.b2b === b2bSide && (e.qty !== 0 || e.value !== 0))
      .sort((a, b) => a.code.localeCompare(b.code) || a.rate - b.rate)
      .map((e) => [
        e.code,
        SAC_NAMES[e.code] ?? '',
        'NA-NOT APPLICABLE',
        e.qty,
        r2(e.value),
        e.rate,
        r2(e.taxable),
        r2(e.igst),
        r2(e.cgst),
        r2(e.sgst),
        0,
      ]);
  const HSN_HEADER = [
    'HSN',
    'Description',
    'UQC',
    'Total Quantity',
    'Total Value',
    'Rate',
    'Taxable Value',
    'Integrated Tax Amount',
    'Central Tax Amount',
    'State/UT Tax Amount',
    'Cess Amount',
  ];
  const docs: Gstr1Sheet['rows'] = [
    ...series(invoices.map((i) => i.number)).map((s) => [
      'Invoices for outward supply',
      s.from,
      s.to,
      s.n,
      0,
    ]),
    ...series(creditNotes.map((c) => c.number)).map((s) => ['Credit Note', s.from, s.to, s.n, 0]),
  ];

  return {
    summary: sum,
    sheets: [
      {
        name: 'b2b',
        header: [
          'GSTIN/UIN of Recipient',
          'Receiver Name',
          'Invoice Number',
          'Invoice date',
          'Invoice Value',
          'Place Of Supply',
          'Reverse Charge',
          'Applicable % of Tax Rate',
          'Invoice Type',
          'E-Commerce GSTIN',
          'Rate',
          'Taxable Value',
          'Cess Amount',
        ],
        rows: b2b,
      },
      {
        name: 'b2cl',
        header: [
          'Invoice Number',
          'Invoice date',
          'Invoice Value',
          'Place Of Supply',
          'Applicable % of Tax Rate',
          'Rate',
          'Taxable Value',
          'Cess Amount',
          'E-Commerce GSTIN',
        ],
        rows: b2cl,
      },
      {
        name: 'b2cs',
        header: [
          'Type',
          'Place Of Supply',
          'Applicable % of Tax Rate',
          'Rate',
          'Taxable Value',
          'Cess Amount',
          'E-Commerce GSTIN',
        ],
        rows: [...b2cs.values()]
          .filter((e) => e.taxable !== 0)
          .sort((a, b) => a.pos.localeCompare(b.pos) || a.rate - b.rate)
          .map((e) => ['OE', pos(e.pos), '', e.rate, r2(e.taxable), 0, '']),
      },
      {
        name: 'cdnr',
        header: [
          'GSTIN/UIN of Recipient',
          'Receiver Name',
          'Note Number',
          'Note Date',
          'Note Type',
          'Place Of Supply',
          'Reverse Charge',
          'Note Supply Type',
          'Note Value',
          'Applicable % of Tax Rate',
          'Rate',
          'Taxable Value',
          'Cess Amount',
        ],
        rows: cdnr,
      },
      {
        name: 'cdnur',
        header: [
          'UR Type',
          'Note Number',
          'Note Date',
          'Note Type',
          'Place Of Supply',
          'Note Value',
          'Applicable % of Tax Rate',
          'Rate',
          'Taxable Value',
          'Cess Amount',
        ],
        rows: cdnur,
      },
      { name: 'hsn(b2b)', header: HSN_HEADER, rows: hsnRows(true) },
      { name: 'hsn(b2c)', header: HSN_HEADER, rows: hsnRows(false) },
      {
        name: 'docs',
        header: ['Nature of Document', 'Sr. No. From', 'Sr. No. To', 'Total Number', 'Cancelled'],
        rows: docs,
      },
    ],
  };
}
