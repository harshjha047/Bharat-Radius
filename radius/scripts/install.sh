#!/usr/bin/env bash
# Idempotent installer for the RADIUS hot path (FreeRADIUS 3.2 + PostgreSQL 16 or 18) on Ubuntu 24.04 / 26.04.
# Usage: sudo PG_TLS_HOSTNAME=radius.example.net [APP_SUBNET=172.16.0.0/12] [WINDOWS_IP=203.0.113.10] ./install.sh [production|staging|all]
#   APP_SUBNET: Docker networks of the app stack on this host (deploy/ubuntu/app); app roles may connect from there over TLS.
#     Must not contain any address of this host (e.g. a provider private network in 172.16.0.0/12): set Docker's
#     default-address-pools to a free range first and pass that range here.
#   PG_VER: PostgreSQL major. Default: the existing cluster, else the Ubuntu release's own (24.04: 16, 26.04: 18).
#   PG_SHARED_BUFFERS / PG_EFFECTIVE_CACHE_SIZE: default 1GB / 3GB (sized for the shared 8 GB VPS).
#   WINDOWS_IP: remote app host (Windows plan); app roles + replication may connect from there over TLS.
# Never touches GenieACS; never enables a firewall (adds rules only if ufw is already active).
set -Eeuo pipefail

INSTANCES_ARG="${1:-all}"
# Settings of the previous run are reused when not given again, so a plain rerun never drops app access or
# re-issues the TLS certificate under another name. An explicit empty value (APP_SUBNET=) still clears one.
SETTINGS=/etc/isp-radius/install.env
if [[ -r $SETTINGS ]]; then
  while IFS='=' read -r k v; do
    case "$k" in
      WINDOWS_IP|APP_SUBNET|PG_TLS_HOSTNAME|PG_TLS_IP|PG_VER|PG_SHARED_BUFFERS|PG_EFFECTIVE_CACHE_SIZE)
        [[ -v $k ]] || printf -v "$k" '%s' "$v" ;;
    esac
  done <"$SETTINGS"
fi
WINDOWS_IP="${WINDOWS_IP:-}"
APP_SUBNET="${APP_SUBNET:-}"
PG_TLS_HOSTNAME="${PG_TLS_HOSTNAME:-$(hostname -f 2>/dev/null || hostname)}"
PG_TLS_IP="${PG_TLS_IP:-}"
PG_SHARED_BUFFERS="${PG_SHARED_BUFFERS:-1GB}"
PG_EFFECTIVE_CACHE_SIZE="${PG_EFFECTIVE_CACHE_SIZE:-3GB}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPT_DIR=/opt/isp-radius
ETC_DIR=/etc/isp-radius
STATE_DIR=/var/lib/isp-radius
BACKUP_DIR=/var/backups/isp-radius
TS="$(date +%Y%m%d-%H%M%S)"
HAS_SYSTEMD=0; [[ -d /run/systemd/system ]] && HAS_SYSTEMD=1

log() { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[install] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }
trap 'die "failed at line $LINENO: $BASH_COMMAND"' ERR

[[ $EUID -eq 0 ]] || die "run as root"
. /etc/os-release
[[ "$ID" == ubuntu ]] || die "Ubuntu required (found $ID)"
case "$INSTANCES_ARG" in
  production|staging) INSTANCES=("$INSTANCES_ARG") ;;
  all) INSTANCES=(production staging) ;;
  *) die "instance must be production, staging or all" ;;
esac
if [[ -n "$WINDOWS_IP" ]]; then
  [[ "$WINDOWS_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "WINDOWS_IP must be an IPv4 address"
fi
if [[ -n "$APP_SUBNET" ]]; then
  [[ "$APP_SUBNET" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$ ]] || die "APP_SUBNET must be an IPv4 CIDR"
  # A host address inside APP_SUBNET would let that network reach PostgreSQL and the exporters (pg_hba + ufw trust it).
  clash="$(ip -4 -o addr show | awk '$2 != "lo" && $2 != "docker0" && $2 !~ /^(br-|veth)/ {print $4}' | python3 -c '
import ipaddress, sys
net = ipaddress.ip_network(sys.argv[1], strict=False)
print(" ".join(a for a in sys.stdin.read().split() if ipaddress.ip_interface(a).ip in net))' "$APP_SUBNET")"
  [[ -z $clash ]] || die "APP_SUBNET $APP_SUBNET contains this host's address $clash: use Docker's own range (/etc/docker/daemon.json default-address-pools)"
fi
for v in PG_SHARED_BUFFERS PG_EFFECTIVE_CACHE_SIZE; do [[ ${!v} =~ ^[0-9]+(MB|GB)$ ]] || die "$v must look like 512MB or 4GB"; done

# PostgreSQL major: keep an existing cluster (never a silent major upgrade), else the release's default package.
if [[ -z "${PG_VER:-}" ]]; then
  PG_VER="$(for c in /etc/postgresql/*/main; do [[ -d $c ]] && basename "$(dirname "$c")"; done | sort -V | tail -1 || true)"
fi
if [[ -z "${PG_VER:-}" ]]; then
  apt-get update -qq
  PG_VER="$(apt-cache policy postgresql | sed -n 's/^ *Candidate: *\([0-9]\+\)+.*/\1/p')"
fi
[[ "$PG_VER" =~ ^1[6-9]$ ]] || die "PostgreSQL 16-19 required; set PG_VER (found '${PG_VER:-none}')"

instance_vars() {
  case "$1" in
    production) DB=radius; FR_ROLE=fr_radius; APP_ROLE=app_radius; RADDB=/etc/freeradius/3.0
                SERVICE=freeradius; AUTH_PORT=1812; ACCT_PORT=1813; STATUS_PORT=18121 ;;
    staging)    DB=radius_staging; FR_ROLE=fr_radius_staging; APP_ROLE=app_radius_staging
                RADDB=/etc/freeradius-staging/3.0; SERVICE=freeradius-staging
                AUTH_PORT=11812; ACCT_PORT=11813; STATUS_PORT=18122 ;;
  esac
}

psql_su() { runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -q "$@"; }

# ---------------------------------------------------------------- packages
log "installing packages"
export DEBIAN_FRONTEND=noninteractive
PKGS=("postgresql-$PG_VER" freeradius freeradius-postgresql freeradius-utils openssl iproute2)
missing=(); for p in "${PKGS[@]}"; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
if ((${#missing[@]})); then apt-get update -qq; apt-get install -y -qq "${missing[@]}"; fi
FR_VER="$(freeradius -v | sed -n 's/.*Version \([0-9.]*\).*/\1/p' | head -1)"
dpkg --compare-versions "$FR_VER" ge 3.2.5 || die "FreeRADIUS >= 3.2.5 required (Blast-RADIUS fixes); found $FR_VER"

# ---------------------------------------------------------------- port checks
port_owner() { ss -H -lnp "$@" 2>/dev/null | sed -n 's/.*users:((("\([^"]*\)".*/\1/p' | head -1; }
for inst in "${INSTANCES[@]}"; do
  instance_vars "$inst"
  for p in "$AUTH_PORT" "$ACCT_PORT"; do
    o="$(port_owner -u "sport = :$p")"
    [[ -z "$o" || "$o" == freeradius ]] || die "UDP $p is used by '$o'"
  done
done
o="$(port_owner -t "sport = :5432")"
[[ -z "$o" || "$o" == postgres ]] || die "TCP 5432 is used by '$o'"

# ---------------------------------------------------------------- backups
install -d -m 0700 "$BACKUP_DIR" "$STATE_DIR"
install -d -m 0755 "$ETC_DIR"
log "backing up FreeRADIUS and PostgreSQL config to $BACKUP_DIR"
BACKUP_PATHS=(/etc/freeradius "/etc/postgresql/$PG_VER/main")
[[ -d /etc/freeradius-staging ]] && BACKUP_PATHS+=(/etc/freeradius-staging)
tar -czf "$BACKUP_DIR/config-$TS.tgz" "${BACKUP_PATHS[@]}" 2>/dev/null
ls -1t "$BACKUP_DIR"/config-*.tgz | tail -n +11 | xargs -r rm -f

# ---------------------------------------------------------------- secrets
gen() { openssl rand -hex "${1:-32}"; }
for inst in "${INSTANCES[@]}"; do
  f="$ETC_DIR/$inst.env"
  if [[ ! -s "$f" ]]; then
    log "generating secrets for $inst"
    umask 077
    cat >"$f" <<EOF
PGPASSWORD=$(gen 24)
RADIUS_PW_KEY=$(gen 32)
FR_STATUS_SECRET=$(gen 16)
EOF
    . "$f"
    cat >"$ETC_DIR/$inst.app.env" <<EOF
APP_DB_PASSWORD=$(gen 24)
RADIUS_PW_KEY=$RADIUS_PW_KEY
EOF
    umask 022
  fi
  sed -i 's/^FR_DB_PASSWORD=/PGPASSWORD=/' "$f"
  chown root:freerad "$f"; chmod 0640 "$f"
  chown root:root "$ETC_DIR/$inst.app.env"; chmod 0600 "$ETC_DIR/$inst.app.env"
done
if [[ ! -s "$ETC_DIR/replication.env" ]]; then
  umask 077; echo "REPLICATOR_PASSWORD=$(gen 24)" >"$ETC_DIR/replication.env"; umask 022
fi

# ---------------------------------------------------------------- TLS for PostgreSQL
TLS_DIR="$ETC_DIR/tls"
install -d -m 0755 "$TLS_DIR"
if [[ ! -s "$TLS_DIR/ca.crt" ]]; then
  log "creating PostgreSQL CA"
  openssl req -x509 -newkey rsa:3072 -nodes -days 3650 -subj "/CN=isp-radius-ca" \
    -keyout "$TLS_DIR/ca.key" -out "$TLS_DIR/ca.crt" 2>/dev/null
  chmod 0600 "$TLS_DIR/ca.key"
fi
SAN="DNS:$PG_TLS_HOSTNAME"; [[ -n "$PG_TLS_IP" ]] && SAN="$SAN,IP:$PG_TLS_IP"
if [[ ! -s "$TLS_DIR/server.crt" ]] || ! openssl x509 -in "$TLS_DIR/server.crt" -noout -ext subjectAltName 2>/dev/null | grep -q "$PG_TLS_HOSTNAME"; then
  log "issuing PostgreSQL server certificate for $SAN"
  openssl req -newkey rsa:3072 -nodes -subj "/CN=$PG_TLS_HOSTNAME" \
    -keyout "$TLS_DIR/server.key" -out "$TLS_DIR/server.csr" 2>/dev/null
  openssl x509 -req -in "$TLS_DIR/server.csr" -CA "$TLS_DIR/ca.crt" -CAkey "$TLS_DIR/ca.key" -CAcreateserial \
    -days 825 -extfile <(printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth' "$SAN") \
    -out "$TLS_DIR/server.crt" 2>/dev/null
  rm -f "$TLS_DIR/server.csr"
fi
chown postgres:postgres "$TLS_DIR/server.key" "$TLS_DIR/server.crt"; chmod 0600 "$TLS_DIR/server.key"

# ---------------------------------------------------------------- PostgreSQL config
PGCONF=/etc/postgresql/$PG_VER/main
log "writing PostgreSQL tuning and pg_hba"
LISTEN="localhost"; [[ -n "$WINDOWS_IP$APP_SUBNET" ]] && LISTEN="*"
cat >"$PGCONF/conf.d/isp-radius.conf" <<EOF
# Managed by isp-platform install.sh. PostgreSQL $PG_VER.
listen_addresses = '$LISTEN'
port = 5432
max_connections = 200
shared_buffers = $PG_SHARED_BUFFERS
effective_cache_size = $PG_EFFECTIVE_CACHE_SIZE
work_mem = 8MB
maintenance_work_mem = 256MB
random_page_cost = 1.1
effective_io_concurrency = 200
checkpoint_completion_target = 0.9
max_wal_size = 4GB
wal_compression = on
wal_level = replica
max_wal_senders = 5
max_replication_slots = 5
max_slot_wal_keep_size = 10GB
password_encryption = scram-sha-256
ssl = on
ssl_cert_file = '$TLS_DIR/server.crt'
ssl_key_file = '$TLS_DIR/server.key'
ssl_min_protocol_version = 'TLSv1.2'
shared_preload_libraries = 'pg_stat_statements'
track_io_timing = on
log_min_duration_statement = 500
log_checkpoints = on
log_lock_waits = on
timezone = 'UTC'
EOF

HBA="$PGCONF/pg_hba.conf"
{
  echo "# BEGIN isp-radius (managed)"
  echo "local   radius          fr_radius                               scram-sha-256"
  echo "local   radius_staging  fr_radius_staging                       scram-sha-256"
  echo "host    radius          app_radius          127.0.0.1/32        scram-sha-256"
  echo "host    radius_staging  app_radius_staging  127.0.0.1/32        scram-sha-256"
  if [[ -n "$APP_SUBNET" ]]; then
    echo "hostssl radius          app_radius          $APP_SUBNET  scram-sha-256"
    echo "hostssl radius_staging  app_radius_staging  $APP_SUBNET  scram-sha-256"
  fi
  if [[ -n "$WINDOWS_IP" ]]; then
    echo "hostssl radius          app_radius          $WINDOWS_IP/32  scram-sha-256"
    echo "hostssl radius_staging  app_radius_staging  $WINDOWS_IP/32  scram-sha-256"
    echo "hostssl replication     replicator          $WINDOWS_IP/32  scram-sha-256"
  fi
  echo "# END isp-radius"
  sed '/^# BEGIN isp-radius/,/^# END isp-radius/d' "$HBA"
} >"$HBA.new"
mv "$HBA.new" "$HBA"; chown postgres:postgres "$HBA"; chmod 0640 "$HBA"

if ((HAS_SYSTEMD)); then
  systemctl enable -q postgresql
  systemctl restart postgresql@$PG_VER-main
else
  pg_ctlcluster $PG_VER main restart 2>/dev/null || pg_ctlcluster $PG_VER main start
fi
for _ in $(seq 1 30); do runuser -u postgres -- pg_isready -q && break; sleep 1; done

# ---------------------------------------------------------------- databases, roles, schema
. "$ETC_DIR/replication.env"
psql_su -d postgres <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'replicator') THEN
    CREATE ROLE replicator WITH LOGIN REPLICATION;
  END IF;
END \$\$;
ALTER ROLE replicator PASSWORD '$REPLICATOR_PASSWORD';
SQL
if [[ -n "$WINDOWS_IP" ]]; then
  psql_su -d postgres -c "SELECT pg_create_physical_replication_slot('windows_standby') WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = 'windows_standby')" >/dev/null
fi

for inst in "${INSTANCES[@]}"; do
  instance_vars "$inst"
  . "$ETC_DIR/$inst.env"; . "$ETC_DIR/$inst.app.env"
  log "[$inst] database $DB, roles $FR_ROLE / $APP_ROLE"
  psql_su -d postgres <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$FR_ROLE') THEN CREATE ROLE $FR_ROLE LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$APP_ROLE') THEN CREATE ROLE $APP_ROLE LOGIN; END IF;
END \$\$;
ALTER ROLE $FR_ROLE PASSWORD '$PGPASSWORD' CONNECTION LIMIT 80;
ALTER ROLE $APP_ROLE PASSWORD '$APP_DB_PASSWORD' CONNECTION LIMIT 40;
SQL
  runuser -u postgres -- psql -XtAc "SELECT 1 FROM pg_database WHERE datname='$DB'" | grep -q 1 \
    || runuser -u postgres -- createdb -E UTF8 -T template0 "$DB"
  psql_su -d "$DB" -c "REVOKE ALL ON DATABASE $DB FROM PUBLIC; GRANT CONNECT ON DATABASE $DB TO $FR_ROLE, $APP_ROLE;"
  psql_su -d "$DB" -c "SET client_min_messages = warning; CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
  for f in "$SRC_DIR"/sql/0*.sql; do
    v="$(basename "$f" .sql)"
    if ! runuser -u postgres -- psql -XtA -d "$DB" -c "SELECT 1 FROM schema_migrations WHERE version='$v'" | grep -q 1; then
      log "[$inst] migration $v"
      { echo "BEGIN;"; cat "$f"; echo "INSERT INTO schema_migrations(version) VALUES ('$v');"; echo "COMMIT;"; } \
        | runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -q -d "$DB"
    fi
  done
  psql_su -d "$DB" <"$SRC_DIR/sql/100_functions.sql"
  psql_su -d "$DB" -v fr_role="$FR_ROLE" -v app_role="$APP_ROLE" <"$SRC_DIR/sql/200_grants.sql"
  # The app's copy is authoritative: it encrypts with it. Role-level (not IN DATABASE) so pg_dump never carries it.
  psql_su -d postgres -v role="$FR_ROLE" -v key="$RADIUS_PW_KEY" <<<"ALTER ROLE :\"role\" SET app.pw_key = :'key';"
  psql_su -d "$DB" -c "SELECT radius_ensure_partitions(1)" >/dev/null
done

# ---------------------------------------------------------------- FreeRADIUS
install -d -m 0755 "$OPT_DIR"
# Only these two are owned here; other tools keep their files elsewhere under $OPT_DIR (e.g. monitoring/).
rm -rf "$OPT_DIR/scripts" "$OPT_DIR/sql"
cp -r "$SRC_DIR/scripts" "$SRC_DIR/sql" "$OPT_DIR/"
chmod 0755 "$OPT_DIR"/scripts/*.sh "$OPT_DIR"/scripts/*.py

render() { sed -e "s|@DB_NAME@|$DB|g" -e "s|@FR_ROLE@|$FR_ROLE|g" -e "s|@AUTH_PORT@|$AUTH_PORT|g" \
               -e "s|@ACCT_PORT@|$ACCT_PORT|g" -e "s|@STATUS_PORT@|$STATUS_PORT|g" "$1" >"$2"; }

set_conf() { # file key value  (first occurrence, keeps indentation)
  sed -i -E "0,/^([[:space:]]*)#?[[:space:]]*$2[[:space:]]*=.*/s##\1$2 = $3#" "$1"
}

for inst in "${INSTANCES[@]}"; do
  instance_vars "$inst"
  if [[ "$inst" == staging ]]; then
    log "[$inst] cloning FreeRADIUS tree to $RADDB"
    install -d -m 0755 "$(dirname "$RADDB")"
    rm -rf "$RADDB.new"; cp -a /etc/freeradius/3.0 "$RADDB.new"
    rm -rf "$RADDB"; mv "$RADDB.new" "$RADDB"
    set_conf "$RADDB/radiusd.conf" run_dir '/var/run/freeradius-staging'
    set_conf "$RADDB/radiusd.conf" logdir '/var/log/freeradius-staging'
    install -d -o freerad -g freerad -m 0750 /var/log/freeradius-staging /var/run/freeradius-staging
  fi
  log "[$inst] writing FreeRADIUS config in $RADDB"
  set_conf "$RADDB/radiusd.conf" max_requests 65536
  set_conf "$RADDB/radiusd.conf" start_servers 16
  set_conf "$RADDB/radiusd.conf" max_servers 32
  set_conf "$RADDB/radiusd.conf" min_spare_servers 8
  set_conf "$RADDB/radiusd.conf" max_spare_servers 16
  set_conf "$RADDB/radiusd.conf" max_queue_size 65536
  set_conf "$RADDB/radiusd.conf" proxy_requests no
  render "$SRC_DIR/freeradius/mods/sql" "$RADDB/mods-available/sql"
  install -m 0640 "$SRC_DIR/freeradius/mods/isp_queries.conf" "$RADDB/mods-config/sql/main/postgresql/isp_queries.conf"
  install -m 0640 "$SRC_DIR/freeradius/policy.d/isp_filter" "$RADDB/policy.d/isp_filter"
  render "$SRC_DIR/freeradius/sites/isp" "$RADDB/sites-available/isp"
  render "$SRC_DIR/freeradius/sites/status" "$RADDB/sites-available/status"
  install -m 0640 "$SRC_DIR/freeradius/clients.conf" "$RADDB/clients.conf"
  rm -f "$RADDB"/sites-enabled/* "$RADDB/mods-enabled/eap"
  ln -sf ../sites-available/isp "$RADDB/sites-enabled/isp"
  ln -sf ../sites-available/status "$RADDB/sites-enabled/status"
  ln -sf ../mods-available/sql "$RADDB/mods-enabled/sql"
  chown -R root:freerad "$RADDB"; find "$RADDB" -type f -exec chmod 0640 {} +; find "$RADDB" -type d -exec chmod 0750 {} +
  chmod 0755 "$RADDB" "$(dirname "$RADDB")"

  cat >"$ETC_DIR/$inst.conf" <<EOF
INSTANCE=$inst
DB=$DB
FR_ROLE=$FR_ROLE
APP_ROLE=$APP_ROLE
RADDB=$RADDB
SERVICE=$SERVICE
AUTH_PORT=$AUTH_PORT
ACCT_PORT=$ACCT_PORT
STATUS_PORT=$STATUS_PORT
EOF

  log "[$inst] checking FreeRADIUS config"
  ( set -a; . "$ETC_DIR/$inst.env"; set +a; freeradius -XC -d "$RADDB" >"$STATE_DIR/$inst.configcheck.log" 2>&1 ) \
    || { tail -30 "$STATE_DIR/$inst.configcheck.log" >&2; die "[$inst] FreeRADIUS config check failed"; }
done

# ---------------------------------------------------------------- services and timers
if ((HAS_SYSTEMD)); then
  install -d /etc/systemd/system/freeradius.service.d
  cat >/etc/systemd/system/freeradius.service.d/isp.conf <<EOF
[Unit]
After=postgresql.service
Wants=postgresql.service
[Service]
EnvironmentFile=$ETC_DIR/production.env
EOF
  sed -e 's|^Description=.*|Description=FreeRADIUS staging (isp-platform)|' \
      -e 's|^EnvironmentFile=.*|EnvironmentFile=/etc/isp-radius/staging.env|' \
      -e 's|\$FREERADIUS_OPTIONS|-d /etc/freeradius-staging/3.0|g' \
      -e 's|^RuntimeDirectory=.*|RuntimeDirectory=freeradius-staging|' \
      -e 's|^ReadOnlyDirectories=.*|ReadOnlyDirectories=/etc/freeradius-staging/|' \
      -e 's|^ReadWriteDirectories=.*|ReadWriteDirectories=/var/log/freeradius-staging/|' \
      -e 's|^MemoryMax=.*|MemoryMax=512M|' \
      -e 's|^After=network-online.target|After=network-online.target postgresql.service|' \
      /lib/systemd/system/freeradius.service >/etc/systemd/system/freeradius-staging.service
  install -m 0644 "$SRC_DIR"/scripts/systemd/* /etc/systemd/system/
  systemctl daemon-reload
  for inst in "${INSTANCES[@]}"; do
    instance_vars "$inst"
    systemctl enable -q "$SERVICE"
    systemctl restart "$SERVICE"
    for t in stale partitions nas-watch events; do systemctl enable -q --now "isp-radius-$t@$inst.timer"; done
  done
  # Synthetic login (WP 4.9): needs the node exporter's textfile directory.
  if [[ -d /var/lib/prometheus/node-exporter ]]; then
    "$OPT_DIR/scripts/probe.sh" setup && systemctl enable -q --now isp-radius-probe.timer \
      || log "synthetic probe setup failed; RADIUS itself is fine (run $OPT_DIR/scripts/probe.sh setup)"
  fi
else
  log "no systemd: starting services directly (CI/sandbox mode)"
  for inst in "${INSTANCES[@]}"; do "$OPT_DIR/scripts/frctl.sh" "$inst" restart; done
fi
for inst in "${INSTANCES[@]}"; do
  instance_vars "$inst"
  runuser -u postgres -- psql -XtA -d "$DB" -c "SELECT radius_nas_hash()" >"$STATE_DIR/$inst.nas.hash"
done

# ---------------------------------------------------------------- firewall (only if already active)
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  log "ufw active: adding rules"
  # RADIUS ports: only routers in the nas table (synced by the NAS watcher) plus hand-added entries in
  # $ETC_DIR/<instance>.allow (scripts/nas-allow.sh). Both instances start closed; nothing is open to all.
  for inst in "${INSTANCES[@]}"; do
    [[ -f "$ETC_DIR/$inst.allow" ]] || install -m 0644 /dev/null "$ETC_DIR/$inst.allow"
    "$OPT_DIR/scripts/nas-allow.sh" "$inst" sync | sed "s/^/[$inst] /"
  done
  [[ -n "$WINDOWS_IP" ]] && ufw allow from "$WINDOWS_IP" to any port 5432 proto tcp comment "isp-radius pg" >/dev/null
  [[ -n "$APP_SUBNET" ]] && ufw allow from "$APP_SUBNET" to any port 5432 proto tcp comment "isp-radius pg (app containers)" >/dev/null
fi

# $ETC_DIR was created 0755 above so PostgreSQL can reach tls/; never re-mode it here.
printf '%s=%s\n' WINDOWS_IP "$WINDOWS_IP" APP_SUBNET "$APP_SUBNET" PG_TLS_HOSTNAME "$PG_TLS_HOSTNAME" PG_TLS_IP "$PG_TLS_IP" \
  PG_VER "$PG_VER" PG_SHARED_BUFFERS "$PG_SHARED_BUFFERS" PG_EFFECTIVE_CACHE_SIZE "$PG_EFFECTIVE_CACHE_SIZE" >"$SETTINGS"
chmod 0600 "$SETTINGS"; chown root:root "$SETTINGS"
log "settings saved to $SETTINGS (PostgreSQL $PG_VER, APP_SUBNET=${APP_SUBNET:-none}, TLS name $PG_TLS_HOSTNAME${PG_TLS_IP:+, $PG_TLS_IP})"
log "done. App credentials: $ETC_DIR/<instance>.app.env; CA: $TLS_DIR/ca.crt (never email or paste them)."
