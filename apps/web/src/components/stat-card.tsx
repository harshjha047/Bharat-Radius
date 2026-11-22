import { ArrowUp } from 'lucide-react';
import Link from 'next/link';
import { useId } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export type StatTone = 'plain' | 'success' | 'warning' | 'danger' | 'info';

export interface StatCardProps {
  label: string;
  /** Pre-formatted: "₹5,805.60", "3.47 TB", "441". */
  value: string;
  /** Coloured start of the change line: "+12", "₹1". */
  today?: string;
  /** Grey end of the change line. */
  todayLabel?: string;
  trend?: string;
  trendDir?: 'up' | 'down';
  /** Chip colour: green when the move is good, red when bad, whatever the arrow says. */
  trendGood?: boolean;
  period?: string;
  tone?: StatTone;
  /** Oldest first; fewer than 2 points draws no chart. */
  spark?: number[];
  markerLabel?: string;
  markerSub?: string;
  href: string;
}

const TONES: Record<StatTone, { line: string; text: string; wash: string; dots: string }> = {
  plain: { line: '#9A96A2', text: '#5F5B66', wash: 'rgba(139,135,146,.10)', dots: 'rgba(139,135,146,.22)' },
  success: { line: '#3AA570', text: '#1E7A4A', wash: 'rgba(58,165,112,.14)', dots: 'rgba(58,165,112,.22)' },
  warning: { line: '#E39A2E', text: '#B45309', wash: 'rgba(227,154,46,.14)', dots: 'rgba(227,154,46,.24)' },
  danger: { line: '#E0525F', text: '#B42335', wash: 'rgba(224,82,95,.14)', dots: 'rgba(224,82,95,.22)' },
  info: { line: '#4C86F0', text: '#1D5FD1', wash: 'rgba(76,134,240,.13)', dots: 'rgba(76,134,240,.22)' },
};

/** True when the value has no digit 1–9 ("0", "₹0.00"): shown grey, tone ignored. */
export const isZeroValue = (v: string) => !/[1-9]/.test(v);

/** Whole part and the rest from the first "." (decimals and any unit): "3.47 TB" → ["3", ".47 TB"]. */
export function splitValue(v: string): [string, string] {
  const i = v.indexOf('.');
  return i < 0 ? [v, ''] : [v.slice(0, i), v.slice(i)];
}

type Pt = [number, number];

/** Points in a 100×40 box: x spread evenly, y between 8 (max) and 36 (min). */
export function sparkPoints(values: number[]): Pt[] {
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const n = values.length;
  return values.map((v, i) => [(i / (n - 1)) * 100, 36 - ((v - min) / span) * 28]);
}

/** Catmull-Rom through the points, as cubic Béziers (ends clamped). */
export function smoothPath(p: Pt[]): string {
  const f = (n: number) => Number(n.toFixed(2));
  let d = `M${f(p[0]![0])} ${f(p[0]![1])}`;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[Math.max(0, i - 1)]!;
    const p1 = p[i]!;
    const p2 = p[i + 1]!;
    const p3 = p[Math.min(p.length - 1, i + 2)]!;
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d;
}

export function statAriaLabel(
  p: Pick<StatCardProps, 'label' | 'value' | 'today' | 'todayLabel' | 'trend' | 'trendDir' | 'period'>,
) {
  let s = `${p.label}: ${p.value}`;
  if (p.today) s += `, ${p.today} ${p.todayLabel ?? 'today'}`;
  if (p.trend) s += `, ${p.trendDir === 'down' ? 'down' : 'up'} ${p.trend}${p.period ? ` ${p.period}` : ''}`;
  return s;
}

function Sparkline({
  values,
  color,
  markerLabel,
  markerSub,
}: {
  values: number[];
  color: string;
  markerLabel?: string;
  markerSub?: string;
}) {
  const id = useId();
  const pts = sparkPoints(values);
  const line = smoothPath(pts);
  const [x, y] = pts[pts.length - 1]!;
  return (
    <div aria-hidden className="pointer-events-none absolute right-0 bottom-0 -z-[1] h-[62%] w-[62%]">
      <svg
        viewBox="0 0 100 40"
        preserveAspectRatio="none"
        className="absolute inset-0 size-full overflow-visible"
      >
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.16} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <path d={`${line} L100 40 L0 40 Z`} fill={`url(#${id})`} />
        <path
          d={line}
          fill="none"
          stroke={color}
          strokeWidth={1.6}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span
        className="absolute bottom-0 border-l border-dashed border-[#DAD7DE]"
        style={{ left: `${Math.min(x, 97)}%`, top: '-40%' }}
      />
      <span
        className="absolute size-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full shadow-[0_0_0_2px_#fff]"
        style={{ left: `${Math.min(x, 97)}%`, top: `${(y / 40) * 100}%`, background: color }}
      />
      {markerLabel ? (
        <span
          className="absolute flex flex-col rounded-lg bg-white px-[9px] py-[5px] whitespace-nowrap shadow-[0_0_0_1px_#ECEAEF,0_4px_12px_-4px_rgba(22,19,26,.16)]"
          style={{
            left: `${Math.min(x, 97)}%`,
            top: `${(y / 40) * 100}%`,
            transform: 'translate(calc(-100% - 10px), -50%)',
          }}
        >
          <span className="text-xs font-medium text-[#16131A]">{markerLabel}</span>
          {markerSub ? <span className="text-[10px] text-[#6B6772]">{markerSub}</span> : null}
        </span>
      ) : null}
    </div>
  );
}

export function StatCard(props: StatCardProps) {
  const {
    label,
    value,
    today,
    todayLabel = 'today',
    trend,
    trendDir = 'up',
    trendGood = true,
    period,
    spark,
    markerLabel,
    markerSub,
    href,
  } = props;
  const zero = isZeroValue(value);
  const tone = TONES[zero ? 'plain' : (props.tone ?? 'plain')];
  const [whole, rest] = splitValue(value);
  return (
    <Link
      href={href}
      aria-label={statAriaLabel({ label, value, today, todayLabel, trend, trendDir, period })}
      className="@container relative isolate flex h-[132px] w-full min-w-0 flex-col justify-between overflow-hidden rounded-2xl border border-[#E7E5EA] bg-white px-4 py-3.5 text-inherit transition-[border-color,box-shadow] duration-[250ms] hover:border-[#DCD9E0] hover:text-inherit hover:shadow-[0_8px_24px_-14px_rgba(22,19,26,.22)] focus-visible:shadow-[0_0_0_2px_#3A3640] focus-visible:outline-none motion-reduce:transition-none"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-[2]"
        style={{ background: `linear-gradient(to top left, ${tone.wash} 0%, rgba(255,255,255,0) 58%)` }}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute right-0 bottom-0 -z-[1] h-[70%] w-[62%]"
        style={{
          backgroundImage: `radial-gradient(${tone.dots} 1px, transparent 1.3px)`,
          backgroundSize: '7px 7px',
          maskImage: 'linear-gradient(to top left, #000 0%, transparent 75%)',
          WebkitMaskImage: 'linear-gradient(to top left, #000 0%, transparent 75%)',
        }}
      />
      {spark && spark.length >= 2 ? (
        <Sparkline
          values={spark}
          color={tone.line}
          {...(markerLabel ? { markerLabel } : {})}
          {...(markerSub ? { markerSub } : {})}
        />
      ) : null}

      <span className="flex items-center gap-2.5">
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[#16131A] @min-[200px]:text-[13.5px]">
          {label}
        </span>
        {trend ? (
          <span
            className={cn(
              'inline-flex items-center gap-[5px] text-xs font-medium',
              trendGood ? 'text-[#1E7A4A]' : 'text-[#B42335]',
            )}
          >
            <span
              className={cn(
                'grid size-[18px] place-items-center rounded-[5px]',
                trendGood ? 'bg-[#E4F4EA]' : 'bg-[#FBE6E9]',
              )}
            >
              <ArrowUp
                className={cn('size-3', trendDir === 'down' && 'rotate-180')}
                strokeWidth={2.4}
                aria-hidden
              />
            </span>
            {trend}
          </span>
        ) : null}
        {period ? <span className="text-xs whitespace-nowrap text-[#8B8792]">{period}</span> : null}
      </span>

      <span className="flex max-w-full flex-col gap-1 @min-[230px]:max-w-[64%]">
        <span
          className={cn(
            'text-[24px] leading-none font-normal tracking-[-0.035em] whitespace-nowrap tabular-nums @min-[190px]:text-[28px] @min-[230px]:text-[34px]',
            zero ? 'text-[#8B8792]' : 'text-[#1C1A21]',
          )}
        >
          {whole}
          {rest ? (
            <span
              className={cn(
                'text-[13px] tracking-[-0.01em] @min-[230px]:text-[17px]',
                zero ? 'text-[#8B8792]' : 'text-[#71717A]',
              )}
            >
              {rest}
            </span>
          ) : null}
        </span>
        {today ? (
          <span className="text-xs whitespace-nowrap">
            <span className="font-medium" style={{ color: tone.text }}>
              {today}
            </span>{' '}
            <span className="text-[#8B8792]">{todayLabel}</span>
          </span>
        ) : null}
      </span>
    </Link>
  );
}

export const StatCardSkeleton = () => <Skeleton className="h-[132px] w-full min-w-0 rounded-2xl" />;
