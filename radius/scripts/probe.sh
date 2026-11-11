#!/usr/bin/env bash
# Synthetic RADIUS login (WP 4.9). Usage (root):
#   probe.sh setup   once per host: probe tenant/router/user in each instance's database (never synced by the app:
#                    no external_id), credentials in /etc/isp-radius/probe.env (root-only)
#   probe.sh run     every minute (isp-radius-probe.timer): one Access-Request per instance from 127.0.0.2
#                    → /var/lib/prometheus/node-exporter/isp_radius_probe.prom
set -Euo pipefail
ETC_DIR=/etc/isp-radius
ENV_FILE="$ETC_DIR/probe.env"
OUT_DIR="${OUT_DIR:-/var/lib/prometheus/node-exporter}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE_NAS_IP="${PROBE_NAS_IP:-127.0.0.2}"
PROBE_SLUG=zz-probe
PROBE_USER=probe

instances() { for c in "$ETC_DIR"/production.conf "$ETC_DIR"/staging.conf; do [[ -f $c ]] && sed -n 's/^INSTANCE=//p' "$c"; done; }
conf() { sed -n "s/^$2=//p" "$ETC_DIR/$1.conf"; }

setup() {
  umask 077
  if [[ ! -f $ENV_FILE ]]; then
    printf 'PROBE_SECRET=%s\nPROBE_PASSWORD=%s\n' "$(openssl rand -hex 16)" "$(openssl rand -hex 12)" >"$ENV_FILE"
    chmod 0600 "$ENV_FILE"
  fi
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  for inst in $(instances); do
    local db key
    db="$(conf "$inst" DB)"
    key="$(sed -n 's/^RADIUS_PW_KEY=//p' "$ETC_DIR/$inst.env")"
    runuser -u postgres -- psql -XtAq -v ON_ERROR_STOP=1 -d "$db" \
      -v slug="$PROBE_SLUG" -v nas="$PROBE_NAS_IP" -v secret="$PROBE_SECRET" -v user="$PROBE_USER" \
      -v pw="$PROBE_PASSWORD" -v key="$key" <<'SQL'
INSERT INTO tenants (slug, name) VALUES (:'slug', 'Synthetic login probe') ON CONFLICT (slug) DO NOTHING;
INSERT INTO plans (tenant_id, name, rate_limit, sim_use)
SELECT id, 'probe', '64k/64k', 1000 FROM tenants WHERE slug = :'slug'
ON CONFLICT (tenant_id, name) DO NOTHING;
INSERT INTO nas (tenant_id, nasname, shortname, secret)
SELECT id, :'nas'::inet, 'synthetic-probe', :'secret' FROM tenants WHERE slug = :'slug'
ON CONFLICT (nasname) DO UPDATE SET (secret, updated_at) = (EXCLUDED.secret, now());
INSERT INTO subscribers (tenant_id, username, password_enc, plan_id, status, expires_at)
SELECT t.id, :'user', radius_encrypt_password(:'pw', :'key'), p.id, 'active', '2099-12-31'
  FROM tenants t JOIN plans p ON p.tenant_id = t.id AND p.name = 'probe' WHERE t.slug = :'slug'
ON CONFLICT (tenant_id, username) DO UPDATE SET password_enc = EXCLUDED.password_enc, status = 'active',
  expires_at = EXCLUDED.expires_at, updated_at = now();
SQL
    [[ $? == 0 ]] || { echo "[$inst] probe seed failed" >&2; exit 1; }
    "$DIR/maint.sh" "$inst" nas-watch || exit 1
    echo "[$inst] probe ready ($PROBE_USER via $PROBE_NAS_IP)"
  done
}

run() {
  [[ -f $ENV_FILE ]] || { echo "probe not set up: $0 setup" >&2; exit 1; }
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  local tmp now
  tmp="$(mktemp "$OUT_DIR/.isp_radius_probe.XXXXXX")"
  trap 'rm -f "$tmp"' EXIT
  now="$(date +%s)"
  {
    echo '# HELP isp_radius_probe_success 1 if the synthetic PPPoE login was accepted.'
    echo '# TYPE isp_radius_probe_success gauge'
    echo '# HELP isp_radius_probe_seconds Access-Request to Access-Accept time of the synthetic login.'
    echo '# TYPE isp_radius_probe_seconds gauge'
    echo '# HELP isp_radius_probe_timestamp_seconds When the probe last ran.'
    echo '# TYPE isp_radius_probe_timestamp_seconds gauge'
    for inst in $(instances); do
      local port out ok=0
      port="$(conf "$inst" AUTH_PORT)"
      out="$(python3 "$DIR/probe.py" 127.0.0.1 "$port" "$PROBE_NAS_IP" "$PROBE_SECRET" "$PROBE_USER" "$PROBE_PASSWORD" 2 2>&1)" && ok=1
      echo "isp_radius_probe_success{instance_name=\"$inst\"} $ok"
      [[ $ok == 1 ]] && echo "isp_radius_probe_seconds{instance_name=\"$inst\"} ${out#accept }"
      echo "isp_radius_probe_timestamp_seconds{instance_name=\"$inst\"} $now"
      [[ $ok == 1 ]] || echo "[$inst] probe failed: $out" >&2
    done
  } >"$tmp"
  chmod 0644 "$tmp"
  mv "$tmp" "$OUT_DIR/isp_radius_probe.prom"
  trap - EXIT
}

case "${1:-}" in
  setup) setup ;;
  run) run ;;
  *) echo "usage: $0 setup|run" >&2; exit 2 ;;
esac
