import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { MoneyError, ScopeViolation } from '@isp/db-mongo';
import { AppError, type ErrorCode } from '../errors.js';

const BY_STATUS: Record<number, ErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'TOO_MANY_ATTEMPTS',
};

/** TRD §7 error format: { error: { code, message, details?, requestId } }. Internals never leak. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(err: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    let status = 500;
    let code: ErrorCode = 'INTERNAL';
    let message = 'Something went wrong. Quote the request id if you report it.';
    let details: Record<string, unknown> | undefined;

    if (err instanceof AppError) {
      ({ status, code, message, details } = err);
      for (const [k, v] of Object.entries(err.headers ?? {})) reply.header(k, v);
    } else if (err instanceof MoneyError) {
      status = err.status;
      code = err.code;
      message = err.message;
    } else if (err instanceof ScopeViolation) {
      req.log.error({ err }, 'scope violation');
      status = 403;
      code = 'FORBIDDEN';
      message = 'You do not have permission for this action';
    } else if (err instanceof HttpException) {
      status = err.getStatus();
      code = BY_STATUS[status] ?? (status >= 500 ? 'INTERNAL' : 'VALIDATION_FAILED');
      message = status >= 500 ? message : err.message;
    } else if (isFastifyClientError(err)) {
      status = err.statusCode;
      code = BY_STATUS[status] ?? 'VALIDATION_FAILED';
      message = err.message;
    } else if ((err as { code?: number }).code === 11000) {
      status = 409;
      code = 'CONFLICT';
      message = 'A record with the same unique value already exists';
      details = { keyValue: Object.keys((err as { keyValue?: object }).keyValue ?? {}) };
    }

    if (status >= 500) req.log.error({ err }, 'request failed');
    void reply
      .status(status)
      .header('cache-control', 'no-store')
      .header('content-disposition', 'inline')
      .type('application/json; charset=utf-8')
      .send({ error: { code, message, ...(details ? { details } : {}), requestId: req.id } });
  }
}

function isFastifyClientError(e: unknown): e is { statusCode: number; message: string } {
  const s = (e as { statusCode?: unknown }).statusCode;
  return typeof s === 'number' && s >= 400 && s < 500;
}
