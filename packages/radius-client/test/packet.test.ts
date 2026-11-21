import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import dgram from 'node:dgram';
import { describe, expect, it } from 'vitest';
import { Attr, Code, MIKROTIK_VENDOR, MikrotikAttr, decodeResponse, encodeRequest } from '../src/packet.js';

const SECRET = 'e2e-test-secret-123';
const attrs = [
  { type: Attr.UserName, value: 'rahul01' },
  { type: Attr.AcctSessionId, value: '81a0001f' },
  { type: Attr.FramedIpAddress, value: '100.64.0.10' },
  { vendor: MIKROTIK_VENDOR, type: MikrotikAttr.RateLimit, value: '50M/50M' },
];

describe('encodeRequest', () => {
  it('computes Message-Authenticator with zero authenticator, then the request authenticator', () => {
    const pkt = encodeRequest(Code.CoaRequest, 7, SECRET, attrs);
    expect(pkt[0]).toBe(43);
    expect(pkt[1]).toBe(7);
    expect(pkt.readUInt16BE(2)).toBe(pkt.length);

    const zero = Buffer.from(pkt);
    zero.fill(0, 4, 20);
    expect(createHash('md5').update(zero).update(SECRET).digest()).toEqual(pkt.subarray(4, 20));

    const maPos = pkt.length - 18;
    expect(pkt[maPos]).toBe(Attr.MessageAuthenticator);
    const z2 = Buffer.from(zero);
    z2.fill(0, maPos + 2);
    expect(createHmac('md5', SECRET).update(z2).digest()).toEqual(pkt.subarray(maPos + 2));
  });

  it('encodes MikroTik VSAs and IPv4 addresses', () => {
    const pkt = encodeRequest(Code.CoaRequest, 1, SECRET, attrs);
    expect(pkt.includes(Buffer.from([26, 15, 0, 0, 0x3a, 0x8c, 8, 9]))).toBe(true);
    expect(pkt.includes(Buffer.from([8, 6, 100, 64, 0, 10]))).toBe(true);
  });

  it('rejects bad input', () => {
    expect(() => encodeRequest(43, 256, SECRET, [])).toThrow();
    expect(() => encodeRequest(43, 1, '', [])).toThrow();
    expect(() =>
      encodeRequest(43, 1, SECRET, [{ type: Attr.FramedIpAddress, value: '300.1.1.1' }]),
    ).toThrow();
  });

  const hasRadclient = spawnSync('which', ['radclient']).status === 0;
  it.skipIf(!hasRadclient)('is byte-identical to radclient for the same CoA-Request', async () => {
    const sock = dgram.createSocket('udp4');
    const got = new Promise<Buffer>((r) => sock.once('message', (m) => r(m)));
    await new Promise<void>((r) => sock.bind(0, '127.0.0.1', () => r()));
    const port = sock.address().port;
    const input = [
      'User-Name = "rahul01"',
      'Acct-Session-Id = "81a0001f"',
      'Framed-IP-Address = 100.64.0.10',
      'Mikrotik-Rate-Limit = "50M/50M"',
      'Message-Authenticator = 0x00',
    ].join('\n');
    try {
      execFileSync(
        'radclient',
        ['-q', '-r', '1', '-t', '1', '-i', '42', `127.0.0.1:${port}`, 'coa', SECRET],
        {
          input,
          stdio: ['pipe', 'ignore', 'ignore'],
        },
      );
    } catch {
      /* no reply expected */
    }
    const theirs = await got;
    sock.close();
    expect(encodeRequest(Code.CoaRequest, 42, SECRET, attrs).toString('hex')).toBe(theirs.toString('hex'));
  });
});

describe('decodeResponse', () => {
  function response(code: number, reqAuth: Buffer, secret: string, withMa = true) {
    const body = withMa ? Buffer.from([80, 18, ...new Array<number>(16).fill(0)]) : Buffer.alloc(0);
    const r = Buffer.alloc(20 + body.length);
    r[0] = code;
    r[1] = 9;
    r.writeUInt16BE(r.length, 2);
    reqAuth.copy(r, 4);
    body.copy(r, 20);
    if (withMa) createHmac('md5', secret).update(r).digest().copy(r, 22);
    createHash('md5').update(r).update(secret).digest().copy(r, 4);
    return r;
  }
  const reqAuth = Buffer.alloc(16, 7);

  it('accepts a correctly signed ACK', () => {
    expect(decodeResponse(response(Code.CoaAck, reqAuth, SECRET), reqAuth, SECRET)?.code).toBe(Code.CoaAck);
    expect(decodeResponse(response(Code.CoaAck, reqAuth, SECRET, false), reqAuth, SECRET)?.code).toBe(
      Code.CoaAck,
    );
  });

  it('rejects wrong secret, tampering and truncation', () => {
    expect(decodeResponse(response(Code.CoaAck, reqAuth, 'other'), reqAuth, SECRET)).toBeNull();
    const t = response(Code.CoaAck, reqAuth, SECRET);
    t[0] = Code.CoaNak;
    expect(decodeResponse(t, reqAuth, SECRET)).toBeNull();
    expect(decodeResponse(Buffer.alloc(10), reqAuth, SECRET)).toBeNull();
  });
});
