#!/usr/bin/env bash
# Prometheus exporters on the Ubuntu RADIUS VPS. Scraped only by the Windows VPS (WINDOWS_IP).
# Usage: sudo WINDOWS_IP=198.51.100.10 ./install-exporters.sh
set -Eeuo pipefail
WINDOWS_IP="${WINDOWS_IP:?WINDOWS_IP required}"
FR_EXPORTER_VERSION="${FR_EXPORTER_VERSION:-0.1.7}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log() { printf '\033[1;34m[exporters]\033[0m %s\n' "$*"; }
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }

log "node and postgres exporters (Ubuntu packages)"
apt-get install -y -qq prometheus-node-exporter prometheus-postgres-exporter >/dev/null
echo 'ARGS="--collector.systemd --collector.systemd.unit-include=(freeradius.*|isp-radius.*|postgresql.*|genieacs.*)\.service"' \
  >/etc/default/prometheus-node-exporter
systemctl restart prometheus-node-exporter

runuser -u postgres -- psql -Xq -v ON_ERROR_STOP=1 -d postgres <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'prometheus') THEN CREATE ROLE prometheus LOGIN; END IF;
END $$;
GRANT pg_monitor TO prometheus;
SQL
for db in radius radius_staging; do
  runuser -u postgres -- psql -Xq -d "$db" -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements; GRANT CONNECT ON DATABASE $db TO prometheus; GRANT USAGE ON SCHEMA public TO prometheus; GRANT SELECT ON radpostauth, radacct, tenants TO prometheus;" 2>/dev/null || true
done
grep -q '^local[[:space:]]\+all[[:space:]]\+prometheus' /etc/postgresql/16/main/pg_hba.conf || \
  sed -i '/^# END isp-radius/i local   all             prometheus                              peer' /etc/postgresql/16/main/pg_hba.conf
runuser -u postgres -- psql -Xqc "SELECT pg_reload_conf()" >/dev/null

install -m 0644 "$DIR/postgres-exporter-queries.yaml" /etc/prometheus/isp-queries.yaml
cat >/etc/default/prometheus-postgres-exporter <<'EOF'
DATA_SOURCE_NAME="user=prometheus host=/run/postgresql dbname=radius sslmode=disable"
ARGS="--web.listen-address=:9187 --extend.query-path=/etc/prometheus/isp-queries.yaml --no-collector.stat_bgwriter"
EOF
systemctl restart prometheus-postgres-exporter

log "freeradius_exporter $FR_EXPORTER_VERSION"
if ! /usr/local/bin/freeradius_exporter --version 2>&1 | grep -q "$FR_EXPORTER_VERSION"; then
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/fe.tgz" \
    "https://github.com/bvantagelimited/freeradius_exporter/releases/download/${FR_EXPORTER_VERSION}/freeradius_exporter-${FR_EXPORTER_VERSION}-amd64.tar.gz"
  tar -xzf "$tmp/fe.tgz" -C "$tmp"
  install -m 0755 "$(find "$tmp" -name freeradius_exporter -type f | head -1)" /usr/local/bin/freeradius_exporter
  rm -rf "$tmp"
fi
for inst in production staging; do
  [[ -f /etc/isp-radius/$inst.conf ]] || continue
  . "/etc/isp-radius/$inst.conf"
  port=$([[ $inst == production ]] && echo 9812 || echo 9813)
  install -m 0640 -o root -g root /dev/null "/etc/isp-radius/exporter-$inst.env"
  printf 'RADIUS_SECRET=%s\n' "$(sed -n 's/^FR_STATUS_SECRET=//p' "/etc/isp-radius/$inst.env")" >"/etc/isp-radius/exporter-$inst.env"
  cat >"/etc/systemd/system/freeradius-exporter@$inst.service" <<EOF
[Unit]
Description=FreeRADIUS exporter ($inst)
After=network-online.target

[Service]
EnvironmentFile=/etc/isp-radius/exporter-$inst.env
ExecStart=/bin/sh -c 'exec /usr/local/bin/freeradius_exporter -radius.address=127.0.0.1:$STATUS_PORT -radius.secret="\$RADIUS_SECRET" -web.listen-address=:$port'
DynamicUser=yes
Restart=always
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
EOF
done
systemctl daemon-reload
for inst in production staging; do
  [[ -f /etc/isp-radius/$inst.conf ]] && systemctl enable -q --now "freeradius-exporter@$inst"
done

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  for p in 9100 9187 9812 9813; do ufw allow from "$WINDOWS_IP" to any port "$p" proto tcp comment "isp-radius metrics" >/dev/null; done
else
  log "ufw inactive: restrict TCP 9100,9187,9812,9813 to $WINDOWS_IP in the provider firewall"
fi
log "done: node :9100, postgres :9187, freeradius :9812 (prod) / :9813 (staging)"
