import { AsyncLocalStorage } from 'node:async_hooks';
import {
  Controller,
  Get,
  Inject,
  Injectable,
  Query,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { ObjectId, type Filter } from 'mongodb';
import { from, mergeMap, type Observable } from 'rxjs';
import { z } from 'zod';
import { ScopedDb, type AuditLogDoc, type MongoHandle } from '@isp/db-mongo';
import type { AuthContext } from '../auth/context.js';
import { ENDPOINT, Ctx, Endpoint, type EndpointOptions } from '../http/endpoint.js';
import { pageOf, pageQuery, page } from '../http/schemas.js';
import { MONGO } from '../infra/infra.module.js';
import { changes, redact } from './diff.js';

interface Note {
  before?: object | null;
  after?: object | null;
  entityId?: ObjectId | string;
  tenantId?: ObjectId;
}

const store = new AsyncLocalStorage<{ notes: Note[] }>();

/**
 * Called by services inside an audited request to record exactly what changed (safe inside a transaction). Without a note the interceptor
 * still records the (redacted) request body, so no audited route goes unrecorded.
 */
export function noteChange(n: Note): void {
  const notes = store.getStore()?.notes;
  if (!notes) return;
  // A retried transaction notes the same entity again; keep only the last attempt.
  const i = n.entityId === undefined ? -1 : notes.findIndex((x) => String(x.entityId) === String(n.entityId));
  if (i >= 0) notes[i] = n;
  else notes.push(n);
}

export interface AuditInput {
  tenantId: ObjectId | null;
  actor: AuditLogDoc['actor'];
  action: string;
  entity: AuditLogDoc['entity'];
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  req?: FastifyRequest;
  meta?: { ip: string; userAgent?: string | undefined };
}

@Injectable()
export class AuditService {
  constructor(@Inject(MONGO) private readonly mongo: MongoHandle) {}

  async record(e: AuditInput): Promise<void> {
    const ua = e.meta ? e.meta.userAgent : e.req?.headers['user-agent'];
    const ip = e.meta?.ip ?? e.req?.ip;
    await this.mongo.db.collection<AuditLogDoc>('audit_logs').insertOne({
      _id: new ObjectId(),
      tenantId: e.tenantId,
      actor: e.actor,
      action: e.action,
      entity: e.entity,
      ...(e.before ? { before: e.before } : {}),
      ...(e.after ? { after: e.after } : {}),
      ...(ip ? { ip } : {}),
      ...(e.req ? { requestId: e.req.id } : {}),
      ...(typeof ua === 'string' ? { userAgent: ua.slice(0, 300) } : {}),
      createdAt: new Date(),
    });
  }
}

/** Sign-in events: the account is both actor and entity. Never blocks a sign-in. */
export async function recordSignIn(
  audit: AuditService,
  user: { _id: ObjectId; tenantId: ObjectId | null; type: string; name: string },
  action: 'auth.login' | 'auth.login_failed' | 'auth.locked',
  meta: { ip: string; userAgent?: string | undefined },
  onError: (e: unknown) => void,
): Promise<void> {
  const id = user._id.toHexString();
  await audit
    .record({
      tenantId: user.tenantId,
      actor: { id, type: user.type, name: user.name },
      action,
      entity: { type: 'user', id },
      meta,
    })
    .catch(onError);
}

const actorOf = (c: AuthContext) => ({ id: c.userId.toHexString(), type: c.type, name: c.name });

/** After a successful audited request: one entry per noted change (or one with the request body). */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  intercept(ec: ExecutionContext, next: CallHandler): Observable<unknown> {
    const opts = this.reflector.get<EndpointOptions | undefined>(ENDPOINT, ec.getHandler());
    if (!opts?.audit) return next.handle();
    const req = ec.switchToHttp().getRequest<FastifyRequest>();
    const ctx = req.ctx;
    if (!ctx) return next.handle();
    const scope = { notes: [] as Note[] };
    store.enterWith(scope);
    const action = opts.audit;
    const prefix = action.split('.')[0]!;
    const entityType = prefix === 'auth' ? 'user' : prefix;
    const paramId =
      prefix === 'auth' ? ctx.userId : ((req.params as { id?: unknown } | undefined)?.id ?? undefined);
    return next.handle().pipe(
      mergeMap((result) =>
        from(
          (async () => {
            const resultId = (result as { id?: unknown } | null)?.id;
            const fallbackId = paramId ?? (typeof resultId === 'string' ? resultId : null);
            const notes = scope.notes.length ? scope.notes : [{ after: (req.body ?? null) as object | null }];
            for (const n of notes) {
              const d =
                n.before !== undefined
                  ? changes(n.before as never, n.after as never)
                  : { after: redact(n.after) as never };
              const id = n.entityId ?? fallbackId;
              await this.audit
                .record({
                  tenantId: n.tenantId ?? ctx.tenantId,
                  actor: actorOf(ctx),
                  action,
                  entity: { type: entityType, id: id == null ? null : String(id) },
                  ...(d.before ? { before: d.before } : {}),
                  ...(d.after && Object.keys(d.after).length ? { after: d.after } : {}),
                  req,
                })
                .catch((err: unknown) => req.log.error({ err, action }, 'audit write failed'));
            }
            return result;
          })(),
        ),
      ),
    );
  }
}

const auditQuery = pageQuery.extend({
  entityType: z
    .string()
    .regex(/^[a-z_]{2,32}$/)
    .optional(),
  entityId: z.string().max(64).optional(),
  actorId: z
    .string()
    .regex(/^[0-9a-f]{24}$/)
    .optional(),
  action: z
    .string()
    .regex(/^[a-z0-9_.-]{2,64}$/)
    .optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
const auditView = z.object({
  id: z.string(),
  at: z.string(),
  action: z.string(),
  actor: z.object({ id: z.string(), type: z.string(), name: z.string() }),
  entity: z.object({ type: z.string(), id: z.string().nullable() }),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  ip: z.string().nullable(),
  tenantId: z.string().nullable(),
});

@Controller('audit')
export class AuditController {
  constructor(@Inject(MONGO) private readonly mongo: MongoHandle) {}

  @Get()
  @Endpoint({
    summary: 'Audit log: who changed what (filter by entity, person, action prefix, time)',
    tags: ['audit'],
    permission: 'audit.view',
    query: auditQuery,
    response: page(auditView),
  })
  async list(@Ctx() ctx: AuthContext, @Query() q: z.output<typeof auditQuery>) {
    const f: Filter<AuditLogDoc> = {};
    if (q.entityType) f['entity.type'] = q.entityType;
    if (q.entityId) f['entity.id'] = q.entityId;
    if (q.actorId) f['actor.id'] = q.actorId;
    if (q.action) f.action = { $regex: `^${q.action.replace(/\./g, '\\.')}` };
    const idRange: Record<string, ObjectId> = {};
    const upper = [
      q.cursor ? new ObjectId(q.cursor) : null,
      q.to ? ObjectId.createFromTime(Math.floor(q.to.getTime() / 1000) + 1) : null,
    ].filter((x): x is ObjectId => x !== null);
    if (upper.length) idRange.$lt = upper.reduce((a, b) => (a.toHexString() < b.toHexString() ? a : b));
    if (q.from) idRange.$gte = ObjectId.createFromTime(Math.floor(q.from.getTime() / 1000));
    if (Object.keys(idRange).length) f._id = idRange;
    const docs = await new ScopedDb(this.mongo.db, ctx.scope)
      .collection<AuditLogDoc>('audit_logs')
      .find(f, { sort: { _id: -1 }, limit: q.limit + 1 })
      .toArray();
    return pageOf(docs, q.limit, (d) => ({
      id: d._id.toHexString(),
      at: d.createdAt.toISOString(),
      action: d.action,
      actor: d.actor,
      entity: d.entity,
      before: d.before ?? null,
      after: d.after ?? null,
      ip: d.ip ?? null,
      tenantId: d.tenantId?.toHexString() ?? null,
    }));
  }
}
