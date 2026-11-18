'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SlidersHorizontal } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, dialogActions } from '@/components/ui/dialog';
import { api, unwrap } from '@/lib/api';

export interface WidgetDef {
  id: string;
  label: string;
}

const KEY = ['me', 'preferences'] as const;

/** Which dashboard widgets this user hides (saved on the server, so it follows them across devices). */
export function useDashboardPrefs() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: KEY,
    queryFn: () => unwrap(api.GET('/api/v1/me/preferences')),
    staleTime: Infinity,
  });
  const hidden = useMemo(() => new Set(q.data?.dashboardHidden ?? []), [q.data]);
  const save = useMutation({
    mutationFn: (dashboardHidden: string[]) =>
      unwrap(api.PUT('/api/v1/me/preferences', { body: { dashboardHidden } })),
    onMutate: async (dashboardHidden) => {
      await qc.cancelQueries({ queryKey: KEY });
      const prev = qc.getQueryData(KEY);
      qc.setQueryData(KEY, { dashboardHidden });
      return { prev };
    },
    onError: (_e, _v, c) => qc.setQueryData(KEY, c?.prev),
    onSettled: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
  const shown = useCallback((id: string) => !hidden.has(id), [hidden]);
  return { shown, hidden, save: save.mutate, saving: save.isPending };
}

export function DashboardConfig({
  widgets,
  hidden,
  onSave,
  saving,
}: {
  widgets: WidgetDef[];
  hidden: Set<string>;
  onSave: (hidden: string[]) => void;
  saving: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Set<string>>(new Set());
  return (
    <>
      <Button
        variant="outline"
        onClick={() => {
          setDraft(new Set(hidden));
          setOpen(true);
        }}
      >
        <SlidersHorizontal /> Customise
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Dashboard"
          description="Choose what you see. Saved for your account on every device."
        >
          <ul className="grid gap-2 sm:grid-cols-2">
            {widgets.map((w) => (
              <li key={w.id}>
                <label className="flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2.5 text-sm hover:border-input">
                  <input
                    type="checkbox"
                    checked={!draft.has(w.id)}
                    onChange={(e) =>
                      setDraft((d) => {
                        const n = new Set(d);
                        if (e.target.checked) n.delete(w.id);
                        else n.add(w.id);
                        return n;
                      })
                    }
                  />
                  {w.label}
                </label>
              </li>
            ))}
          </ul>
          <div className={dialogActions}>
            <Button type="button" variant="ghost" onClick={() => setDraft(new Set())}>
              Show all
            </Button>
            <Button
              loading={saving}
              onClick={() => {
                // Ids of widgets this user cannot see stay as they were.
                const visible = new Set(widgets.map((w) => w.id));
                onSave([...[...hidden].filter((id) => !visible.has(id)), ...draft]);
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
