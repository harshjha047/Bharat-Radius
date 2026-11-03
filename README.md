# isp-platform

ISP RADIUS, billing and reseller platform replacing BharatRadius. Specs (PRD, TRD, BACKEND_SCHEMA, IMPLEMENTATION_PLAN) belong in `docs/`; requirement IDs in code comments refer to them.

**Status: Step 1 (Foundation and RADIUS core).** Gate record: [`docs/gates/step-1.md`](docs/gates/step-1.md).

```
apps/api/               /healthz stub (NestJS app replaces it in WP 2.1)
packages/radius-client/ CoA / Disconnect (RFC 5176) + `coa` CLI
radius/sql/             PostgreSQL schema (migrations 0xx), login functions (100), grants (200)
radius/freeradius/      sql module, queries, virtual servers
radius/scripts/         install.sh, maint.sh (timers), frctl.sh (no-systemd hosts), systemd units
radius/tests/           e2e.sh (49 checks), load.sh, mschapv2.py
mikrotik/               setup.rsc (v6/v7), remove.rsc, swap-primary.rsc
deploy/ubuntu/          Prometheus exporters
deploy/windows/         install-base.ps1, WinSW, nginx site, mongod.cfg, Prometheus/Grafana
docs/runbooks/          operations
```

## Develop

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

RADIUS tests need Ubuntu 24.04 and root (CI does this on every push):

```bash
sudo PG_TLS_HOSTNAME=localhost radius/scripts/install.sh all
sudo INSTANCE=staging radius/tests/e2e.sh
sudo INSTANCE=staging USERS=20000 PARALLEL=200 TARGET=2000 radius/tests/load.sh
```

## Rules

- No secrets or customer files in git. `git config core.hooksPath .githooks` (done by `pnpm install`) runs gitleaks before each commit; CI fails on any finding.
- Money in integer paise; every row/document carries the tenant; the Node API is the only writer (TRD §1).
- Database changes only through migration files.
