'use client';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { toast } from 'sonner';
import { portalKeys } from '@/components/portal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { api, download, unwrap } from '@/lib/api';
import { fmtDate, fmtDateTime, fmtRupees } from '@/lib/utils';

const INVOICE_TONE = {
  paid: 'success',
  issued: 'warning',
  partially_paid: 'warning',
  overdue: 'danger',
  cancelled: 'neutral',
} as const;
const PAYMENT_TONE = {
  captured: 'success',
  created: 'neutral',
  pending: 'warning',
  failed: 'danger',
  refunded: 'neutral',
} as const;
const PAYMENT_LABEL = {
  captured: 'Paid',
  created: 'Not paid',
  pending: 'Pending',
  failed: 'Failed',
  refunded: 'Refunded',
} as const;

export default function PortalBills() {
  const invoices = useInfiniteQuery({
    queryKey: portalKeys.invoices,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/v1/portal/invoices', {
          params: { query: { limit: 20, ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  const payments = useInfiniteQuery({
    queryKey: portalKeys.payments,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/v1/portal/payments', {
          params: { query: { limit: 20, ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });

  const pdf = (id: string, number: string) =>
    download(`/api/v1/portal/invoices/${id}/pdf`, `${number.replace(/\//g, '-')}.pdf`).catch((e: unknown) =>
      toast.error(e instanceof Error ? e.message : 'Download failed'),
    );

  return (
    <>
      <div className="mt-1 space-y-0.5">
        <h1 className="text-[26px] font-extrabold tracking-[-0.03em]">Bills</h1>
        <p className="text-[15px] text-body">Invoices and payments for your connection.</p>
      </div>
      <Card className="overflow-hidden">
        <CardHeader className="border-b pb-4 sm:pb-4">
          <CardTitle>Invoices</CardTitle>
        </CardHeader>
        <div>
          <DataTable
            bare
            caption="Invoices"
            rows={invoices.data?.pages.flatMap((p) => p.items)}
            loading={invoices.isLoading}
            rowKey={(r) => r.id}
            empty="No invoices yet."
            hasMore={invoices.hasNextPage}
            loadingMore={invoices.isFetchingNextPage}
            onLoadMore={() => void invoices.fetchNextPage()}
            columns={[
              {
                key: 'number',
                header: 'Invoice',
                cell: (r) => (
                  <span>
                    <span className="font-medium">{r.number}</span>
                    <span className="block text-xs text-muted-foreground">{fmtDate(r.issueDate)}</span>
                  </span>
                ),
              },
              { key: 'total', header: 'Amount', cell: (r) => fmtRupees(r.totalPaise) },
              {
                key: 'status',
                header: 'Status',
                cell: (r) => (
                  <Badge tone={INVOICE_TONE[r.status]} className="capitalize">
                    {r.status.replace('_', ' ')}
                  </Badge>
                ),
              },
              {
                key: 'pdf',
                header: <span className="sr-only">Download</span>,
                cell: (r) => (
                  <Button variant="ghost" size="sm" onClick={() => void pdf(r.id, r.number)}>
                    <Download /> PDF
                  </Button>
                ),
              },
            ]}
          />
        </div>
      </Card>
      <Card className="overflow-hidden">
        <CardHeader className="border-b pb-4 sm:pb-4">
          <CardTitle>Payments</CardTitle>
        </CardHeader>
        <div>
          <DataTable
            bare
            caption="Payments"
            rows={payments.data?.pages.flatMap((p) => p.items)}
            loading={payments.isLoading}
            rowKey={(r) => r.id}
            empty="No payments yet."
            hasMore={payments.hasNextPage}
            loadingMore={payments.isFetchingNextPage}
            onLoadMore={() => void payments.fetchNextPage()}
            columns={[
              { key: 'at', header: 'Date', cell: (r) => fmtDateTime(r.capturedAt ?? r.createdAt) },
              { key: 'amount', header: 'Amount', cell: (r) => fmtRupees(r.amountPaise) },
              {
                key: 'method',
                header: 'Method',
                cell: (r) =>
                  r.method === 'cash' ? 'Cash' : r.method === 'razorpay' ? 'Razorpay' : 'Cashfree',
                hideOnMobile: true,
              },
              {
                key: 'status',
                header: 'Status',
                cell: (r) => <Badge tone={PAYMENT_TONE[r.status]}>{PAYMENT_LABEL[r.status]}</Badge>,
              },
            ]}
          />
        </div>
      </Card>
    </>
  );
}
