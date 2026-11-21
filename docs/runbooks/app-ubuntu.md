# Staging app stack on the Ubuntu VPS (replaces WP 1.4 Windows base for staging)

Decision 4 Nov 2026: the staging app runs on the Radius host, in Docker Compose project `isp`, next to the ACS stack.
The Windows VPS is not used. Production placement is decided at Step 4.

| Container | Purpose | Reachable at |
|---|---|---|
| `isp-mongo` | MongoDB 8.0, replica set `rs-isp`, auth + keyfile | containers on network `isp_internal`; host `127.0.0.1:27018` |
| `isp-api` | Node API (CPU ≤ 1.5, RAM ≤ 768 MB) | `isp-api:4100` on `acs_default` (ACS Caddy) |
| `isp-web` | Admin panel (Next.js; CPU ≤ 0.5, RAM ≤ 256 MB) | `isp-web:3000` on `acs_default`; Caddy sends everything except `/api/*` and `/grafana` here |
| `isp-walled-garden` | Redirects expired users' HTTP to the pay page | public TCP 8089 |

Radius stays native. The API reaches PostgreSQL as `acs-prod:5432` (mapped to the Docker host gateway) over TLS with
full certificate check; PostgreSQL accepts the app roles only from `172.16.0.0/12` and only over TLS.

Secrets: `/etc/isp-app/` (root only): `staging.env`, Mongo root/app passwords, keyfile, JWT/encryption keys.

## Install / update

```bash
cd ~/isp-platform && git pull
sudo APP_SUBNET=172.16.0.0/12 PG_TLS_HOSTNAME=acs-prod PG_TLS_IP=154.49.142.251 \
  bash radius/scripts/install.sh all          # once: lets the app subnet reach PostgreSQL over TLS
sudo bash deploy/ubuntu/app/app-up.sh         # build, start, Caddy site; rerun after every git pull
# install.sh remembers APP_SUBNET / PG_TLS_* in /etc/isp-radius/install.env: later reruns need no variables.
```

`app-up.sh` adds `sites/isp.caddy` and one `import /etc/caddy/sites/*.caddy` line to `/opt/acs/repo/infra/caddy`,
validates with Caddy, and reloads only if valid (otherwise restores the ACS Caddyfile). Commit those two changes in
the ACS repo, or add `infra/caddy/sites/` to its `.gitignore`.

## First tenant and administrator (once, after the first `app-up.sh` with Step 2)

```bash
cd ~/isp-platform/deploy/ubuntu/app
sudo docker compose run --rm --no-deps api node dist/cli.js create-tenant \
  --slug bharat --name "Bharat Radius" --legal-name "<legal name>" --state-code 07 \
  --line1 "<address>" --city Delhi --state Delhi --pincode 110001 --domain new.bharatradius.com
sudo docker compose run --rm --no-deps -it api node dist/cli.js create-user \
  --tenant bharat --name "<your name>" --email <you@domain> --role "ISP Admin"     # prompts for the password
sudo docker compose run --rm --no-deps -it api node dist/cli.js create-user \
  --tenant platform --name "<your name>" --email <you@domain>                      # super-admin (optional)
```

`--domain` lets staff sign in on that host without typing a tenant. ISP Admin and super-admin accounts must set up
an authenticator app (TOTP) at first sign-in. Lost phone: another admin uses "Reset two-factor"; if you are the only
admin, `docker exec isp-mongo mongosh ...` → `db.users.updateOne({email: '<you>'}, {$unset: {totp: ''}})`.

## Checks

```bash
docker ps --filter name=isp- --format '{{.Names}}\t{{.Status}}'
docker exec isp-api wget -qO- http://127.0.0.1:4100/healthz          # "status":"ok", radiusDb.ssl true, mongo rs-isp
docker exec isp-web wget -qO- http://127.0.0.1:3000/livez            # ok
curl -s https://new.bharatradius.com/api/healthz                     # after DNS points here
curl -sI http://127.0.0.1:8089/anything | grep -i location           # https://new.bharatradius.com/pay
```

## Rollback

```bash
docker compose -f deploy/ubuntu/app/docker-compose.yml down          # add -v to also delete Mongo data
sudo rm /opt/acs/repo/infra/caddy/sites/isp.caddy
sudo sed -i '\|^import /etc/caddy/sites/\*.caddy$|d' /opt/acs/repo/infra/caddy/Caddyfile
docker exec acs-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```

## Forgotten password or lost 2FA phone

Another administrator can do this in the panel (Staff & roles → ⋯ → Set new password / Remove 2FA). When nobody can sign
in, on the VPS:

```bash
cd ~/isp-platform/deploy/ubuntu/app
sudo docker compose run --rm --no-deps -it api node dist/cli.js reset-password \
  --tenant bharat --email info@thediv.in                                            # add --reset-2fa for a lost phone
```

It prompts for the new password (not shown), unlocks the account, signs it out everywhere and writes the audit log.
