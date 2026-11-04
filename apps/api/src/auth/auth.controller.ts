import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { Ctx, Endpoint } from '../http/endpoint.js';
import { okResponse } from '../http/schemas.js';
import { toUserView, userView } from '../users/views.js';
import { AuthService, type ClientMeta } from './auth.service.js';
import type { AuthContext } from './context.js';
import { COOKIE, Cookies } from './cookies.js';
import { passwordSchema } from './passwords.js';
import { SessionUsers } from './session-users.js';
import { Tokens } from './tokens.js';

const loginBody = z.object({
  tenant: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,39}$/i)
    .optional(),
  login: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(256),
});
const code = z.object({ code: z.string().regex(/^\d{6}$/, 'must be 6 digits') });

const sessionView = z.object({
  status: z.enum(['ok', 'mfa_required', 'mfa_enroll_required']),
  csrfToken: z.string().optional(),
});

const meView = z.object({
  user: userView,
  permissions: z.array(z.string()),
  mfa: z.enum(['ok', 'enroll']),
  requireMfa: z.boolean(),
});

export const clientMeta = (req: FastifyRequest): ClientMeta => ({
  ip: req.ip,
  userAgent: req.headers['user-agent'],
  host: req.hostname,
});

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(Cookies) private readonly cookies: Cookies,
    @Inject(SessionUsers) private readonly sessions: SessionUsers,
    @Inject(Tokens) private readonly tokens: Tokens,
  ) {}

  @Post('login')
  @HttpCode(200)
  @Endpoint({
    summary: 'Staff and reseller sign-in',
    tags: ['auth'],
    auth: 'public',
    body: loginBody,
    response: sessionView,
  })
  async login(
    @Body() body: z.output<typeof loginBody>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const r = await this.auth.login(body, clientMeta(req));
    if (r.kind === 'mfa') {
      this.cookies.setMfa(reply, r.challenge);
      return { status: 'mfa_required' as const };
    }
    this.cookies.setSession(reply, r.session);
    return {
      status: r.mfa === 'ok' ? ('ok' as const) : ('mfa_enroll_required' as const),
      csrfToken: r.session.csrf,
    };
  }

  @Post('2fa/verify')
  @HttpCode(200)
  @Endpoint({
    summary: 'Second sign-in step: authenticator code',
    tags: ['auth'],
    auth: 'public',
    body: code,
    response: sessionView,
  })
  async verify2fa(
    @Body() body: z.output<typeof code>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { session } = await this.auth.verifyMfa(
      this.cookies.read(req, COOKIE.mfa),
      body.code,
      clientMeta(req),
    );
    this.cookies.setSession(reply, session);
    return { status: 'ok' as const, csrfToken: session.csrf };
  }

  /** CSRF exempt: the refresh cookie is SameSite=Lax, path-scoped, and the response is only readable same-origin. */
  @Post('refresh')
  @HttpCode(200)
  @Endpoint({
    summary: 'Rotate the session',
    tags: ['auth'],
    auth: 'public',
    csrf: false,
    response: sessionView,
  })
  async refresh(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    try {
      const { session } = await this.auth.refresh(this.cookies.read(req, COOKIE.refresh), clientMeta(req));
      this.cookies.setSession(reply, session);
      const claims = await this.tokens.verifyAccess(session.access);
      return {
        status: claims?.mfa === 'enroll' ? ('mfa_enroll_required' as const) : ('ok' as const),
        csrfToken: session.csrf,
      };
    } catch (e) {
      if (e instanceof AppError && e.status === 401) this.cookies.clearAll(reply);
      throw e;
    }
  }

  @Post('logout')
  @HttpCode(200)
  @Endpoint({ summary: 'Sign out this device', tags: ['auth'], auth: 'public', response: okResponse })
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.auth.logout(this.cookies.read(req, COOKIE.refresh), req.ctx);
    this.cookies.clearAll(reply);
    return { ok: true as const };
  }

  @Post('logout-all')
  @HttpCode(200)
  @Endpoint({ summary: 'Sign out every device', tags: ['auth'], auth: 'enroll', response: okResponse })
  async logoutAll(@Ctx() ctx: AuthContext, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.auth.revokeAll(ctx.userId, 'logout');
    this.cookies.clearAll(reply);
    return { ok: true as const };
  }

  @Get('me')
  @Endpoint({ summary: 'Current user and permissions', tags: ['auth'], auth: 'enroll', response: meView })
  async me(@Ctx() ctx: AuthContext) {
    const su = await this.sessions.load(ctx.userId);
    return {
      user: toUserView(su!.user),
      permissions: [...ctx.permissions].sort(),
      mfa: ctx.mfa,
      requireMfa: su!.requireMfa,
    };
  }

  @Post('2fa/setup')
  @HttpCode(200)
  @Endpoint({
    summary: 'Start two-factor setup (returns the secret for the authenticator app)',
    tags: ['auth'],
    auth: 'enroll',
    response: z.object({ secret: z.string(), otpauthUrl: z.string() }),
  })
  setup2fa(@Ctx() ctx: AuthContext) {
    return this.auth.setupTotp(ctx);
  }

  @Post('2fa/enable')
  @HttpCode(200)
  @Endpoint({
    summary: 'Confirm two-factor setup with a code',
    tags: ['auth'],
    auth: 'enroll',
    body: code,
    response: sessionView,
  })
  async enable2fa(
    @Ctx() ctx: AuthContext,
    @Body() body: z.output<typeof code>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const session = await this.auth.enableTotp(ctx, body.code, clientMeta(req));
    this.cookies.setSession(reply, session);
    return { status: 'ok' as const, csrfToken: session.csrf };
  }

  @Post('2fa/disable')
  @HttpCode(200)
  @Endpoint({
    summary: 'Turn off two-factor sign-in (not allowed when a role requires it)',
    tags: ['auth'],
    body: code.extend({ password: z.string().min(1).max(256) }),
    response: sessionView,
  })
  async disable2fa(
    @Ctx() ctx: AuthContext,
    @Body() body: { code: string; password: string },
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const session = await this.auth.disableTotp(ctx, body.password, body.code, clientMeta(req));
    this.cookies.setSession(reply, session);
    return { status: 'ok' as const, csrfToken: session.csrf };
  }

  @Post('password')
  @HttpCode(200)
  @Endpoint({
    summary: 'Change own password (signs out other devices)',
    tags: ['auth'],
    auth: 'enroll',
    body: z.object({ currentPassword: z.string().min(1).max(256), newPassword: passwordSchema }),
    response: sessionView,
  })
  async changePassword(
    @Ctx() ctx: AuthContext,
    @Body() body: { currentPassword: string; newPassword: string },
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const session = await this.auth.changePassword(
      ctx,
      body.currentPassword,
      body.newPassword,
      clientMeta(req),
    );
    this.cookies.setSession(reply, session);
    return {
      status: ctx.mfa === 'ok' ? ('ok' as const) : ('mfa_enroll_required' as const),
      csrfToken: session.csrf,
    };
  }
}
