# Production prep and go-live (WP 4.10 → 4.12)

Everything stays on the current VPS (owner decision, 6 Nov). Staging keeps running until the first POP is cut
over; routers only ever reach production after their own cutover (runbook §8 in IMPLEMENTATION_PLAN).

## 1. Production RADIUS (once)

```
cd ~/isp-platform && git pull
sudo bash radius/scripts/install.sh production     # database radius, FreeRADIUS on 1812/1813, timers
sudo /opt/isp-radius/scripts/nas-allow.sh production list   # empty until routers are added
```

## 2. Which RADIUS the panel writes to (O-23)

The panel writes routers and subscribers to one RADIUS instance and the matching MongoDB database
(`staging` → `isp_staging`, `production` → `isp`). Remembered in `/etc/isp-app/settings.env`.

- **Recommended:** switch the panel to production for the import dry run (WP 4.11): the production databases
  start empty, the importer fills them, and staging keeps its test data for later checks.
  ```
  sudo RADIUS_INSTANCE=production bash deploy/ubuntu/app/app-up.sh
  docker compose -f deploy/ubuntu/app/docker-compose.yml exec api node dist/cli.js create-tenant ...   # as for staging
  ```
- Switching back: `sudo RADIUS_INSTANCE=staging bash deploy/ubuntu/app/app-up.sh` (nothing is deleted).

## 3. Panel address

`PANEL_HOSTS` (space-separated, first = canonical; remembered): add the ISP's own domain only after its DNS
points to this server (Caddy then fetches its certificate):

```
sudo PANEL_HOSTS="new.bharatradius.com panel.example-isp.in" bash deploy/ubuntu/app/app-up.sh
```

## 4. Content and keys (owner, in the panel)

| Item | Where | Blocks |
|---|---|---|
| Privacy notice (DPDP), lawyer-reviewed | ISP settings → Privacy notice → *Start from the draft* → edit → *Publish* | Go-live (preflight FAIL) |
| Live Razorpay / Cashfree keys (new ones, O-17) | Billing settings | Online payments |
| DLT SMS templates (O-7) | Billing settings → SMS | OTP login, SMS |
| Real plan prices (O-21) | Plans | Import dry run |
| Off-site file bucket | `docs/runbooks/kyc.md` | KYC at scale |

Customers see the notice at their next portal visit and accept it; consent given on paper is recorded on the
subscriber (*Privacy consent* → *Signed CAF received*). The CAF form carries the same consent declaration.

## 5. Security

- CSP: every page carries a per-request nonce; inline scripts are refused (`apps/web/src/proxy.ts`). Styles keep
  `'unsafe-inline'` (React style attributes, runtime-injected component styles; no code execution).
- Secrets are root-only files under `/etc/isp-app` and `/etc/isp-radius`, or encrypted in tenant settings.
- RADIUS ports only from routers on the allow-list (`nas-allow.sh`); unusable packets show in RADIUS log → Routers.

## 6. Preflight

```
sudo bash deploy/ubuntu/preflight.sh production
```

Read-only; checks RADIUS, panel containers, HTTPS + CSP + HSTS, root-only secrets, file bucket, privacy notice,
₹1 plans, backups (≤ 26 h, off-site), last restore drill (≤ 35 days), disk, NTP, Alertmanager. Exit 1 on any
FAIL. Run it before the import dry run (4.11) and before every POP cutover (4.12/4.13).
