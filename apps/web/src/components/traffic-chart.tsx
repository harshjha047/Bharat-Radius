'use client';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtBps } from '@/lib/utils';
import type { TrafficPoint } from './router-live';

const time = new Intl.DateTimeFormat('en-IN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZone: 'Asia/Kolkata',
});

/** Live RX/TX area chart (recharts is loaded only where this is rendered). */
export default function TrafficChart({ points, height = 220 }: { points: TrafficPoint[]; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={points} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis
          dataKey="at"
          tickFormatter={(v: string) => time.format(new Date(v))}
          tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
          tickLine={false}
          axisLine={false}
          minTickGap={40}
        />
        <YAxis
          tickFormatter={(v: number) => fmtBps(v)}
          tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
          tickLine={false}
          axisLine={false}
          width={72}
        />
        <Tooltip
          formatter={(v, k) => [fmtBps(Number(v)), k === 'rx' ? 'RX' : 'TX']}
          labelFormatter={(v) => time.format(new Date(String(v)))}
          contentStyle={{
            background: 'var(--foreground)',
            border: 0,
            borderRadius: 10,
            fontSize: 12,
            color: '#fff',
          }}
        />
        <Area
          type="monotone"
          dataKey="rx"
          stroke="var(--chart-1)"
          fill="var(--chart-1)"
          fillOpacity={0.2}
          isAnimationActive={false}
        />
        <Area
          type="monotone"
          dataKey="tx"
          stroke="var(--chart-2)"
          fill="var(--chart-2)"
          fillOpacity={0.15}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
