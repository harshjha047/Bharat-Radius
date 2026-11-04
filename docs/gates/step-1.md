# Step 1 gate — Foundation and RADIUS core

| | |
|---|---|
| Built | 3 Nov 2026 (WP 1.1–1.8; 1.9/1.10 need the real servers) |
| Verified in | Ubuntu 24.04 sandbox, 2 vCPU / 8 GB, FreeRADIUS 3.2.5, PostgreSQL 16 — same packages as the VPS |
| Ubuntu VPS | `acs-prod` 154.49.142.251, Ubuntu 24.04.5, 4 vCPU Xeon Gold 6138 (KVM, Meltdown PTI on), 7.8 GB; shares the host with GenieACS (Docker) |
| App host (staging) | **Ubuntu VPS, Docker Compose project `isp`** (decision 4 Nov 2026; Windows VPS not used; production placement decided at Step 4) |
| Status | **RADIUS and app stack on Ubuntu done (4 Nov 2026). Open: HTTPS (DNS propagating), monitoring install (WP 1.8, `docs/runbooks/monitoring.md`), NetForChoice firewall, lab routers (1.6)** |

## Checklist (PRD §13)

| # | Item | Evidence | Status |
|---|---|---|---|
| 1 | PAP, CHAP, MS-CHAPv2 accepted with plan speed | `e2e.sh` (MS-CHAPv2 via `mschapv2.py`: MS-CHAP2-Success + MPPE keys) | ✅ sandbox · ⏳ lab |
| 2 | Wrong password / unknown / suspended rejected with reason | `e2e.sh`: reason in `radpostauth` and `Reply-Message`; disabled and ISP-suspended too | ✅ VPS |
| 3 | Same username under two ISPs; no cross-ISP login | `e2e.sh`, two router source IPs | ✅ VPS |
| 4 | Expired → slow speed + pay page | RADIUS side ✅ (256k, list `expired`, 3600 s); redirect needs a MikroTik | ✅ / ⏳ lab |
| 5 | MAC lock, one login at a time | `e2e.sh`, incl. crashed-router session not blocking | ✅ VPS |
| 6 | Start / interim / stop incl. > 4 GB | `e2e.sh`: Gigawords, lost Start, duplicate Stop | ✅ VPS |
| 7 | Router reboot closes sessions; 15-min silent sessions closed | `e2e.sh`: Accounting-On, stale timer, later interim reopens | ✅ VPS |
| 8 | CoA speed + disconnect on v6 and v7 | `radius-client`: packets byte-identical to FreeRADIUS `radclient`; ACK/NAK/retry/timeout tests; CLI against staging DB over verify-full TLS | ✅ protocol · ⏳ v6 + v7 routers |
| 9 | Real PPPoE dial-in on a lab MikroTik | `docs/runbooks/mikrotik-lab.md` | ⏳ owner (O-5) |
| 10 | 2,000 logins/s, no rejects/timeouts | VPS: **1,099/s, 0 rejects, 0 lost** (generator on the same box uses 1 of 4 cores; ≈1,450/s server-only) | ⚠️ **accepted deviation**, see below |
| 11 | GenieACS still works | all 10 containers identical before/after install; NBI and UI answer 200 | ✅ VPS |
| 12 | No passwords in git | gitleaks 8.30.1 in CI over full history + pre-commit hook; catches planted DB URL, router secret, Aadhaar | ✅ CI |

Extra checks beyond the list: router added to `nas` is served after the 30 s watcher (FR-R11); unknown routers ignored; Access-Accept carries Message-Authenticator (Blast-RADIUS); PostgreSQL down → FreeRADIUS stays silent so the MikroTik falls over to BharatRadius, never a false reject, and recovers by itself; installer idempotent.

```
VPS (4 Nov 2026)
e2e staging:                RESULT: 47 passed, 0 failed
load:                       20000 logins in 18.19 s = 1099/s; accepted=20000 rejected=0 lost=0 (cores: 4)
CI (GitHub Actions, every push)
e2e staging / production + DB outage: 47 / 49 passed; load 1042/s on 2 cores
Sandbox
e2e staging:                RESULT: 47 passed, 0 failed
e2e production + DB outage: RESULT: 49 passed, 0 failed
load:                       20000 logins in 12.25 s = 1631/s; accepted=20000 rejected=0 lost=0 (cores: 2)
unit:                       17 passed (radius-client 14, api 3)
shellcheck / eslint / prettier / tsc: clean
```

## Deviation: gate item 10 (owner decision, 4 Nov 2026)

Measured 1,099 logins/s on the Ubuntu VPS, zero rejects or timeouts. Root cause found by profiling: PostgreSQL ~60 % of CPU, load generator ~25 %, FreeRADIUS ~15 %; no CPU steal, no I/O wait. The Xeon Gold 6138 (2017) needs Meltdown page-table isolation, which makes every system call expensive, and each login costs ~3 database round trips plus 2 UDP packets. Fixed in code along the way: auth log as PL/pgSQL (PostgreSQL 16 re-plans SQL functions per call) and a 1-month partition horizon (migration 002): 937 → 1,099/s on the VPS, 1,631 → 2,301/s in the sandbox.

**Decision:** accept for Step 1. Today's ~2,000 subscribers reconnect in ~2 s at this rate; 2,000/s is sized for 100,000. The 2,000/s proof moves to Step 5 (WP 5.3 capacity, 5.11 100k load test), together with:
- move the auth log off the login path (FreeRADIUS writes a local file, a timer bulk-loads it): removes ~58 % of database time per login, estimated +40 %;
- or put RADIUS on a newer CPU (2021+, no PTI), which likely clears 2,000/s without code changes.

## Decision: staging app on the Ubuntu VPS (owner, 4 Nov 2026)

The NetForChoice network firewall blocks every port not opened in their panel, which stopped Windows → Ubuntu PostgreSQL. Instead of opening the database to the internet, the staging app stack runs on the RADIUS host in Docker Compose (`isp-mongo`, `isp-api`, `isp-walled-garden`) behind the existing ACS Caddy. CPU caps keep RADIUS first (app ≤ 2.75 cores in total). Upgrade the VPS (≥ 8 vCPU / 16 GB) before Step 2 seeds 100,000 test subscribers. Windows work was removed without touching its services. Still required from NetForChoice: inbound UDP 1812, 1813, 11812, 11813 and TCP 8089.

## Monitoring (WP 1.8, owner chose Prometheus + Grafana + Alertmanager on the VPS, 4 Nov 2026)

FreeRADIUS counters come from its own Status-Server every 15 s (no third-party exporter: its release assets could not be verified). Tested in the sandbox against the real exporters and Prometheus 2.45: `RadiusDown` fired **76 s** after production FreeRADIUS was stopped; critical alerts reach Telegram 10 s later. Rule timing is unit-tested in CI. Also found and fixed: the grants file's `REVOKE … FROM PUBLIC` had removed access to `pg_stat_statements`; it is now handed back to `pg_read_all_stats`.

## Decisions closed in Step 1

| Decision (IMPLEMENTATION_PLAN §10) | Outcome |
|---|---|
| PPPoE password protection | `pgp_sym_encrypt` (AES-256). Key lives only in FreeRADIUS/API env files, passed per query; statement logging off for both roles; dumps, standby and backups hold ciphertext only |
| Node framework | NestJS (WP 2.1); Step 1 API is a dependency-light `/healthz` stub |
| Windows service wrapper | WinSW, runs as LocalService, secrets via `node --env-file` |

## Findings that change the documents

1. **Pay page cannot identify the subscriber by source IP** (TRD §9). MikroTik masquerades customer traffic, so the pay page sees the router's public IP, not the customer's. Proposal for WP 4.2: phone/username + OTP on the pay page, pre-filled when only one expired session is open behind that router. `setup.rsc` already redirects expired HTTP to `appIp:8089`.
2. **Windows standby must not use 5432** — BharatRadius' own PostgreSQL may be there. Standby runs on 5433 as service `isp-pg-standby`.
3. **TRD §3.2 network table**: WAL streaming is initiated by the Windows standby (Windows → Ubuntu 5432). No inbound 5432 on Windows is needed; remove that row.
4. **Simultaneous-use check moved into `radius_check()`** (one database round trip less per login). Side effect: an online user who types a wrong password is told "already logged in" rather than "wrong password".
5. **Partition horizon is 1 month ahead (was 3)**: every login scans all `radacct` partitions (open sessions cannot be pruned by date); more partitions cost lock-manager time under load.
6. **FreeRADIUS SQL pool must equal the thread pool**: `rlm_sql` fails rather than waits when connections run out (seen as 15 % rejects under load before the fix). Threads 16→32, pool follows.
7. **Windows MongoDB is shared and unauthenticated** (27017, used by six other apps; already replica set `rs0`). Enabling auth would break them, and ISP data must not be readable by other local apps: we run our own `isp-mongo` on 127.0.0.1:27018 with auth. Port 4000 is taken by a pm2 app: the API uses 4100.
8. **CoA firewall**: routers accept UDP 3799 only from `appIp`; `COA_SOURCE_IP` must be that address on a multi-IP Windows host.

## Owner actions to pass the gate

1. ~~O-2/O-3/O-4, CI green, Ubuntu install, e2e, load, GenieACS check~~ done 4 Nov 2026.
2. O-1: confirm the old BharatRadius repo is private and its DB, JWT and SMTP passwords are rotated.
3. Run `docs/runbooks/windows-base.md` (WP 1.4; script not yet run on Windows — expect to iterate once together).
4. Lab routers v7 and v6: `docs/runbooks/mikrotik-lab.md` (items 1, 4, 8, 9).
5. `deploy/ubuntu/install-exporters.sh` + Prometheus/Grafana on Windows (WP 1.8); confirm `RadiusDown` fires when FreeRADIUS is stopped.
