# Step 2 progress — Admin panel and subscriber management

Started 4 Nov 2026 while Step 1 waits on NetForChoice ports (UDP 1812/1813/11812/11813, TCP 8089) and lab routers.
Nothing here touches the RADIUS login path; Step 1 items 1, 4, 8, 9 are still to be closed on real routers.

## Work packages

| WP | Status | Notes |
|---|---|---|
| 2.1 API skeleton | ✅ code + tests | NestJS 12 (ESM) on Fastify 5; zod at every boundary; OpenAPI 3.1 at `/api/v1/openapi.json` (off in production); pino JSON logs with request id, tenant id, user id; error format TRD §7; `/healthz` `/livez` unchanged; MongoDB migrations with lock, API refuses to start with pending ones; `cli.js migrate / create-tenant / create-user` |
| 2.2 Data-access scoping | ✅ code + tests | `ScopedDb`/`ScopedCollection` in `packages/db-mongo`: tenant (and reseller branch) ANDed into every read and write; tenant stamped on insert; tenant field immutable; `$lookup`-style stages refused; unknown collections refused. Cross-tenant harness: every `:id` route is called by another tenant's admin and must answer 404 with no change; a new `:id` route without a fixture fails CI |
| 2.3 Auth | ✅ code + tests | argon2id (19 MiB, t=2), TOTP (RFC 6238, ±1 step, replay-proof), 15-min HS512 access JWT + 30-day rotating refresh token (peppered HMAC, family revocation on reuse, 10 s multi-tab grace), HttpOnly cookies, session-bound CSRF + Origin check, JSON-only bodies, lockout 5 failures/15 min per account and 20/15 min per IP; built-in roles; users and roles API with no privilege escalation |
| 2.4 Tenants, routers, plans | ✅ code + tests | Own-ISP settings (staff) and ISP CRUD/suspend (super-admin, others get 404); routers with IP unique across ISPs, encrypted secret (generated, shown once, reveal/rotate), soft delete that frees the IP; plans with Mikrotik-Rate-Limit derived from speeds/burst, cap ⇒ FUP speed, reserved RADIUS attributes refused, GST defaults (18 %, SAC 998422). Every change commits with its outbox row in one MongoDB transaction |
| 2.5 Outbox worker | ✅ code + tests | `apps/workers` (`isp-workers` container): one leader via lease, change-stream wake + 1 s poll, latest-state sync (idempotent, adopts Step 1 rows by natural key), backoff 5 s → 5 min, `/metrics` + alerts `OutboxStuck`, `OutboxNoLeader`; runbook `docs/runbooks/outbox.md`. Test proves < 2 s save → PostgreSQL |
| 2.6 Subscribers | ✅ code + tests | CRUD, suspend/activate, kick, delete (frees username/static IP), PPPoE password encrypted (generated, shown once, reveal needs `subscribers.password.reveal`), customer numbers per ISP, MAC lock/static IP/sim-use, prefix search on name/username/phone/customer no., `syncStatus` per version. Worker syncs to PostgreSQL (`radius_encrypt_password`) and sends CoA: rate change via `radius_reply`, disconnect for state changes, NAK → disconnect, every attempt in `coa_log` (`GET /subscribers/:id/coa-log`). Plan speed edits CoA everyone online on the plan |
| 2.7 Sessions and logs | ✅ code + tests | `GET /sessions/live` (search username/IP/MAC prefix, filter by router, stale flag), `/sessions/summary` (online per router), `/sessions/lookup?ip=&at=` (who had an IP), `/subscribers/:id/sessions` and `/auth-log` (reject reasons), keyset paging with microsecond-exact cursors, partition-pruned 90-day default window. Kick is `POST /subscribers/:id/kick` (2.6) |
| 2.8 Usage and FUP | ✅ code + tests | `radius_usage_rollup()` (one statement, advisory lock, `usage_seen` so runs never double count) every 15 min via a lease-based scheduler in `isp-workers`; FUP on/off when cycle usage crosses the plan cap (calendar month or billing cycle), synced with a Disconnect; cap removed → FUP lifted; `GET /subscribers/:id/usage`; job metrics + `UsageJobStale` alert; runbook `docs/runbooks/usage.md` |
| 2.9–2.13 | ⏳ | Next: 2.9 Excel import/export |

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
10. **Outbox rows carry no data**: the worker reads the entity's current MongoDB state (BACKEND_SCHEMA said
    "full row"). Replays and reordering cannot write stale data, and secrets never sit in the outbox.
11. **Single worker leader** (lease) instead of Agenda for the outbox: ordering needs one writer; Agenda comes with
    the scheduled jobs (WP 2.8).
12. Plan `burst` is `{ downloadKbps, uploadKbps, thresholdDownloadKbps, thresholdUploadKbps, timeSecs }`; FUP speed
    is `fup: { downloadKbps, uploadKbps }`, both turned into RouterOS strings (`upload/download`, 1M = 1000k).
13. Router delete moves `ip` to `deletedIp` so the IP can be reused; disabling or deleting removes the row from
    PostgreSQL (FreeRADIUS stops answering that router within 30 s).
14. ~~A plan speed change reaches online users only after WP 2.6~~ done in 2.6.
15. **CoA policy**: same RADIUS state (active/fup/expired) and a new plan → CoA with the rate `radius_reply()` now
    returns; any state change, suspend, delete, new static IP or MAC lock → Disconnect (the router re-dials and gets
    a fresh reply, including address lists). A NAK falls back to Disconnect. Needs `radius_reply` granted to the
    app role (`200_grants.sql`): **rerun `install.sh all` on the VPS**; without it the worker disconnects instead.
16. Search uses a `search` array of lower-case prefix tokens indexed with `tenantId`, not a MongoDB text index:
    prefix matches on phone/username are what support types, and the compound index keeps it per ISP.
17. PPPoE usernames cannot be renamed (delete and recreate); static IPs are unique per ISP.
18. Until recharges exist (Step 3) staff with `subscribers.write` may set `expiresAt` directly.
19. No ISP-wide login log yet: `radpostauth` has no `(tenant_id, authdate)` index and adding one would slow the
    login path (Step 1 item 10). It comes with moving the auth log off the login path (Step 5); per-subscriber
    history covers support.
20. Resellers get session views in Step 3 (403 until then); super-admins pass `?tenantId=`.
21. FUP counts upload + download. Usage is booked on the IST day of the 15-minute run (traffic just before midnight
    may land on the next day); per-session totals are exact. No separate `fup-reset` job: every run re-evaluates the
    current cycle, so a new cycle lifts FUP within 15 minutes.
22. PostgreSQL migration 003 (`usage_seen`) and new grants: **rerun `install.sh all`** before deploying.

## Tests

```
unit:        shared 7, db-mongo 10 (scope rules), api 34 (config, tokens, passwords, route table, app wiring)
integration: apps/api/test/*.int.test.ts against a MongoDB replica set (CI: 7.0, see ci.yml): health/errors, sign-in, TOTP,
             enrolment, lockout, refresh rotation and reuse, CSRF/Origin, disable, password change, logout,
             permissions, privilege escalation, cross-tenant 404 for every :id route
```
