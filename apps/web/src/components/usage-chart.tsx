'use client';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtBytes, fmtDay } from '@/lib/utils';

export interface UsageDay {
  day: string;
  uploadBytes: number;
  downloadBytes: number;
}

/** Daily download/upload, stacked. Loaded on demand (Recharts is the heaviest dependency). */
export default function UsageChart({ days }: { days: UsageDay[] }) {
  return (
    <div className="h-64 w-full" role="img" aria-label="Daily data usage chart">
      <ResponsiveContainer>
        <BarChart data={days} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis
            dataKey="day"
            tickFormatter={fmtDay}
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            tickLine={false}
            axisLine={false}
            minTickGap={16}
          />
          <YAxis
            tickFormatter={(v: number) => fmtBytes(v)}
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            tickLine={false}
            axisLine={false}
            width={64}
          />
          <Tooltip
            cursor={{ fill: 'var(--muted)' }}
            contentStyle={{
              background: 'var(--card)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              fontSize: 12,
            }}
            labelFormatter={(d) => fmtDay(String(d))}
            formatter={(v, name) => [fmtBytes(Number(v)), name === 'downloadBytes' ? 'Download' : 'Upload']}
          />
          <Bar dataKey="downloadBytes" stackId="a" fill="var(--primary)" radius={[0, 0, 0, 0]} />
          <Bar dataKey="uploadBytes" stackId="a" fill="var(--success)" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
