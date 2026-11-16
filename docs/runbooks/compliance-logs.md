# Compliance logs: archive, NAT logs, IP lookup (WP 4.6)

Not legal advice: retention below is the owner's choice (11 Nov 2026) pending the lawyer (O-11).

| Rule | Asks for | We keep |
|---|---|---|
| DoT licence (internet access) | Subscriber log-in/log-out details, ≥ 2 years | RADIUS sessions (`radacct`): never deleted; login attempts (`radpostauth`): 1,100 days |
| DPDP Rules 2025, r. 6 (in force 13 May 2027) | Processing logs + personal data ≥ 1 year; access control, monitoring | Archive 3 years; audit log (changes) indefinitely; access log (who viewed a customer) 1,100 days |
| CERT-In directions 2022 | Logs of all ICT systems 180 days, in India; NTP-synced clocks | Archive 3 years on the VPS (India); `ClockNotSynced` alert |

## What is archived

`/var/log/isp-archive/` on the VPS (root:isp-archive, 0750; nobody else can read it):

| Folder | Source |
|---|---|
| `nat/<router-ip>/` | NAT translations from routers (`ISPNAT` lines): who used which public IP:port, when |
| `routers/<router-ip>/` | Router syslog: PPPoE logins/logouts, router logins, errors |
| `radius/<program>/` | FreeRADIUS production and staging |
| `app/<container>/` | API, workers, web, MongoDB, walled garden (Docker journald driver) |
| `host/auth/`, `host/system/` | SSH/sudo logins; everything else on the server |

Times are this server's receive time (NTP), never the router's clock. Files are named by day.

**Daily seal** (`isp-logs-maint.timer`, 00:20): each finished day file is gzip-compressed, made read-only, and its SHA-256 written to `MANIFEST/<date>.sha256`. Each manifest starts with the hash of the previous one, so editing or deleting any sealed file or manifest is detectable. Manifests also go into the encrypted nightly backup. Files older than 3 years (1,096 days) are deleted; nothing newer is ever deleted, even when the disk fills (you get `LogArchiveDiskLow` instead).

```bash
sudo /opt/isp-logs/logs-maint.sh verify      # "archive verified" or what changed
sudo du -sh /var/log/isp-archive/*           # size per kind
```

**Disk:** NAT logs are one line (~250 bytes, ~25 compressed) per new customer connection. Rough guide: 1,000 customers ≈ 100–150 MB/day compressed ≈ 110–160 GB for 3 years, more than this VPS has free. Watch `isp_logarchive_free_bytes` in Grafana; add a disk or a bucket (O-18, Indian region) before it runs low.

## Setup (once, on the VPS)

```bash
cd ~/isp-platform && git pull
sudo bash deploy/ubuntu/logs/logs-setup.sh          # rsyslog + journald forwarding + timers; prints OK
sudo bash deploy/ubuntu/app/app-up.sh               # containers switch to the journald log driver; API gets the NAT archive
sudo bash deploy/ubuntu/monitoring/mon-up.sh        # new alerts
ls /var/log/isp-archive/app/                        # isp-api, isp-workers, … appear within a minute
```

## Adding a router (at its cutover)

1. NetForChoice: inbound **UDP 514** open (once, for the server).
2. Allow the router: `sudo /opt/isp-logs/logs-allow.sh add <router public IP> <pop-name>` (list / remove the same way).
3. On the router: edit the top of `mikrotik/logging.rsc` (`syslogIp`, `srcAddress`, `natLog`), upload, `/import file-name=logging.rsc`.
   It sends PPP, account, system, warning/error logs, and with `natLog true` turns on `log=yes log-prefix=ISPNAT` on the router's existing srcnat masquerade/src-nat rules. Rollback: `/import remove.rsc`.
4. Check within a minute: `sudo ls -l /var/log/isp-archive/routers/<router-ip>/ /var/log/isp-archive/nat/<router-ip>/`

Customers with their own public IP need no NAT log (set `natLog false`); the RADIUS session already says who had the IP.

NAT logging costs router CPU on busy POPs: enable it on one router first and watch its CPU for a day.

## Answering "who used IP X at time T"

Panel → **Sessions → Who had an IP**: IP, date/time (IST, seconds allowed), optional port, search window.
- *Sessions that had this IP*: customers whose own IP it was (RADIUS).
- *NAT logs*: customers behind NAT who went out as that public IP (needs permission **Search NAT logs**, ISP Admin by default). With the port, usually exactly one customer. Every search is recorded in the audit log (who searched what).

Requests usually give the public IP, port and time from the website's log. NAT lines record when a connection *started*: if nothing matches, widen the window.

## Lab test (before any real router)

```bash
sudo bash deploy/ubuntu/lab/chr-lab.sh up               # if not running
sudo bash deploy/ubuntu/lab/chr-lab.sh dial test.lab
sudo bash deploy/ubuntu/lab/chr-lab.sh logs-on          # applies the repo's logging.rsc to the CHR
sudo bash deploy/ubuntu/lab/chr-lab.sh nat-test         # prints the archived NAT line
```

Then in the panel: Sessions → Who had an IP → IP `10.99.0.2`, the port from the `NAT (…->10.99.0.2:PORT)` part, time now → the test customer.

## Who viewed a customer

Subscriber → **Viewed by** (permission `audit.view`): every opening of the record, sessions, usage, login log, router actions and password reveals, by whom, from which IP. Kept 1,100 days (`access_logs`, TTL).

## Alerts

| Alert | Meaning |
|---|---|
| LogArchiveDiskLow (critical) | < 15 % free on the archive disk |
| LogArchiveSealStale | Daily seal did not run for 26 h |
| RouterLogsSilent | A router that sent syslog before has been silent for 3 h |
| ClockNotSynced | Server clock not NTP-synced (timestamps would be wrong) |

## Not covered yet

DPDP notice/consent screen, customer data export and erasure requests, grievance contact, and the written breach procedure (CERT-In 6 h, DPDP Board + customers): planned with production prep (WP 4.10). Off-site copy of the archive waits on the bucket (O-18).
