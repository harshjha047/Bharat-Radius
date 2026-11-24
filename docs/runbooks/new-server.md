# New production server (br-prod, Ubuntu 26.04)

Fresh production on a dedicated VPS; acs-prod keeps its staging data and is not used for production.

| | |
|---|---|
| Host | `br-prod`, Ubuntu 26.04, 8 vCPU / 20 GB / 500 GB, VMware |
| Addresses | public 151.158.118.179 → private 172.18.33.179/24 (provider firewall, 1:1 NAT) |
| SSH | `ssh -p 56767 admin@172.18.33.179`, only through the provider's FortiClient SSL-VPN; keys only |
| PostgreSQL | 18 (Ubuntu's own) |
| Web entry | own Caddy (`deploy/ubuntu/edge`, `EDGE=own`), `bharatradius.com` |
| Docker ranges | `bip` 10.199.0.1/24, pools 10.200.0.0/16 → `APP_SUBNET=10.200.0.0/16` |

**Why the Docker ranges:** the host's own network is 172.18.33.0/24, inside Docker's default 172.17–172.31 pools
and the old `APP_SUBNET=172.16.0.0/12`. A Docker network on 172.18.0.0/16 cuts the host off its gateway, and
`pg_hba`/ufw would trust the provider's network. `install.sh` now refuses an `APP_SUBNET` holding a host address.

## 0. Base (done 24 Nov 2026)

`/etc/docker/daemon.json` before installing Docker:

```json
{"bip":"10.199.0.1/24","default-address-pools":[{"base":"10.200.0.0/16","size":24}],"log-driver":"local"}
```

ufw: deny in, allow out, `56767/tcp`. SSH: `PasswordAuthentication no`, `PermitRootLogin no`. Read-only deploy
key `~/.ssh/github_deploy`, checkout `~/isp-platform`.

## 1. Provider firewall (ticket) and DNS

Inbound to 151.158.118.179 → 172.18.33.179, **router source IPs preserved** (FreeRADIUS identifies routers by
source address): UDP 1812/1813, TCP 80/443, TCP 8089; UDP 514 from router IPs at cutover.

Check the outbound address too: `curl -4s https://ifconfig.me`. If it is not 151.158.118.179, routers must accept
CoA (UDP 3799, `setup.rsc`) from that address instead.

DNS: `bharatradius.com` A → 151.158.118.179 before step 4 (Caddy gets the certificate over port 80).

## 2. RADIUS

```
cd ~/isp-platform && git pull
sudo PG_TLS_HOSTNAME=br-prod APP_SUBNET=10.200.0.0/16 PG_SHARED_BUFFERS=3GB PG_EFFECTIVE_CACHE_SIZE=10GB \
  bash radius/scripts/install.sh production
```

Production only; no staging instance on this host. Settings are remembered in `/etc/isp-radius/install.env`.
RADIUS ports stay closed in ufw until routers are added in the panel (`nas-allow.sh production list`).

## 3. Exporters

```
sudo bash deploy/ubuntu/install-exporters.sh
sudo bash radius/scripts/install.sh production     # again: enables the synthetic login probe
```

## 4. App, own Caddy

```
sudo EDGE=own RADIUS_INSTANCE=production RADIUS_PUBLIC_HOST=151.158.118.179 \
  PANEL_HOSTS=bharatradius.com CANONICAL_ORIGIN=https://bharatradius.com \
  bash deploy/ubuntu/app/app-up.sh
```

`RADIUS_PUBLIC_HOST` must be given: behind NAT the host's own address is the private one. All five values are
remembered in `/etc/isp-app/settings.env`; later deploys are `git pull && sudo bash deploy/ubuntu/app/app-up.sh`.
`app-up.sh` also writes the non-secret values to `deploy/ubuntu/{app,monitoring}/.env` so hand-run
`docker compose` commands resolve the same network and host names.

Tenant and first ISP Admin: `docs/runbooks/app-ubuntu.md` (create-tenant, create-user), then 2FA.

## 5. Monitoring, logs, disk guard, backups

```
sudo install -m 0400 /dev/stdin /etc/isp-app/telegram_token     # paste the bot token, Ctrl-D
sudo TELEGRAM_CHAT_ID=<id> bash deploy/ubuntu/monitoring/mon-up.sh --test-alert
sudo bash deploy/ubuntu/logs/logs-setup.sh
sudo bash deploy/ubuntu/disk/disk-setup.sh
sudo bash deploy/ubuntu/backup/backup-setup.sh 'age1…'           # owner's public key; docs/runbooks/backups.md
```

Off-site copy: new B2 application key scoped to the bucket (`docs/runbooks/backups.md` §off-site); never reuse
acs-prod's key.

The walled-garden probe (Prometheus → 151.158.118.179:8089) needs the provider firewall to hairpin. If it
reports down while routers reach :8089 fine, the firewall does not hairpin; tell the owner before silencing it.

## 6. Preflight

```
sudo bash deploy/ubuntu/preflight.sh production
```
