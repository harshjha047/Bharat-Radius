import { SetMetadata, applyDecorators, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import type { Permission } from '@isp/shared';
import type { AuthContext } from '../auth/context.js';

/**
 * public  — no session (login, refresh, health)
 * enroll  — session that still has to enrol 2FA may call it
 * session — full session (default)
 */
export type AuthMode = 'public' | 'enroll' | 'session';

export interface EndpointOptions {
  summary: string;
  tags: string[];
  auth?: AuthMode;
  permission?: Permission;
  /** Origin + CSRF checks for unsafe methods. Off only for server-to-server routes (webhooks). */
  csrf?: boolean;
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
  response?: ZodType;
}

export const ENDPOINT = 'isp:endpoint';

export interface RegisteredEndpoint {
  controller: object;
  handler: object;
  opts: EndpointOptions;
}

/** Every @Endpoint in the process, for the OpenAPI document and the cross-tenant test harness. */
export const ENDPOINTS: RegisteredEndpoint[] = [];

export function Endpoint(opts: EndpointOptions): MethodDecorator {
  const meta = SetMetadata(ENDPOINT, opts);
  return applyDecorators((target: object, key: string | symbol, desc: PropertyDescriptor) => {
    ENDPOINTS.push({ controller: target.constructor, handler: desc.value as object, opts });
    meta(target, key, desc);
  });
}

declare module 'fastify' {
  interface FastifyRequest {
    ctx?: AuthContext;
  }
}

/** The authenticated caller; only on routes that are not `auth: 'public'`. */
export const Ctx = createParamDecorator((_: unknown, ec: ExecutionContext): AuthContext => {
  const ctx = ec.switchToHttp().getRequest<FastifyRequest>().ctx;
  if (!ctx) throw new Error('Ctx used on a route without authentication');
  return ctx;
});
