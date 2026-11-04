import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { Observable } from 'rxjs';
import type { ZodType } from 'zod';
import { AppError } from '../errors.js';
import { ENDPOINT, type EndpointOptions } from './endpoint.js';

function parse(schema: ZodType, value: unknown, where: string): unknown {
  const r = schema.safeParse(value ?? {});
  if (r.success) return r.data;
  throw new AppError(400, 'VALIDATION_FAILED', 'Some fields are not valid', {
    issues: r.error.issues.map((i) => ({
      in: where,
      path: i.path.map(String).join('.'),
      message: i.message,
    })),
  });
}

/** Replaces body/query/params with their parsed (typed, coerced, stripped) values before the handler runs. */
@Injectable()
export class ValidationInterceptor implements NestInterceptor {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  intercept(ec: ExecutionContext, next: CallHandler): Observable<unknown> {
    const opts = this.reflector.get<EndpointOptions | undefined>(ENDPOINT, ec.getHandler());
    if (opts) {
      const req = ec.switchToHttp().getRequest<FastifyRequest>();
      if (opts.params) req.params = parse(opts.params, req.params, 'params');
      if (opts.query) req.query = parse(opts.query, req.query, 'query');
      if (opts.body) req.body = parse(opts.body, req.body, 'body');
    }
    return next.handle();
  }
}
