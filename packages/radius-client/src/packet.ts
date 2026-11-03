import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const Code = {
  DisconnectRequest: 40,
  DisconnectAck: 41,
  DisconnectNak: 42,
  CoaRequest: 43,
  CoaAck: 44,
  CoaNak: 45,
} as const;

export const Attr = {
  UserName: 1,
  NasIpAddress: 4,
  FramedIpAddress: 8,
  ReplyMessage: 18,
  VendorSpecific: 26,
  SessionTimeout: 27,
  CallingStationId: 31,
  AcctSessionId: 44,
  EventTimestamp: 55,
  MessageAuthenticator: 80,
  ErrorCause: 101,
} as const;

export const MIKROTIK_VENDOR = 14988;
export const MikrotikAttr = { RateLimit: 8, AddressList: 19 } as const;

export type AttrValue = string | number | Buffer;
export interface Attribute {
  type: number;
  value: AttrValue;
  vendor?: number;
}

const HEADER = 20;
const MAX_PACKET = 4096;

function encodeValue(type: number, vendor: number | undefined, value: AttrValue): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'number') {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(value >>> 0);
    return b;
  }
  if (!vendor && type === Attr.FramedIpAddress) {
    const parts = value.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
      throw new Error(`invalid IPv4 address: ${value}`);
    }
    return Buffer.from(parts);
  }
  return Buffer.from(value, 'utf8');
}

function encodeAttribute(a: Attribute): Buffer {
  const data = encodeValue(a.type, a.vendor, a.value);
  if (a.vendor !== undefined) {
    if (data.length > 247) throw new Error(`vendor attribute ${a.vendor}:${a.type} too long`);
    const out = Buffer.alloc(8 + data.length);
    out[0] = Attr.VendorSpecific;
    out[1] = out.length;
    out.writeUInt32BE(a.vendor, 2);
    out[6] = a.type;
    out[7] = data.length + 2;
    data.copy(out, 8);
    return out;
  }
  if (data.length > 253) throw new Error(`attribute ${a.type} too long`);
  const out = Buffer.alloc(2 + data.length);
  out[0] = a.type;
  out[1] = out.length;
  data.copy(out, 2);
  return out;
}

/**
 * Builds a CoA-Request or Disconnect-Request (RFC 5176) with Message-Authenticator (RFC 3579, Blast-RADIUS hardening).
 * Message-Authenticator is computed with a zero Request Authenticator, then the Request Authenticator is computed
 * over the final packet: MD5(Code | Id | Length | 16 zero octets | Attributes | Secret).
 */
export function encodeRequest(code: number, id: number, secret: string, attributes: Attribute[]): Buffer {
  if (!Number.isInteger(id) || id < 0 || id > 255) throw new Error('id must be 0..255');
  if (!secret) throw new Error('secret required');
  const ma = Buffer.from([Attr.MessageAuthenticator, 18, ...new Array<number>(16).fill(0)]);
  const body = Buffer.concat([...attributes.map(encodeAttribute), ma]);
  const length = HEADER + body.length;
  if (length > MAX_PACKET) throw new Error('packet too large');

  const pkt = Buffer.alloc(length);
  pkt[0] = code;
  pkt[1] = id;
  pkt.writeUInt16BE(length, 2);
  body.copy(pkt, HEADER);

  const maOffset = length - 16;
  createHmac('md5', secret).update(pkt).digest().copy(pkt, maOffset);
  createHash('md5').update(pkt).update(secret).digest().copy(pkt, 4);
  return pkt;
}

export interface DecodedResponse {
  code: number;
  id: number;
  attributes: Attribute[];
}

export function decodeAttributes(buf: Buffer): Attribute[] {
  const out: Attribute[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const type = buf[pos];
    const len = buf[pos + 1];
    if (type === undefined || len === undefined || len < 2 || pos + len > buf.length) {
      throw new Error('malformed attribute');
    }
    const value = buf.subarray(pos + 2, pos + len);
    if (type === Attr.VendorSpecific && value.length >= 6) {
      const vendor = value.readUInt32BE(0);
      let vp = 4;
      while (vp + 2 <= value.length) {
        const vt = value[vp]!;
        const vl = value[vp + 1]!;
        if (vl < 2 || vp + vl > value.length) break;
        out.push({ vendor, type: vt, value: value.subarray(vp + 2, vp + vl) });
        vp += vl;
      }
    } else {
      out.push({ type, value });
    }
    pos += len;
  }
  return out;
}

/** Verifies Response Authenticator and, if present, Message-Authenticator. Returns null when invalid. */
export function decodeResponse(
  pkt: Buffer,
  requestAuthenticator: Buffer,
  secret: string,
): DecodedResponse | null {
  if (pkt.length < HEADER) return null;
  const length = pkt.readUInt16BE(2);
  if (length < HEADER || length > pkt.length) return null;
  const p = Buffer.from(pkt.subarray(0, length));
  const received = Buffer.from(p.subarray(4, 20));

  const check = Buffer.from(p);
  requestAuthenticator.copy(check, 4);
  const expected = createHash('md5').update(check).update(secret).digest();
  if (!timingSafeEqual(expected, received)) return null;

  let attributes: Attribute[];
  try {
    attributes = decodeAttributes(p.subarray(HEADER));
  } catch {
    return null;
  }

  let pos = HEADER;
  while (pos < length) {
    const t = p[pos]!;
    const l = p[pos + 1]!;
    if (t === Attr.MessageAuthenticator && l === 18) {
      const got = Buffer.from(p.subarray(pos + 2, pos + 18));
      const zeroed = Buffer.from(p);
      requestAuthenticator.copy(zeroed, 4);
      zeroed.fill(0, pos + 2, pos + 18);
      const mac = createHmac('md5', secret).update(zeroed).digest();
      if (!timingSafeEqual(mac, got)) return null;
    }
    pos += l;
  }
  return { code: p[0]!, id: p[1]!, attributes };
}

export const ERROR_CAUSES: Readonly<Record<number, string>> = {
  201: 'Residual Session Context Removed',
  401: 'Unsupported Attribute',
  402: 'Missing Attribute',
  403: 'NAS Identification Mismatch',
  404: 'Invalid Request',
  405: 'Unsupported Service',
  406: 'Unsupported Extension',
  407: 'Invalid Attribute Value',
  501: 'Administratively Prohibited',
  502: 'Request Not Routable',
  503: 'Session Context Not Found',
  504: 'Session Context Not Removable',
  505: 'Other Proxy Processing Error',
  506: 'Resources Unavailable',
  507: 'Request Initiated',
};
