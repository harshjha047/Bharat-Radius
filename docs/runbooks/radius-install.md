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
git clone git@github.com:harshjha047/Bharat-Radius.git isp-platform && cd isp-platform
sudo WINDOWS_IP=<windows-vps-ip> PG_TLS_HOSTNAME=<dns-name-of-ubuntu-vps> PG_TLS_IP=<ubuntu-ip> \
  radius/scripts/install.sh all
```

The installer backs up `/etc/freeradius` and `/etc/postgresql` to `/var/backups/isp-radius/config-<time>.tgz`, generates secrets in `/etc/isp-radius/`, creates databases `radius` and `radius_staging`, installs FreeRADIUS config for both instances, and enables the timers:

| Timer | Every | Does |
|---|---|---|
| `isp-radius-nas-watch@<inst>` | 30 s | restarts FreeRADIUS after `freeradius -XC` passes when the `nas` table changed |
| `isp-radius-stale@<inst>` | 5 min | closes sessions silent for 3 interim periods |
| `isp-radius-partitions@<inst>` | daily | creates the next month's partitions; drops `radpostauth` (login attempts) older than `POSTAUTH_KEEP_DAYS` (default 1100 days ≈ 3 years) |

Rerunning is safe (CI runs it twice).

## 2. Prove it

```bash
sudo apt-get install -y python3-pycryptodome bc                 # test-only dependencies
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

## Which routers may reach RADIUS (firewall)

The list of routers allowed to send RADIUS packets lives in `/etc/isp-radius/<instance>.allow` (one `<ip or cidr> <name>` per line) and survives reinstalls; ufw is rebuilt from it. `install.sh` never opens production to everyone: on first install production starts **closed** and staging gets `any staging-lab` (open, for the CHR lab and tests).

```bash
S=/opt/isp-radius/scripts/nas-allow.sh
sudo $S production list
sudo $S production add 160.191.125.238 fab5          # at each POP cutover (runbook §8 step 4), the router's static public IP
sudo $S production remove fab5                       # by name or IP
sudo $S production add 103.170.81.119 owner-test     # temporary test access from your own connection
sudo $S staging apply                                # rebuild ufw from the file
```

Managed rules carry the comment `isp-radius <instance>: <name>`. Rules with any other comment are left alone and listed as a note, so delete old manual rules yourself (`sudo ufw status numbered`, `sudo ufw delete <n>`). The panel's Routers list and this list are separate: a router must be in **both** (panel = which tenant it belongs to and its secret; this list = firewall).

The synthetic probe (loopback) and the app's CoA (outbound to routers on 3799) do not need entries.
