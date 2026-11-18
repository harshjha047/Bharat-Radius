import { RouterOsConnection, RouterOsError, type RouterOsReply, type RouterOsTarget } from './client.js';

const MAX_IN_FLIGHT = 3;
const IDLE_MS = 60_000;

interface Entry {
  conn: Promise<RouterOsConnection> | null;
  active: number;
  queue: (() => void)[];
  inflight: Map<string, Promise<RouterOsReply>>;
}

/**
 * One API session per router per API process, reused across requests (no login per poll). At most 3 commands run
 * on a router at once; identical commands in flight share one router call. Idle sessions close after 60 s.
 */
export class RouterOsPool {
  private readonly routers = new Map<string, Entry>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly open = RouterOsConnection.open) {
    this.sweeper = setInterval(() => this.sweep(), 15_000);
    this.sweeper.unref();
  }

  private entry(key: string): Entry {
    let e = this.routers.get(key);
    if (!e) {
      e = { conn: null, active: 0, queue: [], inflight: new Map() };
      this.routers.set(key, e);
    }
    return e;
  }

  private async connection(e: Entry, t: RouterOsTarget): Promise<RouterOsConnection> {
    if (e.conn) {
      const c = await e.conn.catch(() => null);
      if (c && !c.closed) return c;
    }
    e.conn = this.open(t);
    e.conn.catch(() => {
      e.conn = null;
    });
    return e.conn;
  }

  private async slot(e: Entry) {
    if (e.active < MAX_IN_FLIGHT) {
      e.active++;
      return;
    }
    await new Promise<void>((r) => e.queue.push(r));
    e.active++;
  }

  private release(e: Entry) {
    e.active--;
    e.queue.shift()?.();
  }

  /** `key` identifies the router and its credentials (changing either opens a new session). */
  run(key: string, t: RouterOsTarget, words: string[], timeoutMs = 15_000): Promise<RouterOsReply> {
    const e = this.entry(key);
    const id = words.join('\0');
    const shared = e.inflight.get(id);
    if (shared) return shared;
    const p = (async () => {
      await this.slot(e);
      try {
        const c = await this.connection(e, t);
        return await c.run(words, timeoutMs);
      } catch (err) {
        if (err instanceof RouterOsError && err.kind !== 'trap') e.conn = null;
        throw err;
      } finally {
        this.release(e);
      }
    })();
    e.inflight.set(id, p);
    void p.finally(() => e.inflight.delete(id)).catch(() => undefined);
    return p;
  }

  /** Drop every session of a router (credentials changed or router deleted). */
  forget(prefix: string) {
    for (const [k, e] of this.routers) {
      if (!k.startsWith(prefix)) continue;
      void e.conn?.then((c) => c.close()).catch(() => undefined);
      this.routers.delete(k);
    }
  }

  private sweep() {
    const now = Date.now();
    for (const [k, e] of this.routers) {
      if (e.active || e.inflight.size) continue;
      void e.conn
        ?.then((c) => {
          if (c.closed || now - c.lastUsed > IDLE_MS) {
            c.close();
            if (this.routers.get(k) === e) this.routers.delete(k);
          }
        })
        .catch(() => this.routers.delete(k));
      if (!e.conn) this.routers.delete(k);
    }
  }

  close() {
    clearInterval(this.sweeper);
    for (const e of this.routers.values()) void e.conn?.then((c) => c.close()).catch(() => undefined);
    this.routers.clear();
  }
}
