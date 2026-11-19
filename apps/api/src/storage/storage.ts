import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { FieldCrypto } from '@isp/shared';

/** Private file store: every object is encrypted (AES-256-GCM, FIELD_ENCRYPTION_KEY) before it leaves the API. */
export abstract class FileStore {
  abstract readonly kind: 's3' | 'local';
  abstract putRaw(key: string, body: Buffer): Promise<void>;
  /** null when the object does not exist. */
  abstract getRaw(key: string): Promise<Buffer | null>;
  abstract delete(key: string): Promise<void>;
}

export const FILE_STORE = Symbol('FILE_STORE');

/** Encrypting wrapper used by the app: the bucket or disk only ever holds ciphertext. */
export class Files {
  constructor(
    readonly store: FileStore,
    private readonly crypto: FieldCrypto,
  ) {}

  async put(key: string, plain: Buffer) {
    await this.store.putRaw(key, this.crypto.encryptBytes(plain, key));
  }

  async get(key: string): Promise<Buffer | null> {
    const raw = await this.store.getRaw(key);
    return raw ? this.crypto.decryptBytes(raw, key) : null;
  }

  delete(key: string) {
    return this.store.delete(key);
  }
}

const KEY_RE = /^[a-z0-9][a-z0-9/_.-]{0,200}$/;
const checkKey = (k: string) => {
  if (!KEY_RE.test(k) || k.includes('..') || k.includes('//')) throw new Error(`invalid storage key "${k}"`);
};

/** Fallback for dev, CI and installs without a bucket: a directory on a Docker volume. */
export class LocalStore extends FileStore {
  readonly kind = 'local' as const;
  private readonly root: string;

  constructor(dir: string) {
    super();
    this.root = resolve(dir);
  }

  private path(key: string) {
    checkKey(key);
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + sep)) throw new Error('storage key escapes the root');
    return p;
  }

  async putRaw(key: string, body: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${process.pid}.tmp`;
    await writeFile(tmp, body, { mode: 0o600 });
    await rename(tmp, p);
  }

  async getRaw(key: string) {
    try {
      return await readFile(this.path(key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async delete(key: string) {
    await unlink(this.path(key)).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }
}

export interface S3Options {
  /** e.g. https://s3.us-west-004.backblazeb2.com */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Prefix inside the bucket, e.g. `isp-files`. */
  prefix?: string;
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const hmac = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s).digest();
const enc = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface SignInput {
  method: string;
  host: string;
  /** Already URI-encoded path, e.g. /bucket/a/b.pdf */
  path: string;
  headers: Record<string, string>;
  payloadHash: string;
  date: Date;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** AWS Signature V4 for S3 (B2's S3 API): returns the Authorization header. */
export function signV4(i: SignInput): string {
  const amzDate = i.date.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const h: Record<string, string> = { host: i.host };
  for (const [k, v] of Object.entries(i.headers)) h[k.toLowerCase()] = v.trim().replace(/\s+/g, ' ');
  const names = Object.keys(h).sort();
  const canonical = [
    i.method,
    i.path,
    '',
    ...names.map((n) => `${n}:${h[n]}`),
    '',
    names.join(';'),
    i.payloadHash,
  ].join('\n');
  const scope = `${day}/${i.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const kDate = hmac(`AWS4${i.secretAccessKey}`, day);
  const kSigning = hmac(hmac(hmac(kDate, i.region), 's3'), 'aws4_request');
  const sig = createHmac('sha256', kSigning).update(toSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}`;
}

/** Path-style S3 client with only what the app needs (PUT, GET, DELETE); no SDK. */
export class S3Store extends FileStore {
  readonly kind = 's3' as const;
  private readonly base: URL;

  constructor(
    private readonly o: S3Options,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    super();
    this.base = new URL(o.endpoint);
  }

  private async send(method: 'PUT' | 'GET' | 'DELETE', key: string, body?: Buffer) {
    checkKey(key);
    const full = this.o.prefix ? `${this.o.prefix.replace(/\/+$/, '')}/${key}` : key;
    const path = `/${enc(this.o.bucket)}/${full.split('/').map(enc).join('/')}`;
    const date = new Date();
    const payloadHash = sha256(body ?? '');
    const headers: Record<string, string> = {
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': date.toISOString().replace(/[-:]|\.\d{3}/g, ''),
      ...(body ? { 'content-type': 'application/octet-stream' } : {}),
    };
    const authorization = signV4({
      method,
      host: this.base.host,
      path,
      headers,
      payloadHash,
      date,
      region: this.o.region,
      accessKeyId: this.o.accessKeyId,
      secretAccessKey: this.o.secretAccessKey,
    });
    const res = await this.fetchFn(`${this.base.origin}${path}`, {
      method,
      headers: { ...headers, authorization },
      ...(body ? { body: new Uint8Array(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    return res;
  }

  async putRaw(key: string, body: Buffer) {
    const r = await this.send('PUT', key, body);
    if (!r.ok) throw new Error(`storage PUT ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }

  async getRaw(key: string) {
    const r = await this.send('GET', key);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`storage GET ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return Buffer.from(await r.arrayBuffer());
  }

  async delete(key: string) {
    const r = await this.send('DELETE', key);
    if (!r.ok && r.status !== 404) throw new Error(`storage DELETE ${r.status}`);
  }
}

/** What a stored upload is allowed to be; checked by content, not by the name or header the client sent. */
export const FILE_TYPES = {
  'image/jpeg': { ext: 'jpg', magic: (b: Buffer) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': {
    ext: 'png',
    magic: (b: Buffer) =>
      b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  'image/webp': {
    ext: 'webp',
    magic: (b: Buffer) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
  },
  'application/pdf': { ext: 'pdf', magic: (b: Buffer) => b.subarray(0, 5).toString() === '%PDF-' },
} as const;
export type FileType = keyof typeof FILE_TYPES;

/** The real type of `b`, or null if it is none of the allowed ones. */
export function sniff(b: Buffer, allowed: readonly FileType[]): FileType | null {
  return allowed.find((t) => FILE_TYPES[t].magic(b)) ?? null;
}

export const sha256Hex = (b: Buffer) => sha256(b);

/** For the CLI (same env as the API container). */
export function filesFromEnv(env: NodeJS.ProcessEnv, crypto: FieldCrypto): Files {
  const store = env.FILES_S3_BUCKET
    ? new S3Store({
        endpoint: env.FILES_S3_ENDPOINT!,
        region: env.FILES_S3_REGION!,
        bucket: env.FILES_S3_BUCKET,
        accessKeyId: env.FILES_S3_KEY_ID!,
        secretAccessKey: env.FILES_S3_SECRET!,
        prefix: env.FILES_S3_PREFIX ?? 'isp-files',
      })
    : new LocalStore(env.FILES_DIR ?? '/var/lib/isp-files');
  return new Files(store, crypto);
}
