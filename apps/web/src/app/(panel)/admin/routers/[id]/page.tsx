'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plug } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { usePolledSeries, type TrafficPoint } from '@/components/router-live';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { ErrorState, Field, KeyValue, PageHeader } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorText, unwrap } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { fmtBps } from '@/lib/utils';

const TrafficChart = dynamic(() => import('@/components/traffic-chart'), {
  ssr: false,
  loading: () => <Skeleton className="h-[220px] w-full rounded-xl" />,
});

const MAX_POINTS = 90;

function ApiForm({ id }: { id: string }) {
  const qc = useQueryClient();
  const can = useCan();
  const q = useQuery({
    queryKey: ['nas', id, 'api'],
    queryFn: () => unwrap(api.GET('/api/v1/nas/{id}/api', { params: { path: { id } } })),
  });
  const save = useMutation({
    meta: { silent: true },
    mutationFn: (body: {
      enabled: boolean;
      host: string | null;
      port: number;
      tls: boolean;
      username: string;
      password?: string;
      monitorPorts: { interface: string; label?: string }[];
    }) => unwrap(api.PUT('/api/v1/nas/{id}/api', { params: { path: { id } }, body })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['nas'] });
      void qc.invalidateQueries({ queryKey: ['router-live', id] });
      toast.success('API login saved.');
    },
  });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const a = q.data;
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const password = String(f.get('password') ?? '');
    save.mutate({
      enabled: f.get('enabled') === 'on',
      host: String(f.get('host') ?? '').trim() || null,
      port: Number(f.get('port') || 8728),
      tls: f.get('tls') === 'on',
      username: String(f.get('username') ?? '').trim(),
      ...(password ? { password } : {}),
      monitorPorts: (a?.monitorPorts ?? []).map((p) => ({
        interface: p.interface,
        ...(p.label ? { label: p.label } : {}),
      })),
    });
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>API login</CardTitle>
        <CardDescription>
          RouterOS user with the <code>api</code> and <code>read</code> policies (add <code>test</code> for
          ping). Allow only this server on the API port in the router’s firewall.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!a ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <form key={`${a.username}-${a.port}`} onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
            <Field label="Username" htmlFor="api-user">
              <Input
                id="api-user"
                name="username"
                defaultValue={a.username ?? ''}
                required
                autoComplete="off"
              />
            </Field>
            <Field
              label="Password"
              htmlFor="api-pw"
              hint={a.hasPassword ? 'Saved. Leave empty to keep it.' : undefined}
            >
              <Input id="api-pw" name="password" type="password" autoComplete="new-password" />
            </Field>
            <Field label="Address" htmlFor="api-host" hint="Empty = the router’s RADIUS IP.">
              <Input id="api-host" name="host" defaultValue={a.host ?? ''} />
            </Field>
            <Field label="Port" htmlFor="api-port" hint="8728 (api) or 8729 (api-ssl).">
              <Input id="api-port" name="port" inputMode="numeric" defaultValue={a.port} />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="tls" defaultChecked={a.tls} /> Use api-ssl (TLS)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="enabled" defaultChecked={a.enabled || !a.username} /> Live graphs
              on
            </label>
            {save.error ? (
              <p className="text-sm text-destructive sm:col-span-2">{errorText(save.error)}</p>
            ) : null}
            {can('nas.write') ? (
              <div className="flex justify-end sm:col-span-2">
                <Button type="submit" loading={save.isPending}>
                  <Plug /> Save and connect
                </Button>
              </div>
            ) : null}
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function Info({ id, ip }: { id: string; ip: string }) {
  const can = useCan();
  const q = useQuery({
    queryKey: ['router-live', id, 'info'],
    queryFn: () => unwrap(api.GET('/api/v1/nas/{id}/live/info', { params: { path: { id } } })),
    refetchInterval: 30_000,
    retry: false,
  });
  const online = useQuery({
    queryKey: ['router-live', id, 'online'],
    queryFn: () => unwrap(api.GET('/api/v1/nas/{id}/live/online', { params: { path: { id } } })),
    enabled: can('sessions.read'),
    refetchInterval: 30_000,
    retry: false,
  });
  const summary = useQuery({
    queryKey: ['sessions', 'summary'],
    queryFn: () => unwrap(api.GET('/api/v1/sessions/summary')),
    enabled: can('sessions.read'),
    refetchInterval: 30_000,
  });
  const radiusOnline = summary.data?.byNas.find((x) => x.nasIp === ip)?.online ?? 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Router</CardTitle>
      </CardHeader>
      <CardContent>
        {q.isError ? (
          <p className="text-sm text-destructive">{errorText(q.error)}</p>
        ) : !q.data ? (
          <Skeleton className="h-28 w-full" />
        ) : (
          <KeyValue
            items={[
              ['Identity', q.data.identity ?? '—'],
              ['Board', q.data.board ?? '—'],
              ['RouterOS', q.data.version ?? '—'],
              ['Uptime', q.data.uptime ?? '—'],
              ['CPU', q.data.cpuLoadPct === null ? '—' : `${q.data.cpuLoadPct}%`],
              ['Memory used', q.data.memoryUsedPct === null ? '—' : `${q.data.memoryUsedPct}%`],
              ...(online.data
                ? ([
                    [
                      'PPPoE online',
                      `${online.data.pppActive} on the router · ${radiusOnline} in RADIUS${
                        online.data.pppActive === radiusOnline ? '' : ' (mismatch)'
                      }`,
                    ],
                  ] as [string, string][])
                : []),
            ]}
          />
        )}
      </CardContent>
    </Card>
  );
}

function Traffic({ id, interfaces }: { id: string; interfaces: string[] }) {
  const [iface, setIface] = useState('');
  const chosen = iface || interfaces[0] || '';
  const { data, error } = usePolledSeries(
    ['router-live', id, 'traffic', chosen],
    () =>
      unwrap(
        api.GET('/api/v1/nas/{id}/live/traffic', { params: { path: { id }, query: { interfaces: chosen } } }),
      ),
    (d): TrafficPoint => ({ at: d.at, rx: d.interfaces[0]?.rxBps ?? 0, tx: d.interfaces[0]?.txBps ?? 0 }),
    2000,
    MAX_POINTS,
    !!chosen,
  );
  const list = useMemo(() => data?.series ?? [], [data]);
  const stats = useMemo(() => {
    if (!list.length) return null;
    const avg = (k: 'rx' | 'tx') => list.reduce((n, p) => n + p[k], 0) / list.length;
    const peak = (k: 'rx' | 'tx') => Math.max(...list.map((p) => p[k]));
    return { rxAvg: avg('rx'), txAvg: avg('tx'), rxPeak: peak('rx'), txPeak: peak('tx') };
  }, [list]);
  return (
    <Card className="lg:col-span-2">
      <CardHeader className="flex flex-row flex-wrap items-center gap-3">
        <CardTitle className="mr-auto">Traffic</CardTitle>
        <Select
          value={chosen}
          onChange={(e) => setIface(e.target.value)}
          aria-label="Interface"
          className="w-56"
        >
          {interfaces.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? <p className="text-sm text-destructive">{errorText(error)}</p> : null}
        <TrafficChart points={list} />
        {stats ? (
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <span>
              RX now <strong>{fmtBps(list.at(-1)!.rx)}</strong>
            </span>
            <span>
              TX now <strong>{fmtBps(list.at(-1)!.tx)}</strong>
            </span>
            <span>
              RX avg / peak{' '}
              <strong>
                {fmtBps(stats.rxAvg)} / {fmtBps(stats.rxPeak)}
              </strong>
            </span>
            <span>
              TX avg / peak{' '}
              <strong>
                {fmtBps(stats.txAvg)} / {fmtBps(stats.txPeak)}
              </strong>
            </span>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Ping({ id }: { id: string }) {
  const [address, setAddress] = useState('8.8.8.8');
  const [target, setTarget] = useState('8.8.8.8');
  const q = usePolledSeries(
    ['router-live', id, 'ping', target],
    () =>
      unwrap(api.GET('/api/v1/nas/{id}/live/ping', { params: { path: { id }, query: { address: target } } })),
    (d) => d.avgMs,
    5000,
  );
  const data = q.data?.last;
  const error = q.error;
  const ms = (q.data?.series ?? []).filter((x): x is number => x !== null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Latency</CardTitle>
        <CardDescription>Ping from the router, 3 packets every 5 s.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setTarget(address.trim() || '8.8.8.8');
          }}
        >
          <Input value={address} onChange={(e) => setAddress(e.target.value)} aria-label="Address to ping" />
          <Button type="submit" variant="outline">
            Ping
          </Button>
        </form>
        {error ? <p className="text-sm text-destructive">{errorText(error)}</p> : null}
        {data ? (
          <KeyValue
            items={[
              ['Current', data.avgMs === null ? 'timeout' : `${data.avgMs.toFixed(1)} ms`],
              ['Average', ms.length ? `${(ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(1)} ms` : '—'],
              [
                'Min / max',
                ms.length ? `${Math.min(...ms).toFixed(1)} / ${Math.max(...ms).toFixed(1)} ms` : '—',
              ],
              ['Loss (last)', `${data.lossPct}%`],
            ]}
          />
        ) : !error ? (
          <Skeleton className="h-24 w-full" />
        ) : null}
      </CardContent>
    </Card>
  );
}

function MonitoredPorts({ id, interfaces }: { id: string; interfaces: string[] }) {
  const qc = useQueryClient();
  const can = useCan();
  const q = useQuery({
    queryKey: ['nas', id, 'api'],
    queryFn: () => unwrap(api.GET('/api/v1/nas/{id}/api', { params: { path: { id } } })),
  });
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const saved = useMemo(
    () => Object.fromEntries((q.data?.monitorPorts ?? []).map((p) => [p.interface, p.label ?? ''])),
    [q.data],
  );
  const ports = draft ?? saved;
  const save = useMutation({
    mutationFn: () => {
      const a = q.data!;
      return unwrap(
        api.PUT('/api/v1/nas/{id}/api', {
          params: { path: { id } },
          body: {
            enabled: a.enabled,
            host: a.host,
            port: a.port,
            tls: a.tls,
            username: a.username ?? '',
            monitorPorts: Object.entries(ports).map(([i, label]) => ({
              interface: i,
              ...(label.trim() ? { label: label.trim() } : {}),
            })),
          },
        }),
      );
    },
    onSuccess: () => {
      setDraft(null);
      void qc.invalidateQueries({ queryKey: ['nas'] });
      toast.success('Ports saved; they show on the dashboard.');
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Ports on the dashboard</CardTitle>
        <CardDescription>Pick the ports to watch (uplink, OLT VLAN …) and give them a name.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {interfaces.map((n) => (
          <div key={n} className="flex items-center gap-2">
            <label className="flex w-40 shrink-0 items-center gap-2 font-mono text-xs">
              <input
                type="checkbox"
                checked={n in ports}
                disabled={!can('nas.write')}
                onChange={(e) =>
                  setDraft(
                    e.target.checked
                      ? { ...ports, [n]: '' }
                      : Object.fromEntries(Object.entries(ports).filter(([k]) => k !== n)),
                  )
                }
              />
              {n}
            </label>
            {n in ports ? (
              <Input
                value={ports[n]}
                placeholder="Label (optional)"
                aria-label={`Label for ${n}`}
                onChange={(e) => setDraft({ ...ports, [n]: e.target.value })}
                className="h-8"
              />
            ) : null}
          </div>
        ))}
        {can('nas.write') ? (
          <div className="flex justify-end">
            <Button
              disabled={!draft || !q.data?.hasPassword}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              Save ports
            </Button>
          </div>
        ) : null}
        {save.error ? <p className="text-sm text-destructive">{errorText(save.error)}</p> : null}
      </CardContent>
    </Card>
  );
}

export default function RouterPage() {
  const { id } = useParams<{ id: string }>();
  const nas = useQuery({
    queryKey: ['nas', id],
    queryFn: () => unwrap(api.GET('/api/v1/nas/{id}', { params: { path: { id } } })),
  });
  const n = nas.data;
  const ifaces = useQuery({
    queryKey: ['router-live', id, 'interfaces'],
    queryFn: () => unwrap(api.GET('/api/v1/nas/{id}/live/interfaces', { params: { path: { id } } })),
    enabled: !!n?.apiEnabled,
    staleTime: 60_000,
    retry: false,
  });
  const names = useMemo(
    () => (ifaces.data ?? []).filter((i) => !i.disabled && !i.name.startsWith('<')).map((i) => i.name),
    [ifaces.data],
  );
  return (
    <>
      <PageHeader
        title={n?.name ?? 'Router'}
        description={n ? `${n.ip}${n.location.popName ? ` · ${n.location.popName}` : ''}` : undefined}
        actions={
          <Button variant="outline" asChild>
            <Link href="/admin/routers">
              <ArrowLeft /> Routers
            </Link>
          </Button>
        }
      />
      {nas.isError ? <ErrorState error={nas.error} onRetry={() => void nas.refetch()} /> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <ApiForm id={id} />
        {n?.apiEnabled ? (
          <Info id={id} ip={n.ip} />
        ) : (
          <Card>
            <CardContent className="py-8 text-sm text-muted-foreground">
              <Badge tone="neutral">Live graphs off</Badge>
              <p className="mt-2">
                Save the router’s API login to see traffic, latency and router health here.
              </p>
            </CardContent>
          </Card>
        )}
        {n?.apiEnabled ? (
          ifaces.isError ? (
            <Card className="lg:col-span-2">
              <CardContent className="py-6 text-sm text-destructive">{errorText(ifaces.error)}</CardContent>
            </Card>
          ) : names.length ? (
            <>
              <Traffic id={id} interfaces={names} />
              <Ping id={id} />
              <MonitoredPorts id={id} interfaces={names} />
            </>
          ) : (
            <Skeleton className="h-64 w-full rounded-2xl lg:col-span-2" />
          )
        ) : null}
      </div>
    </>
  );
}
