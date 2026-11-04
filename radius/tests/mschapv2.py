#!/usr/bin/env python3
"""MS-CHAPv2 Access-Request (RFC 2548/2759) — radclient only speaks MS-CHAPv1.

Usage: mschapv2.py <server> <port> <secret> <user> <password>
Prints: ACCEPT|REJECT, then 'success-attr', 'mppe-keys' markers when present. Exit 0 always on a reply.
Requires python3-pycryptodome (MD4, DES).
"""
import hashlib
import hmac
import os
import socket
import struct
import sys

try:
    from Cryptodome.Cipher import DES
    from Cryptodome.Hash import MD4
except ImportError:
    try:
        from Crypto.Cipher import DES
        from Crypto.Hash import MD4
    except ImportError:
        sys.exit("missing pycryptodome: sudo apt-get install python3-pycryptodome")

MS_VENDOR = 311


def vsa(vtype: int, value: bytes) -> bytes:
    inner = struct.pack("!BB", vtype, len(value) + 2) + value
    return struct.pack("!BBI", 26, len(inner) + 6, MS_VENDOR) + inner


def attr(atype: int, value: bytes) -> bytes:
    return struct.pack("!BB", atype, len(value) + 2) + value


def des_key(k7: bytes) -> bytes:
    bits = int.from_bytes(k7, "big")
    out = bytearray()
    for i in range(8):
        b = (bits >> (56 - 7 * (i + 1))) & 0x7F
        b <<= 1
        b |= 0 if bin(b).count("1") % 2 else 1
        out.append(b)
    return bytes(out)


def nt_response(auth_chal: bytes, peer_chal: bytes, user: str, password: str) -> bytes:
    challenge = hashlib.sha1(peer_chal + auth_chal + user.encode()).digest()[:8]
    pw_hash = MD4.new(password.encode("utf-16-le")).digest() + b"\x00" * 5
    return b"".join(DES.new(des_key(pw_hash[i : i + 7]), DES.MODE_ECB).encrypt(challenge) for i in (0, 7, 14))


def main() -> None:
    server, port, secret, user, password = sys.argv[1], int(sys.argv[2]), sys.argv[3].encode(), sys.argv[4], sys.argv[5]
    auth_chal, peer_chal = os.urandom(16), os.urandom(16)
    response = bytes([1, 0]) + peer_chal + b"\x00" * 8 + nt_response(auth_chal, peer_chal, user, password)
    ident = os.urandom(1)[0]
    req_auth = os.urandom(16)
    attrs = (
        attr(1, user.encode())
        + attr(61, struct.pack("!I", 15))
        + vsa(11, auth_chal)
        + vsa(25, response)
        + attr(80, b"\x00" * 16)
    )
    length = 20 + len(attrs)
    pkt = struct.pack("!BBH", 1, ident, length) + req_auth + attrs
    mac = hmac.new(secret, pkt, hashlib.md5).digest()
    pkt = pkt[:-16] + mac

    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(3)
    s.sendto(pkt, (server, port))
    data, _ = s.recvfrom(4096)
    code = data[0]
    print("ACCEPT" if code == 2 else "REJECT" if code == 3 else f"CODE{code}")
    pos, found = 20, set()
    while pos < len(data):
        t, ln = data[pos], data[pos + 1]
        if t == 26 and struct.unpack("!I", data[pos + 2 : pos + 6])[0] == MS_VENDOR:
            vt = data[pos + 6]
            if vt == 26:
                found.add("success-attr")
            if vt in (16, 17):
                found.add("mppe-keys")
        pos += ln
    for f in sorted(found):
        print(f)


if __name__ == "__main__":
    main()
