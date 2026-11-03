export type CheckFn = () => Promise<Record<string, unknown>>;

export interface HealthReport {
  status: 'ok' | 'degraded';
  version: string;
  uptimeSecs: number;
  checks: Record<string, { ok: boolean; ms: number; detail?: Record<string, unknown>; error?: string }>;
}

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms} ms`)), ms)),
  ]);

/** Runs checks in parallel; result cached for ttlMs so probes and load balancers cannot hammer the databases. */
export function createHealth(
  checks: Record<string, CheckFn>,
  version: string,
  ttlMs = 2000,
  timeoutMs = 1500,
) {
  let cached: { at: number; report: Promise<HealthReport> } | undefined;

  async function run(): Promise<HealthReport> {
    const entries = await Promise.all(
      Object.entries(checks).map(async ([name, fn]) => {
        const t0 = performance.now();
        try {
          const detail = await withTimeout(fn(), timeoutMs);
          return [name, { ok: true, ms: Math.round(performance.now() - t0), detail }] as const;
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          return [name, { ok: false, ms: Math.round(performance.now() - t0), error }] as const;
        }
      }),
    );
    const out: HealthReport['checks'] = Object.fromEntries(entries);
    return {
      status: Object.values(out).every((c) => c.ok) ? 'ok' : 'degraded',
      version,
      uptimeSecs: Math.round(process.uptime()),
      checks: out,
    };
  }

  return (): Promise<HealthReport> => {
    const now = Date.now();
    if (!cached || now - cached.at > ttlMs) cached = { at: now, report: run() };
    return cached.report;
  };
}
