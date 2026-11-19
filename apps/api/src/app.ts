import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import fastifyCookie from '@fastify/cookie';
import { Controller, Get, Inject, Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Logger as PinoLogger } from 'pino';
import { AccessLogController, AccessLogInterceptor } from './audit/access-log.js';
import { AuditController, AuditInterceptor, AuditService } from './audit/audit.js';
import { AuthController } from './auth/auth.controller.js';
import { PreferencesController } from './auth/preferences.js';
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
import { PLANS_IMPORT_PATH, PlanExcel, PlanExcelController } from './network/plans-excel.js';
import { PlansController, PlansService } from './network/plans.js';
import { ResellersController, ResellersService } from './resellers/resellers.js';
import { InvoicesController, InvoicesService } from './billing/invoices.js';
import { PaymentsController, PaymentsService, WebhooksService } from './billing/payments.js';
import { RechargesController, RechargesService } from './billing/recharges.js';
import { BillingSettingsController, BillingSettingsService } from './billing/settings.js';
import { TopupRequestsController, TopupRequestsService } from './billing/topup-requests.js';
import { KYC_UPLOAD_PATH, KycController, KycService, MAX_KYC_BYTES } from './documents/kyc.js';
import { BrandingController, BrandingService, LOGO_UPLOAD_PATH } from './resellers/branding.js';
import { WalletsController, WalletsService } from './billing/wallets.js';
import { TenantsController, TenantsService } from './network/tenants.js';
import { FinancialInsightsService } from './reports/insights.js';
import { ReportsController, ReportsService } from './reports/reports.js';
import { ComplianceController, ComplianceService } from './compliance/compliance.js';
import { RouterLiveController, RouterLiveService } from './network/router-live.js';
import { RadiusLogController, RadiusLogService } from './sessions/radius-log.js';
import { SessionsController, SessionsService } from './sessions/sessions.js';
import {
  IMPORT_PATH,
  MAX_IMPORT_BYTES,
  SubscriberExcel,
  SubscriberExcelController,
  XLSX_MIME,
} from './subscribers/excel.js';
import { PortalAuth } from './portal/portal-auth.js';
import { guardFlag, openDuringMaintenance } from './guard.js';
import { PayPageController, PayPageService } from './portal/pay-page.js';
import { PortalAdminController, PortalController, PortalService } from './portal/portal.js';
import { SubscribersController, SubscribersService } from './subscribers/subscribers.js';
import { Outbox } from './sync/outbox.js';
import { PortalTicketsController, TicketsController, TicketsService } from './tickets/tickets.js';
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
        PreferencesController,
        UsersController,
        RolesController,
        TenantsController,
        NasController,
        PlanExcelController,
        PlansController,
        ResellersController,
        WalletsController,
        TopupRequestsController,
        KycController,
        BrandingController,
        RechargesController,
        InvoicesController,
        PaymentsController,
        BillingSettingsController,
        SubscribersController,
        SessionsController,
        RadiusLogController,
        RouterLiveController,
        ComplianceController,
        AccessLogController,
        SubscriberExcelController,
        AuditController,
        PortalController,
        PayPageController,
        PortalAdminController,
        TicketsController,
        PortalTicketsController,
        ReportsController,
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
        PlanExcel,
        PlansService,
        ResellersService,
        WalletsService,
        TopupRequestsService,
        KycService,
        BrandingService,
        RechargesService,
        InvoicesService,
        PaymentsService,
        WebhooksService,
        BillingSettingsService,
        SubscribersService,
        SessionsService,
        RadiusLogService,
        RouterLiveService,
        ComplianceService,
        SubscriberExcel,
        AuditService,
        PortalAuth,
        PortalService,
        PayPageService,
        TicketsService,
        ReportsService,
        FinancialInsightsService,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_INTERCEPTOR, useClass: ValidationInterceptor },
        { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
        { provide: APP_INTERCEPTOR, useClass: AccessLogInterceptor },
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
    // Webhook signatures are computed over the exact bytes received.
    rawBody: true,
  });
  await app.register(fastifyCookie);
  app.setGlobalPrefix(API_PREFIX, { exclude: ['healthz', 'api/healthz', 'livez'] });
  app.enableShutdownHooks();

  const f = app.getHttpAdapter().getInstance();
  const XLSX_UPLOAD_PATHS = new Set([IMPORT_PATH, PLANS_IMPORT_PATH]);
  // Excel uploads arrive as the raw file. A custom media type always needs a CORS preflight, so it is CSRF-safe.
  f.addContentTypeParser(XLSX_MIME, { parseAs: 'buffer', bodyLimit: MAX_IMPORT_BYTES }, (_req, body, done) =>
    done(null, body),
  );
  // KYC files and logos arrive as the raw file; these media types also need a CORS preflight (CSRF-safe).
  const FILE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
  f.addContentTypeParser(FILE_MIME, { parseAs: 'buffer', bodyLimit: MAX_KYC_BYTES }, (_req, body, done) =>
    done(null, body),
  );
  // Disk guard maintenance (disk >= 85 %): staff, reseller and customer screens pause; RADIUS is not affected.
  f.addHook('onRequest', async (req, reply) => {
    if (!guardFlag('maintenance') || openDuringMaintenance(req.url.split('?')[0]!)) return;
    return reply
      .status(503)
      .header('retry-after', '300')
      .header('cache-control', 'no-store')
      .send({
        error: {
          code: 'MAINTENANCE',
          message: 'Scheduled maintenance. Please try again in a few minutes.',
          requestId: req.id,
        },
      });
  });
  // JSON only: form and text bodies are what cross-site "simple" requests can send without a CORS preflight.
  f.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    if (
      req.method === 'POST' &&
      XLSX_UPLOAD_PATHS.has(req.url.split('?')[0]!) &&
      req.headers['content-type'] === XLSX_MIME
    )
      return;
    const path = req.url.split('?')[0]!;
    if (
      (req.method === 'POST' && KYC_UPLOAD_PATH.test(path)) ||
      (req.method === 'PUT' && LOGO_UPLOAD_PATH.test(path))
    ) {
      if (FILE_MIME.includes((req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase())) return;
    }
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
