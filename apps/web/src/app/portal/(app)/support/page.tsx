'use client';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { CATEGORY_LABEL, TicketStatusBadge } from '@/components/tickets';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Select, Textarea } from '@/components/ui/input';
import { ErrorState, Field } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError, fieldErrors, unwrap } from '@/lib/api';
import { relTime } from '@/lib/utils';

const KEY = ['portal', 'tickets'] as const;
const CUSTOMER_CATEGORIES = [
  'no_internet',
  'slow_speed',
  'billing',
  'plan_change',
  'relocation',
  'other',
] as const;

function Support() {
  const params = useSearchParams();
  const initial = params.get('category');
  const list = useInfiniteQuery({
    queryKey: KEY,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/v1/portal/tickets', {
          params: { query: { limit: 20, ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <NewTicket
        initialCategory={(CUSTOMER_CATEGORIES as readonly string[]).includes(initial ?? '') ? initial! : null}
      />
      <Card>
        <CardHeader>
          <CardTitle>My tickets</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {list.isLoading ? <Skeleton className="h-16 w-full" /> : null}
          {list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : null}
          {!list.isLoading && !items.length ? (
            <p className="text-sm text-muted-foreground">No tickets yet.</p>
          ) : null}
          {items.map((t) => (
            <Link
              key={t.id}
              href={`/portal/support/${t.id}`}
              className="flex items-center justify-between gap-3 rounded-md border p-3 hover:bg-muted"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{t.subject}</span>
                <span className="text-xs text-muted-foreground">
                  {t.number} · {relTime(t.lastActivityAt)}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <TicketStatusBadge status={t.status} />
                <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
              </span>
            </Link>
          ))}
          {list.hasNextPage ? (
            <Button
              variant="outline"
              loading={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              Show more
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </>
  );
}

function NewTicket({ initialCategory }: { initialCategory: string | null }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState(!!initialCategory);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const create = useMutation({
    meta: { silent: true },
    mutationFn: (b: { subject: string; category: string; body: string }) =>
      unwrap(api.POST('/api/v1/portal/tickets', { body: b as never })),
    onSuccess: (t) => {
      void qc.invalidateQueries({ queryKey: KEY });
      router.push(`/portal/support/${t.id}`);
    },
    onError: (e) =>
      setErrors(
        e instanceof ApiError && e.status === 429
          ? { body: 'You have opened several tickets recently. Please wait before opening another.' }
          : { body: e instanceof Error ? e.message : 'Failed', ...fieldErrors(e) },
      ),
  });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setErrors({});
    create.mutate({
      subject: String(f.get('subject')),
      category: String(f.get('category')),
      body: String(f.get('body')),
    });
  };
  if (!open) {
    return (
      <Button size="lg" className="w-full sm:w-auto" onClick={() => setOpen(true)}>
        Report a problem
      </Button>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Report a problem</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label="What is it about?" htmlFor="category">
            <Select id="category" name="category" defaultValue={initialCategory ?? 'no_internet'}>
              {CUSTOMER_CATEGORIES.map((k) => (
                <option key={k} value={k}>
                  {CATEGORY_LABEL[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Subject" htmlFor="subject" error={errors.subject}>
            <Input
              id="subject"
              name="subject"
              required
              maxLength={160}
              defaultValue={initialCategory === 'plan_change' ? 'Change my plan' : ''}
            />
          </Field>
          <Field
            label="Details"
            htmlFor="body"
            error={errors.body}
            hint="Lights on the router, since when, etc."
          >
            <Textarea id="body" name="body" rows={4} required maxLength={4000} />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" loading={create.isPending}>
              Send
            </Button>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export default function SupportPage() {
  return (
    <Suspense>
      <Support />
    </Suspense>
  );
}
