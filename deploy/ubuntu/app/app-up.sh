#!/usr/bin/env bash
# Staging app stack on the RADIUS host: our MongoDB, the API, the walled-garden redirect, and one Caddy site in the
# ACS stack. Idempotent. Never changes ACS containers or routes; adds only:
#   /opt/acs/repo/infra/caddy/sites/isp.caddy  +  one "import /etc/caddy/sites/*.caddy" line in its Caddyfile.
# Usage: sudo bash deploy/ubuntu/app/app-up.sh
set -Eeuo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ETC=/etc/isp-app
ACS_CADDY_DIR="${ACS_CADDY_DIR:-/opt/acs/repo/infra/caddy}"
ACS_CADDY_CONTAINER="${ACS_CADDY_CONTAINER:-acs-caddy-1}"
APP_SUBNET="${APP_SUBNET:-172.16.0.0/12}"
COMPOSE=(docker compose -f "$DIR/docker-compose.yml")
REPLSET=rs-isp

log() { printf '\033[1;34m[app-up]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[app-up] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }
trap 'die "failed at line $LINENO: $BASH_COMMAND"' ERR

[[ $EUID -eq 0 ]] || die "run as root"
command -v docker >/dev/null || die "docker not installed"
docker network inspect acs_default >/dev/null 2>&1 || die "docker network acs_default not found (ACS stack down?)"
[[ -s /etc/isp-radius/staging.app.env && -s /etc/isp-radius/tls/ca.crt ]] || die "run radius/scripts/install.sh first"
grep -q "app_radius_staging  $APP_SUBNET" /etc/postgresql/16/main/pg_hba.conf \
  || die "PostgreSQL does not accept the app subnet yet: rerun install.sh with APP_SUBNET=$APP_SUBNET"

# ------------------------------------------------------------------ secrets (generated once)
install -d -m 0700 "$ETC"
# Log archive (WP 4.6): the API container reads NAT logs as group isp-archive (fixed gid, see docker-compose.yml).
getent group isp-archive >/dev/null || groupadd -g 2470 isp-archive
install -d -m 0750 -g isp-archive /var/log/isp-archive /var/log/isp-archive/nat
gen() { openssl rand -hex "${1:-24}"; }
[[ -s $ETC/mongo.keyfile ]] || openssl rand -base64 756 | tr -d '\n' >"$ETC/mongo.keyfile"
[[ -s $ETC/mongo_root_pw ]] || gen >"$ETC/mongo_root_pw"
[[ -s $ETC/mongo_app_pw ]] || gen >"$ETC/mongo_app_pw"
[[ -s $ETC/app_keys.env ]] || printf 'JWT_SIGNING_KEY=%s\nREFRESH_TOKEN_PEPPER=%s\nFIELD_ENCRYPTION_KEY=%s\n' \
  "$(gen 32)" "$(gen 32)" "$(openssl rand -base64 32)" >"$ETC/app_keys.env"
# mongod in the container runs as uid 999 and refuses a keyfile readable by others.
chown 999:999 "$ETC/mongo.keyfile" "$ETC/mongo_root_pw"; chmod 0400 "$ETC/mongo.keyfile" "$ETC/mongo_root_pw"
chmod 0600 "$ETC/mongo_app_pw" "$ETC/app_keys.env"

APP_DB_PASSWORD="$(sed -n 's/^APP_DB_PASSWORD=//p' /etc/isp-radius/staging.app.env)"
RADIUS_PW_KEY="$(sed -n 's/^RADIUS_PW_KEY=//p' /etc/isp-radius/staging.app.env)"
MONGO_APP_PW="$(cat "$ETC/mongo_app_pw")"
umask 077
{
  echo "NODE_ENV=production"
  echo "MONGO_URL=mongodb://isp_app:${MONGO_APP_PW}@isp-mongo:27017/isp_staging?replicaSet=${REPLSET}&authSource=admin"
  echo "RADIUS_DB_URL=postgres://app_radius_staging:${APP_DB_PASSWORD}@acs-prod:5432/radius_staging?sslmode=verify-full&sslrootcert=/etc/isp/radius-ca.crt"
  echo "RADIUS_DB_POOL_MAX=10"
  echo "RADIUS_PW_KEY=${RADIUS_PW_KEY}"
  cat "$ETC/app_keys.env"
  echo "PUBLIC_BASE_URL=https://new.bharatradius.com"
  echo "MONGO_POOL_MAX=20"
  echo "TZ_BILLING=Asia/Kolkata"
} >"$ETC/staging.env.new"
mv "$ETC/staging.env.new" "$ETC/staging.env"
umask 022

# ------------------------------------------------------------------ PostgreSQL reachable from containers
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow from "$APP_SUBNET" to any port 5432 proto tcp comment "isp-radius pg (app containers)" >/dev/null
fi

# ------------------------------------------------------------------ MongoDB
log "starting isp-mongo"
"${COMPOSE[@]}" up -d --wait mongo
ROOT_PW="$(cat "$ETC/mongo_root_pw")"
msh() { docker exec -i isp-mongo mongosh --quiet -u root -p "$ROOT_PW" --authenticationDatabase admin "$@"; }
msh --eval "try { rs.status().ok } catch (e) { rs.initiate({_id: '$REPLSET', members: [{_id: 0, host: 'isp-mongo:27017'}]}).ok }" >/dev/null
for _ in $(seq 1 30); do
  [[ "$(msh --eval 'db.hello().isWritablePrimary')" == true ]] && break
  sleep 1
done
[[ "$(msh --eval 'db.hello().isWritablePrimary')" == true ]] || die "isp-mongo did not become PRIMARY"
# --eval, not stdin: mongosh ignores errors in piped scripts, which once left isp_app uncreated.
user_js="const a = db.getSiblingDB('admin');
const r = [{ role: 'readWrite', db: 'isp' }, { role: 'readWrite', db: 'isp_staging' }];
if (a.getUser('isp_app')) a.updateUser('isp_app', { pwd: '$MONGO_APP_PW', roles: r });
else a.createUser({ user: 'isp_app', pwd: '$MONGO_APP_PW', roles: r });
print(a.getUser('isp_app') ? 'isp_app ok' : 'isp_app missing');"
[[ "$(msh --eval "$user_js")" == "isp_app ok" ]] || die "could not create MongoDB user isp_app"
log "isp-mongo: $(msh --eval 'rs.status().members[0].stateStr')"

# ------------------------------------------------------------------ API + walled garden
log "building isp-api, isp-workers, isp-web"
APP_VERSION="$(git -C "$DIR" rev-parse --short HEAD 2>/dev/null || echo dev)"
export APP_VERSION
"${COMPOSE[@]}" build api workers web
# Migrations run before the new API starts; the API refuses to start with pending migrations.
log "MongoDB migrations: $("${COMPOSE[@]}" run --rm --no-deps api node dist/cli.js migrate | tail -1)"
log "starting isp-api, isp-workers, isp-web, isp-walled-garden"
"${COMPOSE[@]}" up -d --wait api workers web walled-garden

health="$(docker exec isp-api node -e "fetch('http://127.0.0.1:4100/healthz').then(r => r.text()).then(console.log)" || true)"
log "healthz: $health"
grep -q '"status":"ok"' <<<"$health" || die "API not healthy"

# ------------------------------------------------------------------ Caddy site in the ACS stack
CF="$ACS_CADDY_DIR/Caddyfile"
[[ -f $CF ]] || die "$CF not found"
install -d -m 0755 "$ACS_CADDY_DIR/sites"
install -m 0644 "$DIR/caddy/isp.caddy" "$ACS_CADDY_DIR/sites/isp.caddy.new"
install -d -m 0700 /var/backups/isp-app
backup="/var/backups/isp-app/Caddyfile.$(date +%Y%m%d%H%M%S)"
cp -p "$CF" "$backup"
grep -qxF 'import /etc/caddy/sites/*.caddy' "$CF" || printf '\nimport /etc/caddy/sites/*.caddy\n' >>"$CF"
mv "$ACS_CADDY_DIR/sites/isp.caddy.new" "$ACS_CADDY_DIR/sites/isp.caddy"
if docker exec "$ACS_CADDY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/isp-caddy-validate.log 2>&1; then
  docker exec "$ACS_CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
  if cmp -s "$backup" "$CF"; then rm -f "$backup"; fi
  log "Caddy reloaded with new.bharatradius.com"
else
  cp -p "$backup" "$CF"; rm -f "$ACS_CADDY_DIR/sites/isp.caddy"
  tail -20 /tmp/isp-caddy-validate.log >&2
  die "Caddy config invalid; ACS Caddyfile restored, nothing reloaded"
fi

log "done. Containers: $(docker ps --filter name=isp- --format '{{.Names}}={{.Status}}' | tr '\n' ' ')"
