#!/usr/bin/env bash
# End-to-end RADIUS checks for the PRD Step 1 checklist. Run as root on the RADIUS host (or CI runner).
# Usage: sudo INSTANCE=staging ./e2e.sh      (default staging; never point at production with live routers)
# Uses two router source IPs: 127.0.0.1 (ISP A) and the host's primary IP (ISP B).
set -Euo pipefail
INSTANCE="${INSTANCE:-staging}"
. "/etc/isp-radius/$INSTANCE.conf"
set -a; . "/etc/isp-radius/$INSTANCE.env"; set +a
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAINT="${MAINT:-/opt/isp-radius/scripts/maint.sh}"
NAS_A=127.0.0.1
NAS_B="${NAS_B:-$(hostname -I | awk '{print $1}')}"
SECRET_A="e2e-$(openssl rand -hex 8)"
SECRET_B="e2e-$(openssl rand -hex 8)"
PASS=0; FAIL=0; FAILED=()

q() { runuser -u postgres -- psql -XtAq -v ON_ERROR_STOP=1 -d "$DB" "$@"; }
rc() { # nas_ip port type secret "attr=val,attr=val"
  printf '%s\n' "$5" | radclient -x -r 1 -t 2 "$1:$2" "$3" "$4" 2>&1 || true
}
auth() { rc "$1" "$AUTH_PORT" auth "$2" "$3"; }
acct() { rc "$1" "$ACCT_PORT" acct "$2" "$3"; }
check() { # name, command...
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then PASS=$((PASS + 1)); printf '  \033[32mPASS\033[0m %s\n' "$name"
  else FAIL=$((FAIL + 1)); FAILED+=("$name"); printf '  \033[31mFAIL\033[0m %s\n' "$name"; fi
}
has() { grep -qE -- "$2" <<<"$1"; }
lacks() { ! grep -qE -- "$2" <<<"$1"; }
reason() { q -c "SELECT reason FROM radpostauth WHERE tenant_id=$1 AND username='$2' ORDER BY authdate DESC, id DESC LIMIT 1"; }
eq() { [[ "$1" == "$2" ]]; }

cleanup() {
  q <<'SQL' >/dev/null
DELETE FROM radacct WHERE tenant_id IN (SELECT id FROM tenants WHERE slug LIKE 'e2e-%');
DELETE FROM radpostauth WHERE tenant_id IN (SELECT id FROM tenants WHERE slug LIKE 'e2e-%');
DELETE FROM tenants WHERE slug LIKE 'e2e-%';
SQL
}
trap 'cleanup; "$MAINT" "$INSTANCE" nas-watch >/dev/null 2>&1 || true' EXIT

echo "e2e on instance=$INSTANCE db=$DB auth=$AUTH_PORT acct=$ACCT_PORT nas_a=$NAS_A nas_b=$NAS_B"
cleanup
"$MAINT" "$INSTANCE" nas-watch >/dev/null

q -1 -v key="$RADIUS_PW_KEY" -v nas_a="$NAS_A" -v nas_b="$NAS_B" -v sa="$SECRET_A" -v sb="$SECRET_B" <<'SQL' || { echo 'seed failed' >&2; exit 1; }
INSERT INTO tenants (slug, name, expired_mode) VALUES ('e2e-a', 'E2E ISP A', 'walled'), ('e2e-b', 'E2E ISP B', 'walled');
INSERT INTO plans (tenant_id, name, rate_limit, fup_rate, ip_pool, sim_use)
SELECT id, 'p50', '50M/50M', '5M/5M', NULL, 1 FROM tenants WHERE slug = 'e2e-a' UNION ALL
SELECT id, 'pool', '20M/20M', NULL, 'pool-e2e', 1 FROM tenants WHERE slug = 'e2e-a' UNION ALL
SELECT id, 'p100', '100M/100M', NULL, NULL, 1 FROM tenants WHERE slug = 'e2e-b';
INSERT INTO plan_attributes (plan_id, attribute, op, value)
SELECT id, 'Idle-Timeout', ':=', '900' FROM plans WHERE name = 'pool';
CREATE TEMP TABLE seed (slug text, username text, pw text, plan text, status text, expires interval,
                        static_ip inet, mac text, sim int, fup boolean);
INSERT INTO seed VALUES
  ('e2e-a', 'e2e-user',      'Pa55-user',  'p50',  'active',    '30 days',  NULL, NULL, NULL, false),
  ('e2e-a', 'e2e-shared',    'Pa55-sharA', 'p50',  'active',    '30 days',  NULL, NULL, NULL, false),
  ('e2e-b', 'e2e-shared',    'Pa55-sharB', 'p100', 'active',    '30 days',  NULL, NULL, NULL, false),
  ('e2e-b', 'e2e-buser',     'Pa55-buser', 'p100', 'active',    '30 days',  NULL, NULL, NULL, false),
  ('e2e-a', 'e2e-suspended', 'Pa55-x',     'p50',  'suspended', '30 days',  NULL, NULL, NULL, false),
  ('e2e-a', 'e2e-disabled',  'Pa55-x',     'p50',  'disabled',  '30 days',  NULL, NULL, NULL, false),
  ('e2e-a', 'e2e-expired',   'Pa55-x',     'p50',  'active',    '-1 day',   NULL, NULL, NULL, false),
  ('e2e-a', 'e2e-noplan',    'Pa55-x',     NULL,   'active',    NULL,       NULL, NULL, NULL, false),
  ('e2e-a', 'e2e-mac',       'Pa55-x',     'p50',  'active',    '30 days',  NULL, 'AA:BB:CC:DD:EE:FF', NULL, false),
  ('e2e-a', 'e2e-static',    'Pa55-x',     'p50',  'active',    '30 days',  '100.64.9.9', NULL, NULL, false),
  ('e2e-a', 'e2e-pool',      'Pa55-x',     'pool', 'active',    '30 days',  NULL, NULL, NULL, false),
  ('e2e-a', 'e2e-fup',       'Pa55-x',     'p50',  'active',    '30 days',  NULL, NULL, NULL, true),
  ('e2e-a', 'e2e-sim',       'Pa55-x',     'p50',  'active',    '30 days',  NULL, NULL, NULL, false),
  ('e2e-a', 'e2e-acct',      'Pa55-x',     'p50',  'active',    '30 days',  NULL, NULL, NULL, false),
  ('e2e-a', 'e2e-realm@123', 'Pa55-x',     'p50',  'active',    '30 days',  NULL, NULL, NULL, false);
INSERT INTO subscribers (tenant_id, username, password_enc, plan_id, status, expires_at, static_ip, mac_lock, sim_use, fup_active)
SELECT t.id, s.username, radius_encrypt_password(s.pw, :'key'), p.id, s.status,
       CASE WHEN s.expires IS NOT NULL THEN now() + s.expires END, s.static_ip, s.mac, s.sim, s.fup
  FROM seed s JOIN tenants t ON t.slug = s.slug LEFT JOIN plans p ON p.tenant_id = t.id AND p.name = s.plan;
INSERT INTO nas (tenant_id, nasname, shortname, secret)
SELECT id, :'nas_a'::inet, 'e2e-router-a', :'sa' FROM tenants WHERE slug = 'e2e-a' UNION ALL
SELECT id, :'nas_b'::inet, 'e2e-router-b', :'sb' FROM tenants WHERE slug = 'e2e-b';
SQL
TA="$(q -c "SELECT id FROM tenants WHERE slug='e2e-a'")"
TB="$(q -c "SELECT id FROM tenants WHERE slug='e2e-b'")"

echo "[routers]"
r="$(auth "$NAS_A" "$SECRET_A" 'User-Name=e2e-user,User-Password=Pa55-user')"
check "unregistered router is ignored before the NAS watcher runs" lacks "$r" "Received Access"
"$MAINT" "$INSTANCE" nas-watch >/dev/null
r="$(auth "$NAS_A" "$SECRET_A" 'User-Name=e2e-user,User-Password=Pa55-user')"
check "router added to nas is accepted after the NAS watcher (FR-R11)" has "$r" "Received Access-Accept"

echo "[authentication methods]"
check "PAP accepted with plan speed" has "$r" 'Mikrotik-Rate-Limit = "50M/50M"'
check "Access-Accept carries Message-Authenticator" has "$r" "Message-Authenticator"
check "Acct-Interim-Interval = 300" has "$r" "Acct-Interim-Interval = 300"
st="$(sed -n 's/.*Session-Timeout = \([0-9]*\).*/\1/p' <<<"$r")"
check "Session-Timeout = time to expiry (~30 days)" test "${st:-0}" -gt 2591000 -a "${st:-0}" -le 2592000
r="$(auth "$NAS_A" "$SECRET_A" 'User-Name=e2e-user,CHAP-Password=Pa55-user')"
check "CHAP accepted with plan speed" has "$(tr '\n' ' ' <<<"$r")" 'Access-Accept.*Mikrotik-Rate-Limit = "50M/50M"'
r="$(auth "$NAS_A" "$SECRET_A" 'User-Name=e2e-user,MS-CHAP-Password=Pa55-user')"
check "MS-CHAPv1 accepted" has "$r" "Received Access-Accept"
r="$(python3 "$DIR/mschapv2.py" "$NAS_A" "$AUTH_PORT" "$SECRET_A" e2e-user Pa55-user 2>&1)"
check "MS-CHAPv2 accepted with MS-CHAP2-Success and MPPE keys" has "$(tr '\n' ' ' <<<"$r")" "ACCEPT mppe-keys success-attr"
r="$(python3 "$DIR/mschapv2.py" "$NAS_A" "$AUTH_PORT" "$SECRET_A" e2e-user wrong 2>&1)"
check "MS-CHAPv2 wrong password rejected" has "$r" "REJECT"
PROBE="$DIR/../scripts/probe.py"
r="$(python3 "$PROBE" "$NAS_A" "$AUTH_PORT" "$NAS_A" "$SECRET_A" e2e-user Pa55-user 2>&1)"
check "synthetic probe (WP 4.9): accept with verified reply authenticator" has "$r" "^accept [0-9.]+$"
r="$(python3 "$PROBE" "$NAS_A" "$AUTH_PORT" "$NAS_A" "$SECRET_A" e2e-user wrong 2>&1)"
check "synthetic probe: wrong password is a reject, not an accept" has "$r" "^reject "
r="$(python3 "$PROBE" "$NAS_A" "$AUTH_PORT" "$NAS_A" "wrong-secret-123" e2e-user Pa55-user 1 2>&1)"
check "synthetic probe: wrong secret fails" lacks "$r" "^accept"

echo "[rejects with reasons]"
r="$(auth "$NAS_A" "$SECRET_A" 'User-Name=e2e-user,User-Password=nope')"
check "wrong password rejected" has "$r" "Received Access-Reject"
check "  reason logged: Wrong password" eq "$(reason "$TA" e2e-user)" "Wrong password"
check "  Reply-Message carries the reason" has "$r" 'Reply-Message = "Wrong password"'
r="$(auth "$NAS_A" "$SECRET_A" 'User-Name=e2e-ghost,User-Password=x')"
check "unknown user rejected, reason logged" eq "$(reason "$TA" e2e-ghost)" "User not found"
auth "$NAS_A" "$SECRET_A" 'User-Name=e2e-suspended,User-Password=Pa55-x' >/dev/null
check "suspended user rejected, reason logged" eq "$(reason "$TA" e2e-suspended)" "Account suspended"
auth "$NAS_A" "$SECRET_A" 'User-Name=e2e-disabled,User-Password=Pa55-x' >/dev/null
check "disabled user rejected, reason logged" eq "$(reason "$TA" e2e-disabled)" "Account disabled"
q -c "UPDATE tenants SET status='suspended' WHERE id=$TB"
r="$(auth "$NAS_B" "$SECRET_B" 'User-Name=e2e-buser,User-Password=Pa55-buser')"
check "suspended ISP: its users rejected, reason logged" eq "$(reason "$TB" e2e-buser)" "Service provider suspended"
q -c "UPDATE tenants SET status='active' WHERE id=$TB"
r="$(auth "$NAS_A" "$SECRET_A" 'User-Name=e2e-realm@123,User-Password=Pa55-x')"
check "username with a dotless realm (john@123) accepted" has "$r" "Received Access-Accept"
r="$(auth "$NAS_A" "$SECRET_A" 'User-Name=E2E-User,User-Password=Pa55-user')"
check "username matched ignoring case (E2E-User = e2e-user)" has "$r" "Received Access-Accept"
check "  auth log keeps the subscriber's username" eq "$(q -c "SELECT username FROM radpostauth WHERE tenant_id=$TA ORDER BY authdate DESC, id DESC LIMIT 1")" "e2e-user"
auth "$NAS_A" "$SECRET_A" 'User-Name=e2e-realm@.x,User-Password=Pa55-x' >/dev/null
check "username filter reject logs the filter's reason, not 'User not found'" \
  eq "$(reason "$TA" 'e2e-realm@.x')" "Rejected: Realm begins with a dot"
lacks_rate() { lacks "$(auth "$NAS_A" "$SECRET_A" 'User-Name=e2e-suspended,User-Password=Pa55-x')" "Mikrotik-Rate-Limit"; }
check "Access-Reject carries no plan attributes" lacks_rate

echo "[multi-tenant]"
r="$(auth "$NAS_A" "$SECRET_A" 'User-Name=e2e-shared,User-Password=Pa55-sharA')"
check "same username, ISP A router -> ISP A plan" has "$r" 'Mikrotik-Rate-Limit = "50M/50M"'
r="$(auth "$NAS_B" "$SECRET_B" 'User-Name=e2e-shared,User-Password=Pa55-sharB')"
check "same username, ISP B router -> ISP B plan" has "$r" 'Mikrotik-Rate-Limit = "100M/100M"'
r="$(auth "$NAS_B" "$SECRET_B" 'User-Name=e2e-shared,User-Password=Pa55-sharA')"
check "ISP A password does not work through ISP B router" has "$r" "Received Access-Reject"
auth "$NAS_B" "$SECRET_B" 'User-Name=e2e-user,User-Password=Pa55-user' >/dev/null
check "ISP A user cannot log in through ISP B router" eq "$(reason "$TB" e2e-user)" "User not found"

echo "[plans and states]"
r="$(auth "$NAS_A" "$SECRET_A" 'User-Name=e2e-expired,User-Password=Pa55-x')"
check "expired user accepted at slow speed" has "$r" 'Mikrotik-Rate-Limit = "256k/256k"'
check "  expired user gets address list 'expired' (pay-page redirect)" has "$r" 'Mikrotik-Address-List = "expired"'
check "  expired session limited to 3600 s" has "$r" "Session-Timeout = 3600"
check "  accept logged with reason 'Plan expired'" eq "$(reason "$TA" e2e-expired)" "Plan expired"
r="$(auth "$NAS_A" "$SECRET_A" 'User-Name=e2e-noplan,User-Password=Pa55-x')"
check "user without plan treated as expired" has "$r" 'Mikrotik-Address-List = "expired"'
q -c "UPDATE tenants SET expired_mode = 'reject' WHERE id = $TA" >/dev/null
r="$(auth "$NAS_A" "$SECRET_A" 'User-Name=e2e-expired,User-Password=Pa55-x')"
check "expired_mode=reject: expired user rejected" has "$r" "Received Access-Reject"
check "  reject logged with reason 'Subscriber account expired'" eq "$(reason "$TA" e2e-expired)" "Subscriber account expired"
r="$(auth "$NAS_A" "$SECRET_A" 'User-Name=e2e-noplan,User-Password=Pa55-x')"
check "  user without plan rejected" has "$r" "Received Access-Reject"
r="$(auth "$NAS_A" "$SECRET_A" 'User-Name=e2e-user,User-Password=Pa55-user')"
check "  active user still accepted" has "$r" "Received Access-Accept"
q -c "UPDATE tenants SET expired_mode = 'walled' WHERE id = $TA" >/dev/null
r="$(auth "$NAS_A" "$SECRET_A" 'User-Name=e2e-static,User-Password=Pa55-x')"
check "static IP -> Framed-IP-Address" has "$r" "Framed-IP-Address = 100.64.9.9"
r="$(auth "$NAS_A" "$SECRET_A" 'User-Name=e2e-pool,User-Password=Pa55-x')"
check "plan pool -> Framed-Pool" has "$r" 'Framed-Pool = "pool-e2e"'
check "plan_attributes appended" has "$r" "Idle-Timeout = 900"
r="$(auth "$NAS_A" "$SECRET_A" 'User-Name=e2e-fup,User-Password=Pa55-x')"
check "FUP active -> FUP speed + address list 'fup'" has "$(tr '\n' ' ' <<<"$r")" 'Mikrotik-Rate-Limit = "5M/5M".*Mikrotik-Address-List = "fup"'

echo "[MAC lock and simultaneous use]"
r="$(auth "$NAS_A" "$SECRET_A" 'User-Name=e2e-mac,User-Password=Pa55-x,Calling-Station-Id=aa-bb-cc-dd-ee-ff')"
check "MAC lock: correct MAC accepted (case/dash-insensitive)" has "$r" "Received Access-Accept"
auth "$NAS_A" "$SECRET_A" 'User-Name=e2e-mac,User-Password=Pa55-x,Calling-Station-Id=11:22:33:44:55:66' >/dev/null
check "MAC lock: other MAC rejected, reason logged" eq "$(reason "$TA" e2e-mac)" "MAC address not allowed"
acct "$NAS_A" "$SECRET_A" 'Acct-Status-Type=Start,User-Name=E2E-Sim,Acct-Session-Id=sim-1,NAS-IP-Address=127.0.0.1,Framed-IP-Address=100.64.1.1' >/dev/null
r="$(auth "$NAS_A" "$SECRET_A" 'User-Name=e2e-sim,User-Password=Pa55-x')"
check "second login while online rejected (one-login limit; Start sent as E2E-Sim)" has "$r" "Received Access-Reject"
check "  reason logged: already logged in" eq "$(reason "$TA" e2e-sim)" "You are already logged in - access denied"
q -c "UPDATE radacct SET acctupdatetime = now() - interval '16 minutes' WHERE tenant_id=$TA AND username='e2e-sim'"
r="$(auth "$NAS_A" "$SECRET_A" 'User-Name=e2e-sim,User-Password=Pa55-x')"
check "silent (crashed-router) session does not block login" has "$r" "Received Access-Accept"

echo "[accounting]"
base='User-Name=e2e-acct,Acct-Session-Id=acct-1,NAS-IP-Address=127.0.0.1,NAS-Port-Id=ether1,Framed-IP-Address=100.64.2.2,Calling-Station-Id=AA:00:00:00:00:01'
r="$(acct "$NAS_A" "$SECRET_A" "Acct-Status-Type=Start,$base")"
check "Start answered with Accounting-Response" has "$r" "Received Accounting-Response"
row() { q -c "SELECT $1 FROM radacct WHERE tenant_id=$TA AND username='$2' ORDER BY acctstarttime DESC LIMIT 1"; }
check "Start creates open session row with ISP from router IP" eq "$(row "(acctstoptime IS NULL)::text || '/' || host(framedipaddress)" e2e-acct)" "true/100.64.2.2"
acct "$NAS_A" "$SECRET_A" "Acct-Status-Type=Interim-Update,$base,Acct-Session-Time=600,Acct-Input-Octets=100,Acct-Input-Gigawords=2,Acct-Output-Octets=5,Acct-Output-Gigawords=3" >/dev/null
check "Interim records > 4 GB using Gigawords" eq "$(row "acctinputoctets || '/' || acctoutputoctets || '/' || acctsessiontime" e2e-acct)" "8589934692/12884901893/600"
acct "$NAS_A" "$SECRET_A" "Acct-Status-Type=Stop,$base,Acct-Session-Time=900,Acct-Input-Octets=200,Acct-Input-Gigawords=2,Acct-Terminate-Cause=User-Request" >/dev/null
check "Stop closes the session with cause and final counters" eq "$(row "(acctstoptime IS NOT NULL)::text || '/' || acctterminatecause || '/' || acctinputoctets" e2e-acct)" "true/User-Request/8589934792"
check "duplicate Stop is answered and changes nothing" has "$(acct "$NAS_A" "$SECRET_A" "Acct-Status-Type=Stop,$base,Acct-Session-Time=900")" "Accounting-Response"
lost='User-Name=e2e-acct,Acct-Session-Id=acct-lost,NAS-IP-Address=127.0.0.1'
acct "$NAS_A" "$SECRET_A" "Acct-Status-Type=Interim-Update,$lost,Acct-Session-Time=3600,Acct-Input-Octets=1" >/dev/null
check "lost Start: Interim creates the session back-dated by session time" \
  eq "$(q -c "SELECT (abs(extract(epoch FROM acctstarttime - (now() - interval '3600 seconds'))) < 30)::text FROM radacct WHERE acctsessionid='acct-lost'")" "true"
for i in 1 2; do acct "$NAS_A" "$SECRET_A" "Acct-Status-Type=Start,User-Name=e2e-acct,Acct-Session-Id=boot-$i,NAS-IP-Address=127.0.0.1" >/dev/null; done
acct "$NAS_A" "$SECRET_A" 'Acct-Status-Type=Accounting-On,NAS-IP-Address=127.0.0.1' >/dev/null
check "router reboot (Accounting-On) closes its open sessions" \
  eq "$(q -c "SELECT count(*) FILTER (WHERE acctterminatecause='NAS-Reboot')::text || '/' || count(*) FILTER (WHERE acctstoptime IS NULL) FROM radacct WHERE tenant_id=$TA")" "4/0"
acct "$NAS_A" "$SECRET_A" 'Acct-Status-Type=Start,User-Name=e2e-acct,Acct-Session-Id=stale-1,NAS-IP-Address=127.0.0.1' >/dev/null
q -c "UPDATE radacct SET acctupdatetime = now() - interval '16 minutes' WHERE acctsessionid='stale-1'"
"$MAINT" "$INSTANCE" stale >/dev/null
check "session silent for 15 minutes closed as Stale-Session" eq "$(q -c "SELECT acctterminatecause FROM radacct WHERE acctsessionid='stale-1'")" "Stale-Session"
acct "$NAS_A" "$SECRET_A" 'Acct-Status-Type=Interim-Update,User-Name=e2e-acct,Acct-Session-Id=stale-1,NAS-IP-Address=127.0.0.1,Acct-Session-Time=1200' >/dev/null
check "later Interim reopens a stale-closed session" eq "$(q -c "SELECT (acctstoptime IS NULL)::text FROM radacct WHERE acctsessionid='stale-1'")" "true"
check "sessions land in monthly partitions, not the default" eq "$(q -c "SELECT count(*) FROM radacct_default WHERE tenant_id IN ($TA,$TB)")" "0"
check "partition maintenance is idempotent" eq "$(q -c "SELECT radius_ensure_partitions(1)")" "0"

echo "[unusable packets (F-17)]"
EVENTS="${EVENTS:-$(dirname "$MAINT")/log-events.sh}"
sample="$(printf '%s\n' \
  "Thu Nov 19 13:00:01 2026 : Error: Ignoring request to auth address * port $AUTH_PORT bound to server default from unknown client 203.0.113.9 port 40000 proto udp" \
  "Thu Nov 19 13:00:02 2026 : Error: Received packet from 198.51.100.7 with invalid Message-Authenticator!  (Shared secret is incorrect.) Dropping packet without response." \
  "Thu Nov 19 13:00:03 2026 : Error: Received Accounting-Request packet from client e2e-nas-a with invalid Request Authenticator!  (Shared secret is incorrect.)" \
  "Thu Nov  9 13:00:04 2026 : [12.3] [UFW BLOCK] IN=eth0 OUT= SRC=192.0.2.44 DST=10.0.0.1 LEN=60 PROTO=UDP SPT=5000 DPT=$ACCT_PORT LEN=40" \
  "Thu Nov  9 13:00:05 2026 : [12.4] [UFW BLOCK] IN=eth0 OUT= SRC=192.0.2.45 DST=10.0.0.1 LEN=60 PROTO=UDP SPT=5000 DPT=53 LEN=40" \
  | "$EVENTS" "$INSTANCE" parse)"
check "log parser: unknown client with its address and port" has "$sample" "^unknown_client	203.0.113.9	$AUTH_PORT	Thu Nov 19 13:00:01 2026$"
check "  wrong secret (auth, by address)" has "$sample" "^bad_secret	198.51.100.7	$AUTH_PORT	"
check "  wrong secret (accounting, by router name)" has "$sample" "^bad_secret_name	e2e-nas-a	$ACCT_PORT	"
check "  firewall block on this instance's port only" eq "$(grep -c firewall_block <<<"$sample")" "1"
q -c "DELETE FROM radius_events WHERE src_ip = '$NAS_A'" >/dev/null
for i in 1 2; do
  auth "$NAS_A" "wrong-secret-$i-xyz" 'User-Name=e2e-user,User-Password=Pa55-user,Message-Authenticator=0x00' >/dev/null
done
sleep 1
"$EVENTS" "$INSTANCE" || true
check "wrong shared secret from a router is recorded (radius_events)" \
  eq "$(q -c "SELECT (coalesce(sum(packets), 0) >= 1)::text FROM radius_events WHERE kind = 'bad_secret' AND src_ip = '$NAS_A' AND minute > now() - interval '5 minutes'")" "true"
first="$(q -c "SELECT sum(packets) FROM radius_events WHERE kind = 'bad_secret' AND src_ip = '$NAS_A'")"
"$EVENTS" "$INSTANCE" || true
check "  re-running the ingester does not count lines twice" \
  eq "$(q -c "SELECT sum(packets) FROM radius_events WHERE kind = 'bad_secret' AND src_ip = '$NAS_A'")" "$first"

if [[ "${DB_OUTAGE_TEST:-0}" == 1 ]]; then
  echo "[database outage] (stops PostgreSQL briefly; CI/lab only)"
  if [[ -d /run/systemd/system ]]; then pgstop() { systemctl stop postgresql@16-main; }; pgstart() { systemctl start postgresql@16-main; }
  else pgstop() { pg_ctlcluster 16 main stop; }; pgstart() { pg_ctlcluster 16 main start; }; fi
  pgstop
  r="$(auth "$NAS_A" "$SECRET_A" 'User-Name=e2e-user,User-Password=Pa55-user')"
  pgstart; sleep 3
  check "DB down: no reply (router fails over to fallback RADIUS), never a false reject" lacks "$r" "Received Access"
  r="$(auth "$NAS_A" "$SECRET_A" 'User-Name=e2e-user,User-Password=Pa55-user')"
  check "DB back: logins recover without restarting FreeRADIUS" has "$r" "Received Access-Accept"
fi

echo
echo "RESULT: $PASS passed, $FAIL failed"
((FAIL == 0)) || { printf '  failed: %s\n' "${FAILED[@]}"; exit 1; }
