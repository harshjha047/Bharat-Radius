# RADIUS install on the Ubuntu VPS (WP 1.3, 1.9)

Production RADIUS stays idle (no router points at it) until Step 4. Staging runs on UDP 11812/11813.

## 0. Before you start (O-3, O-4)

```bash
df -h /                                   # >= 40 GB free
sudo ss -lunp | grep -E ':(1812|1813|11812|11813)\b'   # must be empty
sudo ss -ltnp | grep ':5432\b'            # must be empty
systemctl list-units --type=service | grep -i genie    # note GenieACS units and state
```

## 1. Install

```bash
git clone git@github.com:<you>/isp-platform.git && cd isp-platform
sudo WINDOWS_IP=<windows-vps-ip> PG_TLS_HOSTNAME=<dns-name-of-ubuntu-vps> PG_TLS_IP=<ubuntu-ip> \
  radius/scripts/install.sh all
```

The installer backs up `/etc/freeradius` and `/etc/postgresql` to `/var/backups/isp-radius/config-<time>.tgz`, generates secrets in `/etc/isp-radius/`, creates databases `radius` and `radius_staging`, installs FreeRADIUS config for both instances, and enables the timers:

| Timer | Every | Does |
|---|---|---|
| `isp-radius-nas-watch@<inst>` | 30 s | restarts FreeRADIUS after `freeradius -XC` passes when the `nas` table changed |
| `isp-radius-stale@<inst>` | 5 min | closes sessions silent for 3 interim periods |
| `isp-radius-partitions@<inst>` | daily | creates month partitions 3 ahead; drops `radpostauth` older than 90 days |

Rerunning is safe (CI runs it twice).

## 2. Prove it

```bash
sudo INSTANCE=staging radius/tests/e2e.sh                       # expect 47 passed, 0 failed
sudo INSTANCE=staging USERS=20000 PARALLEL=200 TARGET=2000 radius/tests/load.sh   # quiet hour (WP 1.9)
systemctl status genieacs-cwmp genieacs-nbi genieacs-fs genieacs-ui --no-pager   # GenieACS unaffected
```

Paste both outputs into `docs/gates/step-1.md`.

If load is under 2,000/s: check `top` for CPU split, then raise `start_servers`/`max_servers` in `/etc/freeradius/3.0/radiusd.conf` (the SQL pool follows the thread pool) and rerun. Keep `max_connections` (200) above the sum of both instances' `max_servers` plus API pools.

## 3. Hand over to the Windows VPS

Copy over SSH (never email/chat): `/etc/isp-radius/tls/ca.crt` → `C:\isp\tls\radius-ca.crt`, the `APP_DB_PASSWORD` and `RADIUS_PW_KEY` from `staging.app.env`, the replicator password from `replication.env`.

`RADIUS_DB_URL=postgres://app_radius_staging:<pw>@<PG_TLS_HOSTNAME>:5432/radius_staging?sslmode=verify-full&sslrootcert=C:/isp/tls/radius-ca.crt`

## Rollback

```bash
sudo systemctl disable --now freeradius-staging 'isp-radius-*@*.timer'
sudo systemctl stop freeradius
sudo tar -xzf /var/backups/isp-radius/config-<time>.tgz -C /
sudo systemctl restart postgresql
```

No router uses production RADIUS before Step 4, so nothing customer-facing changes.
