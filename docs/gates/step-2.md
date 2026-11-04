# Step 2 progress — Admin panel and subscriber management

Started 4 Nov 2026 while Step 1 waits on NetForChoice ports (UDP 1812/1813/11812/11813, TCP 8089) and lab routers.
Nothing here touches the RADIUS login path; Step 1 items 1, 4, 8, 9 are still to be closed on real routers.

## Work packages

| WP | Status | Notes |
|---|---|---|
| 2.1 API skeleton | ✅ code + tests | NestJS 12 (ESM) on Fastify 5; zod at every boundary; OpenAPI 3.1 at `/api/v1/openapi.json` (off in production); pino JSON logs with request id, tenant id, user id; error format TRD §7; `/healthz` `/livez` unchanged; MongoDB migrations with lock, API refuses to start with pending ones; `cli.js migrate / create-tenant / create-user` |
| 2.2 Data-access scoping | ✅ code + tests | `ScopedDb`/`ScopedCollection` in `packages/db-mongo`: tenant (and reseller branch) ANDed into every read and write; tenant stamped on insert; tenant field immutable; `$lookup`-style stages refused; unknown collections refused. Cross-tenant harness: every `:id` route is called by another tenant's admin and must answer 404 with no change; a new `:id` route without a fixture fails CI |
| 2.3 Auth | ✅ code + tests | argon2id (19 MiB, t=2), TOTP (RFC 6238, ±1 step, replay-proof), 15-min HS512 access JWT + 30-day rotating refresh token (peppered HMAC, family revocation on reuse, 10 s multi-tab grace), HttpOnly cookies, session-bound CSRF + Origin check, JSON-only bodies, lockout 5 failures/15 min per account and 20/15 min per IP; built-in roles; users and roles API with no privilege escalation |
| 2.4–2.13 | ⏳ | Next: 2.4 tenants/routers/plans, then 2.5 outbox worker |

## Decisions and schema changes (BACKEND_SCHEMA to update)

1. **Per-IP login limit 20 failures/15 min** (TRD §8.1 says 5): staff share office and CGNAT IPs; the per-account
   limit stays 5. Both are env settings.
2. `users.tokenVersion` (int): bumped on password change, disable, role change, 2FA change, logout-all; ends every
   session without a token blacklist.
3. `roles.requireMfa` (bool): ISP Admin and super-admin require TOTP; a user with such a role must enrol before
   any other call.
4. `refresh_tokens` gains `tenantId`, `tokenVersion`, `mfa`, `familyExpiresAt`, `revokedReason`.
5. New collection `rate_limits` (TTL) for login/MFA counters: works across API replicas without Redis.
6. `tenants.walletId` optional until Step 3 creates wallets.
7. Super-admins sign in with tenant `platform` (reserved slug); staff by host (`branding.domain`) or tenant slug.
8. Session cache: user + permissions cached 30 s per API process; changes made through the same process apply at
   once. Disabling a user or changing roles also revokes refresh tokens immediately.
9. Reseller users and reseller-scoped roles are modelled (branch scope, `RESELLER_PERMISSIONS`) but only staff
   accounts can be created until resellers exist (Step 3).

## Tests

```
unit:        shared 7, db-mongo 10 (scope rules), api 34 (config, tokens, passwords, route table, app wiring)
integration: apps/api/test/*.int.test.ts against MongoDB 8.0 replica set (CI): health/errors, sign-in, TOTP,
             enrolment, lockout, refresh rotation and reuse, CSRF/Origin, disable, password change, logout,
             permissions, privilege escalation, cross-tenant 404 for every :id route
```
