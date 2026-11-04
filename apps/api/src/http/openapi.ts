import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { z, type ZodType } from 'zod';
import { ENDPOINTS, type EndpointOptions } from './endpoint.js';

export interface RouteInfo {
  method: string;
  path: string;
  opts: EndpointOptions;
}

const join = (...parts: (string | string[] | undefined)[]) =>
  '/' +
  parts
    .map((p) => (Array.isArray(p) ? p[0] : p) ?? '')
    .flatMap((p) => p.split('/'))
    .filter(Boolean)
    .join('/');

/** Every @Endpoint with its full path (Nest syntax, e.g. /api/v1/users/:id). */
export function listRoutes(prefix: string): RouteInfo[] {
  return ENDPOINTS.map(({ controller, handler, opts }) => {
    const m = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod;
    return {
      method: RequestMethod[m]!,
      path: join(
        prefix,
        Reflect.getMetadata(PATH_METADATA, controller),
        Reflect.getMetadata(PATH_METADATA, handler),
      ),
      opts,
    };
  });
}

const schema = (s: ZodType, io: 'input' | 'output') => z.toJSONSchema(s, { io, unrepresentable: 'any' });

const ERROR = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'requestId'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: { type: 'object' },
        requestId: { type: 'string' },
      },
    },
  },
};

export function buildOpenApi(prefix: string, version: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of listRoutes(prefix)) {
    const path = r.path.replace(/:(\w+)/g, '{$1}');
    const params: unknown[] = [];
    for (const [where, s] of [
      ['path', r.opts.params],
      ['query', r.opts.query],
    ] as const) {
      if (!s) continue;
      const js = schema(s, 'input') as { properties?: Record<string, unknown>; required?: string[] };
      for (const [name, sch] of Object.entries(js.properties ?? {})) {
        params.push({
          name,
          in: where,
          required: where === 'path' || !!js.required?.includes(name),
          schema: sch,
        });
      }
    }
    const security = r.opts.auth === 'public' ? [] : [{ session: [] }];
    (paths[path] ??= {})[r.method.toLowerCase()] = {
      summary: r.opts.summary,
      tags: r.opts.tags,
      security,
      ...(r.opts.permission ? { 'x-permission': r.opts.permission } : {}),
      ...(params.length ? { parameters: params } : {}),
      ...(r.opts.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: schema(r.opts.body, 'input') } },
            },
          }
        : {}),
      responses: {
        '200': {
          description: 'OK',
          ...(r.opts.response
            ? { content: { 'application/json': { schema: schema(r.opts.response, 'output') } } }
            : {}),
        },
        default: { description: 'Error', content: { 'application/json': { schema: ERROR } } },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'ISP platform API', version },
    components: {
      securitySchemes: {
        session: {
          type: 'apiKey',
          in: 'cookie',
          name: 'isp_at',
          description: 'Plus X-CSRF-Token on unsafe methods',
        },
      },
    },
    paths,
  };
}
