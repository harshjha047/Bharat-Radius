'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ImageUp, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ErrorState, Field } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorText, unwrap, uploadFile, type ApiData } from '@/lib/api';
import { ME_KEY, useCan } from '@/lib/auth';

type Branding = ApiData<'/api/v1/resellers/{id}/branding'>;

/** F-8: name and logo a reseller's panel and its customers see (sub-resellers inherit it unless they set their own). */
export function ResellerBranding({ resellerId }: { resellerId: string }) {
  const qc = useQueryClient();
  const can = useCan();
  const edit = can('branding.manage');
  const key = ['branding', resellerId];
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      unwrap(api.GET('/api/v1/resellers/{id}/branding', { params: { path: { id: resellerId } } })),
  });
  const [name, setName] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const done = (b: Branding, msg: string) => {
    qc.setQueryData(key, b);
    void qc.invalidateQueries({ queryKey: ME_KEY });
    toast.success(msg);
  };
  const saveName = useMutation({
    meta: { silent: true },
    mutationFn: (n: string | null) =>
      unwrap(
        api.PUT('/api/v1/resellers/{id}/branding', {
          params: { path: { id: resellerId } },
          body: { name: n },
        }),
      ),
    onSuccess: (b) => {
      setName(null);
      done(b, 'Name saved.');
    },
  });
  const upload = useMutation({
    meta: { silent: true },
    mutationFn: (f: File) => uploadFile<Branding>(`/api/v1/resellers/${resellerId}/branding/logo`, f, 'PUT'),
    onSuccess: (b) => {
      if (file.current) file.current.value = '';
      done(b, 'Logo saved.');
    },
  });
  const removeLogo = useMutation({
    mutationFn: () =>
      unwrap(api.DELETE('/api/v1/resellers/{id}/branding/logo', { params: { path: { id: resellerId } } })),
    onSuccess: (b) => done(b, 'Logo removed.'),
  });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data) return <Skeleton className="h-48 w-full" />;
  const b = q.data;
  const value = name ?? b.name ?? '';
  const inherited = b.effective.fromResellerId && b.effective.fromResellerId !== resellerId;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Branding</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">
          Shown in this reseller’s panel and in its customers’ portal instead of the ISP name. Sub-resellers
          use it too unless they set their own. “Powered by” stays.
        </p>
        <div className="flex items-center gap-4 rounded-xl border p-4">
          {b.effective.logoUrl ? (
            <img src={b.effective.logoUrl} alt="" className="h-12 w-auto max-w-40 object-contain" />
          ) : (
            <div className="grid h-12 w-12 place-items-center rounded-lg bg-muted text-xs text-muted-foreground">
              logo
            </div>
          )}
          <div className="min-w-0">
            <p className="font-semibold">{b.effective.name ?? 'ISP name (default)'}</p>
            <p className="text-xs text-muted-foreground">
              {inherited ? 'Inherited from a parent reseller' : 'What its panel and customers see'}
            </p>
          </div>
        </div>
        {edit ? (
          <>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                saveName.mutate(value.trim() || null);
              }}
            >
              <Field
                label="Display name"
                htmlFor="br-name"
                className="min-w-64 flex-1"
                error={saveName.error ? errorText(saveName.error) : undefined}
              >
                <Input id="br-name" maxLength={60} value={value} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Button type="submit" variant="outline" loading={saveName.isPending} disabled={name === null}>
                Save name
              </Button>
            </form>
            <div className="flex flex-wrap items-end gap-2">
              <Field
                label="Logo (PNG, JPEG or WebP, up to 512 KB; wide logos fit best)"
                htmlFor="br-logo"
                className="min-w-64 flex-1"
                error={upload.error ? errorText(upload.error) : undefined}
              >
                <Input
                  ref={file}
                  id="br-logo"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) upload.mutate(f);
                  }}
                />
              </Field>
              {upload.isPending ? (
                <Button variant="outline" loading>
                  <ImageUp /> Uploading
                </Button>
              ) : null}
              {b.logoUrl ? (
                <Button variant="outline" loading={removeLogo.isPending} onClick={() => removeLogo.mutate()}>
                  <Trash2 /> Remove logo
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
