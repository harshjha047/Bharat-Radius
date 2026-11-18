'use client';
import { useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { Gauge } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Card, CardBar } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorText, unwrap } from '@/lib/api';
import type { Nas } from '@/lib/queries';
import { fmtBps } from '@/lib/utils';

export interface TrafficPoint {
  at: string;
  rx: number;
  tx: number;
}

const TrafficChart = dynamic(() => import('./traffic-chart'), {
  ssr: false,
  loading: () => <Skeleton className="h-[120px] w-full rounded-xl" />,
});

/**
 * Poll a live router value: one request at a time (react-query never overlaps a key), paused while the tab is
 * hidden, no retries (a slow router answers next tick instead of piling up).
 */
export function usePolled<T>(key: QueryKey, fn: () => Promise<T>, everyMs: number, enabled = true) {
  return useQuery({
    queryKey: key,
    queryFn: fn,
    enabled,
    refetchInterval: everyMs,
    refetchIntervalInBackground: false,
    retry: false,
    staleTime: 0,
    gcTime: 10_000,
  });
}

/**
 * Like usePolled, but keeps the last `max` samples in the query cache (no effect-driven state): each poll appends
 * `sample(response)` to the history already cached under the same key.
 */
export function usePolledSeries<T, S>(
  key: QueryKey,
  fn: () => Promise<T>,
  sample: (r: T) => S,
  everyMs: number,
  max = 60,
  enabled = true,
) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: key,
    queryFn: async () => {
      const r = await fn();
      const prev = qc.getQueryData<{ last: T; series: S[] }>(key)?.series ?? [];
      return { last: r, series: [...prev, sample(r)].slice(-max) };
    },
    enabled,
    refetchInterval: everyMs,
    refetchIntervalInBackground: false,
    retry: false,
    staleTime: 0,
    gcTime: 10_000,
  });
}

/** Subscriber profile: live download/upload from the router they are connected to. */
export function LiveSpeed({ id }: { id: string }) {
  const q = usePolled(
    ['subscriber', id, 'live-speed'],
    () => unwrap(api.GET('/api/v1/subscribers/{id}/live-speed', { params: { path: { id } } })),
    2000,
  );
  const d = q.data;
  return (
    <Card className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-4">
      <span className="flex items-center gap-2 text-sm font-bold">
        <Gauge className="size-4 text-primary" aria-hidden /> Live speed
      </span>
      {q.isError ? (
        <span className="text-sm text-destructive">{errorText(q.error)}</span>
      ) : !d ? (
        <Skeleton className="h-5 w-48" />
      ) : d.downloadBps !== null ? (
        <>
          <span className="text-sm">
            ↓ <strong className="tabular-nums">{fmtBps(d.downloadBps)}</strong>
          </span>
          <span className="text-sm">
            ↑ <strong className="tabular-nums">{fmtBps(d.uploadBps ?? 0)}</strong>
          </span>
          <span className="font-mono text-xs text-muted-foreground">
            {d.nasName} · {d.interface}
          </span>
        </>
      ) : (
        <span className="text-sm text-muted-foreground">
          {d.note}
          {d.nasName ? ` (${d.nasName})` : ''}
        </span>
      )}
    </Card>
  );
}

function PortGraphs({ nas }: { nas: Nas }) {
  const names = nas.monitorPorts.map((p) => p.interface).join(',');
  const q = usePolledSeries(
    ['router-live', nas.id, 'ports', names],
    () =>
      unwrap(
        api.GET('/api/v1/nas/{id}/live/traffic', {
          params: { path: { id: nas.id }, query: { interfaces: names } },
        }),
      ),
    (d) => d,
    5000,
  );
  const series = q.data?.series ?? [];
  const pointsOf = (iface: string): TrafficPoint[] =>
    series.flatMap((d) => {
      const m = d.interfaces.find((x) => x.name === iface);
      return m ? [{ at: d.at, rx: m.rxBps, tx: m.txBps }] : [];
    });
  return (
    <Card className="min-w-0 flex-[1_1_360px] overflow-hidden">
      <CardBar>
        <Link href={`/admin/routers/${nas.id}`} className="mr-auto text-base font-bold text-foreground">
          {nas.name}
        </Link>
        <span className="text-xs text-muted-foreground">live · every 5 s</span>
      </CardBar>
      <div className="flex flex-col gap-4 p-4">
        {q.isError ? <p className="text-sm text-destructive">{errorText(q.error)}</p> : null}
        {nas.monitorPorts.map((p) => {
          const pts = pointsOf(p.interface);
          const last = pts.at(-1);
          return (
            <div key={p.interface} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-baseline gap-x-3 text-sm">
                <span className="mr-auto font-semibold">
                  {p.label ?? p.interface}
                  {p.label ? (
                    <span className="ml-1 font-mono text-xs text-muted-foreground">{p.interface}</span>
                  ) : null}
                </span>
                <span className="tabular-nums">RX {last ? fmtBps(last.rx) : '…'}</span>
                <span className="tabular-nums">TX {last ? fmtBps(last.tx) : '…'}</span>
              </div>
              <TrafficChart points={pts} height={110} />
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/** Dashboard: live RX/TX of the ports chosen on each router (Routers → router → Ports on the dashboard). */
export function NasStatistics({ routers }: { routers: Nas[] }) {
  const watched = routers.filter((r) => r.status === 'active' && r.apiEnabled && r.monitorPorts.length);
  if (!watched.length) return null;
  return (
    <section aria-labelledby="nas-stats-h" className="flex flex-col gap-3">
      <h2 id="nas-stats-h" className="text-lg font-extrabold tracking-[-0.02em]">
        NAS statistics
      </h2>
      <div className="flex flex-wrap gap-3">
        {watched.map((r) => (
          <PortGraphs key={r.id} nas={r} />
        ))}
      </div>
    </section>
  );
}
