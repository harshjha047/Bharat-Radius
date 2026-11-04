#!/usr/bin/env bash
# Monitoring stack (Prometheus, Alertmanager -> Telegram, Grafana at https://new.bharatradius.com/grafana/, blackbox).
# Needs: install-exporters.sh, app-up.sh (networks isp_internal, acs_default; Caddy /grafana route), and
#        /etc/isp-app/telegram_token (root, 0400).
# Usage: sudo TELEGRAM_CHAT_ID=123456789 bash deploy/ubuntu/monitoring/mon-up.sh [--test-alert]
set -Eeuo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MON=/etc/isp-app/mon
COMPOSE=(docker compose -f "$DIR/docker-compose.yml")
log() { printf '\033[1;34m[mon-up]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[mon-up] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }
trap 'die "failed at line $LINENO: $BASH_COMMAND"' ERR

[[ $EUID -eq 0 ]] || die "run as root"
[[ "${TELEGRAM_CHAT_ID:-}" =~ ^-?[0-9]+$ ]] || die "set TELEGRAM_CHAT_ID (number from getUpdates)"
[[ -s /etc/isp-app/telegram_token ]] || die "/etc/isp-app/telegram_token missing"
for n in isp_internal acs_default; do docker network inspect "$n" >/dev/null 2>&1 || die "network $n missing: run app-up.sh first"; done
node_metrics="$(curl -fsS http://127.0.0.1:9100/metrics)" || die "node exporter not answering: run install-exporters.sh first"
grep -q '^isp_radius_up' <<<"$node_metrics" || die "node exporter without isp_radius_*: run install-exporters.sh first"

install -d -m 0711 "$MON"
# alertmanager runs as nobody (65534), grafana as 472: each gets only its own secret.
install -o 65534 -g 65534 -m 0400 /etc/isp-app/telegram_token "$MON/telegram_token"
[[ -s $MON/grafana_admin_pw ]] || openssl rand -base64 18 | tr -d '/+=' >"$MON/grafana_admin_pw"
chown 472:0 "$MON/grafana_admin_pw"; chmod 0400 "$MON/grafana_admin_pw"
sed "s/__TELEGRAM_CHAT_ID__/$TELEGRAM_CHAT_ID/" "$DIR/alertmanager/alertmanager.yml.tmpl" >"$MON/alertmanager.yml"
chmod 0644 "$MON/alertmanager.yml"

log "validating configs"
"${COMPOSE[@]}" pull -q
docker run --rm --entrypoint promtool -v "$DIR/prometheus:/etc/prometheus:ro" prom/prometheus:v2.55.1 \
  check config /etc/prometheus/prometheus.yml >/dev/null
docker run --rm --entrypoint promtool -v "$DIR/prometheus:/p:ro" -w /p prom/prometheus:v2.55.1 test rules alerts.test.yml
docker run --rm --entrypoint amtool -v "$MON:/etc/alertmanager:ro" prom/alertmanager:v0.28.1 check-config /etc/alertmanager/alertmanager.yml >/dev/null

log "starting"
"${COMPOSE[@]}" up -d --wait --remove-orphans
# Single-file bind mounts keep the old inode when a secret file is replaced: restart to pick up a new token.
docker restart isp-alertmanager >/dev/null
docker exec isp-prometheus wget -qO- --post-data= http://127.0.0.1:9090/-/reload >/dev/null 2>&1 || true

sleep 20
targets="$(docker exec isp-prometheus wget -qO- 'http://127.0.0.1:9090/api/v1/targets?state=active')"
log "targets up: $(grep -o '"health":"up"' <<<"$targets" | wc -l || true), down: $(grep -o '"health":"down"' <<<"$targets" | wc -l || true)"
grep -o '"lastError":"[^"]\+"' <<<"$targets" | sed 's/^/  /' || true

if [[ "${1:-}" == --test-alert ]]; then
  docker exec isp-alertmanager amtool alert add isp_test_alert 'severity="info"' \
    --annotation='summary="Test from isp-platform monitoring: alerts reach this chat"' \
    --end="$(date -u -d '+5 minutes' +%Y-%m-%dT%H:%M:%SZ)" --alertmanager.url=http://127.0.0.1:9093
  log "test alert sent: expect a Telegram message within ~30 s"
fi
log "Grafana: https://new.bharatradius.com/grafana/  user admin, password: sudo cat $MON/grafana_admin_pw"
