'use client';
import { useQuery } from '@tanstack/react-query';
import { Download, FileSpreadsheet } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { ErrorState, PageHeader, Stat } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { api, download, unwrap, type ApiData } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { periodPresets as presets } from '@/lib/periods';
import { cn, fmtBytes, fmtNum, fmtRupees } from '@/lib/utils';

type ReportData = ApiData<'/api/v1/reports/{name}'>;
type Table = ReportData['tables'][number];
type Name = 'revenue' | 'collections' | 'recharges' | 'subscribers' | 'reseller-sales' | 'usage' | 'tickets';

const REPORTS: { name: Name; label: string; staffOnly?: boolean }[] = [
  { name: 'revenue', label: 'Revenue' },
  { name: 'collections', label: 'Collections' },
  { name: 'recharges', label: 'Recharges and expiries' },
  { name: 'subscribers', label: 'Subscribers' },
  { name: 'reseller-sales', label: 'Reseller sales' },
  { name: 'usage', label: 'Usage', staffOnly: true },
  { name: 'tickets', label: 'Tickets' },
];

function fmt(v: string | number | null | undefined, kind?: string) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'string') return v;
  if (kind === 'money') return fmtRupees(v);
  if (kind === 'bytes') return fmtBytes(v);
  if (kind === 'hours') return v.toFixed(1);
  if (kind === 'pct') return `${v.toFixed(1)}%`;
  return fmtNum(v);
}

function ReportTable({ t }: { t: Table }) {
  return (
    <Card className="overflow-hidden">
      <div className="border-b px-5 py-4">
        <CardTitle>{t.title}</CardTitle>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] text-sm tabular-nums">
          <thead>
            <tr className="bg-subtle">
              {t.columns.map((c, i) => (
                <th
                  key={c.key}
                  scope="col"
                  className={cn(
                    'eyebrow px-3.5 py-2.5 font-medium tracking-[0.08em] whitespace-nowrap',
                    i ? 'text-right' : 'pl-5 text-left',
                  )}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {t.rows.length ? (
              t.rows.map((r, j) => (
                <tr key={j} className="border-t border-divider">
                  {t.columns.map((c, i) => (
                    <td
                      key={c.key}
                      className={
                        i ? 'px-3.5 py-2.5 text-right' : 'py-2.5 pr-3.5 pl-5 font-semibold text-foreground'
                      }
                    >
                      {fmt(r[c.key], c.kind)}
                    </td>
                  ))}
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={t.columns.length} className="py-10 text-center text-muted-foreground">
                  No data for this period.
                </td>
              </tr>
            )}
          </tbody>
          {t.totals ? (
            <tfoot>
              <tr className="border-t-2 bg-subtle font-extrabold text-foreground">
                {t.columns.map((c, i) => (
                  <td key={c.key} className={i ? 'px-3.5 py-3 text-right' : 'py-3 pr-3.5 pl-5'}>
                    {fmt(t.totals![c.key], c.kind)}
                  </td>
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
    </Card>
  );
}

function Gstr1() {
  const [month, setMonth] = useState(() => {
    const d = new Date(Date.now() + 330 * 60_000);
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - 1);
    return d.toISOString().slice(0, 7);
  });
  const r = useQuery({
    queryKey: ['reports', 'gstr1', month],
    queryFn: () => unwrap(api.GET('/api/v1/reports/gstr1', { params: { query: { month } } })),
  });
  const [busy, setBusy] = useState(false);
  const get = () => {
    setBusy(true);
    download(`/api/v1/reports/gstr1/download?month=${month}`, `GSTR1-${month}.xlsx`)
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Download failed'))
      .finally(() => setBusy(false));
  };
  const s = r.data?.summary;
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-end justify-between gap-3">
        <div>
          <CardTitle>GSTR-1 export</CardTitle>
          <p className="text-sm text-muted-foreground">
            Excel in the GST offline tool layout: b2b, b2cl, b2cs, cdnr, cdnur, hsn, docs.
          </p>
        </div>
        <div className="flex gap-2">
          <Input
            type="month"
            aria-label="Month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="w-40"
          />
          <Button onClick={get} loading={busy} disabled={!s}>
            <FileSpreadsheet /> Download
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {r.isLoading ? <Skeleton className="h-20 w-full" /> : null}
        {r.isError ? <ErrorState error={r.error} /> : null}
        {s ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat
                label="Invoices"
                value={fmtNum(s.invoices)}
                hint={`${fmtNum(s.creditNotes)} credit notes`}
              />
              <Stat label="Taxable (net)" value={fmtRupees(s.netTaxablePaise)} />
              <Stat label="IGST" value={fmtRupees(s.igstPaise)} />
              <Stat label="CGST + SGST" value={fmtRupees(s.cgstPaise + s.sgstPaise)} />
            </div>
            <p className="text-xs text-muted-foreground">
              Rows: {r.data!.sheets.map((x) => `${x.name} ${x.rows}`).join(' · ')}
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default function ReportsPage() {
  const me = useMe();
  const staff = !!me.data && !me.data.user.resellerId;
  const [ranges] = useState(presets);
  const [name, setName] = useState<Name>('revenue');
  const [range, setRange] = useState<[string, string]>(ranges['This month']!);
  const [busy, setBusy] = useState<'xlsx' | 'pdf' | null>(null);
  const [from, to] = range;
  const report = useQuery({
    queryKey: ['reports', name, from, to],
    queryFn: () =>
      unwrap(api.GET('/api/v1/reports/{name}', { params: { path: { name }, query: { from, to } } })),
    enabled: !!from && !!to && from <= to,
  });
  const get = (format: 'xlsx' | 'pdf') => {
    setBusy(format);
    download(
      `/api/v1/reports/${name}/download?from=${from}&to=${to}&format=${format}`,
      `${name}-${from}-to-${to}.${format}`,
    )
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Download failed'))
      .finally(() => setBusy(null));
  };
  const visible = REPORTS.filter((r) => staff || !r.staffOnly);

  return (
    <>
      <PageHeader
        title="Reports"
        description="IST days. Excel keeps numbers as numbers; PDF for printing."
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => get('xlsx')}
              loading={busy === 'xlsx'}
              disabled={!report.data}
            >
              <Download /> Excel
            </Button>
            <Button
              variant="outline"
              onClick={() => get('pdf')}
              loading={busy === 'pdf'}
              disabled={!report.data}
            >
              <Download /> PDF
            </Button>
          </>
        }
      />
      <div className="mb-4 flex gap-1 overflow-x-auto border-b" role="tablist" aria-label="Report">
        {visible.map((r) => (
          <button
            key={r.name}
            type="button"
            role="tab"
            aria-selected={name === r.name}
            onClick={() => setName(r.name)}
            className={cn(
              'h-11 shrink-0 px-3.5 text-sm font-medium whitespace-nowrap text-body hover:text-foreground',
              name === r.name && 'font-bold text-primary shadow-[inset_0_-2px_0_var(--primary)]',
            )}
          >
            {r.label}
          </button>
        ))}
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select
          aria-label="Period"
          className="w-48"
          value={Object.entries(ranges).find(([, v]) => v[0] === from && v[1] === to)?.[0] ?? ''}
          onChange={(e) => e.target.value && setRange(ranges[e.target.value]!)}
        >
          <option value="">Custom</option>
          {Object.keys(ranges).map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </Select>
        <Input
          type="date"
          aria-label="From"
          value={from}
          onChange={(e) => setRange([e.target.value, to])}
          className="w-40"
        />
        <Input
          type="date"
          aria-label="To"
          value={to}
          onChange={(e) => setRange([from, e.target.value])}
          className="w-40"
        />
      </div>
      <div className="space-y-4">
        {report.isLoading ? <Skeleton className="h-64 w-full" /> : null}
        {report.isError ? <ErrorState error={report.error} onRetry={() => void report.refetch()} /> : null}
        {report.data?.tables.map((t) => (
          <ReportTable key={t.title} t={t} />
        ))}
        {report.data && !report.data.tables.length ? (
          <p className="text-sm text-muted-foreground">No data for this period.</p>
        ) : null}
        {staff ? <Gstr1 /> : null}
      </div>
    </>
  );
}
