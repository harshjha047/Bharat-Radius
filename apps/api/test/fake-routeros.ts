import net from 'node:net';
import { SentenceReader, encodeSentence } from '../src/network/routeros/client.js';

/** RouterOS API stand-in for integration tests (user api / secret). */
export function fakeRouterOs() {
  const calls: string[][] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    const reader = new SentenceReader();
    const send = (w: string[]) => sock.write(encodeSentence(w));
    sock.on('data', (d) => {
      for (const s of reader.push(d)) {
        calls.push(s);
        const tag = s.find((w) => w.startsWith('.tag='))!;
        const arg = (k: string) => s.find((w) => w.startsWith(`=${k}=`))?.slice(k.length + 2);
        switch (s[0]) {
          case '/login':
            send(
              arg('password') === 'secret'
                ? ['!done', tag]
                : ['!trap', '=message=invalid user name or password', tag],
            );
            break;
          case '/system/resource/print':
            send([
              '!re',
              '=version=6.49.20 (long-term)',
              '=board-name=RB4011iGS+',
              '=uptime=3d4h',
              '=cpu-load=7',
              '=free-memory=256',
              '=total-memory=1024',
              tag,
            ]);
            send(['!done', tag]);
            break;
          case '/system/identity/print':
            send(['!re', '=name=POP-Live', tag]);
            send(['!done', tag]);
            break;
          case '/interface/print':
            for (const n of ['ether1', 'sfp-sfpplus1', '<pppoe-live1>'])
              send(['!re', `=name=${n}`, '=type=ether', '=running=true', '=disabled=false', tag]);
            send(['!done', tag]);
            break;
          case '/interface/monitor-traffic':
            for (const n of arg('interface')!.split(','))
              send(['!re', `=name=${n}`, '=rx-bits-per-second=5000000', '=tx-bits-per-second=20000000', tag]);
            send(['!done', tag]);
            break;
          case '/ping':
            send(['!re', '=seq=0', '=time=10ms', '=sent=1', '=received=1', tag]);
            send(['!re', '=seq=1', '=time=12ms500us', '=sent=2', '=received=2', tag]);
            send([
              '!re',
              '=seq=2',
              '=sent=3',
              '=received=2',
              '=packet-loss=33',
              '=min-rtt=10ms',
              '=avg-rtt=11ms250us',
              '=max-rtt=12ms500us',
              tag,
            ]);
            send(['!done', tag]);
            break;
          case '/ppp/active/print':
            send(['!done', '=ret=7', tag]);
            break;
          default:
            send(['!trap', '=message=no such command', tag]);
        }
      }
    });
  });
  return new Promise<{ port: number; calls: string[][]; close: () => Promise<void> }>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        calls,
        // The panel keeps API sessions open (pooled): drop them, else close() waits for them.
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
      }),
    ),
  );
}
