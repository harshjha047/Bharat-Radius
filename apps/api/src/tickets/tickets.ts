import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import {
  ScopedDb,
  type MongoHandle,
  type RoleDoc,
  type SubscriberDoc,
  type TicketActor,
  type TicketDoc,
  type TicketEventDoc,
  type TicketStatus,
  type UserDoc,
} from '@isp/db-mongo';
import { noteChange } from '../audit/audit.js';
import type { AuthContext } from '../auth/context.js';
import { RateLimiter } from '../auth/rate-limit.js';
import { AppError, conflict, forbidden, notFound, tooMany } from '../errors.js';
import { Ctx, Endpoint } from '../http/endpoint.js';
import { hexId, idParams, objectId } from '../http/schemas.js';
import { MONGO } from '../infra/infra.module.js';

const STATUSES = ['open', 'in_progress', 'waiting_customer', 'resolved', 'closed'] as const;
const CATEGORIES = ['no_internet', 'slow_speed', 'billing', 'plan_change', 'relocation', 'other'] as const;
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const ACTIVE: TicketStatus[] = ['open', 'in_progress', 'waiting_customer'];
/** Customers may open this many tickets per hour. */
const PORTAL_TICKETS_PER_HOUR = 5;

const text = (max: number) => z.string().trim().min(1, 'Required').max(max);
const cursor = z
  .string()
  .regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z_[0-9a-f]{24}$/, 'invalid cursor')
  .optional();

const listQuery = z.object({
  /** `active` = open, in progress or waiting for the customer. */
  status: z.enum([...STATUSES, 'active']).optional(),
  /** `me`, `none` or a user id. */
  assignee: z.union([z.literal('me'), z.literal('none'), hexId]).optional(),
  subscriberId: hexId.optional(),
  category: z.enum(CATEGORIES).optional(),
  /** Ticket number prefix, e.g. T0001 or 0001. */
  q: z
    .string()
    .trim()
    .regex(/^T?\d{1,8}$/i, 'ticket number')
    .optional(),
  cursor,
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const createBody = z.object({
  subscriberId: objectId.optional(),
  subject: text(160),
  category: z.enum(CATEGORIES),
  priority: z.enum(PRIORITIES).default('normal'),
  body: text(4000),
  assigneeId: objectId.optional(),
});
const replyBody = z.object({
  body: text(4000),
  /** Internal note: never shown to the customer. */
  internal: z.boolean().default(false),
  status: z.enum(STATUSES).optional(),
});
const updateBody = z
  .object({
    status: z.enum(STATUSES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    category: z.enum(CATEGORIES).optional(),
    assigneeId: objectId.nullable().optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'nothing to change');
const portalCreateBody = z.object({ subject: text(160), category: z.enum(CATEGORIES), body: text(4000) });
const portalReplyBody = z.object({ body: text(4000) });
const portalListQuery = z.object({ cursor, limit: z.coerce.number().int().min(1).max(50).default(20) });

const actorView = z.object({ type: z.string(), id: z.string(), name: z.string() });
const ticketView = z.object({
  id: z.string(),
  number: z.string(),
  subject: z.string(),
  category: z.enum(CATEGORIES),
  priority: z.enum(PRIORITIES),
  status: z.enum(STATUSES),
  assignee: z.object({ id: z.string(), name: z.string() }).nullable(),
  subscriber: z
    .object({
      id: z.string(),
      name: z.string(),
      customerNo: z.string(),
      username: z.string().nullable(),
      phone: z.string(),
    })
    .nullable(),
  source: z.enum(['portal', 'staff', 'reseller']),
  openedBy: actorView,
  messageCount: z.number(),
  lastActivityAt: z.string(),
  firstResponseAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
});
const eventView = z.object({
  id: z.string(),
  kind: z.enum(['message', 'note', 'status', 'assign', 'priority']),
  body: z.string().nullable(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  author: actorView,
  createdAt: z.string(),
});
const detailView = ticketView.extend({ events: z.array(eventView) });
const listView = z.object({ items: z.array(ticketView), nextCursor: z.string().nullable() });
const countsView = z.object({
  open: z.number(),
  in_progress: z.number(),
  waiting_customer: z.number(),
  resolved: z.number(),
  closed: z.number(),
  mine: z.number(),
  unassigned: z.number(),
});
const assigneeView = z.object({ items: z.array(z.object({ id: z.string(), name: z.string() })) });

type SubRef = Pick<SubscriberDoc, '_id' | 'name' | 'customerNo' | 'username' | 'phone'>;

const actorOf = (ctx: AuthContext): TicketActor => ({
  type: ctx.type === 'customer' ? 'customer' : ctx.type,
  id: ctx.userId.toHexString(),
  name: ctx.name,
});

const toView = (t: TicketDoc, s?: SubRef): z.output<typeof ticketView> => ({
  id: t._id.toHexString(),
  number: t.number,
  subject: t.subject,
  category: t.category,
  priority: t.priority,
  status: t.status,
  assignee: t.assignee ? { id: t.assignee.id.toHexString(), name: t.assignee.name } : null,
  subscriber: s
    ? {
        id: s._id.toHexString(),
        name: s.name,
        customerNo: s.customerNo,
        username: s.username ?? null,
        phone: s.phone,
      }
    : null,
  source: t.source,
  openedBy: t.openedBy,
  messageCount: t.messageCount,
  lastActivityAt: t.lastActivityAt.toISOString(),
  firstResponseAt: t.firstResponseAt?.toISOString() ?? null,
  resolvedAt: t.resolvedAt?.toISOString() ?? null,
  createdAt: t.createdAt.toISOString(),
});

const toEvent = (e: TicketEventDoc): z.output<typeof eventView> => ({
  id: e._id.toHexString(),
  kind: e.kind,
  body: e.body ?? null,
  from: e.from ?? null,
  to: e.to ?? null,
  author: e.author,
  createdAt: e.createdAt.toISOString(),
});

const keyset = (c: string | undefined) => {
  if (!c) return null;
  const i = c.lastIndexOf('_');
  return { at: new Date(c.slice(0, i)), id: new ObjectId(c.slice(i + 1)) };
};
const nextCursorOf = (docs: TicketDoc[], limit: number) =>
  docs.length > limit
    ? `${docs[limit - 1]!.lastActivityAt.toISOString()}_${docs[limit - 1]!._id.toHexString()}`
    : null;

/** Status change side-fields: when it was resolved/closed (cleared again on reopen). */
function statusFields(next: TicketStatus, now: Date) {
  const set: Partial<TicketDoc> = { status: next };
  const unset: Record<string, ''> = {};
  if (next === 'resolved') set.resolvedAt = now;
  else if (next === 'closed') set.closedAt = now;
  else {
    unset.resolvedAt = '';
    unset.closedAt = '';
  }
  return { set, unset };
}

@Injectable()
export class TicketsService {
  constructor(
    @Inject(MONGO) private readonly mongo: MongoHandle,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  private get db() {
    return this.mongo.db;
  }
  private scoped(ctx: AuthContext) {
    return new ScopedDb(this.db, ctx.scope).collection<TicketDoc>('tickets');
  }
  private get events() {
    return this.db.collection<TicketEventDoc>('ticket_events');
  }

  private async subRefs(docs: TicketDoc[]): Promise<Map<string, SubRef>> {
    const ids = [...new Set(docs.flatMap((d) => (d.subscriberId ? [d.subscriberId.toHexString()] : [])))];
    if (!ids.length) return new Map();
    const rows = await this.db
      .collection<SubscriberDoc>('subscribers')
      .find(
        { _id: { $in: ids.map((i) => new ObjectId(i)) } },
        { projection: { name: 1, customerNo: 1, username: 1, phone: 1 } },
      )
      .toArray();
    return new Map(rows.map((r) => [r._id.toHexString(), r]));
  }

  private async views(docs: TicketDoc[]) {
    const subs = await this.subRefs(docs);
    return docs.map((d) => toView(d, d.subscriberId ? subs.get(d.subscriberId.toHexString()) : undefined));
  }

  private async nextNumber(tenantId: ObjectId) {
    const c = await this.db
      .collection<{ _id: string; seq: number }>('counters')
      .findOneAndUpdate(
        { _id: `ticketNo:${tenantId.toHexString()}` },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after', includeResultMetadata: false },
      );
    return `T${String(c!.seq).padStart(6, '0')}`;
  }

  /** An active staff user of this tenant whose roles allow working tickets. */
  private async assignee(tenantId: ObjectId, id: ObjectId) {
    const roles = await this.db
      .collection<RoleDoc>('roles')
      .find({ tenantId: { $in: [tenantId, null] }, permissions: 'tickets.write' }, { projection: { _id: 1 } })
      .toArray();
    const u = await this.db
      .collection<UserDoc>('users')
      .findOne(
        { _id: id, tenantId, type: 'staff', status: 'active', roleIds: { $in: roles.map((r) => r._id) } },
        { projection: { name: 1 } },
      );
    if (!u) throw new AppError(400, 'VALIDATION_FAILED', 'Choose a staff member who can work on tickets');
    return { id: u._id, name: u.name };
  }

  async assignees(ctx: AuthContext) {
    const tenantId = ctx.tenantId!;
    const roles = await this.db
      .collection<RoleDoc>('roles')
      .find({ tenantId: { $in: [tenantId, null] }, permissions: 'tickets.write' }, { projection: { _id: 1 } })
      .toArray();
    const users = await this.db
      .collection<UserDoc>('users')
      .find(
        { tenantId, type: 'staff', status: 'active', roleIds: { $in: roles.map((r) => r._id) } },
        { projection: { name: 1 }, sort: { name: 1 }, limit: 500 },
      )
      .toArray();
    return { items: users.map((u) => ({ id: u._id.toHexString(), name: u.name })) };
  }

  async list(ctx: AuthContext, q: z.output<typeof listQuery>) {
    const f: Filter<TicketDoc> = {};
    if (q.status === 'active') f.status = { $in: ACTIVE };
    else if (q.status) f.status = q.status;
    if (q.assignee === 'me') f['assignee.id'] = ctx.userId;
    else if (q.assignee === 'none') f.assignee = null;
    else if (q.assignee) f['assignee.id'] = new ObjectId(q.assignee);
    if (q.subscriberId) f.subscriberId = new ObjectId(q.subscriberId);
    if (q.category) f.category = q.category;
    if (q.q) f.number = { $regex: `^T${q.q.replace(/^T/i, '')}` };
    const k = keyset(q.cursor);
    if (k) f.$or = [{ lastActivityAt: { $lt: k.at } }, { lastActivityAt: k.at, _id: { $lt: k.id } }];
    const docs = await this.scoped(ctx)
      .find(f, { sort: { lastActivityAt: -1, _id: -1 }, limit: q.limit + 1 })
      .toArray();
    return { items: await this.views(docs.slice(0, q.limit)), nextCursor: nextCursorOf(docs, q.limit) };
  }

  async counts(ctx: AuthContext): Promise<z.output<typeof countsView>> {
    const rows = await this.scoped(ctx)
      .aggregate<{ _id: TicketStatus; n: number; mine: number; unassigned: number }>([
        {
          $group: {
            _id: '$status',
            n: { $sum: 1 },
            mine: { $sum: { $cond: [{ $eq: ['$assignee.id', ctx.userId] }, 1, 0] } },
            unassigned: { $sum: { $cond: [{ $eq: ['$assignee', null] }, 1, 0] } },
          },
        },
      ])
      .toArray();
    const out = {
      open: 0,
      in_progress: 0,
      waiting_customer: 0,
      resolved: 0,
      closed: 0,
      mine: 0,
      unassigned: 0,
    };
    for (const r of rows) {
      out[r._id] = r.n;
      if (ACTIVE.includes(r._id)) {
        out.mine += r.mine;
        out.unassigned += r.unassigned;
      }
    }
    return out;
  }

  private async find(ctx: AuthContext, id: ObjectId) {
    const t = await this.scoped(ctx).findOne({ _id: id });
    if (!t) throw notFound('Ticket');
    return t;
  }

  async get(ctx: AuthContext, id: ObjectId, publicOnly = false) {
    const t = await this.find(ctx, id);
    return this.detail(t, publicOnly);
  }

  private async detail(t: TicketDoc, publicOnly: boolean) {
    const [view] = await this.views([t]);
    const events = await this.events
      .find(
        { ticketId: t._id, ...(publicOnly ? { kind: { $in: ['message', 'status'] } } : {}) },
        { sort: { _id: 1 }, limit: 1000 },
      )
      .toArray();
    return { ...view!, events: events.map(toEvent) };
  }

  private async open(
    ctx: AuthContext,
    s: SubscriberDoc | null,
    b: { subject: string; category: TicketDoc['category']; priority: TicketDoc['priority']; body: string },
    source: TicketDoc['source'],
    assignee: TicketDoc['assignee'],
  ) {
    const tenantId = ctx.tenantId!;
    const now = new Date();
    const author = actorOf(ctx);
    const t: TicketDoc = {
      _id: new ObjectId(),
      tenantId,
      number: await this.nextNumber(tenantId),
      subscriberId: s?._id ?? null,
      ancestors: s?.ancestors ?? [],
      subject: b.subject,
      category: b.category,
      priority: b.priority,
      status: 'open',
      assignee,
      source,
      openedBy: author,
      messageCount: 1,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
      version: 0,
    };
    // The customer was already read through the caller's scope; ancestors come from that record.
    await this.db.collection<TicketDoc>('tickets').insertOne(t);
    const ev: TicketEventDoc[] = [
      {
        _id: new ObjectId(),
        tenantId,
        ticketId: t._id,
        kind: 'message',
        body: b.body,
        author,
        createdAt: now,
      },
    ];
    if (assignee) {
      ev.push({
        _id: new ObjectId(),
        tenantId,
        ticketId: t._id,
        kind: 'assign',
        to: assignee.name,
        author,
        createdAt: now,
      });
    }
    await this.events.insertMany(ev);
    noteChange({ after: { ...t, body: b.body }, entityId: t._id });
    return this.detail(t, ctx.type === 'customer');
  }

  async create(ctx: AuthContext, b: z.output<typeof createBody>) {
    let s: SubscriberDoc | null = null;
    if (b.subscriberId) {
      s = await new ScopedDb(this.db, ctx.scope)
        .collection<SubscriberDoc>('subscribers')
        .findOne({ _id: b.subscriberId, status: { $ne: 'deleted' } });
      if (!s) throw notFound('Subscriber');
    } else if (ctx.scope.kind === 'branch') {
      throw new AppError(400, 'VALIDATION_FAILED', 'Choose the customer this ticket is about', {
        issues: [{ path: 'subscriberId', message: 'Required' }],
      });
    }
    let assignee: TicketDoc['assignee'] = null;
    if (b.assigneeId) {
      if (!ctx.permissions.has('tickets.assign')) throw forbidden('You cannot assign tickets');
      assignee = await this.assignee(ctx.tenantId!, b.assigneeId);
    }
    return this.open(ctx, s, b, ctx.type === 'reseller' ? 'reseller' : 'staff', assignee);
  }

  /**
   * Message or internal note (+ optional status). A reply the customer can see sets firstResponseAt;
   * the version guard makes concurrent replies serialise instead of overwriting each other's counters.
   */
  private async addEvent(
    ctx: AuthContext,
    t: TicketDoc,
    kind: 'message' | 'note',
    body: string,
    status: TicketStatus | undefined,
  ) {
    const now = new Date();
    const author = actorOf(ctx);
    const ev: TicketEventDoc[] = [
      { _id: new ObjectId(), tenantId: t.tenantId, ticketId: t._id, kind, body, author, createdAt: now },
    ];
    const set: Partial<TicketDoc> = { lastActivityAt: now, updatedAt: now };
    let unset: Record<string, ''> = {};
    if (status && status !== t.status) {
      const sf = statusFields(status, now);
      Object.assign(set, sf.set);
      unset = sf.unset;
      ev.push({
        _id: new ObjectId(),
        tenantId: t.tenantId,
        ticketId: t._id,
        kind: 'status',
        from: t.status,
        to: status,
        author,
        createdAt: now,
      });
    }
    if (kind === 'message' && ctx.type !== 'customer' && !t.firstResponseAt) set.firstResponseAt = now;
    const r = await this.db.collection<TicketDoc>('tickets').updateOne(
      { _id: t._id, version: t.version },
      {
        $set: set,
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
        $inc: { version: 1, ...(kind === 'message' ? { messageCount: 1 } : {}) },
      },
    );
    if (!r.matchedCount) throw conflict('The ticket changed meanwhile. Reload and try again.');
    await this.events.insertMany(ev);
    noteChange({
      before: { status: t.status },
      after: { status: set.status ?? t.status, [kind]: body },
      entityId: t._id,
    });
  }

  async reply(ctx: AuthContext, id: ObjectId, b: z.output<typeof replyBody>) {
    const t = await this.find(ctx, id);
    await this.addEvent(ctx, t, b.internal ? 'note' : 'message', b.body, b.status);
    return this.get(ctx, id);
  }

  async update(ctx: AuthContext, id: ObjectId, b: z.output<typeof updateBody>) {
    const t = await this.find(ctx, id);
    const now = new Date();
    const author = actorOf(ctx);
    const set: Partial<TicketDoc> = { updatedAt: now, lastActivityAt: now };
    let unset: Record<string, ''> = {};
    const ev: TicketEventDoc[] = [];
    const base = { tenantId: t.tenantId, ticketId: t._id, author, createdAt: now };
    if (b.status && b.status !== t.status) {
      const sf = statusFields(b.status, now);
      Object.assign(set, sf.set);
      unset = sf.unset;
      ev.push({ _id: new ObjectId(), ...base, kind: 'status', from: t.status, to: b.status });
    }
    if (b.priority && b.priority !== t.priority) {
      set.priority = b.priority;
      ev.push({ _id: new ObjectId(), ...base, kind: 'priority', from: t.priority, to: b.priority });
    }
    if (b.category && b.category !== t.category) set.category = b.category;
    if (b.assigneeId !== undefined && String(b.assigneeId) !== String(t.assignee?.id ?? null)) {
      if (!ctx.permissions.has('tickets.assign')) throw forbidden('You cannot assign tickets');
      const next = b.assigneeId ? await this.assignee(ctx.tenantId!, b.assigneeId) : null;
      set.assignee = next;
      ev.push({
        _id: new ObjectId(),
        ...base,
        kind: 'assign',
        ...(t.assignee ? { from: t.assignee.name } : {}),
        ...(next ? { to: next.name } : {}),
      });
    }
    if (!ev.length && !set.category) return this.get(ctx, id);
    const r = await this.db
      .collection<TicketDoc>('tickets')
      .updateOne(
        { _id: t._id, version: t.version },
        { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}), $inc: { version: 1 } },
      );
    if (!r.matchedCount) throw conflict('The ticket changed meanwhile. Reload and try again.');
    if (ev.length) await this.events.insertMany(ev);
    noteChange({
      before: {
        status: t.status,
        priority: t.priority,
        category: t.category,
        assignee: t.assignee?.name ?? null,
      },
      after: {
        status: set.status ?? t.status,
        priority: set.priority ?? t.priority,
        category: set.category ?? t.category,
        assignee: set.assignee === undefined ? (t.assignee?.name ?? null) : (set.assignee?.name ?? null),
      },
      entityId: t._id,
    });
    return this.get(ctx, id);
  }

  // ---- portal (ctx.subscriberId is the signed-in customer) ----

  private async own(ctx: AuthContext, id: ObjectId) {
    const t = await this.db
      .collection<TicketDoc>('tickets')
      .findOne({ _id: id, tenantId: ctx.tenantId!, subscriberId: ctx.subscriberId! });
    if (!t) throw notFound('Ticket');
    return t;
  }

  async portalList(ctx: AuthContext, q: z.output<typeof portalListQuery>) {
    const f: Filter<TicketDoc> = { tenantId: ctx.tenantId!, subscriberId: ctx.subscriberId! };
    const k = keyset(q.cursor);
    if (k) f.$or = [{ lastActivityAt: { $lt: k.at } }, { lastActivityAt: k.at, _id: { $lt: k.id } }];
    const docs = await this.db
      .collection<TicketDoc>('tickets')
      .find(f, { sort: { lastActivityAt: -1, _id: -1 }, limit: q.limit + 1 })
      .toArray();
    return { items: await this.views(docs.slice(0, q.limit)), nextCursor: nextCursorOf(docs, q.limit) };
  }

  async portalGet(ctx: AuthContext, id: ObjectId) {
    return this.detail(await this.own(ctx, id), true);
  }

  async portalCreate(ctx: AuthContext, b: z.output<typeof portalCreateBody>) {
    const hit = await this.limiter.hit(`portal:tickets:${ctx.subscriberId!.toHexString()}`, 3600);
    if (hit.count > PORTAL_TICKETS_PER_HOUR) throw tooMany(hit.retryAfterSecs);
    const s = await this.db
      .collection<SubscriberDoc>('subscribers')
      .findOne({ _id: ctx.subscriberId!, tenantId: ctx.tenantId!, status: { $ne: 'deleted' } });
    if (!s) throw notFound('Account');
    return this.open(
      ctx,
      s,
      { ...b, priority: b.category === 'no_internet' ? 'high' : 'normal' },
      'portal',
      null,
    );
  }

  /** Customer reply; a resolved or waiting ticket goes back to open. Closed tickets stay closed. */
  async portalReply(ctx: AuthContext, id: ObjectId, body: string) {
    const t = await this.own(ctx, id);
    if (t.status === 'closed') throw conflict('This ticket is closed. Open a new one.');
    await this.addEvent(ctx, t, 'message', body, t.status === 'in_progress' ? undefined : 'open');
    return this.portalGet(ctx, id);
  }

  async portalClose(ctx: AuthContext, id: ObjectId) {
    const t = await this.own(ctx, id);
    if (t.status !== 'closed') {
      await this.addEvent(ctx, t, 'message', 'Closed by the customer.', 'closed');
    }
    return this.portalGet(ctx, id);
  }
}

@Controller('tickets')
export class TicketsController {
  constructor(@Inject(TicketsService) private readonly s: TicketsService) {}

  @Get()
  @Endpoint({
    summary: 'Tickets, most recently active first (a reseller sees its branch)',
    tags: ['tickets'],
    permission: 'tickets.read',
    query: listQuery,
    response: listView,
  })
  list(@Ctx() ctx: AuthContext, @Query() q: z.output<typeof listQuery>) {
    return this.s.list(ctx, q);
  }

  @Get('counts')
  @Endpoint({
    summary: 'Ticket counts by status, plus active ones assigned to me / unassigned',
    tags: ['tickets'],
    permission: 'tickets.read',
    response: countsView,
  })
  counts(@Ctx() ctx: AuthContext) {
    return this.s.counts(ctx);
  }

  @Get('assignees')
  @Endpoint({
    summary: 'Staff who can be assigned tickets',
    tags: ['tickets'],
    permission: 'tickets.assign',
    response: assigneeView,
  })
  assignees(@Ctx() ctx: AuthContext) {
    return this.s.assignees(ctx);
  }

  @Post()
  @Endpoint({
    summary: 'Open a ticket (for a customer, or an internal one without a customer: ISP staff only)',
    tags: ['tickets'],
    permission: 'tickets.write',
    audit: 'ticket.create',
    body: createBody,
    response: detailView,
  })
  create(@Ctx() ctx: AuthContext, @Body() b: z.output<typeof createBody>) {
    return this.s.create(ctx, b);
  }

  @Get(':id')
  @Endpoint({
    summary: 'One ticket with its timeline (incl. internal notes)',
    tags: ['tickets'],
    permission: 'tickets.read',
    params: idParams,
    response: detailView,
  })
  get(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }) {
    return this.s.get(ctx, p.id);
  }

  @Post(':id/reply')
  @HttpCode(200)
  @Endpoint({
    summary: 'Reply to the customer or add an internal note; optionally change the status',
    tags: ['tickets'],
    permission: 'tickets.write',
    audit: 'ticket.reply',
    params: idParams,
    body: replyBody,
    response: detailView,
  })
  reply(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }, @Body() b: z.output<typeof replyBody>) {
    return this.s.reply(ctx, p.id, b);
  }

  @Patch(':id')
  @Endpoint({
    summary: 'Status, priority, category or assignee (assigning needs tickets.assign)',
    tags: ['tickets'],
    permission: 'tickets.write',
    audit: 'ticket.update',
    params: idParams,
    body: updateBody,
    response: detailView,
  })
  update(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }, @Body() b: z.output<typeof updateBody>) {
    return this.s.update(ctx, p.id, b);
  }
}

@Controller('portal/tickets')
export class PortalTicketsController {
  constructor(@Inject(TicketsService) private readonly s: TicketsService) {}

  @Get()
  @Endpoint({
    summary: 'Own tickets, most recently active first',
    tags: ['portal'],
    auth: 'portal',
    query: portalListQuery,
    response: listView,
  })
  list(@Ctx() ctx: AuthContext, @Query() q: z.output<typeof portalListQuery>) {
    return this.s.portalList(ctx, q);
  }

  @Post()
  @Endpoint({
    summary: 'Raise a ticket (5 per hour)',
    tags: ['portal'],
    auth: 'portal',
    audit: 'ticket.create',
    body: portalCreateBody,
    response: detailView,
  })
  create(@Ctx() ctx: AuthContext, @Body() b: z.output<typeof portalCreateBody>) {
    return this.s.portalCreate(ctx, b);
  }

  @Get(':id')
  @Endpoint({
    summary: 'Own ticket with replies (no internal notes)',
    tags: ['portal'],
    auth: 'portal',
    params: idParams,
    response: detailView,
  })
  get(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }) {
    return this.s.portalGet(ctx, p.id);
  }

  @Post(':id/reply')
  @HttpCode(200)
  @Endpoint({
    summary: 'Reply to own ticket (reopens a resolved one)',
    tags: ['portal'],
    auth: 'portal',
    audit: 'ticket.reply',
    params: idParams,
    body: portalReplyBody,
    response: detailView,
  })
  reply(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }, @Body() b: z.output<typeof portalReplyBody>) {
    return this.s.portalReply(ctx, p.id, b.body);
  }

  @Post(':id/close')
  @HttpCode(200)
  @Endpoint({
    summary: 'Close own ticket',
    tags: ['portal'],
    auth: 'portal',
    audit: 'ticket.close',
    params: idParams,
    response: detailView,
  })
  close(@Ctx() ctx: AuthContext, @Param() p: { id: ObjectId }) {
    return this.s.portalClose(ctx, p.id);
  }
}
