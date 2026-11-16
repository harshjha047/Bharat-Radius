import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';

/**
 * One NAT translation as archived by rsyslog from a MikroTik srcnat rule with log-prefix "ISPNAT", e.g.
 *   2026-11-16T06:33:27.852267+05:30 203.0.113.9 firewall,info ISPNAT srcnat: in:<pppoe-ravi.p> out:ether1, …,
 *   proto TCP (SYN), 100.64.50.10:51515->142.250.1.1:443, NAT (100.64.50.10:51515->203.0.113.9:51515)->142.250.1.1:443, len 60
 * The first two fields are written by our server (receive time, router IP), never taken from the router.
 */
export interface NatEvent {
  at: Date;
  router: string;
  inInterface: string;
  /** PPPoE username when the customer side is a dynamic PPPoE interface (<pppoe-USER>). */
  pppoeUser: string | null;
  proto: string;
  privateIp: string;
  privatePort: number | null;
  publicIp: string;
  publicPort: number | null;
  destIp: string;
  destPort: number | null;
}

const ADDR = '(\\d{1,3}(?:\\.\\d{1,3}){3})(?::(\\d{1,5}))?';
const LINE = new RegExp(
  `^(\\S+) (\\S+) .*?ISPNAT\\s*srcnat: in:(\\S+) out:[^,]*,.*?proto (\\w+)(?: \\([^)]*\\))?, ${ADDR}->${ADDR}, ` +
    `NAT \\(${ADDR}->${ADDR}\\)->${ADDR}`,
);

const port = (s: string | undefined) => (s === undefined ? null : Number(s));

export function parseNatLine(line: string): NatEvent | null {
  const m = LINE.exec(line);
  if (!m) return null;
  const at = new Date(m[1]!);
  if (Number.isNaN(at.getTime())) return null;
  const ifc = m[3]!;
  const pppoe = /^<pppoe-(.+)>$/.exec(ifc);
  return {
    at,
    router: m[2]!,
    inInterface: ifc,
    pppoeUser: pppoe ? pppoe[1]! : null,
    proto: m[4]!.toUpperCase(),
    privateIp: m[9]!,
    privatePort: port(m[10]),
    publicIp: m[11]!,
    publicPort: port(m[12]),
    destIp: m[13]!,
    destPort: port(m[14]),
  };
}

export interface NatQuery {
  publicIp: string;
  port?: number | undefined;
  at: Date;
  windowSecs: number;
  /** Only these router directories (the tenant's routers). */
  routers: string[];
  limit: number;
}

export interface NatSearchResult {
  hits: NatEvent[];
  filesScanned: number;
  bytesScanned: number;
  truncated: boolean;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Day files that can hold [from, to]: the archive names files by the server's local date, so scan ±1 day. */
function candidateDays(from: Date, to: Date): Set<string> {
  const days = new Set<string>();
  for (let t = from.getTime() - 86_400_000; t <= to.getTime() + 86_400_000; t += 86_400_000) {
    days.add(isoDay(new Date(t)));
  }
  return days;
}

async function* lines(path: string): AsyncGenerator<string> {
  const raw = createReadStream(path);
  const input = path.endsWith('.gz') ? raw.pipe(createGunzip()) : raw;
  const rl = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const l of rl) yield l;
  } finally {
    rl.close();
    raw.destroy();
  }
}

/**
 * Scans the NAT archive (read-only) for connections that went out as publicIp[:port] within ±windowSecs of `at`.
 * Cheap substring filter first, full parse only on candidates. One scan at a time per process.
 */
export class NatArchive {
  private busy = false;

  constructor(private readonly root: string | undefined) {}

  get configured() {
    return !!this.root;
  }

  async search(q: NatQuery): Promise<NatSearchResult> {
    if (!this.root) return { hits: [], filesScanned: 0, bytesScanned: 0, truncated: false };
    if (this.busy) throw new Error('BUSY');
    this.busy = true;
    try {
      return await this.scan(this.root, q);
    } finally {
      this.busy = false;
    }
  }

  private async scan(root: string, q: NatQuery): Promise<NatSearchResult> {
    const from = new Date(q.at.getTime() - q.windowSecs * 1000);
    const to = new Date(q.at.getTime() + q.windowSecs * 1000);
    const days = candidateDays(from, to);
    const needle = q.port === undefined ? `->${q.publicIp}:` : `->${q.publicIp}:${q.port})`;
    const needleNoPort = `->${q.publicIp})`;
    const out: NatSearchResult = { hits: [], filesScanned: 0, bytesScanned: 0, truncated: false };
    let present: string[];
    try {
      present = await readdir(root);
    } catch {
      return out;
    }
    for (const router of q.routers.filter((r) => present.includes(r))) {
      const dir = join(root, router);
      const files = (await readdir(dir))
        .filter((f) => days.has(f.slice(0, 10)) && /\.log(\.gz)?$/.test(f))
        .sort();
      for (const f of files) {
        const path = join(dir, f);
        out.filesScanned++;
        out.bytesScanned += (await stat(path)).size;
        for await (const l of lines(path)) {
          if (!l.includes(needle) && !(q.port === undefined && l.includes(needleNoPort))) continue;
          const e = parseNatLine(l);
          if (!e || e.publicIp !== q.publicIp || (q.port !== undefined && e.publicPort !== q.port)) continue;
          if (e.at < from || e.at > to) continue;
          out.hits.push(e);
          if (out.hits.length >= q.limit) {
            out.truncated = true;
            break;
          }
        }
        if (out.truncated) break;
      }
      if (out.truncated) break;
    }
    out.hits.sort(
      (a, b) => Math.abs(a.at.getTime() - q.at.getTime()) - Math.abs(b.at.getTime() - q.at.getTime()),
    );
    return out;
  }
}
