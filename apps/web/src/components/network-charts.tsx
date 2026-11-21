'use client';
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fmtBps, fmtBytes, fmtNum } from '@/lib/utils';

const istTime = new Intl.DateTimeFormat('en-IN', {
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZone: 'Asia/Kolkata',
});
const istHour = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', hour12: true, timeZone: 'Asia/Kolkata' });
const hourLabel = (iso: string) => istHour.format(new Date(iso)).toLowerCase();
const compact = (n: number) => (n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n));

const tooltip = {
  contentStyle: { background: 'var(--foreground)', border: 0, borderRadius: 10, fontSize: 12, color: '#fff' },
  labelStyle: { color: '#cfc7d3', fontFamily: 'var(--font-mono)', fontSize: 11 },
  itemStyle: { color: '#fff' },
} as const;
const axis = {
  tick: { fontSize: 11, fill: 'var(--muted-foreground)' },
  tickLine: false,
  axisLine: false,
} as const;

export interface OnlinePoint {
  at: string;
  online: number;
  lastWeek: number;
}

/** Online users through the day (solid) against the same hours last week (dashed). */
export function OnlineChart({ points }: { points: OnlinePoint[] }) {
  return (
    <div
      className="h-[220px] w-full"
      role="img"
      aria-label="Online users over the last 24 hours, with last week"
    >
      <ResponsiveContainer>
        <ComposedChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--divider)" />
          <XAxis dataKey="at" tickFormatter={hourLabel} minTickGap={36} {...axis} />
          <YAxis tickFormatter={compact} width={36} allowDecimals={false} {...axis} />
          <Tooltip
            {...tooltip}
            cursor={{ stroke: 'var(--muted-foreground)', strokeDasharray: '3 3' }}
            labelFormatter={(v) => `${istTime.format(new Date(String(v))).toLowerCase()} IST`}
            formatter={(v, name) => [fmtNum(Number(v)), name === 'online' ? 'Today' : 'Last week']}
          />
          <Area
            type="monotone"
            dataKey="online"
            stroke="none"
            fill="var(--chart-1)"
            fillOpacity={0.08}
            isAnimationActive={false}
            tooltipType="none"
          />
          <Line
            type="monotone"
            dataKey="lastWeek"
            stroke="var(--chart-2)"
            strokeWidth={2}
            strokeDasharray="5 4"
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="online"
            stroke="var(--chart-1)"
            strokeWidth={2.2}
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface AuthHour {
  hour: string;
  accepted: number;
  rejected: number;
}

/** Accepted logins (solid) with rejects stacked on top (hatched, so it reads without colour). */
export function LoginsChart({ hours }: { hours: AuthHour[] }) {
  return (
    <div
      className="h-[220px] w-full"
      role="img"
      aria-label="Radius logins and rejects per hour, last 24 hours"
    >
      <ResponsiveContainer>
        <BarChart data={hours} margin={{ top: 8, right: 0, left: 0, bottom: 0 }} barCategoryGap={2}>
          <defs>
            <pattern
              id="reject-hatch"
              width="4"
              height="4"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <rect width="4" height="4" fill="#F6C894" />
              <rect width="2" height="4" fill="var(--chart-2)" />
            </pattern>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--divider)" />
          <XAxis dataKey="hour" tickFormatter={hourLabel} minTickGap={28} {...axis} />
          <YAxis tickFormatter={compact} width={32} allowDecimals={false} {...axis} />
          <Tooltip
            {...tooltip}
            cursor={{ fill: 'var(--divider)' }}
            labelFormatter={(v) => `${hourLabel(String(v))} IST`}
            formatter={(v, name) => [fmtNum(Number(v)), name === 'accepted' ? 'Logins' : 'Rejects']}
          />
          <Bar dataKey="accepted" stackId="a" fill="var(--chart-1)" isAnimationActive={false} />
          <Bar dataKey="rejected" stackId="a" fill="url(#reject-hatch)" isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface BalancePoint {
  day: string;
  balancePaise: number;
}

/** End-of-day wallet balance with the low-balance line. */
export function BalanceChart({ days, lowPaise }: { days: BalancePoint[]; lowPaise: number }) {
  const rupees = (p: number) => `₹${fmtNum(Math.round(p / 100))}`;
  return (
    <div
      className="h-[150px] w-full"
      role="img"
      aria-label="Wallet balance at the end of each day, last 30 days"
    >
      <ResponsiveContainer>
        <ComposedChart data={days} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--divider)" />
          <XAxis
            dataKey="day"
            tickFormatter={(d: string) =>
              new Date(`${d}T00:00:00+05:30`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
            }
            minTickGap={36}
            {...axis}
          />
          <YAxis hide domain={[0, (max: number) => Math.max(max, lowPaise) * 1.1]} />
          <Tooltip
            {...tooltip}
            labelFormatter={(d) =>
              new Date(`${String(d)}T00:00:00+05:30`).toLocaleDateString('en-IN', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })
            }
            formatter={(v) => [rupees(Number(v)), 'Balance']}
          />
          <Area
            type="stepAfter"
            dataKey="balancePaise"
            stroke="var(--chart-1)"
            strokeWidth={2.2}
            fill="var(--chart-1)"
            fillOpacity={0.1}
            isAnimationActive={false}
          />
          <Line
            dataKey={() => lowPaise}
            stroke="var(--chart-2)"
            strokeDasharray="6 4"
            dot={false}
            activeDot={false}
            isAnimationActive={false}
            tooltipType="none"
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface DayCount {
  day: string;
  count: number;
}

/** Recharges per day (count). */
export function RechargesChart({ days }: { days: DayCount[] }) {
  return (
    <div className="h-[180px] w-full" role="img" aria-label="Recharges per day, last 30 days">
      <ResponsiveContainer>
        <BarChart data={days} margin={{ top: 8, right: 0, left: 0, bottom: 0 }} barCategoryGap={3}>
          <CartesianGrid vertical={false} stroke="var(--divider)" />
          <XAxis
            dataKey="day"
            tickFormatter={(d: string) =>
              new Date(`${d}T00:00:00+05:30`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
            }
            minTickGap={36}
            {...axis}
          />
          <YAxis width={28} allowDecimals={false} {...axis} />
          <Tooltip
            {...tooltip}
            cursor={{ fill: 'var(--divider)' }}
            formatter={(v) => [fmtNum(Number(v)), 'Recharges']}
          />
          <Bar dataKey="count" fill="var(--chart-1)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Accepted and rejected colours for the line chart (checked for colour-blind separation on white). */
export const LOGIN_COLORS = { accepted: '#3AA570', rejected: 'var(--danger-text)' } as const;

const istRange = (iso: string) => {
  const s = new Date(iso);
  const e = new Date(s.getTime() + 3_600_000);
  return `${hourLabel(s.toISOString())} – ${hourLabel(e.toISOString())}`;
};

function LoginsTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { dataKey?: string | number; value?: number | string }[];
  label?: string | number;
}) {
  if (!active || !payload?.length) return null;
  const v = (k: string) => fmtNum(Number(payload.find((p) => p.dataKey === k)?.value ?? 0));
  return (
    <div className="flex flex-col gap-1.5 rounded-[10px] bg-foreground px-3 py-2 text-white shadow-lg">
      <span className="font-mono text-[11px] text-[#cfc7d3]">{istRange(String(label))} IST</span>
      <span className="flex gap-4">
        <span className="flex flex-col">
          <span className="text-base font-bold tabular-nums">{v('accepted')}</span>
          <span className="text-[11px] text-[#cfc7d3]">Accepted</span>
        </span>
        <span className="flex flex-col">
          <span className="text-base font-bold tabular-nums">{v('rejected')}</span>
          <span className="text-[11px] text-[#cfc7d3]">Rejected</span>
        </span>
      </span>
    </div>
  );
}

/** RADIUS logins per hour as two lines (accepted, rejected) with soft fills and a crosshair tooltip. */
export function LoginsLineChart({ hours, className }: { hours: AuthHour[]; className?: string }) {
  return (
    <div
      className={className ?? 'h-[180px] w-full'}
      role="img"
      aria-label="Accepted and rejected logins per hour, last 24 hours"
    >
      <ResponsiveContainer>
        <ComposedChart data={hours} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="logins-acc" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={LOGIN_COLORS.accepted} stopOpacity={0.22} />
              <stop offset="1" stopColor={LOGIN_COLORS.accepted} stopOpacity={0} />
            </linearGradient>
            <linearGradient id="logins-rej" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={LOGIN_COLORS.rejected} stopOpacity={0.14} />
              <stop offset="1" stopColor={LOGIN_COLORS.rejected} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--divider)" strokeDasharray="3 3" />
          <XAxis dataKey="hour" tickFormatter={hourLabel} minTickGap={36} {...axis} />
          <YAxis tickFormatter={compact} width={28} allowDecimals={false} {...axis} />
          <Tooltip
            content={<LoginsTooltip />}
            cursor={{ stroke: 'var(--muted-foreground)', strokeDasharray: '3 3' }}
          />
          <Area
            type="linear"
            dataKey="accepted"
            stroke={LOGIN_COLORS.accepted}
            strokeWidth={2}
            fill="url(#logins-acc)"
            activeDot={{ r: 4, strokeWidth: 2, fill: '#fff', stroke: LOGIN_COLORS.accepted }}
            dot={false}
            isAnimationActive={false}
          />
          <Area
            type="linear"
            dataKey="rejected"
            stroke={LOGIN_COLORS.rejected}
            strokeWidth={2}
            fill="url(#logins-rej)"
            activeDot={{ r: 4, strokeWidth: 2, fill: '#fff', stroke: LOGIN_COLORS.rejected }}
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface UsageDay {
  day: string;
  downBytes: number;
  upBytes: number;
}

const bytes = (n: number) => fmtBytes(n);
const dayLabel = (d: string) =>
  new Date(`${d}T00:00:00+05:30`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

/** Data used per day: download (to subscribers) and upload, last 30 days. */
export const USAGE_COLORS = { down: '#4C86F0', up: '#3AA570' } as const;

export function UsageChart({ days }: { days: UsageDay[] }) {
  return (
    <div
      className="h-[220px] w-full"
      role="img"
      aria-label="Data used per day, download and upload, last 30 days"
    >
      <ResponsiveContainer>
        <ComposedChart data={days} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="usage-down" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={USAGE_COLORS.down} stopOpacity={0.22} />
              <stop offset="100%" stopColor={USAGE_COLORS.down} stopOpacity={0} />
            </linearGradient>
            <linearGradient id="usage-up" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={USAGE_COLORS.up} stopOpacity={0.18} />
              <stop offset="100%" stopColor={USAGE_COLORS.up} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--divider)" />
          <XAxis dataKey="day" tickFormatter={dayLabel} minTickGap={36} {...axis} />
          <YAxis width={56} tickFormatter={(v: number) => (v ? bytes(v) : '0')} {...axis} />
          <Tooltip
            {...tooltip}
            cursor={{ stroke: 'var(--divider)' }}
            labelFormatter={(d) => dayLabel(String(d))}
            formatter={(v, k) => [bytes(Number(v)), k === 'downBytes' ? 'Download' : 'Upload']}
          />
          <Area
            type="monotone"
            dataKey="downBytes"
            stroke={USAGE_COLORS.down}
            strokeWidth={1.8}
            fill="url(#usage-down)"
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="upBytes"
            stroke={USAGE_COLORS.up}
            strokeWidth={1.8}
            fill="url(#usage-up)"
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface SpeedPoint {
  at: string;
  rx: number;
  tx: number;
}
export const SPEED_COLORS = { rx: '#4C86F0', tx: '#3AA570' } as const;
const istSeconds = new Intl.DateTimeFormat('en-IN', {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
  timeZone: 'Asia/Kolkata',
});
/** Axis label without decimals: "600 Mbps", "1.2 Gbps". */
const bpsTick = (v: number) =>
  v >= 1e9
    ? `${+(v / 1e9).toFixed(1)} Gbps`
    : v >= 1e6
      ? `${Math.round(v / 1e6)} Mbps`
      : v
        ? `${Math.round(v / 1e3)} kbps`
        : '0';

/** Live network speed, newest on the right: download (RX) and upload (TX) in bits per second. */
export function LiveSpeedChart({ points }: { points: SpeedPoint[] }) {
  return (
    <div
      className="h-[200px] w-full"
      role="img"
      aria-label="Live network speed, download and upload, last few minutes"
    >
      <ResponsiveContainer>
        <ComposedChart data={points} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="speed-rx" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={SPEED_COLORS.rx} stopOpacity={0.2} />
              <stop offset="100%" stopColor={SPEED_COLORS.rx} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--divider)" />
          <XAxis
            dataKey="at"
            tickFormatter={(iso: string) => istSeconds.format(new Date(iso)).toLowerCase()}
            minTickGap={48}
            {...axis}
          />
          <YAxis width={72} tickFormatter={bpsTick} {...axis} />
          <Tooltip
            {...tooltip}
            cursor={{ stroke: 'var(--divider)' }}
            labelFormatter={(iso) => istSeconds.format(new Date(String(iso))).toLowerCase()}
            formatter={(v, k) => [fmtBps(Number(v)), k === 'rx' ? 'Download' : 'Upload']}
          />
          <Area
            type="monotone"
            dataKey="rx"
            stroke={SPEED_COLORS.rx}
            strokeWidth={1.8}
            fill="url(#speed-rx)"
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="tx"
            stroke={SPEED_COLORS.tx}
            strokeWidth={1.8}
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
