import type { LoggerService } from '@nestjs/common';
import { pino, type Logger } from 'pino';
import type { Config } from './config.js';

/** JSON to stdout (Docker/journald collect it). Secrets and cookies are redacted at the source. */
export function createLogger(config: Pick<Config, 'LOG_LEVEL' | 'APP_VERSION'>): Logger {
  return pino({
    level: config.LOG_LEVEL,
    base: { svc: 'isp-api', ver: config.APP_VERSION },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'req.headers["x-csrf-token"]',
        'res.headers["set-cookie"]',
        '*.password',
        '*.passwordHash',
        '*.secret',
        '*.token',
      ],
      censor: '[redacted]',
    },
  });
}

export class NestPinoLogger implements LoggerService {
  constructor(private readonly pino: Logger) {}
  private ctx(optional: unknown[]) {
    const c = optional.at(-1);
    return typeof c === 'string' ? { ctx: c } : {};
  }
  log(msg: unknown, ...o: unknown[]) {
    this.pino.info(this.ctx(o), String(msg));
  }
  error(msg: unknown, ...o: unknown[]) {
    this.pino.error(
      { ...this.ctx(o), ...(typeof o[0] === 'string' && o.length > 1 ? { stack: o[0] } : {}) },
      String(msg),
    );
  }
  warn(msg: unknown, ...o: unknown[]) {
    this.pino.warn(this.ctx(o), typeof msg === 'object' ? JSON.stringify(msg) : String(msg));
  }
  debug(msg: unknown, ...o: unknown[]) {
    this.pino.debug(this.ctx(o), String(msg));
  }
  verbose(msg: unknown, ...o: unknown[]) {
    this.pino.trace(this.ctx(o), String(msg));
  }
  fatal(msg: unknown, ...o: unknown[]) {
    this.pino.fatal(this.ctx(o), String(msg));
  }
}
