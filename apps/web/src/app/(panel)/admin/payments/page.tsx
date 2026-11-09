'use client';
import { useMemo, useState } from 'react';
import { PaymentsTable } from '@/components/billing';
import { Input, Select } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/misc';

export default function PaymentsPage() {
  const [method, setMethod] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const query = useMemo(
    () =>
      Object.fromEntries(Object.entries({ method, status, from, to }).filter(([, v]) => v)) as Record<
        string,
        string
      >,
    [method, status, from, to],
  );
  return (
    <>
      <PageHeader title="Payments" description="Cash collected and online payments." />
      <div className="mb-3 flex flex-wrap gap-2">
        <Select
          aria-label="Method"
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          className="w-36"
        >
          <option value="">All methods</option>
          <option value="cash">Cash</option>
          <option value="razorpay">Razorpay</option>
          <option value="cashfree">Cashfree</option>
        </Select>
        <Select
          aria-label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="w-36"
        >
          <option value="">Any status</option>
          <option value="captured">Paid</option>
          <option value="created">Link sent</option>
          <option value="failed">Failed</option>
          <option value="refunded">Refunded</option>
        </Select>
        <Input
          type="date"
          aria-label="From"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="w-40"
        />
        <Input
          type="date"
          aria-label="To"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="w-40"
        />
      </div>
      <PaymentsTable query={query} />
    </>
  );
}
