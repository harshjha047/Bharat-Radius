import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface EncryptedField {
  iv: string;
  tag: string;
  data: string;
  keyId: string;
}

/**
 * AES-256-GCM field encryption (BACKEND_SCHEMA §1, 🔒 fields).
 * Key spec: "<base64 key>" (id "k1") or "<id>:<base64>,<id>:<base64>" — the first entry encrypts, all decrypt,
 * so keys rotate by prepending a new one and re-encrypting at leisure.
 * `aad` binds a ciphertext to where it lives (e.g. "users.totp:<userId>") so it cannot be copied to another record.
 */
export class FieldCrypto {
  private readonly keys = new Map<string, Buffer>();
  private readonly currentId: string;

  constructor(spec: string) {
    const entries = spec.includes(':')
      ? spec.split(',').map((e) => {
          const i = e.indexOf(':');
          return [e.slice(0, i).trim(), e.slice(i + 1).trim()] as const;
        })
      : [['k1', spec.trim()] as const];
    for (const [id, b64] of entries) {
      const key = Buffer.from(b64, 'base64');
      if (!/^[\w-]{1,16}$/.test(id)) throw new Error(`invalid field key id "${id}"`);
      if (key.length !== 32)
        throw new Error(`field key "${id}" must be 32 bytes (base64), got ${key.length}`);
      this.keys.set(id, key);
    }
    this.currentId = entries[0]![0];
  }

  encrypt(plaintext: string, aad: string): EncryptedField {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.keys.get(this.currentId)!, iv);
    c.setAAD(Buffer.from(aad));
    const data = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    return {
      iv: iv.toString('base64'),
      tag: c.getAuthTag().toString('base64'),
      data: data.toString('base64'),
      keyId: this.currentId,
    };
  }

  decrypt(f: EncryptedField, aad: string): string {
    const key = this.keys.get(f.keyId);
    if (!key) throw new Error(`unknown field key id "${f.keyId}"`);
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(f.iv, 'base64'));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(f.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(f.data, 'base64')), d.final()]).toString('utf8');
  }

  needsRotation(f: EncryptedField): boolean {
    return f.keyId !== this.currentId;
  }

  /** Files at rest: `ISPF1` | key-id length | key id | iv (12) | tag (16) | ciphertext. `aad` binds it to its key. */
  encryptBytes(plain: Buffer, aad: string): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.keys.get(this.currentId)!, iv);
    c.setAAD(Buffer.from(aad));
    const data = Buffer.concat([c.update(plain), c.final()]);
    const id = Buffer.from(this.currentId);
    return Buffer.concat([FILE_MAGIC, Buffer.from([id.length]), id, iv, c.getAuthTag(), data]);
  }

  decryptBytes(blob: Buffer, aad: string): Buffer {
    if (blob.length < 34 || !blob.subarray(0, 5).equals(FILE_MAGIC)) throw new Error('not an encrypted file');
    const n = blob[5]!;
    const keyId = blob.subarray(6, 6 + n).toString();
    const key = this.keys.get(keyId);
    if (!key) throw new Error(`unknown field key id "${keyId}"`);
    const o = 6 + n;
    const d = createDecipheriv('aes-256-gcm', key, blob.subarray(o, o + 12));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(blob.subarray(o + 12, o + 28));
    return Buffer.concat([d.update(blob.subarray(o + 28)), d.final()]);
  }
}

const FILE_MAGIC = Buffer.from('ISPF1');
