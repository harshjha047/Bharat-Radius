#!/usr/bin/env bash
# Login load test: N users, P in flight, PAP. Pass = zero rejects/timeouts and rate >= TARGET.
# Usage: sudo INSTANCE=staging USERS=20000 PARALLEL=200 TARGET=2000 ./load.sh
set -Euo pipefail
INSTANCE="${INSTANCE:-staging}"; USERS="${USERS:-20000}"; PARALLEL="${PARALLEL:-200}"; TARGET="${TARGET:-2000}"
. "/etc/isp-radius/$INSTANCE.conf"
set -a; . "/etc/isp-radius/$INSTANCE.env"; set +a
MAINT="${MAINT:-/opt/isp-radius/scripts/maint.sh}"
SECRET="e2e-load-$(openssl rand -hex 8)"
WORK="$(mktemp -d)"
q() { runuser -u postgres -- psql -XtAq -v ON_ERROR_STOP=1 -d "$DB" "$@"; }
cleanup() {
  q -c "DELETE FROM radpostauth WHERE tenant_id IN (SELECT id FROM tenants WHERE slug='e2e-load'); DELETE FROM tenants WHERE slug='e2e-load'" >/dev/null
  "$MAINT" "$INSTANCE" nas-watch >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
cleanup; WORK="$(mktemp -d)"

echo "seeding $USERS subscribers"
q -1 -v key="$RADIUS_PW_KEY" -v n="$USERS" -v secret="$SECRET" <<'SQL'
INSERT INTO tenants (slug, name) VALUES ('e2e-load', 'Load test');
INSERT INTO plans (tenant_id, name, rate_limit) SELECT id, 'load', '20M/20M' FROM tenants WHERE slug='e2e-load';
INSERT INTO subscribers (tenant_id, username, password_enc, plan_id, expires_at)
SELECT t.id, 'load' || g, radius_encrypt_password('pw' || g, :'key'), p.id, now() + interval '30 days'
  FROM tenants t JOIN plans p ON p.tenant_id = t.id, generate_series(1, :n) g WHERE t.slug = 'e2e-load';
INSERT INTO nas (tenant_id, nasname, shortname, secret) SELECT id, '127.0.0.1', 'load', :'secret' FROM tenants WHERE slug='e2e-load';
ANALYZE subscribers;
SQL
"$MAINT" "$INSTANCE" nas-watch >/dev/null
for i in $(seq 1 "$USERS"); do printf 'User-Name = "load%d"\nUser-Password = "pw%d"\nNAS-Port-Type = Virtual\n\n' "$i" "$i"; done >"$WORK/req"

echo "running: $USERS logins, $PARALLEL in flight"
start=$(date +%s.%N)
radclient -q -s -p "$PARALLEL" -r 3 -t 3 -f "$WORK/req" "127.0.0.1:$AUTH_PORT" auth "$SECRET" >"$WORK/out" 2>&1 || true
end=$(date +%s.%N)
accepted=$(sed -n 's/.*Accepted *: *\([0-9]*\).*/\1/p' "$WORK/out" | head -1)
rejected=$(sed -n 's/.*Rejected *: *\([0-9]*\).*/\1/p' "$WORK/out" | head -1)
lost=$(sed -n 's/.*Lost *: *\([0-9]*\).*/\1/p' "$WORK/out" | head -1)
secs=$(echo "$end - $start" | bc -l)
rate=$(echo "$USERS / $secs" | bc)
printf 'result: %d logins in %.2f s = %d/s; accepted=%s rejected=%s lost=%s (cores: %s)\n' \
  "$USERS" "$secs" "$rate" "${accepted:-?}" "${rejected:-?}" "${lost:-?}" "$(nproc)"
q -c "SELECT '  reject reason: ' || coalesce(reason,'?') || ' x' || count(*) FROM radpostauth WHERE tenant_id=(SELECT id FROM tenants WHERE slug='e2e-load') AND reply='Access-Reject' GROUP BY reason"
[[ "${accepted:-0}" == "$USERS" && "${rejected:-1}" == 0 && "${lost:-1}" == 0 ]] || { echo "FAIL: rejects or timeouts"; exit 1; }
(( rate >= TARGET )) || { echo "FAIL: below target $TARGET/s"; exit 2; }
echo "PASS"
