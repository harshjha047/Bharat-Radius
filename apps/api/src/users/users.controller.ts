import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import type { ObjectId } from 'mongodb';
import { z } from 'zod';
import { PERMISSIONS } from '@isp/shared';
import type { AuthContext } from '../auth/context.js';
import { passwordSchema } from '../auth/passwords.js';
import { Ctx, Endpoint } from '../http/endpoint.js';
import { email, idParams, objectId, okResponse, page, pageQuery, phone } from '../http/schemas.js';
import { UsersService } from './users.service.js';
import { roleView, toUserView, userView } from './views.js';

const name = z.string().trim().min(1).max(120);
const listQuery = pageQuery.extend({
  q: z.string().trim().min(1).max(60).optional(),
  status: z.enum(['active', 'locked', 'disabled']).optional(),
});
const createBody = z.object({
  tenantId: objectId.optional(),
  name,
  email: email.optional(),
  phone: phone.optional(),
  password: passwordSchema,
  roleIds: z.array(objectId).max(10).default([]),
});
const updateBody = z
  .object({
    name: name.optional(),
    email: email.nullable().optional(),
    phone: phone.nullable().optional(),
    roleIds: z.array(objectId).max(10).optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'nothing to change');
const roleBody = z.object({
  tenantId: objectId.optional(),
  name: z.string().trim().min(1).max(60),
  scope: z.enum(['tenant', 'reseller']),
  permissions: z.array(z.enum(PERMISSIONS)).min(1),
  requireMfa: z.boolean().default(false),
});
// Explicit, not roleBody.partial(): zod 4 applies .default() inside .partial(), which would reset requireMfa.
const roleUpdate = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    permissions: z.array(z.enum(PERMISSIONS)).min(1).optional(),
    requireMfa: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'nothing to change');

type Id = { id: ObjectId };

@Controller('users')
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Get()
  @Endpoint({
    summary: 'List staff accounts',
    tags: ['users'],
    permission: 'users.read',
    query: listQuery,
    response: page(userView),
  })
  list(@Ctx() ctx: AuthContext, @Query() q: z.output<typeof listQuery>) {
    return this.users.list(ctx, q);
  }

  @Post()
  @Endpoint({
    summary: 'Create a staff account',
    tags: ['users'],
    audit: 'user.create',
    permission: 'users.write',
    body: createBody,
    response: userView,
  })
  create(@Ctx() ctx: AuthContext, @Body() body: z.output<typeof createBody>) {
    return this.users.create(ctx, body);
  }

  @Get(':id')
  @Endpoint({
    summary: 'Get a staff account',
    tags: ['users'],
    permission: 'users.read',
    params: idParams,
    response: userView,
  })
  async get(@Ctx() ctx: AuthContext, @Param() p: Id) {
    return toUserView(await this.users.get(ctx, p.id));
  }

  @Patch(':id')
  @Endpoint({
    summary: 'Edit a staff account (disabling or changing roles signs it out)',
    tags: ['users'],
    audit: 'user.update',
    permission: 'users.write',
    params: idParams,
    body: updateBody,
    response: userView,
  })
  update(@Ctx() ctx: AuthContext, @Param() p: Id, @Body() body: z.output<typeof updateBody>) {
    return this.users.update(ctx, p.id, body);
  }

  @Post(':id/unlock')
  @HttpCode(200)
  @Endpoint({
    summary: 'Clear a sign-in lock',
    tags: ['users'],
    audit: 'user.unlock',
    permission: 'users.write',
    params: idParams,
    response: userView,
  })
  unlock(@Ctx() ctx: AuthContext, @Param() p: Id) {
    return this.users.unlock(ctx, p.id);
  }

  @Post(':id/password')
  @HttpCode(200)
  @Endpoint({
    summary: 'Set a new password for a staff account (signs it out)',
    tags: ['users'],
    audit: 'user.password_reset',
    permission: 'users.write',
    params: idParams,
    body: z.object({ password: passwordSchema }),
    response: userView,
  })
  resetPassword(@Ctx() ctx: AuthContext, @Param() p: Id, @Body() body: { password: string }) {
    return this.users.resetPassword(ctx, p.id, body.password);
  }

  @Post(':id/reset-2fa')
  @HttpCode(200)
  @Endpoint({
    summary: 'Remove two-factor sign-in (lost phone)',
    tags: ['users'],
    audit: 'user.2fa_reset',
    permission: 'users.write',
    params: idParams,
    response: userView,
  })
  reset2fa(@Ctx() ctx: AuthContext, @Param() p: Id) {
    return this.users.reset2fa(ctx, p.id);
  }
}

@Controller('roles')
export class RolesController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Get()
  @Endpoint({
    summary: 'Built-in and custom roles',
    tags: ['roles'],
    permission: 'users.read',
    response: z.array(roleView),
  })
  list(@Ctx() ctx: AuthContext) {
    return this.users.listRoles(ctx);
  }

  @Post()
  @Endpoint({
    summary: 'Create a custom role',
    tags: ['roles'],
    audit: 'role.create',
    permission: 'roles.write',
    body: roleBody,
    response: roleView,
  })
  create(@Ctx() ctx: AuthContext, @Body() body: z.output<typeof roleBody>) {
    return this.users.createRole(ctx, body);
  }

  @Patch(':id')
  @Endpoint({
    summary: 'Edit a custom role',
    tags: ['roles'],
    audit: 'role.update',
    permission: 'roles.write',
    params: idParams,
    body: roleUpdate,
    response: roleView,
  })
  update(@Ctx() ctx: AuthContext, @Param() p: Id, @Body() body: z.output<typeof roleUpdate>) {
    return this.users.updateRole(ctx, p.id, body);
  }

  @Delete(':id')
  @Endpoint({
    summary: 'Delete an unused custom role',
    tags: ['roles'],
    audit: 'role.delete',
    permission: 'roles.write',
    params: idParams,
    response: okResponse,
  })
  async remove(@Ctx() ctx: AuthContext, @Param() p: Id) {
    await this.users.deleteRole(ctx, p.id);
    return { ok: true as const };
  }
}
