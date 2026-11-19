import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FieldCrypto } from '@isp/shared';
import { kindOf } from '../documents/import.js';
import { maskNumber, missingKinds } from '../documents/kyc.js';
import { Files, LocalStore, S3Store, signV4, sniff } from './storage.js';

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('S3 signature V4', () => {
  it('matches the AWS documented GET Object example', () => {
    const auth = signV4({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      headers: {
        range: 'bytes=0-9',
        'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'x-amz-date': '20130524T000000Z',
      },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      date: new Date('2013-05-24T00:00:00Z'),
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    });
    expect(auth).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('S3Store sends path-style signed requests and maps 404 to null', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(init.method === 'GET' ? null : '', { status: init.method === 'GET' ? 404 : 200 });
    }) as unknown as typeof fetch;
    const s = new S3Store(
      {
        endpoint: 'https://s3.us-west-004.backblazeb2.com',
        region: 'us-west-004',
        bucket: 'isp',
        accessKeyId: 'k',
        secretAccessKey: 's',
        prefix: 'files',
      },
      fake,
    );
    await s.putRaw('kyc/a/b.pdf', Buffer.from('x'));
    expect(await s.getRaw('kyc/a/b.pdf')).toBeNull();
    expect(calls[0]!.url).toBe('https://s3.us-west-004.backblazeb2.com/isp/files/kyc/a/b.pdf');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=k\/\d{8}\/us-west-004\/s3\/aws4_request/,
    );
  });
});

describe('encrypted local store', () => {
  let dir = '';
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('stores only ciphertext, round-trips, rejects path escapes, and binds the file to its key', async () => {
    dir = await mkdtemp(join(tmpdir(), 'isp-files-'));
    const files = new Files(new LocalStore(dir), new FieldCrypto(KEY));
    const plain = Buffer.from('%PDF-1.4 aadhaar 1234 5678 9012');
    await files.put('kyc/t/s/d.pdf', plain);
    const raw = await readFile(join(dir, 'kyc/t/s/d.pdf'));
    expect(raw.includes(Buffer.from('aadhaar'))).toBe(false);
    expect(await files.get('kyc/t/s/d.pdf')).toEqual(plain);
    expect(await files.get('kyc/t/s/missing.pdf')).toBeNull();
    await expect(files.put('../etc/passwd', plain)).rejects.toThrow(/invalid storage key/);
    // Copying ciphertext under another key does not decrypt (AAD = key).
    await new LocalStore(dir).putRaw('kyc/t/s/other.pdf', raw);
    await expect(files.get('kyc/t/s/other.pdf')).rejects.toThrow();
    await files.delete('kyc/t/s/d.pdf');
    expect(await readdir(join(dir, 'kyc/t/s'))).toEqual(['other.pdf']);
  });
});

describe('KYC helpers', () => {
  it('detects file types by content, not by name', () => {
    expect(sniff(Buffer.from('%PDF-1.7\n'), ['application/pdf'])).toBe('application/pdf');
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), ['image/jpeg', 'application/pdf'])).toBe(
      'image/jpeg',
    );
    expect(sniff(Buffer.from('<html>'), ['image/jpeg', 'application/pdf'])).toBeNull();
    expect(sniff(Buffer.from('%PDF-1.7'), ['image/png'])).toBeNull();
  });
  it('masks document numbers, last four visible', () => {
    expect(maskNumber('1234 5678 9012')).toBe('XXXX-XXXX-9012');
    expect(maskNumber('ABCDE1234F')).toBe('XXXX-XX23-4F');
    expect(maskNumber('9012')).toBe('9012');
    expect(maskNumber(' ')).toBeUndefined();
  });
  it('lists what a complete KYC file still needs', () => {
    expect(missingKinds(new Set())).toEqual(['identity proof', 'address proof', 'photo', 'signed CAF']);
    expect(missingKinds(new Set(['aadhaar', 'photo', 'caf_signed']))).toEqual([]);
    expect(missingKinds(new Set(['pan', 'photo', 'caf_signed']))).toEqual(['address proof']);
  });
  it('guesses the kind of an old file from its path', () => {
    expect(kindOf('C1001/aadhar_front.jpg')).toBe('aadhaar');
    expect(kindOf('john/CAF.pdf')).toBe('caf_signed');
    expect(kindOf('john/photo.png')).toBe('photo');
    expect(kindOf('john/pan card.jpg')).toBe('pan');
    expect(kindOf('john/scan001.jpg')).toBe('other');
  });
});
