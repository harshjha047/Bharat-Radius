'use client';
import { useMemo, useState } from 'react';
import { InvoicesTable } from '@/components/billing';
import { Input, Select } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/misc';
import { useDebounced } from '@/hooks/use-debounced';

export default function InvoicesPage() {
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 300);
  const query = useMemo(
    () =>
      Object.fromEntries(Object.entries({ status, type, q: dq }).filter(([, v]) => v)) as Record<
        string,
        string
      >,
    [status, type, dq],
  );
  return (
    <>
      <PageHeader title="Invoices" description="GST tax invoices: recharges and monthly postpaid bills." />
      <div className="mb-3 flex flex-wrap gap-2">
        <Input
          aria-label="Invoice number"
          placeholder="Invoice no."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-44"
          maxLength={20}
        />
        <Select
          aria-label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="w-40"
        >
          <option value="">Any status</option>
          <option value="unpaid">Unpaid</option>
          <option value="overdue">Overdue</option>
          <option value="paid">Paid</option>
          <option value="cancelled">Cancelled</option>
        </Select>
        <Select aria-label="Type" value={type} onChange={(e) => setType(e.target.value)} className="w-40">
          <option value="">All types</option>
          <option value="postpaid_monthly">Monthly (postpaid)</option>
          <option value="prepaid_recharge">Recharge (prepaid)</option>
        </Select>
      </div>
      <InvoicesTable query={query} />
    </>
  );
}
