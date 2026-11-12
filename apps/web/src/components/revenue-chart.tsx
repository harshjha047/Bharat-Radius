'use client';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtDay, fmtRupees0 } from '@/lib/utils';

export interface RevenueDay {
  day: string;
  billedPaise: number;
  collectedPaise: number;
}

/** "₹1.2 L", "₹90 K" — compact Indian units for the axis. */
function axisRupees(paise: number): string {
  const r = paise / 100;
  if (r >= 1e7) return `₹${+(r / 1e7).toFixed(1)} Cr`;
  if (r >= 1e5) return `₹${+(r / 1e5).toFixed(1)} L`;
  if (r >= 1e3) return `₹${+(r / 1e3).toFixed(0)} K`;
  return `₹${r.toFixed(0)}`;
}

/** Daily billed vs collected, overlapping areas. Loaded on demand (Recharts is the heaviest dependency). */
export default function RevenueChart({
  days,
  label = 'Daily revenue billed and collected, last 30 days',
  billedName = 'Billed',
}: {
  days: RevenueDay[];
  label?: string;
  billedName?: string;
}) {
  return (
    <div className="h-[220px] w-full" role="img" aria-label={label}>
      <ResponsiveContainer>
        <AreaChart data={days} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--divider)" />
          <XAxis
            dataKey="day"
            tickFormatter={fmtDay}
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            tickLine={false}
            axisLine={false}
            minTickGap={28}
          />
          <YAxis
            tickFormatter={axisRupees}
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            tickLine={false}
            axisLine={false}
            width={52}
          />
          <Tooltip
            cursor={{ stroke: 'var(--input)' }}
            contentStyle={{
              background: 'var(--foreground)',
              border: 0,
              borderRadius: 10,
              fontSize: 12,
              color: '#fff',
            }}
            labelStyle={{ color: '#cfc7d3', fontFamily: 'var(--font-mono)', fontSize: 11 }}
            itemStyle={{ color: '#fff' }}
            labelFormatter={(d) => fmtDay(String(d))}
            formatter={(v, name) => [
              fmtRupees0(Number(v)),
              name === 'billedPaise' ? billedName : 'Collected',
            ]}
          />
          <Area
            type="monotone"
            dataKey="billedPaise"
            stroke="var(--chart-1)"
            strokeWidth={2}
            fill="var(--chart-1)"
            fillOpacity={0.12}
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="collectedPaise"
            stroke="var(--chart-4)"
            strokeWidth={2}
            fill="var(--chart-4)"
            fillOpacity={0.16}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
