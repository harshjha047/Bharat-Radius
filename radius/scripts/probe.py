#!/usr/bin/env python3
"""Synthetic RADIUS login: one PAP Access-Request with Message-Authenticator, reply authenticator verified.

Usage: probe.py <server> <port> <bind-ip> <secret> <user> <password> [timeout]
Prints one line: "accept <seconds>", "reject <seconds>", "timeout" or "bad-reply". Exit 0 only on accept.
Standard library only.
"""
import hashlib
import hmac
import os
import socket
import struct
import sys
import time


def attr(t: int, v: bytes) -> bytes:
    return struct.pack("!BB", t, len(v) + 2) + v


def pap(password: bytes, secret: bytes, authenticator: bytes) -> bytes:
    p = password.ljust(max(16, -(-len(password) // 16) * 16), b"\0")
    out, prev = b"", authenticator
    for i in range(0, len(p), 16):
        b = hashlib.md5(secret + prev).digest()
        c = bytes(x ^ y for x, y in zip(p[i : i + 16], b))
        out, prev = out + c, c
    return out


def main() -> int:
    if len(sys.argv) < 7:
        print(__doc__, file=sys.stderr)
        return 2
    server, port, bind_ip, secret, user, password = sys.argv[1:7]
    timeout = float(sys.argv[7]) if len(sys.argv) > 7 else 2.0
    key = secret.encode()
    ident = os.urandom(1)[0]
    ra = os.urandom(16)
    attrs = (
        attr(1, user.encode())
        + attr(2, pap(password.encode(), key, ra))
        + attr(4, socket.inet_aton(bind_ip))
        + attr(61, struct.pack("!I", 15))  # NAS-Port-Type = Ethernet (PPPoE-like)
    )
    ma_off = 20 + len(attrs) + 2
    body = attrs + attr(80, b"\0" * 16)
    head = struct.pack("!BBH", 1, ident, 20 + len(body))
    pkt = bytearray(head + ra + body)
    pkt[ma_off : ma_off + 16] = hmac.new(key, bytes(pkt), hashlib.md5).digest()

    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind((bind_ip, 0))
    s.settimeout(timeout)
    t0 = time.monotonic()
    s.sendto(bytes(pkt), (server, int(port)))
    try:
        reply, _ = s.recvfrom(4096)
    except socket.timeout:
        print("timeout")
        return 1
    dt = time.monotonic() - t0
    if len(reply) < 20 or reply[1] != ident:
        print("bad-reply")
        return 1
    code, _, length = struct.unpack("!BBH", reply[:4])
    want = hashlib.md5(reply[:4] + ra + reply[20:length] + key).digest()
    if not hmac.compare_digest(want, reply[4:20]):
        print("bad-reply")
        return 1
    print(f"{'accept' if code == 2 else 'reject'} {dt:.4f}")
    return 0 if code == 2 else 1


if __name__ == "__main__":
    sys.exit(main())
