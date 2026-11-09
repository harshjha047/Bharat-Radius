'use client';
import { useMemo, useState } from 'react';
import { RechargesTable } from '@/components/billing';
import { Input, Select } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/misc';

export default function RechargesPage() {
  const [channel, setChannel] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const query = useMemo(
    () =>
      Object.fromEntries(Object.entries({ channel, status, from, to }).filter(([, v]) => v)) as Record<
        string,
        string
      >,
    [channel, status, from, to],
  );
  return (
    <>
      <PageHeader title="Recharges" description="Every prepaid renewal, who paid and how." />
      <div className="mb-3 flex flex-wrap gap-2">
        <Select
          aria-label="Channel"
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
          className="w-44"
        >
          <option value="">All channels</option>
          <option value="reseller_wallet">Reseller wallet</option>
          <option value="online">Online</option>
          <option value="cash">Cash</option>
          <option value="staff">Complimentary</option>
        </Select>
        <Select
          aria-label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="w-36"
        >
          <option value="">Any status</option>
          <option value="SUCCESS">Done</option>
          <option value="REVERSED">Refunded</option>
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
      <RechargesTable query={query} />
    </>
  );
}
