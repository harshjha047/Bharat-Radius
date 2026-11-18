import { createHash } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

/** RouterOS API (TCP 8728, TLS 8729): length-prefixed words, sentences end with an empty word, `.tag` multiplexes. */
export interface RouterOsTarget {
  host: string;
  port: number;
  tls: boolean;
  username: string;
  password: string;
}

export interface RouterOsReply {
  re: Record<string, string>[];
  done: Record<string, string>;
}

export class RouterOsError extends Error {
  constructor(
    readonly kind: 'offline' | 'login' | 'timeout' | 'trap' | 'closed',
    message: string,
  ) {
    super(message);
  }
}

export function encodeLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x4000) return Buffer.from([(n >> 8) | 0x80, n & 0xff]);
  if (n < 0x200000) return Buffer.from([(n >> 16) | 0xc0, (n >> 8) & 0xff, n & 0xff]);
  if (n < 0x10000000) return Buffer.from([(n >>> 24) | 0xe0, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
  return Buffer.from([0xf0, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
}

export function encodeSentence(words: string[]): Buffer {
  const parts: Buffer[] = [];
  for (const w of words) {
    const b = Buffer.from(w, 'utf8');
    parts.push(encodeLength(b.length), b);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/** Incremental decoder: feed bytes, get complete sentences. */
export class SentenceReader {
  private buf: Buffer = Buffer.alloc(0);
  private words: string[] = [];

  push(chunk: Buffer): string[][] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: string[][] = [];
    for (;;) {
      const len = this.readLength();
      if (!len) break;
      const [n, hdr] = len;
      if (this.buf.length < hdr + n) break;
      const word = this.buf.subarray(hdr, hdr + n).toString('utf8');
      this.buf = this.buf.subarray(hdr + n);
      if (n === 0) {
        out.push(this.words);
        this.words = [];
      } else this.words.push(word);
    }
    return out;
  }

  private readLength(): [number, number] | null {
    const b = this.buf;
    if (!b.length) return null;
    const c = b[0]!;
    if ((c & 0x80) === 0) return [c, 1];
    if ((c & 0xc0) === 0x80) return b.length < 2 ? null : [((c & 0x3f) << 8) | b[1]!, 2];
    if ((c & 0xe0) === 0xc0) return b.length < 3 ? null : [((c & 0x1f) << 16) | (b[1]! << 8) | b[2]!, 3];
    if ((c & 0xf0) === 0xe0)
      return b.length < 4 ? null : [(c & 0x0f) * 0x1000000 + ((b[1]! << 16) | (b[2]! << 8) | b[3]!), 4];
    return b.length < 5 ? null : [b.readUInt32BE(1), 5];
  }
}

const attrs = (words: string[]) => {
  const o: Record<string, string> = {};
  for (const w of words) {
    if (!w.startsWith('=')) continue;
    const i = w.indexOf('=', 1);
    if (i > 0) o[w.slice(1, i)] = w.slice(i + 1);
  }
  return o;
};
const tagOf = (words: string[]) => words.find((w) => w.startsWith('.tag='))?.slice(5);

interface Pending {
  re: Record<string, string>[];
  resolve: (r: RouterOsReply) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class RouterOsConnection {
  private readonly reader = new SentenceReader();
  private readonly pending = new Map<string, Pending>();
  private seq = 0;
  closed = false;
  lastUsed = Date.now();

  private constructor(private readonly socket: net.Socket) {
    socket.on('data', (d) => {
      for (const s of this.reader.push(d)) this.onSentence(s);
    });
    const fail = (why: string) => {
      if (this.closed) return;
      this.closed = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new RouterOsError('closed', why));
      }
      this.pending.clear();
    };
    socket.on('error', (e) => fail(`Router connection failed: ${e.message}`));
    socket.on('close', () => fail('Router closed the API connection'));
  }

  static async open(t: RouterOsTarget, connectTimeoutMs = 2000): Promise<RouterOsConnection> {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = t.tls
        ? tls.connect({ host: t.host, port: t.port, rejectUnauthorized: false, servername: undefined })
        : net.connect({ host: t.host, port: t.port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new RouterOsError('offline', `Router did not answer on API port ${t.port} within 2 s`));
      }, connectTimeoutMs);
      s.once(t.tls ? 'secureConnect' : 'connect', () => {
        clearTimeout(timer);
        s.setNoDelay(true);
        s.setKeepAlive(true, 30_000);
        resolve(s);
      });
      s.once('error', (e) => {
        clearTimeout(timer);
        reject(new RouterOsError('offline', `Router API unreachable: ${e.message}`));
      });
    });
    const c = new RouterOsConnection(socket);
    try {
      await c.login(t.username, t.password);
    } catch (e) {
      c.close();
      throw e;
    }
    return c;
  }

  private async login(username: string, password: string) {
    const fail = () =>
      new RouterOsError(
        'login',
        "API login refused: wrong username/password, or the user has no 'api' policy",
      );
    let r: RouterOsReply;
    try {
      r = await this.run(['/login', `=name=${username}`, `=password=${password}`], 5000);
    } catch (e) {
      if (e instanceof RouterOsError && e.kind === 'trap') throw fail();
      throw e;
    }
    // RouterOS before 6.43: challenge–response.
    if (r.done.ret) {
      const md5 = createHash('md5')
        .update(
          Buffer.concat([Buffer.from([0]), Buffer.from(password, 'utf8'), Buffer.from(r.done.ret, 'hex')]),
        )
        .digest('hex');
      try {
        await this.run(['/login', `=name=${username}`, `=response=00${md5}`], 5000);
      } catch (e) {
        if (e instanceof RouterOsError && e.kind === 'trap') throw fail();
        throw e;
      }
    }
  }

  private onSentence(words: string[]) {
    const tag = tagOf(words);
    const p = tag ? this.pending.get(tag) : undefined;
    const type = words[0];
    if (type === '!fatal') {
      this.socket.destroy();
      return;
    }
    if (!p) return;
    if (type === '!re') p.re.push(attrs(words));
    else if (type === '!trap') {
      clearTimeout(p.timer);
      this.pending.delete(tag!);
      p.reject(new RouterOsError('trap', attrs(words).message ?? 'Router refused the command'));
    } else if (type === '!done' || type === '!empty') {
      clearTimeout(p.timer);
      this.pending.delete(tag!);
      p.resolve({ re: p.re, done: attrs(words) });
    }
  }

  run(words: string[], timeoutMs = 15_000): Promise<RouterOsReply> {
    if (this.closed) return Promise.reject(new RouterOsError('closed', 'Router API connection closed'));
    this.lastUsed = Date.now();
    const tag = String(++this.seq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(tag);
        // A command still running on the router keeps the connection busy; drop it.
        this.socket.destroy();
        reject(
          new RouterOsError('timeout', `Router did not answer within ${Math.round(timeoutMs / 1000)} s`),
        );
      }, timeoutMs);
      this.pending.set(tag, { re: [], resolve, reject, timer });
      this.socket.write(encodeSentence([...words, `.tag=${tag}`]));
    });
  }

  get inFlight() {
    return this.pending.size;
  }

  close() {
    this.closed = true;
    this.socket.destroy();
  }
}
