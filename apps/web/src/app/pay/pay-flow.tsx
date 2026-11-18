'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { FormError } from '@/components/auth-card';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError, unwrap, type ApiData } from '@/lib/api';
import { fmtDate, fmtKbps, fmtRupees } from '@/lib/utils';

type Ctx = ApiData<'/api/v1/pay/context'>;

const message = (e: unknown) =>
  e instanceof ApiError && e.status === 429
    ? 'Too many tries. Wait 15 minutes and try again.'
    : e instanceof Error
      ? e.message
      : 'Something went wrong';

export function PayFlow() {
  const initial = useSearchParams().get('t');
  const [token, setToken] = useState(initial);
  const qc = useQueryClient();
  const [lookupOpen, setLookupOpen] = useState(false);

  const ctx = useQuery({
    queryKey: ['pay', token],
    enabled: !!token,
    retry: false,
    queryFn: () => unwrap(api.GET('/api/v1/pay/context', { params: { query: { t: token! } } })),
  });

  const lookup = useMutation({
    meta: { silent: true },
    mutationFn: (login: string) => unwrap(api.POST('/api/v1/pay/lookup', { body: { t: token!, login } })),
    onSuccess: (c) => {
      qc.setQueryData(['pay', c.t], c);
      setToken(c.t);
      setLookupOpen(false);
    },
  });

  const order = useMutation({
    meta: { silent: true },
    mutationFn: () => unwrap(api.POST('/api/v1/pay/order', { body: { t: token! } })),
    onSuccess: (p) => {
      if (p.linkUrl) window.location.assign(p.linkUrl);
    },
  });

  if (!token) return <Generic />;
  if (ctx.isPending) return <Loading />;
  if (ctx.isError) return <Generic notice={message(ctx.error)} />;

  const c: Ctx = ctx.data;
  const s = c.subscriber;
  const findForm = (
    <form
      className="space-y-3"
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        lookup.mutate(String(new FormData(e.currentTarget).get('login')).trim());
      }}
    >
      <Field label="Username, customer number or mobile" htmlFor="login">
        <Input
          id="login"
          name="login"
          autoCapitalize="none"
          spellCheck={false}
          required
          minLength={3}
          autoFocus
          className="h-12 text-base"
        />
      </Field>
      {lookup.isError && <FormError>{message(lookup.error)}</FormError>}
      <Button type="submit" size="lg" className="w-full" disabled={lookup.isPending}>
        {lookup.isPending ? 'Finding…' : 'Find my connection'}
      </Button>
    </form>
  );

  return (
    <div className="space-y-4">
      <div className="space-y-1 text-center">
        <h1 className="text-lg font-semibold">
          {s && !s.expired ? 'Your plan is active' : 'Your internet plan has expired'}
        </h1>
        <p className="text-sm text-muted-foreground">{c.isp.name}</p>
      </div>

      {s && !lookupOpen ? (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-lg bg-subtle p-4 text-sm">
            <dt className="text-muted-foreground">Name</dt>
            <dd className="font-medium">{s.name}</dd>
            <dt className="text-muted-foreground">Customer</dt>
            <dd className="font-mono">
              {s.customerNo}
              {s.username ? ` · ${s.username}` : ''}
            </dd>
            <dt className="text-muted-foreground">{s.expired ? 'Expired' : 'Valid until'}</dt>
            <dd>{fmtDate(s.expiresAt)}</dd>
            {s.plan && (
              <>
                <dt className="text-muted-foreground">Plan</dt>
                <dd>
                  {s.plan.name} · {fmtKbps(s.plan.downloadKbps)} · {s.plan.validityDays} days
                </dd>
              </>
            )}
          </dl>

          {s.plan && c.online ? (
            <>
              {order.isError && <FormError>{message(order.error)}</FormError>}
              <Button size="lg" className="w-full" disabled={order.isPending} onClick={() => order.mutate()}>
                {order.isPending ? 'Opening payment…' : `Pay ${fmtRupees(s.plan.pricePaise)}`}
              </Button>
              <p className="text-xs text-muted-foreground">
                GST included. Full speed returns within a minute of payment; if a page does not open, turn
                your router or Wi-Fi off and on once.
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Online payment is not available for this connection. Recharge with your provider
              {c.isp.phone ? ` (${c.isp.phone})` : ''} or their local partner.
            </p>
          )}
          <button
            type="button"
            className="w-full text-center text-sm text-muted-foreground underline-offset-4 hover:underline"
            onClick={() => setLookupOpen(true)}
          >
            Not you?
          </button>
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Enter the details of the connection you are using now to recharge it.
          </p>
          {findForm}
          {s && (
            <button
              type="button"
              className="w-full text-center text-sm text-muted-foreground underline-offset-4 hover:underline"
              onClick={() => setLookupOpen(false)}
            >
              Back
            </button>
          )}
        </>
      )}
      <Hindi />
    </div>
  );
}

function Loading() {
  return (
    <div className="space-y-4" aria-busy>
      <Skeleton className="mx-auto h-6 w-3/4" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-11 w-full" />
    </div>
  );
}

const Hindi = () => (
  <p className="text-center text-sm text-muted-foreground" lang="hi">
    आपका इंटरनेट प्लान समाप्त हो गया है। रिचार्ज करते ही पूरी स्पीड वापस आ जाएगी।
  </p>
);

function Generic({ notice }: { notice?: string }) {
  return (
    <div className="space-y-4 text-center">
      <h1 className="text-lg font-semibold">Your internet plan has expired</h1>
      {notice && <p className="text-sm text-amber-700 dark:text-amber-400">{notice}</p>}
      <p className="text-sm text-muted-foreground">
        Recharge online, or with your internet provider or their local partner. Your connection returns to
        full speed as soon as the recharge is recorded.
      </p>
      <Link href="/portal/login" className={buttonVariants({ size: 'lg', className: 'w-full' })}>
        Recharge online
      </Link>
      <p className="text-xs text-muted-foreground">
        Sign in with the username and password of your internet connection.
      </p>
      <Hindi />
    </div>
  );
}
