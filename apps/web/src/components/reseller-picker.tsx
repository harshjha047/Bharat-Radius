'use client';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useDebounced } from '@/hooks/use-debounced';
import { api, unwrap } from '@/lib/api';

export interface ResellerRef {
  id: string;
  code: string;
  name: string;
}

/** Search-as-you-type reseller chooser (code, name or owner prefix); `null` = no reseller. */
export function ResellerPicker({
  id,
  value,
  onChange,
  noneLabel = 'None',
  exclude,
  invalid,
}: {
  id?: string;
  value: ResellerRef | null;
  onChange: (r: ResellerRef | null) => void;
  noneLabel?: string;
  /** Hidden from the results (e.g. the reseller being moved). */
  exclude?: string;
  invalid?: boolean;
}) {
  const listId = useId();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const dq = useDebounced(q.trim(), 250);
  const res = useQuery({
    queryKey: ['resellers', 'pick', dq],
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/resellers', {
          params: { query: { limit: 20, status: 'active', ...(dq ? { q: dq } : {}) } },
        }),
      ),
    enabled: open,
    staleTime: 30_000,
  });
  const items = (res.data?.items ?? []).filter((r) => r.id !== exclude);

  if (value) {
    return (
      <div className="flex h-9 items-center justify-between gap-2 rounded-xl border bg-subtle px-3 text-sm">
        <span className="truncate">
          {value.name} <span className="text-muted-foreground">· {value.code}</span>
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Clear reseller"
          onClick={() => onChange(null)}
        >
          <X />
        </Button>
      </div>
    );
  }
  return (
    <div className="relative">
      <Input
        id={id}
        type="search"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-invalid={invalid || undefined}
        placeholder={`${noneLabel} · type to search resellers`}
        value={q}
        maxLength={64}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open ? (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-xl border bg-card p-1 shadow-[0_6px_16px_rgba(36,23,42,0.10)]"
        >
          {res.isLoading ? <li className="px-2 py-1.5 text-sm text-muted-foreground">Searching…</li> : null}
          {!res.isLoading && !items.length ? (
            <li className="px-2 py-1.5 text-sm text-muted-foreground">No active reseller matches.</li>
          ) : null}
          {items.map((r) => (
            <li
              key={r.id}
              role="option"
              aria-selected={false}
              className="cursor-pointer rounded px-2 py-1.5 text-sm hover:bg-subtle"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange({ id: r.id, code: r.code, name: r.name });
                setQ('');
                setOpen(false);
              }}
            >
              {r.name} <span className="text-muted-foreground">· {r.code}</span>
              {r.level > 1 ? (
                <span className="ml-1 text-xs text-muted-foreground">(level {r.level})</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
