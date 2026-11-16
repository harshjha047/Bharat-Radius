import {
  Controller,
  Get,
  Inject,
  Injectable,
  Param,
  Query,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { ObjectId, type Filter } from 'mongodb';
import { tap, type Observable } from 'rxjs';
import { z } from 'zod';
import { ScopedDb, type MongoHandle, type SubscriberDoc } from '@isp/db-mongo';
import type { AuthContext } from '../auth/context.js';
import { notFound } from '../errors.js';
import { Ctx, ENDPOINT, Endpoint, type EndpointOptions } from '../http/endpoint.js';
import { idParams, pageOf, pageQuery } from '../http/schemas.js';
import { MONGO } from '../infra/infra.module.js';

interface AccessLogDoc {
  _id: ObjectId;
  tenantId: ObjectId | null;
  actor: { id: string; type: string; name: string };
  entity: { type: string; id: string | null };
  route: string;
  ip: string;
  at: Date;
}

/**
 * Personal-data read log (DPDP Rules, r. 6): one row per successful view of a customer's data by staff or a
 * reseller. Written after the response, never blocks or fails the request. Kept ~3 years (TTL, migration 013).
 */
@Injectable()
export class AccessLogInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(MONGO) private readonly mongo: MongoHandle,
  ) {}

  intercept(ec: ExecutionContext, next: CallHandler): Observable<unknown> {
    const opts = this.reflector.get<EndpointOptions | undefined>(ENDPOINT, ec.getHandler());
    if (!opts?.access) return next.handle();
    const req = ec.switchToHttp().getRequest<FastifyRequest>();
    const ctx = req.ctx;
    if (!ctx || ctx.type === 'customer') return next.handle();
    const id = (req.params as { id?: unknown } | undefined)?.id;
    return next.handle().pipe(
      tap(() => {
        const doc: Omit<AccessLogDoc, '_id'> = {
          tenantId: ctx.tenantId ?? null,
          actor: { id: ctx.userId.toHexString(), type: ctx.type, name: ctx.name },
          entity: { type: opts.access!, id: id == null ? null : String(id) },
          route: `${req.method} ${req.routeOptions.url ?? req.url}`,
          ip: req.ip,
          at: new Date(),
        };
        this.mongo.db
          .collection('access_logs')
          .insertOne(doc)
          .catch((err: unknown) => req.log.error({ err }, 'access log write failed'));
      }),
    );
  }
}

const accessView = z.object({
  id: z.string(),
  actor: z.object({ id: z.string(), type: z.string(), name: z.string() }),
  route: z.string(),
  ip: z.string(),
  at: z.string(),
});

@Controller('subscribers')
export class AccessLogController {
  constructor(@Inject(MONGO) private readonly mongo: MongoHandle) {}

  @Get(':id/access-log')
  @Endpoint({
    summary: 'Who viewed this customer’s data (newest first; kept 3 years)',
    tags: ['audit'],
    permission: 'audit.view',
    params: idParams,
    query: pageQuery,
    response: z.object({ items: z.array(accessView), nextCursor: z.string().nullable() }),
  })
  async list(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }, @Query() q: z.output<typeof pageQuery>) {
    const s = await new ScopedDb(this.mongo.db, ctx.scope)
      .collection<SubscriberDoc>('subscribers')
      .findOne({ _id: p.id }, { projection: { _id: 1 } });
    if (!s) throw notFound('Subscriber');
    const f: Filter<AccessLogDoc> = {
      tenantId: ctx.tenantId ?? null,
      'entity.type': 'subscriber',
      'entity.id': p.id.toHexString(),
    };
    if (q.cursor) f._id = { $lt: new ObjectId(q.cursor) };
    const docs = await this.mongo.db
      .collection<AccessLogDoc>('access_logs')
      .find(f, { sort: { _id: -1 }, limit: q.limit + 1 })
      .toArray();
    return pageOf(docs, q.limit, (d) => ({
      id: d._id.toHexString(),
      actor: d.actor,
      route: d.route,
      ip: d.ip,
      at: d.at.toISOString(),
    }));
  }
}
