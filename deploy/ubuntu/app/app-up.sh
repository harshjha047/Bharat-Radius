#!/usr/bin/env bash
# App stack on the RADIUS host: our MongoDB, the API, the walled-garden redirect, and one Caddy site. Idempotent.
#   EDGE=acs: site in the ACS stack's Caddy. Never changes ACS containers or routes; adds only
#     /opt/acs/repo/infra/caddy/sites/isp.caddy  +  one "import /etc/caddy/sites/*.caddy" line in its Caddyfile.
#   EDGE=own: our own Caddy (deploy/ubuntu/edge, network "edge"), site file in /etc/isp-edge/sites/isp.caddy.
#   Default: acs if the ACS stack's network exists, else own. Remembered in settings.env.
# Usage: sudo [RADIUS_INSTANCE=staging|production] [RADIUS_PUBLIC_HOST=<ip>] bash deploy/ubuntu/app/app-up.sh
#   RADIUS_INSTANCE: which RADIUS database the panel writes routers and subscribers to (default staging). The panel
#     shows it with the host and ports routers must use. Remembered in /etc/isp-app/settings.env, so a plain rerun
#     never switches instance. production uses MongoDB database "isp", staging "isp_staging".
#   RADIUS_PUBLIC_HOST: address routers send RADIUS to (default: this host's primary public IPv4).
#   PANEL_HOSTS: space-separated host names Caddy serves the panel on (default new.bharatradius.com); the first is
#     the canonical address (links in SMS, invoices, pay page). Add an ISP's own domain only after its DNS points
#     here, or Caddy keeps retrying its certificate. Remembered in settings.env like the two above.
#   MONGO_IMAGE: default mongo:8.0. MongoDB 8.x hangs at start on kernels 6.19-7.0.12 (SERVER-121912): use
#     mongo:7.0 there. Fixed per host once data exists (8.0 data cannot be opened by 7.0). Remembered.
#   CANONICAL_ORIGIN: official product site the landing page canonicalises to (default https://new.bharatradius.com).
#   APP_SUBNET (Docker networks allowed into PostgreSQL, trusted proxies) and the PostgreSQL TLS name come from
#   /etc/isp-radius/install.env (radius/scripts/install.sh).
set -Eeuo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ETC=/etc/isp-app
RSET=/etc/isp-radius/install.env
APP_SUBNET="${APP_SUBNET:-$(sed -n 's/^APP_SUBNET=//p' "$RSET" 2>/dev/null)}"
APP_SUBNET="${APP_SUBNET:-172.16.0.0/12}"
PG_HOST="$(sed -n 's/^PG_TLS_HOSTNAME=//p' "$RSET" 2>/dev/null)"; PG_HOST="${PG_HOST:-acs-prod}"
COMPOSE=(docker compose -f "$DIR/docker-compose.yml")
REPLSET=rs-isp

log() { printf '\033[1;34m[app-up]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[app-up] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }
trap 'die "failed at line $LINENO: $BASH_COMMAND"' ERR

[[ $EUID -eq 0 ]] || die "run as root"
# Disk guard drill or maintenance (disk >= 70 %): a rebuild needs several GB; free space first.
if [[ -e /run/isp-guard/pause-heavy && ${FORCE:-0} != 1 ]]; then
  die "disk guard is active ($(df --output=pcent / | tail -1 | tr -d ' ') used): free space first, or FORCE=1"
fi
install -d -m 0755 /run/isp-guard
SETTINGS="$ETC/settings.env"
if [[ -r $SETTINGS ]]; then
  while IFS='=' read -r k v; do
    case "$k" in RADIUS_INSTANCE|RADIUS_PUBLIC_HOST|PANEL_HOSTS|EDGE|CANONICAL_ORIGIN|MONGO_IMAGE) [[ -v $k ]] || printf -v "$k" '%s' "$v" ;; esac
  done <"$SETTINGS"
fi
RADIUS_INSTANCE="${RADIUS_INSTANCE:-staging}"
PANEL_HOSTS="${PANEL_HOSTS:-new.bharatradius.com}"
read -r -a HOSTS <<<"$PANEL_HOSTS"
for h in "${HOSTS[@]}"; do [[ $h =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ && $h == *.* ]] || die "PANEL_HOSTS: '$h' is not a host name"; done
PRIMARY_HOST="${HOSTS[0]}"
EXTRA_ORIGINS=""; for h in "${HOSTS[@]:1}"; do EXTRA_ORIGINS+="${EXTRA_ORIGINS:+,}https://$h"; done
case "$RADIUS_INSTANCE" in
  staging) MONGO_DB=isp_staging ;;
  production) MONGO_DB=isp ;;
  *) die "RADIUS_INSTANCE must be staging or production" ;;
esac
RADIUS_PUBLIC_HOST="${RADIUS_PUBLIC_HOST:-$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')}"
command -v docker >/dev/null || die "docker not installed"
if [[ -z ${EDGE:-} ]]; then EDGE=own; docker network inspect acs_default >/dev/null 2>&1 && EDGE=acs; fi
case "$EDGE" in
  acs) EDGE_NETWORK=acs_default
       CADDY_DIR="${ACS_CADDY_DIR:-/opt/acs/repo/infra/caddy}"; CADDY_CF="$CADDY_DIR/Caddyfile"; CADDY_SITES="$CADDY_DIR/sites"
       CADDY_CONTAINER="${ACS_CADDY_CONTAINER:-acs-caddy-1}"
       docker network inspect acs_default >/dev/null 2>&1 || die "docker network acs_default not found (ACS stack down?)" ;;
  own) EDGE_NETWORK=edge; CADDY_CF=""; CADDY_SITES=/etc/isp-edge/sites; CADDY_CONTAINER=edge-caddy ;;
  *) die "EDGE must be acs or own" ;;
esac
CANONICAL_ORIGIN="${CANONICAL_ORIGIN:-https://new.bharatradius.com}"
MONGO_IMAGE="${MONGO_IMAGE:-mongo:8.0}"
[[ $MONGO_IMAGE =~ ^mongo:[0-9]+\.[0-9]+$ ]] || die "MONGO_IMAGE must look like mongo:8.0"
KERNEL="$(uname -r | cut -d- -f1)"
if [[ $MONGO_IMAGE == mongo:8.* ]] && dpkg --compare-versions "$KERNEL" ge 6.19 && dpkg --compare-versions "$KERNEL" lt 7.0.13; then
  die "kernel $KERNEL: $MONGO_IMAGE hangs at start (SERVER-121912). New host: rerun with MONGO_IMAGE=mongo:7.0"
fi
[[ $CANONICAL_ORIGIN =~ ^https://[a-z0-9.-]+$ ]] || die "CANONICAL_ORIGIN must be https://<host>"
export EDGE_NETWORK APP_SUBNET PG_HOST CANONICAL_ORIGIN MONGO_IMAGE PANEL_HOST="$PRIMARY_HOST"
# Non-secret; read by docker compose itself, so hand-run commands (exec, logs, up) resolve the same values.
for d in "$DIR" "$DIR/../monitoring"; do
  printf '%s=%s\n' EDGE_NETWORK "$EDGE_NETWORK" APP_SUBNET "$APP_SUBNET" PG_HOST "$PG_HOST" \
    CANONICAL_ORIGIN "$CANONICAL_ORIGIN" MONGO_IMAGE "$MONGO_IMAGE" PANEL_HOST "$PRIMARY_HOST" >"$d/.env"
done
RCONF=/etc/isp-radius/$RADIUS_INSTANCE.conf
RAPP=/etc/isp-radius/$RADIUS_INSTANCE.app.env
[[ -s $RCONF && -s $RAPP && -s /etc/isp-radius/tls/ca.crt ]] || die "run radius/scripts/install.sh $RADIUS_INSTANCE first"
R_DB="$(sed -n 's/^DB=//p' "$RCONF")"; R_ROLE="$(sed -n 's/^APP_ROLE=//p' "$RCONF")"
R_AUTH="$(sed -n 's/^AUTH_PORT=//p' "$RCONF")"; R_ACCT="$(sed -n 's/^ACCT_PORT=//p' "$RCONF")"
grep -qE "^hostssl +$R_DB +$R_ROLE +$APP_SUBNET" "$(runuser -u postgres -- psql -XtAc 'SHOW hba_file')" \
  || die "PostgreSQL does not accept the app subnet yet: rerun install.sh with APP_SUBNET=$APP_SUBNET"

# ------------------------------------------------------------------ secrets (generated once)
install -d -m 0700 "$ETC"
# Log archive (WP 4.6): the API container reads NAT logs as group isp-archive (fixed gid, see docker-compose.yml).
getent group isp-archive >/dev/null || groupadd -g 2470 isp-archive
# Owner syslog + setgid, as logs-setup.sh sets it: rsyslogd runs as syslog and must be able to create files here.
WRITER=syslog; id -u syslog >/dev/null 2>&1 || WRITER=root
install -d -o "$WRITER" -g isp-archive -m 2750 /var/log/isp-archive /var/log/isp-archive/nat
# Private files (WP 4.5): owned by the container user (node, uid 1000); content is encrypted by the API.
install -d -o 1000 -g 1000 -m 0700 /var/lib/isp-files
gen() { openssl rand -hex "${1:-24}"; }
[[ -s $ETC/mongo.keyfile ]] || openssl rand -base64 756 | tr -d '\n' >"$ETC/mongo.keyfile"
[[ -s $ETC/mongo_root_pw ]] || gen >"$ETC/mongo_root_pw"
[[ -s $ETC/mongo_app_pw ]] || gen >"$ETC/mongo_app_pw"
[[ -s $ETC/app_keys.env ]] || printf 'JWT_SIGNING_KEY=%s\nREFRESH_TOKEN_PEPPER=%s\nFIELD_ENCRYPTION_KEY=%s\n' \
  "$(gen 32)" "$(gen 32)" "$(openssl rand -base64 32)" >"$ETC/app_keys.env"
# mongod in the container runs as uid 999 and refuses a keyfile readable by others.
chown 999:999 "$ETC/mongo.keyfile" "$ETC/mongo_root_pw"; chmod 0400 "$ETC/mongo.keyfile" "$ETC/mongo_root_pw"
chmod 0600 "$ETC/mongo_app_pw" "$ETC/app_keys.env"

APP_DB_PASSWORD="$(sed -n 's/^APP_DB_PASSWORD=//p' "$RAPP")"
RADIUS_PW_KEY="$(sed -n 's/^RADIUS_PW_KEY=//p' "$RAPP")"
MONGO_APP_PW="$(cat "$ETC/mongo_app_pw")"
umask 077
{
  echo "NODE_ENV=production"
  echo "MONGO_URL=mongodb://isp_app:${MONGO_APP_PW}@isp-mongo:27017/${MONGO_DB}?replicaSet=${REPLSET}&authSource=admin"
  echo "RADIUS_DB_URL=postgres://${R_ROLE}:${APP_DB_PASSWORD}@${PG_HOST}:5432/${R_DB}?sslmode=verify-full&sslrootcert=/etc/isp/radius-ca.crt"
  echo "RADIUS_DB_POOL_MAX=10"
  echo "RADIUS_PW_KEY=${RADIUS_PW_KEY}"
  echo "RADIUS_INSTANCE=${RADIUS_INSTANCE}"
  echo "RADIUS_AUTH_PORT=${R_AUTH}"
  echo "RADIUS_ACCT_PORT=${R_ACCT}"
  [[ -z $RADIUS_PUBLIC_HOST ]] || echo "RADIUS_PUBLIC_HOST=${RADIUS_PUBLIC_HOST}"
  cat "$ETC/app_keys.env"
  echo "PUBLIC_BASE_URL=https://${PRIMARY_HOST}"
  [[ -z $EXTRA_ORIGINS ]] || echo "ALLOWED_ORIGINS=${EXTRA_ORIGINS}"
  echo "MONGO_POOL_MAX=20"
  echo "TZ_BILLING=Asia/Kolkata"
  # Off-site private file bucket (B2 S3 API), written by deploy/ubuntu/app/files-setup.sh; absent = local disk.
  [[ ! -s $ETC/files.env ]] || cat "$ETC/files.env"
} >"$ETC/app.env.new"
mv "$ETC/app.env.new" "$ETC/app.env"
rm -f "$ETC/staging.env"
printf '%s=%s\n' RADIUS_INSTANCE "$RADIUS_INSTANCE" RADIUS_PUBLIC_HOST "$RADIUS_PUBLIC_HOST" PANEL_HOSTS "$PANEL_HOSTS" \
  EDGE "$EDGE" CANONICAL_ORIGIN "$CANONICAL_ORIGIN" MONGO_IMAGE "$MONGO_IMAGE" >"$SETTINGS"
umask 022
log "edge: $EDGE ($EDGE_NETWORK), PostgreSQL as $PG_HOST, app subnet $APP_SUBNET"
log "panel → RADIUS $RADIUS_INSTANCE ($R_DB): routers use ${RADIUS_PUBLIC_HOST:-<host>} auth $R_AUTH / acct $R_ACCT, MongoDB $MONGO_DB"

# ------------------------------------------------------------------ PostgreSQL reachable from containers
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow from "$APP_SUBNET" to any port 5432 proto tcp comment "isp-radius pg (app containers)" >/dev/null
fi

# ------------------------------------------------------------------ own edge Caddy
if [[ $EDGE == own ]]; then
  install -d -m 0755 /etc/isp-edge "$CADDY_SITES"
  log "starting edge-caddy (80/443)"
  docker compose -f "$DIR/../edge/docker-compose.yml" up -d --wait
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
# Build cache and replaced images otherwise grow without bound (16 Nov 2026: ~37 GB). Prune now; BuildKit GC in
# daemon.json keeps it bounded between deploys once Docker restarts (never restarted here: it hosts the ACS stack).
docker builder prune -f --keep-storage 10GB >/dev/null || true
docker image prune -f --filter "label=com.docker.compose.project=isp" >/dev/null || true
python3 - <<'PY' || log "could not update /etc/docker/daemon.json; set builder.gc by hand"
import json, os
p = "/etc/docker/daemon.json"
d = json.load(open(p)) if os.path.exists(p) and os.path.getsize(p) else {}
gc = d.setdefault("builder", {}).setdefault("gc", {})
if gc.get("enabled") is not True or "defaultKeepStorage" not in gc:
    gc.update({"enabled": True, "defaultKeepStorage": gc.get("defaultKeepStorage", "10GB")})
    tmp = p + ".isp-new"
    with open(tmp, "w") as f:
        json.dump(d, f, indent=2)
    os.replace(tmp, p)
    print("daemon.json: builder.gc enabled (applies at the next Docker restart)")
PY
# Migrations run before the new API starts; the API refuses to start with pending migrations.
log "MongoDB migrations: $("${COMPOSE[@]}" run --rm --no-deps api node dist/cli.js migrate | tail -1)"
log "starting isp-api, isp-workers, isp-web, isp-walled-garden"
"${COMPOSE[@]}" up -d --wait api workers web walled-garden

health="$(docker exec isp-api node -e "fetch('http://127.0.0.1:4100/healthz').then(r => r.text()).then(console.log)" || true)"
log "healthz: $health"
grep -q '"status":"ok"' <<<"$health" || die "API not healthy"

# ------------------------------------------------------------------ Caddy site
install -d -m 0755 "$CADDY_SITES"
# The site block's first line lists every panel host (PANEL_HOSTS).
sed "s|^new.bharatradius.com {|${HOSTS[*]} {|" "$DIR/caddy/isp.caddy" >"$CADDY_SITES/isp.caddy.new"
chmod 0644 "$CADDY_SITES/isp.caddy.new"
install -d -m 0700 /var/backups/isp-app
stamp="$(date +%Y%m%d%H%M%S)"
backup_cf=""; backup_site=""
if [[ -n $CADDY_CF ]]; then
  [[ -f $CADDY_CF ]] || die "$CADDY_CF not found"
  backup_cf="/var/backups/isp-app/Caddyfile.$stamp"; cp -p "$CADDY_CF" "$backup_cf"
  grep -qxF 'import /etc/caddy/sites/*.caddy' "$CADDY_CF" || printf '\nimport /etc/caddy/sites/*.caddy\n' >>"$CADDY_CF"
fi
if [[ -f $CADDY_SITES/isp.caddy ]]; then backup_site="/var/backups/isp-app/isp.caddy.$stamp"; cp -p "$CADDY_SITES/isp.caddy" "$backup_site"; fi
mv "$CADDY_SITES/isp.caddy.new" "$CADDY_SITES/isp.caddy"
if docker exec "$CADDY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/isp-caddy-validate.log 2>&1; then
  docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
  [[ -z $backup_cf ]] || ! cmp -s "$backup_cf" "$CADDY_CF" || rm -f "$backup_cf"
  [[ -z $backup_site ]] || rm -f "$backup_site"
  log "Caddy ($CADDY_CONTAINER) reloaded with ${HOSTS[*]}"
else
  [[ -z $backup_cf ]] || cp -p "$backup_cf" "$CADDY_CF"
  if [[ -n $backup_site ]]; then cp -p "$backup_site" "$CADDY_SITES/isp.caddy"; else rm -f "$CADDY_SITES/isp.caddy"; fi
  tail -20 /tmp/isp-caddy-validate.log >&2
  die "Caddy config invalid; previous config restored, nothing reloaded"
fi

log "done. Containers: $(docker ps --filter name=isp- --format '{{.Names}}={{.Status}}' | tr '\n' ' ')"
