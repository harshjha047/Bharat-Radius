import { createHash } from 'node:crypto';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { rttMs } from '../router-live.js';
import { RouterOsConnection, RouterOsError, SentenceReader, encodeLength, encodeSentence } from './client.js';
import { RouterOsPool } from './pool.js';

/** Minimal RouterOS API server: answers the commands the panel sends. */
function fakeRouter(opts: { legacy?: boolean; password?: string; delayMs?: number } = {}) {
  const calls: string[][] = [];
  let connections = 0;
  const server = net.createServer((sock) => {
    connections++;
    const reader = new SentenceReader();
    const challenge = '0123456789abcdef0123456789abcdef';
    const send = (words: string[]) => sock.write(encodeSentence(words));
    sock.on('data', (d) => {
      for (const s of reader.push(d)) {
        calls.push(s);
        const tag = s.find((w) => w.startsWith('.tag='))!;
        const arg = (k: string) => s.find((w) => w.startsWith(`=${k}=`))?.slice(k.length + 2);
        const reply = () => {
          switch (s[0]) {
            case '/login': {
              const pw = opts.password ?? 'secret';
              if (opts.legacy && !arg('response')) return send(['!done', `=ret=${challenge}`, tag]);
              const ok = opts.legacy
                ? arg('response') ===
                  `00${createHash('md5')
                    .update(Buffer.concat([Buffer.from([0]), Buffer.from(pw), Buffer.from(challenge, 'hex')]))
                    .digest('hex')}`
                : arg('password') === pw;
              return ok
                ? send(['!done', tag])
                : send(['!trap', '=message=invalid user name or password', tag]);
            }
            case '/interface/monitor-traffic':
              for (const name of arg('interface')!.split(','))
                send(['!re', `=name=${name}`, '=rx-bits-per-second=1000', '=tx-bits-per-second=2000', tag]);
              return send(['!done', tag]);
            case '/ppp/active/print':
              return send(['!done', '=ret=42', tag]);
            default:
              return send(['!trap', '=message=no such command', tag]);
          }
        };
        if (opts.delayMs) setTimeout(reply, opts.delayMs);
        else reply();
      }
    });
  });
  return new Promise<{ port: number; calls: string[][]; connections: () => number; close: () => void }>((r) =>
    server.listen(0, '127.0.0.1', () =>
      r({
        port: (server.address() as net.AddressInfo).port,
        calls,
        connections: () => connections,
        close: () => server.close(),
      }),
    ),
  );
}

const closers: (() => void)[] = [];
afterEach(() => closers.splice(0).forEach((c) => c()));

describe('RouterOS API client', () => {
  it('encodes lengths and decodes split sentences', () => {
    expect([...encodeLength(0x7f)]).toEqual([0x7f]);
    expect([...encodeLength(0x80)]).toEqual([0x80, 0x80]);
    expect([...encodeLength(0x4000)]).toEqual([0xc0, 0x40, 0x00]);
    const long = 'x'.repeat(300);
    const bytes = encodeSentence(['!re', `=a=${long}`]);
    const r = new SentenceReader();
    expect(r.push(bytes.subarray(0, 5))).toEqual([]);
    expect(r.push(bytes.subarray(5))).toEqual([['!re', `=a=${long}`]]);
  });

  it('logs in (6.43+ and legacy challenge), runs tagged commands, reports traps', async () => {
    for (const legacy of [false, true]) {
      const f = await fakeRouter({ legacy });
      closers.push(f.close);
      const c = await RouterOsConnection.open({
        host: '127.0.0.1',
        port: f.port,
        tls: false,
        username: 'api',
        password: 'secret',
      });
      closers.push(() => c.close());
      const [a, b] = await Promise.all([
        c.run(['/interface/monitor-traffic', '=interface=ether1,ether2', '=once=']),
        c.run(['/ppp/active/print', '=count-only=']),
      ]);
      expect(a.re.map((x) => x.name)).toEqual(['ether1', 'ether2']);
      expect(b.done.ret).toBe('42');
      await expect(c.run(['/nope'])).rejects.toMatchObject({ kind: 'trap', message: 'no such command' });
    }
  });

  it('wrong password → login error; closed port → offline within 2 s', async () => {
    const f = await fakeRouter();
    closers.push(f.close);
    await expect(
      RouterOsConnection.open({
        host: '127.0.0.1',
        port: f.port,
        tls: false,
        username: 'api',
        password: 'bad',
      }),
    ).rejects.toMatchObject({ kind: 'login' });
    const t0 = Date.now();
    await expect(
      RouterOsConnection.open({ host: '127.0.0.1', port: 1, tls: false, username: 'a', password: 'b' }),
    ).rejects.toBeInstanceOf(RouterOsError);
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it('pool reuses one session and shares identical in-flight commands', async () => {
    const f = await fakeRouter({ delayMs: 50 });
    closers.push(f.close);
    const pool = new RouterOsPool();
    closers.push(() => pool.close());
    const t = { host: '127.0.0.1', port: f.port, tls: false, username: 'api', password: 'secret' };
    const words = ['/interface/monitor-traffic', '=interface=ether1', '=once='];
    const results = await Promise.all(Array.from({ length: 30 }, () => pool.run('r1:0', t, words)));
    expect(results.every((r) => r.re[0]?.name === 'ether1')).toBe(true);
    expect(f.calls.filter((c) => c[0] === '/interface/monitor-traffic')).toHaveLength(1);
    await pool.run('r1:0', t, ['/ppp/active/print', '=count-only=']);
    expect(f.connections()).toBe(1);
  });
});

describe('ping times', () => {
  it('parses RouterOS durations to ms', () => {
    expect(rttMs('12ms')).toBe(12);
    expect(rttMs('12ms345us')).toBe(12.35);
    expect(rttMs('1s20ms')).toBe(1020);
    expect(rttMs('850us')).toBe(0.85);
    expect(rttMs(undefined)).toBeNull();
  });
});
