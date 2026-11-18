import { isIP } from 'node:net';
import {
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  Param,
  Put,
  Query,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { FieldCrypto } from '@isp/shared';
import { ScopedDb, type MongoHandle, type NasDeviceDoc, type SubscriberDoc } from '@isp/db-mongo';
import { noteChange } from '../audit/audit.js';
import type { AuthContext } from '../auth/context.js';
import { AppError, notFound } from '../errors.js';
import { Ctx, Endpoint } from '../http/endpoint.js';
import { idParams } from '../http/schemas.js';
import { MONGO } from '../infra/infra.module.js';
import { SessionsService } from '../sessions/sessions.js';
import { RouterOsError, type RouterOsTarget } from './routeros/client.js';
import { RouterOsPool } from './routeros/pool.js';

/** RouterOS interface names: letters, digits and . _ - / @ < > : space (e.g. "ether1", "<pppoe-raj>", "vlan 100"). */
const ifaceName = z.string().regex(/^[\w.@<>:/ -]{1,64}$/, 'not an interface name');
const apiBody = z.object({
  enabled: z.boolean(),
  /** Default: the router's RADIUS IP. */
  host: z
    .string()
    .trim()
    .refine((s) => isIP(s) !== 0 || /^[a-z0-9.-]{1,253}$/i.test(s), 'must be an IP or host name')
    .nullable()
    .optional(),
  port: z.number().int().min(1).max(65535).default(8728),
  tls: z.boolean().default(false),
  username: z.string().trim().min(1).max(64),
  /** Omit to keep the saved password. */
  password: z.string().min(1).max(128).optional(),
  monitorPorts: z
    .array(z.object({ interface: ifaceName, label: z.string().trim().max(40).optional() }))
    .max(12)
    .default([]),
});
const apiView = z.object({
  enabled: z.boolean(),
  host: z.string().nullable(),
  port: z.number(),
  tls: z.boolean(),
  username: z.string().nullable(),
  hasPassword: z.boolean(),
  monitorPorts: z.array(z.object({ interface: z.string(), label: z.string().nullable() })),
});
const infoView = z.object({
  identity: z.string().nullable(),
  version: z.string().nullable(),
  board: z.string().nullable(),
  uptime: z.string().nullable(),
  cpuLoadPct: z.number().nullable(),
  memoryUsedPct: z.number().nullable(),
});
const ifaceView = z.object({
  name: z.string(),
  type: z.string().nullable(),
  running: z.boolean(),
  disabled: z.boolean(),
  comment: z.string().nullable(),
});
const trafficQuery = z.object({
  /** Comma-separated, at most 12. Default: the router's dashboard ports. */
  interfaces: z
    .string()
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    )
    .pipe(z.array(ifaceName).min(1).max(12))
    .optional(),
});
const trafficView = z.object({
  at: z.string(),
  interfaces: z.array(z.object({ name: z.string(), rxBps: z.number(), txBps: z.number() })),
});
const pingQuery = z.object({
  address: z
    .string()
    .trim()
    .refine((s) => isIP(s) !== 0 || /^[a-z0-9.-]{1,253}$/i.test(s), 'must be an IP or host name')
    .default('8.8.8.8'),
});
const pingView = z.object({
  address: z.string(),
  sent: z.number(),
  received: z.number(),
  lossPct: z.number(),
  minMs: z.number().nullable(),
  avgMs: z.number().nullable(),
  maxMs: z.number().nullable(),
  lastMs: z.number().nullable(),
});
const liveSpeedView = z.object({
  online: z.boolean(),
  nasName: z.string().nullable(),
  interface: z.string().nullable(),
  downloadBps: z.number().nullable(),
  uploadBps: z.number().nullable(),
  /** Why live speed is not available (offline, no API login, router error). */
  note: z.string().nullable(),
});

const aad = (id: ObjectId) => `nas.api:${id.toHexString()}`;
const num = (v: string | undefined) => (v === undefined || v === '' ? null : Number(v));

/** RouterOS durations: "12ms", "12ms345us", "1s20ms", "850us" → milliseconds. */
export function rttMs(v: string | undefined): number | null {
  if (!v) return null;
  let ms = 0;
  let any = false;
  for (const [, n, u] of v.matchAll(/(\d+(?:\.\d+)?)(ms|us|s)/g)) {
    any = true;
    ms += Number(n) * (u === 's' ? 1000 : u === 'us' ? 0.001 : 1);
  }
  return any ? Math.round(ms * 100) / 100 : null;
}

function routerError(e: unknown): AppError {
  if (e instanceof RouterOsError) {
    const status = e.kind === 'trap' ? 400 : e.kind === 'login' ? 424 : 504;
    return new AppError(status, e.kind === 'trap' ? 'VALIDATION_FAILED' : 'ROUTER_UNAVAILABLE', e.message);
  }
  return e instanceof AppError ? e : new AppError(502, 'ROUTER_UNAVAILABLE', 'Router API failed');
}

@Injectable()
export class RouterLiveService implements OnModuleDestroy {
  readonly pool = new RouterOsPool();

  constructor(
    @Inject(MONGO) private readonly mongo: MongoHandle,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
    @Inject(SessionsService) private readonly sessions: SessionsService,
  ) {}

  onModuleDestroy() {
    this.pool.close();
  }

  private col(ctx: AuthContext) {
    return new ScopedDb(this.mongo.db, ctx.scope).collection<NasDeviceDoc>('nas_devices');
  }

  private async nas(ctx: AuthContext, id: ObjectId) {
    const n = await this.col(ctx).findOne({ _id: id, status: { $ne: 'deleted' } });
    if (!n) throw notFound('Router');
    return n;
  }

  private target(n: NasDeviceDoc): RouterOsTarget {
    if (!n.api?.enabled) {
      throw new AppError(
        409,
        'CONFLICT',
        'Set up this router’s API login first (Routers → Live → API login)',
      );
    }
    const host = n.api.host ?? n.ip;
    if (!host) throw new AppError(409, 'CONFLICT', 'The router has no IP address');
    return {
      host,
      port: n.api.port,
      tls: n.api.tls,
      username: n.api.username,
      password: this.crypto.decrypt(n.api.password, aad(n._id)),
    };
  }

  private async run(n: NasDeviceDoc, words: string[], timeoutMs?: number) {
    try {
      return await this.pool.run(`${n._id.toHexString()}:${n.version}`, this.target(n), words, timeoutMs);
    } catch (e) {
      throw routerError(e);
    }
  }

  getApi = async (ctx: AuthContext, id: ObjectId): Promise<z.output<typeof apiView>> => {
    const n = await this.nas(ctx, id);
    return {
      enabled: n.api?.enabled ?? false,
      host: n.api?.host ?? null,
      port: n.api?.port ?? 8728,
      tls: n.api?.tls ?? false,
      username: n.api?.username ?? null,
      hasPassword: !!n.api?.password,
      monitorPorts: (n.monitorPorts ?? []).map((p) => ({ interface: p.interface, label: p.label ?? null })),
    };
  };

  async putApi(ctx: AuthContext, id: ObjectId, b: z.output<typeof apiBody>) {
    const cur = await this.nas(ctx, id);
    if (!b.password && !cur.api?.password) {
      throw new AppError(400, 'VALIDATION_FAILED', 'Enter the API password');
    }
    const api: NonNullable<NasDeviceDoc['api']> = {
      enabled: b.enabled,
      ...(b.host ? { host: b.host } : {}),
      port: b.port,
      tls: b.tls,
      username: b.username,
      password: b.password ? this.crypto.encrypt(b.password, aad(id)) : cur.api!.password,
    };
    const monitorPorts = b.monitorPorts.map((p) => ({
      interface: p.interface,
      ...(p.label ? { label: p.label } : {}),
    }));
    // Not a RADIUS change: no outbox row, FreeRADIUS is untouched. version++ opens a fresh API session.
    const u = await this.col(ctx).findOneAndUpdate(
      { _id: id, status: { $ne: 'deleted' } },
      {
        $set: { api, monitorPorts, updatedAt: new Date(), updatedBy: ctx.userId.toHexString() },
        $inc: { version: 1 },
      },
      { returnDocument: 'after' },
    );
    if (!u) throw notFound('Router');
    this.pool.forget(id.toHexString());
    noteChange({
      before: { api: cur.api ? { ...cur.api, password: '•' } : null, monitorPorts: cur.monitorPorts },
      after: { api: { ...api, password: '•' }, monitorPorts },
      entityId: id,
    });
    return this.getApi(ctx, id);
  }

  async info(ctx: AuthContext, id: ObjectId): Promise<z.output<typeof infoView>> {
    const n = await this.nas(ctx, id);
    const [res, ident] = await Promise.all([
      this.run(n, ['/system/resource/print']),
      this.run(n, ['/system/identity/print']),
    ]);
    const r = res.re[0] ?? {};
    const total = num(r['total-memory']);
    const free = num(r['free-memory']);
    return {
      identity: ident.re[0]?.name ?? null,
      version: r.version ?? null,
      board: r['board-name'] ?? null,
      uptime: r.uptime ?? null,
      cpuLoadPct: num(r['cpu-load']),
      memoryUsedPct: total && free !== null ? Math.round(((total - free) / total) * 1000) / 10 : null,
    };
  }

  async interfaces(ctx: AuthContext, id: ObjectId) {
    const n = await this.nas(ctx, id);
    const r = await this.run(n, ['/interface/print', '=.proplist=name,type,running,disabled,comment']);
    return r.re
      .filter((x) => x.name)
      .map((x) => ({
        name: x.name!,
        type: x.type ?? null,
        running: x.running === 'true',
        disabled: x.disabled === 'true',
        comment: x.comment ?? null,
      }));
  }

  private async monitor(n: NasDeviceDoc, names: string[]) {
    const r = await this.run(n, ['/interface/monitor-traffic', `=interface=${names.join(',')}`, '=once=']);
    return r.re.map((x) => ({
      name: x.name ?? names[0]!,
      rxBps: num(x['rx-bits-per-second']) ?? 0,
      txBps: num(x['tx-bits-per-second']) ?? 0,
    }));
  }

  async traffic(ctx: AuthContext, id: ObjectId, names: string[] | undefined) {
    const n = await this.nas(ctx, id);
    const list = names ?? (n.monitorPorts ?? []).map((p) => p.interface);
    if (!list.length)
      throw new AppError(400, 'VALIDATION_FAILED', 'Choose interfaces (or set dashboard ports)');
    return { at: new Date().toISOString(), interfaces: await this.monitor(n, list) };
  }

  async ping(ctx: AuthContext, id: ObjectId, address: string): Promise<z.output<typeof pingView>> {
    const n = await this.nas(ctx, id);
    const r = await this.run(n, ['/ping', `=address=${address}`, '=count=3'], 10_000);
    const last = r.re.at(-1) ?? {};
    const sent = num(last.sent) ?? r.re.length;
    const received = num(last.received) ?? r.re.filter((x) => x.time).length;
    const times = r.re.map((x) => rttMs(x.time)).filter((x): x is number => x !== null);
    return {
      address,
      sent,
      received,
      lossPct:
        num(last['packet-loss']?.replace('%', '')) ??
        (sent ? Math.round(((sent - received) / sent) * 100) : 100),
      minMs: rttMs(last['min-rtt']) ?? (times.length ? Math.min(...times) : null),
      avgMs:
        rttMs(last['avg-rtt']) ?? (times.length ? times.reduce((a, b) => a + b, 0) / times.length : null),
      maxMs: rttMs(last['max-rtt']) ?? (times.length ? Math.max(...times) : null),
      lastMs: times.at(-1) ?? null,
    };
  }

  /** PPPoE sessions the router itself counts (compare with RADIUS "online"). */
  async routerOnline(ctx: AuthContext, id: ObjectId) {
    const n = await this.nas(ctx, id);
    const r = await this.run(n, ['/ppp/active/print', '=count-only=']);
    return { pppActive: Number(r.done.ret ?? r.re.length) };
  }

  /** Live download/upload of a subscriber, read from the router they are connected to now. */
  async liveSpeed(ctx: AuthContext, subscriberId: ObjectId): Promise<z.output<typeof liveSpeedView>> {
    const s = await new ScopedDb(this.mongo.db, ctx.scope)
      .collection<SubscriberDoc>('subscribers')
      .findOne(
        { _id: subscriberId, status: { $ne: 'deleted' } },
        { projection: { tenantId: 1, username: 1 } },
      );
    if (!s?.username) throw notFound('Subscriber');
    const off = (note: string, nasName: string | null = null) => ({
      online: false,
      nasName,
      interface: null,
      downloadBps: null,
      uploadBps: null,
      note,
    });
    const t = await this.sessions.pgTenant(s.tenantId);
    if (!t) return off('Not online');
    const { rows } = await this.sessions.db().query<{ nasip: string; username: string }>(
      `SELECT host(nasipaddress) AS nasip, username FROM radacct
        WHERE tenant_id = $1 AND username = $2 AND acctstoptime IS NULL
          AND acctupdatetime > now() - make_interval(secs => 3 * $3::int)
        ORDER BY acctupdatetime DESC LIMIT 1`,
      [t.id, s.username, t.interim],
    );
    const sess = rows[0];
    if (!sess) return off('Not online');
    const n = await this.mongo.db
      .collection<NasDeviceDoc>('nas_devices')
      .findOne({ tenantId: s.tenantId, ip: sess.nasip, status: { $ne: 'deleted' } });
    if (!n) return off(`Online on ${sess.nasip}, a router not in the panel`);
    if (!n.api?.enabled) return { ...off('Router API login not set up', n.name), online: true };
    const iface = `<pppoe-${sess.username}>`;
    try {
      const [m] = await this.monitor(n, [iface]);
      // On the router's PPPoE interface, tx is what goes to the customer.
      return {
        online: true,
        nasName: n.name,
        interface: iface,
        downloadBps: m?.txBps ?? 0,
        uploadBps: m?.rxBps ?? 0,
        note: null,
      };
    } catch (e) {
      return { ...off(routerError(e).message, n.name), online: true, interface: iface };
    }
  }
}

type Id = { id: ObjectId };

@Controller()
export class RouterLiveController {
  constructor(@Inject(RouterLiveService) private readonly live: RouterLiveService) {}

  @Get('nas/:id/api')
  @Endpoint({
    summary: 'Router API login (password never returned) and the ports shown with live graphs',
    tags: ['nas'],
    permission: 'nas.read',
    params: idParams,
    response: apiView,
  })
  getApi(@Ctx() ctx: AuthContext, @Param() p: Id) {
    return this.live.getApi(ctx, p.id);
  }

  @Put('nas/:id/api')
  @Endpoint({
    summary: 'Save the router API login and monitored ports (not a RADIUS change)',
    tags: ['nas'],
    audit: 'nas.api_update',
    permission: 'nas.write',
    params: idParams,
    body: apiBody,
    response: apiView,
  })
  putApi(@Ctx() ctx: AuthContext, @Param() p: Id, @Body() b: z.output<typeof apiBody>) {
    return this.live.putApi(ctx, p.id, b);
  }

  @Get('nas/:id/live/info')
  @Endpoint({
    summary: 'Router identity, version, uptime, CPU and memory (live from the router)',
    tags: ['nas'],
    permission: 'nas.read',
    params: idParams,
    response: infoView,
  })
  info(@Ctx() ctx: AuthContext, @Param() p: Id) {
    return this.live.info(ctx, p.id);
  }

  @Get('nas/:id/live/interfaces')
  @Endpoint({
    summary: 'Router interfaces (live)',
    tags: ['nas'],
    permission: 'nas.read',
    params: idParams,
    response: z.array(ifaceView),
  })
  interfaces(@Ctx() ctx: AuthContext, @Param() p: Id) {
    return this.live.interfaces(ctx, p.id);
  }

  @Get('nas/:id/live/traffic')
  @Endpoint({
    summary: 'RX/TX bits per second now for up to 12 interfaces (poll every 2 s)',
    tags: ['nas'],
    permission: 'nas.read',
    params: idParams,
    query: trafficQuery,
    response: trafficView,
  })
  traffic(@Ctx() ctx: AuthContext, @Param() p: Id, @Query() q: z.output<typeof trafficQuery>) {
    return this.live.traffic(ctx, p.id, q.interfaces);
  }

  @Get('nas/:id/live/ping')
  @Endpoint({
    summary: 'Ping from the router (3 packets): loss and min/avg/max latency',
    tags: ['nas'],
    permission: 'nas.read',
    params: idParams,
    query: pingQuery,
    response: pingView,
  })
  ping(@Ctx() ctx: AuthContext, @Param() p: Id, @Query() q: z.output<typeof pingQuery>) {
    return this.live.ping(ctx, p.id, q.address);
  }

  @Get('nas/:id/live/online')
  @Endpoint({
    summary: 'PPPoE sessions the router counts (to compare with RADIUS online)',
    tags: ['nas'],
    permission: 'sessions.read',
    params: idParams,
    response: z.object({ pppActive: z.number() }),
  })
  online(@Ctx() ctx: AuthContext, @Param() p: Id) {
    return this.live.routerOnline(ctx, p.id);
  }

  @Get('subscribers/:id/live-speed')
  @Endpoint({
    summary: 'Live download/upload of the subscriber from the router they are on',
    tags: ['sessions'],
    permission: 'sessions.read',
    params: idParams,
    response: liveSpeedView,
  })
  liveSpeed(@Ctx() ctx: AuthContext, @Param() p: Id) {
    return this.live.liveSpeed(ctx, p.id);
  }
}
