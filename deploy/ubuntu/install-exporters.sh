#!/usr/bin/env bash
# Host-side metrics for the monitoring stack (deploy/ubuntu/monitoring), scraped from Docker networks only.
#   node exporter :9100  (+ systemd units, + textfile: isp_radius_* from radius-status.sh every 15 s)
#   postgres exporter :9187  (+ isp_* queries: auth results, online users, login SQL time, partitions)
# Usage: sudo [SCRAPE_FROM=<cidr>] bash deploy/ubuntu/install-exporters.sh   (default: APP_SUBNET from install.sh)
set -Eeuo pipefail
SCRAPE_FROM="${SCRAPE_FROM:-$(sed -n 's/^APP_SUBNET=//p' /etc/isp-radius/install.env 2>/dev/null)}"
SCRAPE_FROM="${SCRAPE_FROM:-172.16.0.0/12}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEXTFILE_DIR=/var/lib/prometheus/node-exporter
log() { printf '\033[1;34m[exporters]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[exporters] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }
trap 'die "failed at line $LINENO: $BASH_COMMAND"' ERR
[[ $EUID -eq 0 ]] || die "run as root"
[[ -f /etc/isp-radius/production.conf ]] || die "run radius/scripts/install.sh first"

log "packages"
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq prometheus-node-exporter prometheus-postgres-exporter bc >/dev/null

log "node exporter (systemd + textfile collectors)"
install -d -m 0755 "$TEXTFILE_DIR"
cat >/etc/default/prometheus-node-exporter <<EOF
ARGS="--collector.textfile.directory=$TEXTFILE_DIR --collector.systemd --collector.systemd.unit-include=(freeradius.*|isp-radius.*|postgresql.*|docker)\\\\.service"
EOF
systemctl restart prometheus-node-exporter

log "radius status every 15 s"
# Own directory: radius/scripts/install.sh replaces /opt/isp-radius/scripts on every run.
install -d -m 0755 /opt/isp-radius/monitoring
install -m 0755 "$DIR/monitoring/radius-status.sh" /opt/isp-radius/monitoring/radius-status.sh
rm -f /opt/isp-radius/scripts/radius-status.sh
cat >/etc/systemd/system/isp-radius-status.service <<'EOF'
[Unit]
Description=isp-radius Status-Server metrics for node exporter

[Service]
Type=oneshot
ExecStart=/opt/isp-radius/monitoring/radius-status.sh
EOF
cat >/etc/systemd/system/isp-radius-status.timer <<'EOF'
[Unit]
Description=isp-radius Status-Server metrics every 15 seconds

[Timer]
OnBootSec=20s
OnUnitActiveSec=15s
AccuracySec=1s

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable -q --now isp-radius-status.timer
systemctl reset-failed isp-radius-status.service 2>/dev/null || true

log "postgres exporter"
runuser -u postgres -- psql -Xq -v ON_ERROR_STOP=1 -d postgres <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'prometheus') THEN CREATE ROLE prometheus LOGIN; END IF;
END $$;
GRANT pg_monitor TO prometheus;
SQL
for db in radius radius_staging; do
  runuser -u postgres -- psql -XtAc "SELECT 1 FROM pg_database WHERE datname = '$db'" | grep -q 1 || continue
  runuser -u postgres -- psql -Xq -v ON_ERROR_STOP=1 -d "$db" <<SQL
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
GRANT CONNECT ON DATABASE $db TO prometheus;
GRANT USAGE ON SCHEMA public TO prometheus;
GRANT SELECT ON radpostauth, radacct, tenants, radacct_default, radpostauth_default TO prometheus;
GRANT SELECT ON pg_stat_statements, pg_stat_statements_info TO pg_read_all_stats;
GRANT EXECUTE ON FUNCTION pg_stat_statements(boolean), pg_stat_statements_info() TO pg_read_all_stats;
SQL
done
HBA="$(runuser -u postgres -- psql -XtAc 'SHOW hba_file')"
grep -q '^local[[:space:]]\+all[[:space:]]\+prometheus' "$HBA" \
  || sed -i '/^# END isp-radius/i local   all             prometheus                              peer' "$HBA"
runuser -u postgres -- psql -Xqc "SELECT pg_reload_conf()" >/dev/null
install -d -m 0755 /etc/prometheus
install -m 0644 "$DIR/postgres-exporter-queries.yaml" /etc/prometheus/isp-queries.yaml
cat >/etc/default/prometheus-postgres-exporter <<'EOF'
DATA_SOURCE_NAME="user=prometheus host=/run/postgresql dbname=radius sslmode=disable"
ARGS="--web.listen-address=:9187 --extend.query-path=/etc/prometheus/isp-queries.yaml"
EOF
systemctl restart prometheus-postgres-exporter

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow from "$SCRAPE_FROM" to any port 9100,9187 proto tcp comment "isp metrics (monitoring containers)" >/dev/null
fi

sleep 3
for p in 9100 9187; do
  curl -fsS "http://127.0.0.1:$p/metrics" >/dev/null || die "exporter on :$p not answering"
done
# Read whole responses first: "curl | grep -q" fails under pipefail when grep exits early (curl error 23).
node_metrics="$(curl -fsS http://127.0.0.1:9100/metrics)"
pg_metrics="$(curl -fsS http://127.0.0.1:9187/metrics)"
grep -q '^isp_radius_up' <<<"$node_metrics" || die "isp_radius_* metrics missing from node exporter"
grep -q '^isp_radius_default_partition_radacct_rows' <<<"$pg_metrics" || die "isp_* queries missing from postgres exporter"
log "done: node :9100 (incl. isp_radius_*), postgres :9187 (incl. isp_*)"
