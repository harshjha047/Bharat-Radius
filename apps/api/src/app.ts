import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import fastifyCookie from '@fastify/cookie';
import { Controller, Get, Inject, Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Logger as PinoLogger } from 'pino';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthService } from './auth/auth.service.js';
import { Cookies } from './auth/cookies.js';
import { RateLimiter } from './auth/rate-limit.js';
import { SessionUsers } from './auth/session-users.js';
import { Tokens } from './auth/tokens.js';
import { CONFIG, type Config } from './config.js';
import { unauthenticated } from './errors.js';
import { HealthController } from './health/health.controller.js';
import { ErrorFilter } from './http/error.filter.js';
import { buildOpenApi } from './http/openapi.js';
import { ValidationInterceptor } from './http/validation.interceptor.js';
import { InfraModule } from './infra/infra.module.js';
import { createLogger, NestPinoLogger } from './logger.js';
import { NasController, NasService } from './network/nas.js';
import { PlansController, PlansService } from './network/plans.js';
import { TenantsController, TenantsService } from './network/tenants.js';
import { SessionsController, SessionsService } from './sessions/sessions.js';
import { SubscribersController, SubscribersService } from './subscribers/subscribers.js';
import { Outbox } from './sync/outbox.js';
import { RolesController, UsersController } from './users/users.controller.js';
import { UsersService } from './users/users.service.js';

export const API_PREFIX = 'api/v1';
const REQUEST_ID = /^[\w.-]{8,64}$/;

@Controller()
class OpenApiController {
  private doc?: ReturnType<typeof buildOpenApi>;
  constructor(@Inject(CONFIG) private readonly config: Config) {}

  @Get('openapi.json')
  get() {
    if (!this.config.OPENAPI_PUBLIC) throw unauthenticated();
    return (this.doc ??= buildOpenApi(API_PREFIX, this.config.APP_VERSION));
  }
}

@Module({})
class AppModule {
  static forRoot(config: Config): DynamicModule {
    return {
      module: AppModule,
      imports: [InfraModule.forRoot(config)],
      controllers: [
        HealthController,
        OpenApiController,
        AuthController,
        UsersController,
        RolesController,
        TenantsController,
        NasController,
        PlansController,
        SubscribersController,
        SessionsController,
      ],
      providers: [
        Tokens,
        Cookies,
        RateLimiter,
        SessionUsers,
        AuthService,
        UsersService,
        Outbox,
        TenantsService,
        NasService,
        PlansService,
        SubscribersService,
        SessionsService,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_INTERCEPTOR, useClass: ValidationInterceptor },
        { provide: APP_FILTER, useClass: ErrorFilter },
      ],
    };
  }
}

export async function createApp(
  config: Config,
  logger: PinoLogger = createLogger(config),
): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    loggerInstance: logger,
    disableRequestLogging: true,
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
    requestIdHeader: false,
    genReqId: (req: IncomingMessage) => {
      const h = req.headers['x-request-id'];
      return typeof h === 'string' && REQUEST_ID.test(h) ? h : randomUUID();
    },
    routerOptions: { maxParamLength: 200 },
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule.forRoot(config), adapter, {
    logger: new NestPinoLogger(logger),
    bufferLogs: false,
  });
  await app.register(fastifyCookie);
  app.setGlobalPrefix(API_PREFIX, { exclude: ['healthz', 'api/healthz', 'livez'] });
  app.enableShutdownHooks();

  const f = app.getHttpAdapter().getInstance();
  // JSON only: form and text bodies are what cross-site "simple" requests can send without a CORS preflight.
  f.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    const hasBody =
      Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined;
    if (hasBody && !/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      return reply
        .status(415)
        .header('cache-control', 'no-store')
        .send({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Send JSON', requestId: req.id } });
    }
  });
  f.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-request-id', req.id);
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    return payload;
  });
  f.addHook('onResponse', async (req, reply) => {
    const level = reply.statusCode >= 500 ? 'error' : reply.statusCode >= 400 ? 'warn' : 'info';
    req.log[level](
      {
        method: req.method,
        url: req.url,
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
        ip: req.ip,
      },
      'request',
    );
  });
  await app.init();
  return app;
}
