import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { NatArchive, parseNatLine } from './nat-archive.js';

const v7 =
  '2026-11-16T12:03:27.852267+05:30 203.0.113.9 firewall,info ISPNAT srcnat: in:<pppoe-ravi.p> out:ether1, ' +
  'connection-state:new src-mac 0c:aa:bb:cc:dd:ee, proto TCP (SYN), 100.64.50.10:51515->142.250.1.1:443, ' +
  'NAT (100.64.50.10:51515->203.0.113.9:40001)->142.250.1.1:443, len 60';
const v6udp =
  '2026-11-16T12:03:30+05:30 203.0.113.9 firewall,info ISPNAT srcnat: in:vlan20 out:ether1, src-mac 0c:aa:bb:cc:dd:01, ' +
  'proto UDP, 192.168.20.7:5353->8.8.8.8:53, NAT (192.168.20.7:5353->203.0.113.9:5353)->8.8.8.8:53, len 72';
const icmp =
  '2026-11-16T12:03:31+05:30 203.0.113.9 firewall,info ISPNAT srcnat: in:<pppoe-sita> out:ether1, src-mac 0c:aa:bb:cc:dd:02, ' +
  'proto ICMP (type 8, code 0), 100.64.50.11->1.1.1.1, NAT (100.64.50.11->203.0.113.9)->1.1.1.1, len 84';

describe('parseNatLine', () => {
  it('RouterOS 7 TCP via PPPoE: user, private and public ip:port, destination', () => {
    expect(parseNatLine(v7)).toMatchObject({
      router: '203.0.113.9',
      pppoeUser: 'ravi.p',
      proto: 'TCP',
      privateIp: '100.64.50.10',
      privatePort: 51515,
      publicIp: '203.0.113.9',
      publicPort: 40001,
      destIp: '142.250.1.1',
      destPort: 443,
    });
    expect(parseNatLine(v7)!.at.toISOString()).toBe('2026-11-16T06:33:27.852Z');
  });
  it('RouterOS 6 UDP on a VLAN (no PPPoE user) and ICMP without ports', () => {
    expect(parseNatLine(v6udp)).toMatchObject({
      pppoeUser: null,
      inInterface: 'vlan20',
      privateIp: '192.168.20.7',
      publicPort: 5353,
    });
    expect(parseNatLine(icmp)).toMatchObject({
      pppoeUser: 'sita',
      proto: 'ICMP',
      privatePort: null,
      publicIp: '203.0.113.9',
      publicPort: null,
    });
  });
  it('ignores other lines', () => {
    expect(
      parseNatLine('2026-11-16T12:03:31+05:30 203.0.113.9 pppoe,info <pppoe-sita>: authenticated'),
    ).toBeNull();
  });
});

describe('NatArchive.search', () => {
  const root = mkdtempSync(join(tmpdir(), 'nat-'));
  mkdirSync(join(root, '203.0.113.9'));
  mkdirSync(join(root, '198.51.100.4'));
  writeFileSync(join(root, '203.0.113.9', '2026-11-16.log.gz'), gzipSync(`${v7}\n${v6udp}\n${icmp}\n`));
  writeFileSync(
    join(root, '198.51.100.4', '2026-11-16.log'),
    v7.replace(/203\.0\.113\.9/g, '198.51.100.4') + '\n',
  );
  const nat = new NatArchive(root);
  const at = new Date('2026-11-16T06:33:28Z');

  it('finds the connection by public IP and port within the window (gzip and live files)', async () => {
    const r = await nat.search({
      publicIp: '203.0.113.9',
      port: 40001,
      at,
      windowSecs: 60,
      routers: ['203.0.113.9'],
      limit: 50,
    });
    expect(r.hits.map((h) => h.pppoeUser)).toEqual(['ravi.p']);
    expect(r.filesScanned).toBe(1);
  });
  it('without a port returns every translation to that IP, nearest first; outside the window nothing', async () => {
    const r = await nat.search({
      publicIp: '203.0.113.9',
      at,
      windowSecs: 60,
      routers: ['203.0.113.9'],
      limit: 50,
    });
    expect(r.hits.map((h) => h.privateIp)).toEqual(['100.64.50.10', '192.168.20.7', '100.64.50.11']);
    const late = await nat.search({
      publicIp: '203.0.113.9',
      at: new Date('2026-11-16T08:00:00Z'),
      windowSecs: 60,
      routers: ['203.0.113.9'],
      limit: 50,
    });
    expect(late.hits).toEqual([]);
  });
  it("only scans the caller's routers", async () => {
    const r = await nat.search({
      publicIp: '198.51.100.4',
      port: 40001,
      at,
      windowSecs: 60,
      routers: ['203.0.113.9'],
      limit: 50,
    });
    expect(r.hits).toEqual([]);
    expect(r.filesScanned).toBe(1);
  });
});
