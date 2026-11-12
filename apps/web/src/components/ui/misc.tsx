'use client';
import { AlertTriangle, Check, Copy } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { Dialog, DialogContent, dialogActions } from './dialog';
import { Label } from './input';

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0 space-y-0.5">
        <h1 className="truncate text-[22px] font-extrabold tracking-[-0.03em] sm:text-[26px]">{title}</h1>
        {description ? <p className="text-[13px] text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : 'Something went wrong';
  const forbidden = error instanceof ApiError && error.status === 403;
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 rounded-2xl border bg-card px-4 py-12 text-center"
    >
      <span className="grid size-11 place-items-center rounded-xl bg-warning-bg text-warning-text">
        <AlertTriangle className="size-5" aria-hidden />
      </span>
      <p className="text-sm font-semibold text-foreground">
        {forbidden ? 'Your role does not allow this.' : msg}
      </p>
      {error instanceof ApiError && error.requestId ? (
        <p className="font-mono text-xs text-muted-foreground">ref {error.requestId}</p>
      ) : null}
      {onRetry && !forbidden ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function Field({
  label,
  error,
  hint,
  children,
  className,
  htmlFor,
}: {
  label: ReactNode;
  error?: string | undefined;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? (
        <p className="text-xs text-danger-text" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? <Check /> : <Copy />}
    </Button>
  );
}

/** Shows a secret once with copy; the server never shows it again unless revealed (audited). */
export function SecretBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">{label}</p>
      <div className="flex items-center gap-2 rounded-xl border bg-subtle px-3 py-1">
        <code className="flex-1 font-mono text-sm break-all">{value}</code>
        <CopyButton value={value} />
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive,
  loading,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} description={description}>
        {children}
        <div className={dialogActions}>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant={destructive ? 'destructive' : 'default'} loading={loading} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const DOT = {
  success: 'bg-success',
  primary: 'bg-chart-1',
  danger: 'bg-destructive',
  warning: 'bg-warning',
  info: 'bg-chart-3',
  teal: 'bg-chart-4',
} as const;

export function Stat({
  label,
  value,
  hint,
  dot,
  hintTone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  dot?: keyof typeof DOT;
  hintTone?: 'success' | 'danger' | 'warning';
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-2xl border bg-card px-[18px] py-4">
      <p className="flex items-center gap-2 text-[13px] font-semibold text-body">
        {dot ? <span className={cn('size-2 shrink-0 rounded-full', DOT[dot])} aria-hidden /> : null}
        {label}
      </p>
      <p className="text-[clamp(22px,2.2vw,28px)] leading-tight font-extrabold tracking-[-0.03em] break-words text-foreground tabular-nums">
        {value}
      </p>
      {hint ? (
        <p
          className={cn(
            'text-xs font-semibold text-muted-foreground',
            hintTone === 'success' && 'text-success-text',
            hintTone === 'danger' && 'text-danger-text',
            hintTone === 'warning' && 'text-warning-text',
          )}
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function KeyValue({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="eyebrow text-[10px]">{k}</dt>
          <dd className="mt-1 font-medium break-words text-foreground">{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
