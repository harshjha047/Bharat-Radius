import { afterEach, describe, expect, it } from 'vitest';
import { RadiusCoaClient } from '../src/client.js';
import { Attr, Code, MIKROTIK_VENDOR, MikrotikAttr } from '../src/packet.js';
import { startFakeNas, type Behaviour } from './fake-nas.js';

const SECRET = 'e2e-router-secret-01';
const session = { userName: 'rahul01', acctSessionId: '81a0001f', framedIp: '100.64.0.10' };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup(behaviour: Behaviour, opts: ConstructorParameters<typeof RadiusCoaClient>[0] = {}) {
  const nas = await startFakeNas(SECRET, behaviour);
  const client = new RadiusCoaClient({ timeoutMs: 200, retries: 3, ...opts });
  cleanup.push(nas.close, () => client.close());
  return { nas, client, target: { host: '127.0.0.1', port: nas.port, secret: SECRET } };
}

describe('RadiusCoaClient', () => {
  it('changes speed with a signed CoA-Request and gets ACK', async () => {
    const { nas, client, target } = await setup('ack');
    const r = await client.changeRate(target, session, { rateLimit: '10M/10M', addressList: null });
    expect(r.result).toBe('ack');
    expect(r.attempts).toBe(1);
    const req = nas.received[0]!;
    expect(req.code).toBe(Code.CoaRequest);
    expect(req.validAuthenticator).toBe(true);
    expect(req.validMessageAuthenticator).toBe(true);
    const rate = req.attributes.find(
      (a) => a.vendor === MIKROTIK_VENDOR && a.type === MikrotikAttr.RateLimit,
    );
    expect(rate?.value.toString()).toBe('10M/10M');
    const list = req.attributes.find(
      (a) => a.vendor === MIKROTIK_VENDOR && a.type === MikrotikAttr.AddressList,
    );
    expect(list?.value.toString()).toBe('');
    expect(req.attributes.some((a) => a.type === Attr.EventTimestamp)).toBe(true);
  });

  it('disconnects with Disconnect-Request', async () => {
    const { nas, client, target } = await setup('ack');
    expect((await client.disconnect(target, session)).result).toBe('ack');
    expect(nas.received[0]!.code).toBe(Code.DisconnectRequest);
  });

  it('reports NAK with Error-Cause', async () => {
    const { client, target } = await setup('nak');
    const r = await client.disconnect(target, session);
    expect(r).toMatchObject({ result: 'nak', errorCause: 503, errorText: 'Session Context Not Found' });
  });

  it('retransmits the identical packet after a lost reply', async () => {
    const { nas, client, target } = await setup('drop-once');
    const r = await client.disconnect(target, session);
    expect(r).toMatchObject({ result: 'ack', attempts: 2 });
    expect(nas.received).toHaveLength(2);
  });

  it('times out after all retries', async () => {
    const { nas, client, target } = await setup('drop');
    const r = await client.disconnect(target, session);
    expect(r).toMatchObject({ result: 'timeout', attempts: 3 });
    expect(nas.received).toHaveLength(3);
  });

  it('ignores replies with a bad authenticator', async () => {
    const { client, target } = await setup('bad-auth');
    expect((await client.disconnect(target, session)).result).toBe('timeout');
  });

  it('limits rate per router', async () => {
    const { client, target } = await setup('ack', { perNasRatePerSec: 10, globalRatePerSec: 1000 });
    const start = Date.now();
    const results = await Promise.all(Array.from({ length: 20 }, () => client.disconnect(target, session)));
    expect(results.every((r) => r.result === 'ack')).toBe(true);
    expect(Date.now() - start).toBeGreaterThanOrEqual(900);
  });

  it('runs >256 concurrent requests to one router without id collisions', async () => {
    const { nas, client, target } = await setup('ack', { perNasRatePerSec: 5000, globalRatePerSec: 5000 });
    const results = await Promise.all(Array.from({ length: 400 }, () => client.disconnect(target, session)));
    expect(results.filter((r) => r.result === 'ack')).toHaveLength(400);
    expect(nas.received).toHaveLength(400);
  });
});
