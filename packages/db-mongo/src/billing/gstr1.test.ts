import { describe, expect, it } from 'vitest';
import { gstDate, gstr1, type Gstr1CreditNote, type Gstr1Invoice } from './gstr1.js';
import { gstLine, gstTotals } from './money.js';

const seller = { name: 'Bharat ISP', gstin: '07AAAAA0000A1Z5', stateCode: '07', address: 'Delhi' };
const at = new Date('2026-12-05T06:00:00Z');

function inv(number: string, pricePaise: number, buyer: { gstin?: string; stateCode: string }): Gstr1Invoice {
  const line = gstLine({
    description: 'Home 100',
    hsnSac: '998422',
    ratePaise: pricePaise,
    gstRatePercent: 18,
    intraState: buyer.stateCode === '07',
  });
  return {
    number,
    issueDate: at,
    seller,
    buyer: { name: `Buyer ${number}`, address: 'x', ...buyer },
    placeOfSupply: buyer.stateCode,
    lines: [line],
    ...gstTotals([line]),
  };
}
const cn = (number: string, of: Gstr1Invoice): Gstr1CreditNote => ({
  number,
  createdAt: at,
  seller: of.seller,
  buyer: of.buyer,
  placeOfSupply: of.placeOfSupply,
  lines: of.lines,
  totalPaise: of.totalPaise,
  taxablePaise: of.taxablePaise,
  igstPaise: of.igstPaise,
  cgstPaise: of.cgstPaise,
  sgstPaise: of.sgstPaise,
  invoice: { totalPaise: of.totalPaise },
});
const sheet = (r: ReturnType<typeof gstr1>, name: string) => r.sheets.find((s) => s.name === name)!.rows;

describe('GSTR-1', () => {
  const a = inv('INV/2627/00001', 50_000, { stateCode: '07' });
  const b = inv('INV/2627/00002', 50_000, { stateCode: '07' });
  const c = inv('INV/2627/00003', 80_000, { stateCode: '09' });
  const biz = inv('INV/2627/00004', 1_000_000, { stateCode: '07', gstin: '07BBBBB1111B1Z5' });
  const big = inv('INV/2627/00005', 9_000_000, { stateCode: '27' });
  const r = gstr1([a, b, c, biz, big], [cn('CN/2627/00001', b), cn('CN/2627/00002', biz)]);

  it('registered buyers → b2b and cdnr, one row per rate', () => {
    expect(sheet(r, 'b2b')).toEqual([
      [
        '07BBBBB1111B1Z5',
        'Buyer INV/2627/00004',
        'INV/2627/00004',
        '05-Dec-2026',
        11_800,
        '07-Delhi',
        'N',
        '',
        'Regular B2B',
        '',
        18,
        10_000,
        0,
      ],
    ]);
    expect(sheet(r, 'cdnr')[0]).toEqual([
      '07BBBBB1111B1Z5',
      'Buyer INV/2627/00004',
      'CN/2627/00002',
      '05-Dec-2026',
      'C',
      '07-Delhi',
      'N',
      'Regular B2B',
      11_800,
      '',
      18,
      10_000,
      0,
    ]);
  });

  it('unregistered: inter-state above ₹1 lakh → b2cl; the rest → b2cs by state and rate, net of credit notes', () => {
    expect(sheet(r, 'b2cl')).toEqual([
      ['INV/2627/00005', '05-Dec-2026', 106_200, '27-Maharashtra', '', 18, 90_000, 0, ''],
    ]);
    expect(sheet(r, 'b2cs')).toEqual([
      ['OE', '07-Delhi', '', 18, 500, 0, ''],
      ['OE', '09-Uttar Pradesh', '', 18, 800, 0, ''],
    ]);
    expect(sheet(r, 'cdnur')).toEqual([]);
  });

  it('HSN split b2b / b2c, credit notes subtracted; docs series', () => {
    expect(sheet(r, 'hsn(b2b)')).toEqual([]);
    expect(sheet(r, 'hsn(b2c)')).toEqual([
      ['998422', 'Internet access services', 'NA-NOT APPLICABLE', 3, 107_734, 18, 91_300, 16_344, 45, 45, 0],
    ]);
    expect(sheet(r, 'docs')).toEqual([
      ['Invoices for outward supply', 'INV/2627/00001', 'INV/2627/00005', 5, 0],
      ['Credit Note', 'CN/2627/00001', 'CN/2627/00002', 2, 0],
    ]);
    expect(r.summary).toMatchObject({ invoices: 5, creditNotes: 2, netTaxablePaise: 91_300_00 });
  });

  it('dates are IST', () => {
    expect(gstDate(new Date('2026-11-30T19:00:00Z'))).toBe('01-Dec-2026');
  });
});
