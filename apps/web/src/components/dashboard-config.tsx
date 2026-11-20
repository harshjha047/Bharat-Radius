'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, GripVertical, SlidersHorizontal } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, dialogActions } from '@/components/ui/dialog';
import { api, unwrap } from '@/lib/api';
import { cn } from '@/lib/utils';

export interface WidgetDef {
  id: string;
  label: string;
  /** Off until the user switches it on (only while they have not arranged this dashboard yet). */
  defaultHidden?: boolean;
}

export interface DashboardLayout {
  hidden: string[];
  /** Leave out to keep the saved order. */
  order?: string[];
}

const KEY = ['me', 'preferences'] as const;
type Prefs = { dashboardHidden: string[]; dashboardOrder: string[] };

/** Saved order first, then any widget the saved order does not know yet, in the page's default order. */
export function arrange<W extends { id: string }>(widgets: W[], order: readonly string[]): W[] {
  const at = new Map(order.map((id, i) => [id, i]));
  return widgets
    .map((w, i) => ({ w, i, at: at.get(w.id) }))
    .sort((a, b) => {
      if (a.at !== undefined && b.at !== undefined) return a.at - b.at;
      if (a.at !== undefined) return -1;
      if (b.at !== undefined) return 1;
      return a.i - b.i;
    })
    .map((x) => x.w);
}

/**
 * Which dashboard widgets this user hides, and the order they arranged them in
 * (saved on the server, so it follows them across devices).
 */
export function useDashboardPrefs() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: KEY,
    queryFn: () => unwrap(api.GET('/api/v1/auth/preferences')),
    staleTime: Infinity,
  });
  const hidden = useMemo(() => new Set(q.data?.dashboardHidden ?? []), [q.data]);
  const order = useMemo(() => q.data?.dashboardOrder ?? [], [q.data]);
  const save = useMutation({
    mutationFn: (l: DashboardLayout) =>
      unwrap(
        api.PUT('/api/v1/auth/preferences', {
          body: { dashboardHidden: l.hidden, ...(l.order ? { dashboardOrder: l.order } : {}) },
        }),
      ),
    onMutate: async (l) => {
      await qc.cancelQueries({ queryKey: KEY });
      const prev = qc.getQueryData<Prefs>(KEY);
      qc.setQueryData<Prefs>(KEY, {
        dashboardHidden: l.hidden,
        dashboardOrder: l.order ?? prev?.dashboardOrder ?? [],
      });
      return { prev };
    },
    onError: (_e, _v, c) => qc.setQueryData(KEY, c?.prev),
    onSettled: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
  /** True once the user arranged a dashboard: from then on `hidden` alone decides. */
  const arranged = order.length > 0;
  const shown = useCallback((id: string) => !hidden.has(id), [hidden]);
  const isShown = useCallback(
    (w: WidgetDef) => !hidden.has(w.id) && (arranged || !w.defaultHidden),
    [hidden, arranged],
  );
  return {
    shown,
    isShown,
    hidden,
    order,
    arranged,
    loaded: q.isSuccess,
    save: save.mutate,
    saving: save.isPending,
  };
}

/**
 * The Customise dialog. With `sortable`, each widget can also be dragged (or moved with the arrow
 * buttons, for keyboard and touch) to change the order of the dashboard.
 */
export function DashboardConfig({
  widgets,
  hidden,
  order = [],
  arranged = false,
  sortable = false,
  onSave,
  saving,
}: {
  widgets: WidgetDef[];
  hidden: Set<string>;
  order?: readonly string[];
  arranged?: boolean;
  sortable?: boolean;
  onSave: (layout: DashboardLayout) => void;
  saving: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draftHidden, setDraftHidden] = useState<Set<string>>(new Set());
  const [draftOrder, setDraftOrder] = useState<string[]>([]);
  const [dragging, setDragging] = useState<string | null>(null);
  const byId = useMemo(() => new Map(widgets.map((w) => [w.id, w])), [widgets]);

  const defaults = () => new Set(widgets.filter((w) => w.defaultHidden).map((w) => w.id));
  const begin = () => {
    const h = new Set(hidden);
    if (!arranged) for (const id of defaults()) h.add(id);
    setDraftHidden(h);
    setDraftOrder(arrange(widgets, order).map((w) => w.id));
    setOpen(true);
  };
  const move = (id: string, to: number) =>
    setDraftOrder((o) => {
      const from = o.indexOf(id);
      if (from < 0 || to < 0 || to >= o.length || from === to) return o;
      const n = [...o];
      n.splice(from, 1);
      n.splice(to, 0, id);
      return n;
    });
  const toggle = (id: string, on: boolean) =>
    setDraftHidden((d) => {
      const n = new Set(d);
      if (on) n.delete(id);
      else n.add(id);
      return n;
    });

  const rows = sortable ? draftOrder.map((id) => byId.get(id)).filter((w): w is WidgetDef => !!w) : widgets;

  return (
    <>
      <Button variant="outline" onClick={begin}>
        <SlidersHorizontal /> Customise
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Dashboard"
          description={
            sortable
              ? 'Choose what you see and drag to change the order. Saved for your account on every device.'
              : 'Choose what you see. Saved for your account on every device.'
          }
        >
          <ul className={cn('grid gap-2', !sortable && 'sm:grid-cols-2')}>
            {rows.map((w, i) => (
              <li
                key={w.id}
                draggable={sortable}
                onDragStart={(e) => {
                  setDragging(w.id);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  if (!dragging || dragging === w.id) return;
                  e.preventDefault();
                  move(dragging, i);
                }}
                onDragEnd={() => setDragging(null)}
                className={cn(
                  'flex items-center gap-2 rounded-xl border bg-card pr-1.5 text-sm hover:border-input',
                  dragging === w.id && 'border-accent-border bg-accent opacity-80',
                )}
              >
                {sortable ? (
                  <GripVertical
                    className="ml-2 size-4 shrink-0 cursor-grab text-muted-foreground"
                    aria-hidden
                  />
                ) : null}
                <label
                  className={cn(
                    'flex flex-1 cursor-pointer items-center gap-2.5 py-2.5',
                    !sortable && 'pl-3',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={!draftHidden.has(w.id)}
                    onChange={(e) => toggle(w.id, e.target.checked)}
                  />
                  {w.label}
                </label>
                {sortable ? (
                  <span className="flex gap-0.5">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Move ${w.label} up`}
                      disabled={i === 0}
                      onClick={() => move(w.id, i - 1)}
                    >
                      <ArrowUp />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Move ${w.label} down`}
                      disabled={i === rows.length - 1}
                      onClick={() => move(w.id, i + 1)}
                    >
                      <ArrowDown />
                    </Button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          <div className={dialogActions}>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setDraftHidden(sortable ? defaults() : new Set());
                setDraftOrder(widgets.map((w) => w.id));
              }}
            >
              {sortable ? 'Reset' : 'Show all'}
            </Button>
            <Button
              loading={saving}
              onClick={() => {
                // Ids of widgets this user cannot see (or of another dashboard) stay as they were.
                const mine = new Set(widgets.map((w) => w.id));
                const keepHidden = [...hidden].filter((id) => !mine.has(id));
                onSave({
                  hidden: [...keepHidden, ...draftHidden].filter((id, k, a) => a.indexOf(id) === k),
                  ...(sortable ? { order: [...draftOrder, ...order.filter((id) => !mine.has(id))] } : {}),
                });
                setOpen(false);
              }}
            >
              Save
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
