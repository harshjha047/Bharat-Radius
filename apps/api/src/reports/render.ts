import PDFDocument from 'pdfkit';
import writeXlsxFile, { type SheetData } from 'write-excel-file/node';

export type CellKind = 'text' | 'int' | 'money' | 'bytes' | 'hours' | 'pct';
export type Cell = string | number | null;

export interface Column {
  key: string;
  label: string;
  kind?: CellKind;
}

export interface Table {
  title: string;
  columns: Column[];
  rows: Record<string, Cell>[];
  totals?: Record<string, Cell>;
}

export interface Report {
  name: string;
  title: string;
  from: string;
  to: string;
  generatedAt: string;
  tables: Table[];
}

/** Money is carried in paise (integers) everywhere and turned into rupees only when rendered. */
const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = new Intl.NumberFormat('en-IN');

function bytes(n: number) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n;
  let i = 0;
  while (v >= 1000 && i < u.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

export function display(v: Cell, kind: CellKind = 'text'): string {
  if (v === null || v === '') return '';
  if (typeof v === 'string') return v;
  switch (kind) {
    case 'money':
      return inr.format(v / 100);
    case 'bytes':
      return bytes(v);
    case 'hours':
      return v.toFixed(1);
    case 'pct':
      return `${v.toFixed(1)}%`;
    default:
      return int.format(v);
  }
}

const sheetName = (title: string, used: Set<string>) => {
  const base = title.replace(/[\\/?*[\]:]/g, ' ').slice(0, 28) || 'Sheet';
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 26)} ${i}`;
  used.add(name.toLowerCase());
  return name;
};

/** One sheet per table; numbers stay numbers (rupees with 2 decimals, bytes as GB) so totals work in Excel. */
export async function toXlsx(r: Report): Promise<Buffer> {
  const used = new Set<string>();
  const sheets = r.tables.map((t) => {
    const header = t.columns.map((c) => ({
      value: c.kind === 'bytes' ? `${c.label} (GB)` : c.kind === 'money' ? `${c.label} (₹)` : c.label,
      fontWeight: 'bold' as const,
    }));
    const cell = (row: Record<string, Cell>, c: Column, bold = false) => {
      const v = row[c.key];
      const b = bold ? { fontWeight: 'bold' as const } : {};
      if (v === null || v === undefined || v === '') return null;
      if (typeof v === 'string') return { value: v, ...b };
      if (c.kind === 'money') return { value: v / 100, format: '#,##0.00', ...b };
      if (c.kind === 'bytes') return { value: Math.round(v / 1e7) / 100, format: '#,##0.00', ...b };
      if (c.kind === 'hours' || c.kind === 'pct') return { value: Math.round(v * 10) / 10, ...b };
      return { value: v, ...b };
    };
    const data = [
      [{ value: `${r.title} · ${t.title}`, fontWeight: 'bold' as const }],
      [{ value: `${r.from} to ${r.to}` }],
      [],
      header,
      ...t.rows.map((row) => t.columns.map((c) => cell(row, c))),
      ...(t.totals ? [t.columns.map((c) => cell(t.totals!, c, true))] : []),
    ] as SheetData;
    return {
      sheet: sheetName(t.title, used),
      data,
      columns: t.columns.map((c, i) => ({ width: i === 0 ? 28 : Math.max(12, c.label.length + 4) })),
    };
  });
  return writeXlsxFile(sheets).toBuffer();
}

/** Landscape A4 tables. Standard PDF fonts have no ₹ glyph, so money columns are labelled (Rs.). */
export function toPdf(r: Report, isp: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, info: { Title: r.title } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const left = 36;
    const width = doc.page.width - 72;
    const bottom = doc.page.height - 48;

    doc.font('Helvetica-Bold').fontSize(14).text(r.title);
    doc.font('Helvetica').fontSize(9).fillColor('#555').text(`${isp} · ${r.from} to ${r.to}`);
    doc.fillColor('#000').moveDown();

    for (const t of r.tables) {
      const n = t.columns.length;
      const first = Math.min(200, Math.max(110, width / (n + 1)));
      const rest = (width - first) / Math.max(1, n - 1);
      const widths = t.columns.map((_, i) => (i === 0 ? first : rest));
      const line = (cells: string[], bold: boolean) => {
        if (doc.y > bottom) doc.addPage();
        let x = left;
        const y = doc.y;
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
        let h = 0;
        cells.forEach((c, i) => {
          const w = widths[i]! - 4;
          doc.text(c, x, y, { width: w, align: i === 0 ? 'left' : 'right' });
          h = Math.max(h, doc.heightOfString(c, { width: w }));
          x += widths[i]!;
        });
        doc.y = y + h + 3;
      };
      if (doc.y > bottom - 60) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(11).text(t.title, left, doc.y);
      doc.moveDown(0.3);
      line(
        t.columns.map((c) => (c.kind === 'money' ? `${c.label} (Rs.)` : c.label)),
        true,
      );
      doc
        .moveTo(left, doc.y)
        .lineTo(left + width, doc.y)
        .strokeColor('#999')
        .stroke();
      doc.y += 2;
      if (!t.rows.length) line(['No data'], false);
      for (const row of t.rows)
        line(
          t.columns.map((c) => display(row[c.key] ?? null, c.kind)),
          false,
        );
      if (t.totals) {
        doc
          .moveTo(left, doc.y)
          .lineTo(left + width, doc.y)
          .stroke();
        doc.y += 2;
        line(
          t.columns.map((c) => display(t.totals![c.key] ?? null, c.kind)),
          true,
        );
      }
      doc.moveDown();
    }
    doc.font('Helvetica').fontSize(7).fillColor('#777').text(`Generated ${r.generatedAt}`, left, doc.y);
    doc.end();
  });
}
