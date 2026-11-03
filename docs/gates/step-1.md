# Step 1 gate — Foundation and RADIUS core

| | |
|---|---|
| Built | 3 Nov 2026 (WP 1.1–1.8; 1.9/1.10 need the real servers) |
| Verified in | Ubuntu 24.04 sandbox, 2 vCPU / 8 GB, FreeRADIUS 3.2.5, PostgreSQL 16 — same packages as the VPS |
| Status | **Code complete; 5 of 12 items need your servers/routers before the gate can pass** |

## Checklist (PRD §13)

| # | Item | Evidence | Status |
|---|---|---|---|
| 1 | PAP, CHAP, MS-CHAPv2 accepted with plan speed | `e2e.sh` (MS-CHAPv2 via `mschapv2.py`: MS-CHAP2-Success + MPPE keys) | ✅ sandbox · ⏳ lab |
| 2 | Wrong password / unknown / suspended rejected with reason | `e2e.sh`: reason in `radpostauth` and `Reply-Message`; disabled and ISP-suspended too | ✅ |
| 3 | Same username under two ISPs; no cross-ISP login | `e2e.sh`, two router source IPs | ✅ |
| 4 | Expired → slow speed + pay page | RADIUS side ✅ (256k, list `expired`, 3600 s); redirect needs a MikroTik | ✅ / ⏳ lab |
| 5 | MAC lock, one login at a time | `e2e.sh`, incl. crashed-router session not blocking | ✅ |
| 6 | Start / interim / stop incl. > 4 GB | `e2e.sh`: Gigawords, lost Start, duplicate Stop | ✅ |
| 7 | Router reboot closes sessions; 15-min silent sessions closed | `e2e.sh`: Accounting-On, stale timer, later interim reopens | ✅ |
| 8 | CoA speed + disconnect on v6 and v7 | `radius-client`: packets byte-identical to FreeRADIUS `radclient`; ACK/NAK/retry/timeout tests; CLI against staging DB over verify-full TLS | ✅ protocol · ⏳ v6 + v7 routers |
| 9 | Real PPPoE dial-in on a lab MikroTik | `docs/runbooks/mikrotik-lab.md` | ⏳ owner (O-5) |
| 10 | 2,000 logins/s, no rejects/timeouts | sandbox: **1,631–1,860/s, 0 rejects, 0 lost** on 2 vCPU *with the load generator on the same box* | ⏳ VPS run (WP 1.9) |
| 11 | GenieACS still works | installer never touches it; check on the VPS | ⏳ owner |
| 12 | No passwords in git | gitleaks: repo clean; catches planted DB URL, router secret, Aadhaar | ✅ |

Extra checks beyond the list: router added to `nas` is served after the 30 s watcher (FR-R11); unknown routers ignored; Access-Accept carries Message-Authenticator (Blast-RADIUS); PostgreSQL down → FreeRADIUS stays silent so the MikroTik falls over to BharatRadius, never a false reject, and recovers by itself; installer idempotent.

```
e2e staging:                RESULT: 47 passed, 0 failed
e2e production + DB outage: RESULT: 49 passed, 0 failed
load:                       20000 logins in 12.25 s = 1631/s; accepted=20000 rejected=0 lost=0 (cores: 2)
unit:                       17 passed (radius-client 14, api 3)
shellcheck / eslint / prettier / tsc: clean
```

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
5. **FreeRADIUS SQL pool must equal the thread pool**: `rlm_sql` fails rather than waits when connections run out (seen as 15 % rejects under load before the fix). Threads 16→32, pool follows.
6. **CoA firewall**: routers accept UDP 3799 only from `appIp`; `COA_SOURCE_IP` must be that address on a multi-IP Windows host.

## Owner actions to pass the gate

1. O-1 now: make the BharatRadius repo private and rotate its secrets.
2. O-2/O-3/O-4: private repo + SSH/RDP access, disk and port checks.
3. Run `docs/runbooks/radius-install.md` on the Ubuntu VPS; paste e2e + load output here (items 10, 11).
4. Run `docs/runbooks/windows-base.md` (WP 1.4; script not yet run on Windows — expect to iterate once together).
5. Lab routers v7 and v6: `docs/runbooks/mikrotik-lab.md` (items 1, 4, 8, 9).
6. `deploy/ubuntu/install-exporters.sh` + Prometheus/Grafana on Windows (WP 1.8); confirm `RadiusDown` fires when FreeRADIUS is stopped.
