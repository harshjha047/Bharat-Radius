import { createHash, createHmac } from 'node:crypto';
import dgram from 'node:dgram';
import { Attr, Code, decodeAttributes, type Attribute } from '../src/packet.js';

export type Behaviour = 'ack' | 'nak' | 'drop' | 'drop-once' | 'bad-auth';

export interface Received {
  code: number;
  attributes: Attribute[];
  validAuthenticator: boolean;
  validMessageAuthenticator: boolean;
}

/** Minimal RFC 5176 Dynamic Authorization Server, like a MikroTik on UDP 3799. */
export async function startFakeNas(secret: string, behaviour: Behaviour) {
  const sock = dgram.createSocket('udp4');
  const received: Received[] = [];
  let dropped = 0;
  sock.on('message', (msg, rinfo) => {
    const req = Buffer.from(msg);
    const zeroAuth = Buffer.from(req);
    zeroAuth.fill(0, 4, 20);
    const validAuthenticator = createHash('md5')
      .update(zeroAuth)
      .update(secret)
      .digest()
      .equals(req.subarray(4, 20));
    let validMessageAuthenticator = false;
    let pos = 20;
    while (pos < req.length) {
      if (req[pos] === Attr.MessageAuthenticator) {
        const z = Buffer.from(zeroAuth);
        z.fill(0, pos + 2, pos + 18);
        validMessageAuthenticator = createHmac('md5', secret)
          .update(z)
          .digest()
          .equals(req.subarray(pos + 2, pos + 18));
      }
      pos += req[pos + 1]!;
    }
    received.push({
      code: req[0]!,
      attributes: decodeAttributes(req.subarray(20)),
      validAuthenticator,
      validMessageAuthenticator,
    });

    if (behaviour === 'drop' || (behaviour === 'drop-once' && dropped++ === 0)) return;
    const isCoa = req[0] === Code.CoaRequest;
    const nak = behaviour === 'nak';
    const code = isCoa ? (nak ? Code.CoaNak : Code.CoaAck) : nak ? Code.DisconnectNak : Code.DisconnectAck;
    const attrs: Buffer[] = [];
    if (nak) attrs.push(Buffer.from([Attr.ErrorCause, 6, 0, 0, 0x01, 0xf7]));
    const maPos = 20 + attrs.reduce((n, a) => n + a.length, 0);
    attrs.push(Buffer.from([Attr.MessageAuthenticator, 18, ...new Array<number>(16).fill(0)]));
    const body = Buffer.concat(attrs);
    const resp = Buffer.alloc(20 + body.length);
    resp[0] = code;
    resp[1] = req[1]!;
    resp.writeUInt16BE(resp.length, 2);
    req.copy(resp, 4, 4, 20);
    body.copy(resp, 20);
    createHmac('md5', secret)
      .update(resp)
      .digest()
      .copy(resp, maPos + 2);
    const auth = createHash('md5')
      .update(resp)
      .update(behaviour === 'bad-auth' ? 'wrong' : secret)
      .digest();
    auth.copy(resp, 4);
    sock.send(resp, rinfo.port, rinfo.address);
  });
  await new Promise<void>((r) => sock.bind(0, '127.0.0.1', () => r()));
  return {
    port: sock.address().port,
    received,
    close: () => new Promise<void>((r) => sock.close(() => r())),
  };
}
