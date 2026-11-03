import dgram from 'node:dgram';
import { performance } from 'node:perf_hooks';
import {
  Attr,
  Code,
  ERROR_CAUSES,
  MIKROTIK_VENDOR,
  MikrotikAttr,
  decodeResponse,
  encodeRequest,
  type Attribute,
} from './packet.js';

export interface NasTarget {
  host: string;
  port?: number;
  secret: string;
}

export interface SessionRef {
  userName: string;
  acctSessionId?: string;
  framedIp?: string;
}

export type CoaOutcome = 'ack' | 'nak' | 'timeout';

export interface CoaResult {
  result: CoaOutcome;
  errorCause?: number;
  errorText?: string;
  latencyMs: number;
  attempts: number;
}

export interface CoaClientOptions {
  sourceIp?: string;
  timeoutMs?: number;
  retries?: number;
  globalRatePerSec?: number;
  perNasRatePerSec?: number;
}

class TokenBucket {
  private tokens: number;
  private last = performance.now();
  constructor(private readonly ratePerSec: number) {
    this.tokens = ratePerSec;
  }
  async take(): Promise<void> {
    for (;;) {
      const now = performance.now();
      this.tokens = Math.min(this.ratePerSec, this.tokens + ((now - this.last) / 1000) * this.ratePerSec);
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000));
    }
  }
}

interface Pending {
  authenticator: Buffer;
  secret: string;
  resolve: (r: { code: number; errorCause?: number }) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RadiusCoaClient {
  private readonly socket: dgram.Socket;
  private readonly ready: Promise<void>;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly global: TokenBucket;
  private readonly perNasRate: number;
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly pending = new Map<string, Pending>();
  private readonly nextId = new Map<string, number>();
  private readonly idWaiters = new Map<string, Array<() => void>>();
  private readonly inUse = new Map<string, Set<number>>();

  constructor(opts: CoaClientOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 2000;
    this.retries = opts.retries ?? 3;
    this.global = new TokenBucket(opts.globalRatePerSec ?? 200);
    this.perNasRate = opts.perNasRatePerSec ?? 50;
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (msg, rinfo) => this.onMessage(msg, rinfo));
    this.ready = new Promise((resolve, reject) => {
      this.socket.once('error', reject);
      this.socket.bind({ address: opts.sourceIp ?? '0.0.0.0', port: 0 }, () => {
        this.socket.off('error', reject);
        this.socket.unref();
        resolve();
      });
    });
  }

  /** Speed/address-list change for a live session (no reconnect). */
  changeRate(
    target: NasTarget,
    session: SessionRef,
    change: { rateLimit: string; addressList?: string | null },
  ) {
    const attrs = [
      ...sessionAttrs(session),
      { vendor: MIKROTIK_VENDOR, type: MikrotikAttr.RateLimit, value: change.rateLimit },
    ];
    if (change.addressList !== undefined) {
      attrs.push({
        vendor: MIKROTIK_VENDOR,
        type: MikrotikAttr.AddressList,
        value: change.addressList ?? '',
      });
    }
    return this.send(target, Code.CoaRequest, attrs);
  }

  disconnect(target: NasTarget, session: SessionRef) {
    return this.send(target, Code.DisconnectRequest, sessionAttrs(session));
  }

  async send(target: NasTarget, code: number, attributes: Attribute[]): Promise<CoaResult> {
    await this.ready;
    const port = target.port ?? 3799;
    const dest = `${target.host}:${port}`;
    let bucket = this.buckets.get(target.host);
    if (!bucket) this.buckets.set(target.host, (bucket = new TokenBucket(this.perNasRate)));
    await bucket.take();
    await this.global.take();

    const id = await this.allocateId(dest);
    const key = `${dest}:${id}`;
    const attrs = [...attributes, { type: Attr.EventTimestamp, value: Math.floor(Date.now() / 1000) }];
    const packet = encodeRequest(code, id, target.secret, attrs);
    const started = performance.now();

    try {
      for (let attempt = 1; attempt <= this.retries; attempt++) {
        const reply = await new Promise<{ code: number; errorCause?: number } | null>((resolve) => {
          const timer = setTimeout(() => {
            this.pending.delete(key);
            resolve(null);
          }, this.timeoutMs);
          this.pending.set(key, {
            authenticator: packet.subarray(4, 20),
            secret: target.secret,
            resolve: (r) => {
              clearTimeout(timer);
              resolve(r);
            },
          });
          this.socket.send(packet, port, target.host, (err) => {
            if (err) {
              clearTimeout(timer);
              this.pending.delete(key);
              resolve(null);
            }
          });
        });
        if (reply) {
          const latencyMs = Math.round(performance.now() - started);
          const ack = reply.code === Code.CoaAck || reply.code === Code.DisconnectAck;
          const result: CoaResult = { result: ack ? 'ack' : 'nak', latencyMs, attempts: attempt };
          if (reply.errorCause !== undefined) {
            result.errorCause = reply.errorCause;
            result.errorText = ERROR_CAUSES[reply.errorCause] ?? 'Unknown';
          }
          return result;
        }
      }
      return {
        result: 'timeout',
        latencyMs: Math.round(performance.now() - started),
        attempts: this.retries,
      };
    } finally {
      this.releaseId(dest, id);
    }
  }

  async close(): Promise<void> {
    await this.ready.catch(() => undefined);
    await new Promise<void>((r) => this.socket.close(() => r()));
  }

  private onMessage(msg: Buffer, rinfo: dgram.RemoteInfo) {
    if (msg.length < 20) return;
    const key = `${rinfo.address}:${rinfo.port}:${msg[1]}`;
    const p = this.pending.get(key);
    if (!p) return;
    const decoded = decodeResponse(msg, p.authenticator, p.secret);
    if (!decoded) return;
    this.pending.delete(key);
    const ec = decoded.attributes.find((a) => a.type === Attr.ErrorCause && a.vendor === undefined);
    const out: { code: number; errorCause?: number } = { code: decoded.code };
    if (ec && Buffer.isBuffer(ec.value) && ec.value.length === 4) out.errorCause = ec.value.readUInt32BE(0);
    p.resolve(out);
  }

  private async allocateId(dest: string): Promise<number> {
    for (;;) {
      let used = this.inUse.get(dest);
      if (!used) this.inUse.set(dest, (used = new Set()));
      if (used.size < 256) {
        let id = this.nextId.get(dest) ?? Math.floor(Math.random() * 256);
        while (used.has(id)) id = (id + 1) & 0xff;
        used.add(id);
        this.nextId.set(dest, (id + 1) & 0xff);
        return id;
      }
      await new Promise<void>((r) => {
        const q = this.idWaiters.get(dest) ?? [];
        q.push(r);
        this.idWaiters.set(dest, q);
      });
    }
  }

  private releaseId(dest: string, id: number) {
    this.inUse.get(dest)?.delete(id);
    this.idWaiters.get(dest)?.shift()?.();
  }
}

function sessionAttrs(s: SessionRef): Attribute[] {
  const attrs: Attribute[] = [{ type: Attr.UserName, value: s.userName }];
  if (s.acctSessionId) attrs.push({ type: Attr.AcctSessionId, value: s.acctSessionId });
  if (s.framedIp) attrs.push({ type: Attr.FramedIpAddress, value: s.framedIp });
  return attrs;
}
