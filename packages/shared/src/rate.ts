/** RouterOS rate units are decimal: 1M = 1000k. */
export function formatKbps(kbps: number): string {
  if (!Number.isInteger(kbps) || kbps <= 0) throw new Error(`invalid rate ${kbps}`);
  return kbps % 1000 === 0 ? `${kbps / 1000}M` : `${kbps}k`;
}

export interface Speeds {
  downloadKbps: number;
  uploadKbps: number;
}

export interface Burst extends Speeds {
  thresholdDownloadKbps: number;
  thresholdUploadKbps: number;
  timeSecs: number;
}

/**
 * Mikrotik-Rate-Limit for PPP: "rx/tx [burst-rx/burst-tx thr-rx/thr-tx time-rx/time-tx]".
 * rx is what the router receives from the customer, i.e. the customer's upload.
 */
export function mikrotikRateLimit(s: Speeds, burst?: Burst): string {
  const base = `${formatKbps(s.uploadKbps)}/${formatKbps(s.downloadKbps)}`;
  if (!burst) return base;
  return [
    base,
    `${formatKbps(burst.uploadKbps)}/${formatKbps(burst.downloadKbps)}`,
    `${formatKbps(burst.thresholdUploadKbps)}/${formatKbps(burst.thresholdDownloadKbps)}`,
    `${burst.timeSecs}/${burst.timeSecs}`,
  ].join(' ');
}

/** Burst only makes sense above the base rate with a threshold below it (RouterOS semantics). */
export function burstProblem(s: Speeds, b: Burst): string | null {
  if (b.downloadKbps <= s.downloadKbps || b.uploadKbps <= s.uploadKbps)
    return 'burst speed must exceed the plan speed';
  if (b.thresholdDownloadKbps > s.downloadKbps || b.thresholdUploadKbps > s.uploadKbps) {
    return 'burst threshold must not exceed the plan speed';
  }
  return null;
}
