import { Inject, Injectable } from '@nestjs/common';
import { ObjectId, type Filter } from 'mongodb';
import { RESELLER_PERMISSIONS, isPermission, type Permission } from '@isp/shared';
import { ScopedDb, type MongoHandle, type ResellerDoc, type RoleDoc, type UserDoc } from '@isp/db-mongo';
import { AuthService } from '../auth/auth.service.js';
import { noteChange } from '../audit/audit.js';
import type { AuthContext } from '../auth/context.js';
import { hashPassword } from '../auth/passwords.js';
import { SessionUsers } from '../auth/session-users.js';
import { AppError, conflict, forbidden, notFound } from '../errors.js';
import { pageOf } from '../http/schemas.js';
import { MONGO } from '../infra/infra.module.js';
import { toRoleView, toUserView } from './views.js';

export interface UserListQuery {
  q?: string | undefined;
  status?: UserDoc['status'] | undefined;
  resellerId?: string | undefined;
  cursor?: string | undefined;
  limit: number;
}

export interface CreateUserInput {
  tenantId?: ObjectId | undefined;
  name: string;
  email?: string | undefined;
  phone?: string | undefined;
  password: string;
  roleIds: ObjectId[];
  /** A reseller sign-in (reseller roles only). */
  resellerId?: ObjectId | undefined;
}

export interface UpdateUserInput {
  name?: string | undefined;
  email?: string | null | undefined;
  phone?: string | null | undefined;
  roleIds?: ObjectId[] | undefined;
  status?: 'active' | 'disabled' | undefined;
}

export interface RoleInput {
  name: string;
  scope: 'tenant' | 'reseller';
  permissions: Permission[];
  requireMfa: boolean;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

@Injectable()
export class UsersService {
  constructor(
    @Inject(MONGO) private readonly mongo: MongoHandle,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SessionUsers) private readonly sessions: SessionUsers,
  ) {}

  private db(ctx: AuthContext) {
    return new ScopedDb(this.mongo.db, ctx.scope);
  }

  /** Prevents privilege escalation: an actor may only grant permissions it holds itself. */
  private assertCanGrant(ctx: AuthContext, permissions: Iterable<string>): void {
    if (ctx.type === 'superadmin') return;
    for (const p of permissions) {
      if (!isPermission(p) || !ctx.permissions.has(p)) throw forbidden(`You cannot grant a role with "${p}"`);
    }
  }

  private async loadRoles(
    ctx: AuthContext,
    ids: ObjectId[],
    tenantId: ObjectId,
    scope: 'tenant' | 'reseller' = 'tenant',
  ): Promise<RoleDoc[]> {
    if (!ids.length) return [];
    const roles = await this.db(ctx)
      .collection<RoleDoc>('roles')
      .find({ _id: { $in: ids }, tenantId: { $in: [tenantId, null] } })
      .toArray();
    if (roles.length !== new Set(ids.map(String)).size)
      throw new AppError(400, 'VALIDATION_FAILED', 'Unknown role');
    if (roles.some((r) => r.scope !== scope)) {
      throw new AppError(
        400,
        'VALIDATION_FAILED',
        scope === 'tenant'
          ? 'Reseller roles can only be given to reseller users'
          : 'A reseller sign-in can only have reseller roles',
      );
    }
    return roles;
  }

  async list(ctx: AuthContext, q: UserListQuery) {
    const filter: Filter<UserDoc> = { type: { $in: ['staff', 'reseller', 'superadmin'] } };
    if (q.status) filter.status = q.status;
    if (q.resellerId) filter.resellerId = new ObjectId(q.resellerId);
    else if (ctx.scope.kind !== 'branch') filter.type = { $in: ['staff', 'superadmin'] };
    if (q.cursor) filter._id = { $lt: new ObjectId(q.cursor) };
    if (q.q) {
      const re = new RegExp(`^${escapeRegex(q.q.trim())}`, 'i');
      filter.$or = [{ name: re }, { email: re }, { phone: re }];
    }
    const docs = await this.db(ctx)
      .collection<UserDoc>('users')
      .find(filter, { sort: { _id: -1 }, limit: q.limit + 1 })
      .toArray();
    return pageOf(docs, q.limit, toUserView);
  }

  async get(ctx: AuthContext, id: ObjectId) {
    const u = await this.db(ctx)
      .collection<UserDoc>('users')
      .findOne({ _id: id, type: { $ne: 'customer' } });
    if (!u) throw notFound('User');
    return u;
  }

  async create(ctx: AuthContext, input: CreateUserInput) {
    const tenantId = ctx.type === 'superadmin' ? input.tenantId : ctx.tenantId;
    if (!tenantId) throw new AppError(400, 'VALIDATION_FAILED', 'tenantId is required');
    if (!input.email && !input.phone)
      throw new AppError(400, 'VALIDATION_FAILED', 'Give an email or a phone number');
    const self = ctx.scope.kind === 'branch' ? ctx.scope.resellerId : null;
    const resellerId = input.resellerId ?? self ?? undefined;
    if (resellerId) {
      const r = await this.db(ctx)
        .collection<ResellerDoc>('resellers')
        .findOne({ _id: resellerId, status: { $ne: 'deleted' } });
      if (!r) throw notFound('Reseller');
      if (self && !r._id.equals(self) && !r.parentId?.equals(self)) {
        throw forbidden('You can add sign-ins for yourself and resellers directly below you');
      }
    }
    const roles = await this.loadRoles(ctx, input.roleIds, tenantId, resellerId ? 'reseller' : 'tenant');
    if (resellerId && !roles.length)
      throw new AppError(400, 'VALIDATION_FAILED', 'Give the sign-in a reseller role');
    this.assertCanGrant(
      ctx,
      roles.flatMap((r) => r.permissions),
    );

    const now = new Date();
    const actor = ctx.userId.toHexString();
    const doc: UserDoc = {
      _id: new ObjectId(),
      tenantId,
      type: resellerId ? 'reseller' : 'staff',
      ...(resellerId ? { resellerId } : {}),
      name: input.name,
      ...(input.email ? { email: input.email } : {}),
      ...(input.phone ? { phone: input.phone } : {}),
      passwordHash: await hashPassword(input.password),
      roleIds: roles.map((r) => r._id),
      status: 'active',
      failedLogins: 0,
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
      createdBy: actor,
      updatedBy: actor,
    };
    // A parent reseller adding a sign-in for a direct child writes outside its own user scope (checked above).
    if (self && resellerId && !resellerId.equals(self))
      await this.mongo.db.collection<UserDoc>('users').insertOne(doc);
    else await this.db(ctx).collection<UserDoc>('users').insertOne(doc);
    noteChange({ after: toUserView(doc), entityId: doc._id });
    return toUserView(doc);
  }

  async update(ctx: AuthContext, id: ObjectId, input: UpdateUserInput) {
    const target = await this.get(ctx, id);
    const self = target._id.equals(ctx.userId);
    if (self && (input.roleIds || input.status))
      throw forbidden('You cannot change your own roles or status');
    await this.assertNotMorePowerful(ctx, target);

    const set: Partial<UserDoc> = { updatedAt: new Date(), updatedBy: ctx.userId.toHexString() };
    const unset: Record<string, ''> = {};
    if (input.name !== undefined) set.name = input.name;
    for (const f of ['email', 'phone'] as const) {
      if (input[f] === null) unset[f] = '';
      else if (input[f] !== undefined) set[f] = input[f];
    }
    if (input.email === null && input.phone === null) {
      throw new AppError(400, 'VALIDATION_FAILED', 'Keep an email or a phone number');
    }
    if (input.roleIds) {
      const roles = await this.loadRoles(
        ctx,
        input.roleIds,
        target.tenantId!,
        target.type === 'reseller' ? 'reseller' : 'tenant',
      );
      this.assertCanGrant(
        ctx,
        roles.flatMap((r) => r.permissions),
      );
      set.roleIds = roles.map((r) => r._id);
    }
    if (input.status) set.status = input.status;

    const updated = await this.db(ctx)
      .collection<UserDoc>('users')
      .findOneAndUpdate(
        { _id: id },
        { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
        { returnDocument: 'after' },
      );
    if (!updated) throw notFound('User');
    noteChange({ before: target, after: updated, entityId: id });
    if (input.status === 'disabled' || input.roleIds) await this.auth.revokeAll(id, 'admin');
    this.sessions.invalidate(id);
    return toUserView(updated);
  }

  /** Staff cannot manage an account that holds permissions they lack (e.g. support resetting an admin). */
  private async assertNotMorePowerful(ctx: AuthContext, target: UserDoc): Promise<void> {
    if (ctx.type === 'superadmin') return;
    if (target.type === 'superadmin') throw notFound('User');
    const su = await this.sessions.resolve(target._id);
    this.assertCanGrant(ctx, su?.permissions ?? []);
  }

  async unlock(ctx: AuthContext, id: ObjectId) {
    const target = await this.get(ctx, id);
    await this.assertNotMorePowerful(ctx, target);
    await this.db(ctx)
      .collection<UserDoc>('users')
      .updateOne(
        { _id: id },
        { $set: { failedLogins: 0, updatedAt: new Date() }, $unset: { lockedUntil: '' } },
      );
    return toUserView(await this.get(ctx, id));
  }

  async resetPassword(ctx: AuthContext, id: ObjectId, password: string) {
    const target = await this.get(ctx, id);
    if (target._id.equals(ctx.userId)) throw forbidden('Use "change password" for your own account');
    await this.assertNotMorePowerful(ctx, target);
    await this.db(ctx)
      .collection<UserDoc>('users')
      .updateOne(
        { _id: id },
        {
          $set: {
            passwordHash: await hashPassword(password),
            passwordChangedAt: new Date(),
            updatedAt: new Date(),
          },
        },
      );
    await this.auth.revokeAll(id, 'admin');
    return toUserView(await this.get(ctx, id));
  }

  async reset2fa(ctx: AuthContext, id: ObjectId) {
    const target = await this.get(ctx, id);
    if (target._id.equals(ctx.userId))
      throw forbidden('Ask another administrator to reset your two-factor sign-in');
    await this.assertNotMorePowerful(ctx, target);
    await this.db(ctx)
      .collection<UserDoc>('users')
      .updateOne({ _id: id }, { $unset: { totp: '' }, $set: { updatedAt: new Date() } });
    await this.auth.revokeAll(id, 'admin');
    return toUserView(await this.get(ctx, id));
  }

  async listRoles(ctx: AuthContext) {
    const roles = await this.db(ctx)
      .collection<RoleDoc>('roles')
      .find({}, { sort: { builtIn: -1, name: 1 } })
      .toArray();
    return roles.map(toRoleView);
  }

  async getRole(ctx: AuthContext, id: ObjectId) {
    const r = await this.db(ctx).collection<RoleDoc>('roles').findOne({ _id: id });
    if (!r) throw notFound('Role');
    return r;
  }

  private checkRoleInput(ctx: AuthContext, input: RoleInput) {
    if (input.scope === 'reseller') {
      const bad = input.permissions.find((p) => !RESELLER_PERMISSIONS.includes(p));
      if (bad) throw new AppError(400, 'VALIDATION_FAILED', `"${bad}" cannot be given to reseller roles`);
    }
    this.assertCanGrant(ctx, input.permissions);
  }

  async createRole(ctx: AuthContext, input: RoleInput & { tenantId?: ObjectId | undefined }) {
    const tenantId = ctx.type === 'superadmin' ? input.tenantId : ctx.tenantId;
    if (!tenantId) throw new AppError(400, 'VALIDATION_FAILED', 'tenantId is required');
    this.checkRoleInput(ctx, input);
    const now = new Date();
    const doc: RoleDoc = {
      _id: new ObjectId(),
      tenantId,
      name: input.name,
      scope: input.scope,
      permissions: [...new Set(input.permissions)],
      requireMfa: input.requireMfa,
      builtIn: false,
      createdAt: now,
      updatedAt: now,
    };
    await this.db(ctx).collection<RoleDoc>('roles').insertOne(doc);
    return toRoleView(doc);
  }

  async updateRole(
    ctx: AuthContext,
    id: ObjectId,
    input: { [K in keyof RoleInput]?: RoleInput[K] | undefined },
  ) {
    const role = await this.getRole(ctx, id);
    if (role.builtIn) throw forbidden('Built-in roles cannot be changed');
    this.assertCanGrant(ctx, role.permissions);
    const merged: RoleInput = {
      name: input.name ?? role.name,
      scope: role.scope,
      permissions: input.permissions ?? (role.permissions as Permission[]),
      requireMfa: input.requireMfa ?? role.requireMfa,
    };
    this.checkRoleInput(ctx, merged);
    const updated = await this.db(ctx)
      .collection<RoleDoc>('roles')
      .findOneAndUpdate(
        { _id: id, builtIn: false },
        {
          $set: {
            name: merged.name,
            permissions: [...new Set(merged.permissions)],
            requireMfa: merged.requireMfa,
            updatedAt: new Date(),
          },
        },
        { returnDocument: 'after' },
      );
    if (!updated) throw notFound('Role');
    noteChange({ before: role, after: updated, entityId: id });
    const holders = await this.db(ctx)
      .collection<UserDoc>('users')
      .find({ roleIds: id }, { projection: { _id: 1 } })
      .toArray();
    for (const h of holders) this.sessions.invalidate(h._id);
    return toRoleView(updated);
  }

  async deleteRole(ctx: AuthContext, id: ObjectId) {
    const role = await this.getRole(ctx, id);
    if (role.builtIn) throw forbidden('Built-in roles cannot be deleted');
    const inUse = await this.db(ctx)
      .collection<UserDoc>('users')
      .countDocuments({ roleIds: id }, { limit: 1 });
    if (inUse) throw conflict('Role is still assigned to users');
    await this.db(ctx).collection<RoleDoc>('roles').deleteOne({ _id: id, builtIn: false });
    noteChange({ before: role, after: null, entityId: id });
  }
}
