'use client';
import { useState } from 'react';
import { ExpiringRows, useExpiring } from '@/components/dashboard-widgets';
import { Card } from '@/components/ui/card';
import { ErrorState, PageHeader } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { usePlans } from '@/lib/queries';
import { fmtNum } from '@/lib/utils';

const WINDOWS = [
  ['1', 'Today and tomorrow'],
  ['7', '7 days'],
  ['15', '15 days'],
  ['30', '30 days'],
] as const;

export default function ExpiringPage() {
  const [days, setDays] = useState('7');
  const q = useExpiring(Number(days), 100);
  const { byId } = usePlans();
  const items = q.data?.items ?? [];
  return (
    <>
      <PageHeader
        title="Expiring soon"
        description={
          q.data
            ? `${fmtNum(q.data.total)} active prepaid customers expire in this window${q.data.total > items.length ? ` · showing the first ${items.length}` : ''}.`
            : 'Active prepaid customers whose validity runs out soon, soonest first.'
        }
      />
      <Tabs value={days} onValueChange={setDays} className="mb-3">
        <TabsList>
          {WINDOWS.map(([v, label]) => (
            <TabsTrigger key={v} value={v}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <Card className="overflow-hidden">
        {q.isError ? (
          <div className="p-4">
            <ErrorState error={q.error} onRetry={() => void q.refetch()} />
          </div>
        ) : q.isLoading ? (
          <div className="space-y-3 p-5">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <p className="px-5 py-12 text-center text-sm text-muted-foreground">
            Nobody expires in this window.
          </p>
        ) : (
          <ExpiringRows items={items} byId={byId} />
        )}
      </Card>
    </>
  );
}
