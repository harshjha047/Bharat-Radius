import createClient from 'openapi-fetch';
import { currentViewAs } from './view-as';
import type { paths } from './api-types';

export type { paths };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Calls that must not trigger a refresh-and-retry.
const NO_RETRY = /\/api\/v1\/(auth\/(login|refresh|logout|2fa\/verify)|portal\/auth\/login)$/;

/** Customer portal calls: own session cookie and CSRF cookie; a 401 means "sign in to the portal", never a staff refresh. */
const PORTAL = /^\/api\/v1\/portal\//;

function csrfToken(portal: boolean): string | undefined {
  const re = portal ? /(?:^|;\s*)isp_pcsrf=([^;]*)/ : /(?:^|;\s*)isp_csrf=([^;]*)/;
  const m = re.exec(document.cookie);
  return m ? decodeURIComponent(m[1]!) : undefined;
}

function withCsrf(req: Request): Request {
  const portal = PORTAL.test(new URL(req.url).pathname);
  const t = csrfToken(portal);
  if (t && UNSAFE.has(req.method)) req.headers.set('x-csrf-token', t);
  const viewAs = portal ? null : currentViewAs();
  if (viewAs) req.headers.set('x-view-as', viewAs);
  return req;
}

let refreshing: Promise<boolean> | null = null;
/** One refresh at a time; concurrent 401s share it. */
export function refreshSession(): Promise<boolean> {
  refreshing ??= fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'same-origin' })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

const signedOutListeners = new Set<() => void>();
export const onSignedOut = (fn: () => void) => {
  signedOutListeners.add(fn);
  return () => void signedOutListeners.delete(fn);
};

const portalSignedOutListeners = new Set<() => void>();
export const onPortalSignedOut = (fn: () => void) => {
  portalSignedOutListeners.add(fn);
  return () => void portalSignedOutListeners.delete(fn);
};

/** fetch with CSRF header and one silent refresh when the 15-minute access token has lapsed. */
export async function authFetch(input: Request): Promise<Response> {
  const retry = input.clone();
  const res = await fetch(withCsrf(input));
  const path = new URL(input.url).pathname;
  if (res.status === 503 && typeof window !== 'undefined' && !path.startsWith('/api/v1/pay/')) {
    const b = (await res
      .clone()
      .json()
      .catch(() => null)) as ErrorBody | null;
    if (b?.error?.code === 'MAINTENANCE') window.location.assign('/maintenance');
    return res;
  }
  if (res.status !== 401 || NO_RETRY.test(path)) return res;
  if (PORTAL.test(path)) {
    portalSignedOutListeners.forEach((fn) => fn());
    return res;
  }
  if (!(await refreshSession())) {
    signedOutListeners.forEach((fn) => fn());
    return res;
  }
  return fetch(withCsrf(retry));
}

export const api = createClient<paths>({ fetch: authFetch, credentials: 'same-origin' });

interface ErrorBody {
  error?: { code?: string; message?: string; details?: unknown; requestId?: string };
}

export async function toApiError(res: Response, body?: unknown): Promise<ApiError> {
  let b = body as ErrorBody | undefined;
  if (b === undefined) b = (await res.json().catch(() => undefined)) as ErrorBody | undefined;
  const e = b?.error;
  return new ApiError(
    res.status,
    e?.code ?? `HTTP_${res.status}`,
    e?.message ??
      (res.status >= 500 ? 'The server had a problem. Try again.' : res.statusText || 'Request failed'),
    e?.details,
    e?.requestId,
  );
}

/** Returns the data or throws an ApiError with the server's message. */
export async function unwrap<T>(p: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const { data, error, response } = await p;
  if (!response.ok) throw await toApiError(response, error);
  return data as T;
}

/** Downloads a file endpoint (xlsx) through the same auth path. */
export async function download(path: string, fallbackName: string): Promise<void> {
  const res = await authFetch(new Request(path, { credentials: 'same-origin' }));
  if (!res.ok) throw await toApiError(res);
  const cd = res.headers.get('content-disposition') ?? '';
  const name = /filename="?([^";]+)"?/.exec(cd)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Opens a protected file (PDF, image) in a new tab through the same auth path. */
export async function openFile(path: string): Promise<void> {
  const tab = window.open('', '_blank');
  const res = await authFetch(new Request(path, { credentials: 'same-origin' }));
  if (!res.ok) {
    tab?.close();
    throw await toApiError(res);
  }
  const url = URL.createObjectURL(await res.blob());
  if (tab) tab.location.href = url;
  else window.location.assign(url);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Sends a file as the raw request body (KYC documents, logos). */
export async function uploadFile<T>(path: string, file: File, method: 'POST' | 'PUT' = 'POST'): Promise<T> {
  const res = await authFetch(
    new Request(path, {
      method,
      body: file,
      credentials: 'same-origin',
      headers: {
        'content-type': file.type || 'application/octet-stream',
        'x-file-name': encodeURIComponent(file.name),
      },
    }),
  );
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Field errors from a 400 VALIDATION_FAILED response, keyed by dotted path. */
export function fieldErrors(e: unknown): Record<string, string> {
  const issues = (
    e instanceof ApiError ? (e.details as { issues?: unknown } | undefined)?.issues : undefined
  ) as { path?: string; message?: string }[] | undefined;
  const out: Record<string, string> = {};
  for (const i of issues ?? []) if (i.path && i.message) out[i.path] ??= i.message;
  return out;
}

type Paths = keyof paths;
type GetPaths = {
  [P in Paths]: paths[P] extends { get: { responses: { 200: unknown } } } ? P : never;
}[Paths];
export type ApiData<P extends GetPaths> = paths[P] extends {
  get: { responses: { 200: { content: { 'application/json': infer R } } } };
}
  ? R
  : never;
export type Item<P extends GetPaths> = ApiData<P> extends { items: (infer I)[] } ? I : never;

/** Message to show for a failed request. */
export const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong');
