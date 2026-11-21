#!/usr/bin/env bash
# Go-live checklist (WP 4.10/4.11), read-only: sudo bash deploy/ubuntu/preflight.sh [production|staging]
# PASS / WARN / FAIL per item; exits 1 if anything FAILs. Run before the import dry run and before each POP cutover.
set -Euo pipefail
INST="${1:-production}"
[[ $EUID -eq 0 ]] || { echo "run as root (reads root-only config)" >&2; exit 2; }
P=0; W=0; F=0
pass() { P=$((P + 1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
warn() { W=$((W + 1)); printf '  \033[33mWARN\033[0m %s\n' "$*"; }
fail() { F=$((F + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
age_h() { echo $(( ($(date +%s) - $1) / 3600 )); }

echo "[Radius $INST]"
CONF=/etc/isp-radius/$INST.conf
if [[ -s $CONF ]]; then
  pass "installed ($CONF)"
  AUTH="$(sed -n 's/^AUTH_PORT=//p' "$CONF")"; DB="$(sed -n 's/^DB=//p' "$CONF")"
  SERVICE=freeradius; [[ $INST == staging ]] && SERVICE=freeradius-staging
  systemctl is-active -q "$SERVICE" && pass "$SERVICE running" || fail "$SERVICE not running"
  ss -lun | grep -q ":$AUTH " && pass "listening on UDP $AUTH" || fail "nothing listens on UDP $AUTH"
  if grep -Eq '^any( |$)' "/etc/isp-radius/$INST.allow" 2>/dev/null; then
    warn "Radius ports open to any address (allow-list entry 'any'); routers only is safer"
  else
    pass "Radius ports limited to the router allow-list"
  fi
  for t in stale partitions nas-watch events; do
    systemctl is-active -q "isp-radius-$t@$INST.timer" || fail "timer isp-radius-$t@$INST not active"
  done
  n="$(runuser -u postgres -- psql -XtAc "SELECT count(*) FROM nas" -d "$DB" 2>/dev/null || echo '?')"
  [[ $n == 0 ]] && warn "no routers in $DB yet" || pass "$n router(s) in $DB"
  e="$(runuser -u postgres -- psql -XtAc "SELECT coalesce(sum(packets),0) FROM radius_events WHERE kind='bad_secret' AND minute > now() - interval '1 hour'" -d "$DB" 2>/dev/null || echo 0)"
  [[ $e == 0 ]] && pass "no wrong-secret packets in the last hour" || warn "$e wrong-secret packets in the last hour (Radius log → Routers)"
else
  fail "Radius $INST not installed: sudo bash radius/scripts/install.sh $INST"
fi

echo "[panel]"
S=/etc/isp-app/settings.env
PANEL_INST="$(sed -n 's/^RADIUS_INSTANCE=//p' "$S" 2>/dev/null)"
HOSTS="$(sed -n 's/^PANEL_HOSTS=//p' "$S" 2>/dev/null)"; HOSTS="${HOSTS:-new.bharatradius.com}"
[[ $PANEL_INST == "$INST" ]] && pass "panel writes to Radius $INST" \
  || warn "panel writes to Radius ${PANEL_INST:-staging}, not $INST (O-23; switch: sudo RADIUS_INSTANCE=$INST bash deploy/ubuntu/app/app-up.sh)"
for c in isp-api isp-workers isp-web isp-mongo isp-walled-garden; do
  [[ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null)" =~ ^(healthy|running)$ ]] \
    && pass "$c up" || fail "$c not up"
done
host="${HOSTS%% *}"
hdr="$(curl -fsSI --max-time 10 "https://$host/login" 2>/dev/null || true)"
if [[ -n $hdr ]]; then
  pass "https://$host answers (valid certificate)"
  csp="$(grep -i '^content-security-policy:' <<<"$hdr" | tr -d '\r')"
  if [[ $csp =~ script-src[^\;]*nonce- && ! $csp =~ script-src[^\;]*unsafe-inline ]]; then pass "CSP: scripts by nonce only"
  else fail "CSP missing or allows inline scripts"; fi
  grep -qi '^strict-transport-security:' <<<"$hdr" && pass "HSTS on" || fail "HSTS header missing"
else
  fail "https://$host/login not reachable"
fi
for f in /etc/isp-app/app.env /etc/isp-app/app_keys.env /etc/isp-app/files.env "/etc/isp-radius/$INST.app.env"; do
  [[ -e $f ]] || continue
  m="$(stat -c '%a %U' "$f")"
  [[ $m == '600 root' || $m == '400 root' ]] && pass "$f root-only" || fail "$f is $m (want 600 root)"
done
# Radius engine env: install.sh sets root:freerad 0640 (the service group); nobody else may read it.
f="/etc/isp-radius/$INST.env"
if [[ -e $f ]]; then
  m="$(stat -c '%a %U %G' "$f")"
  [[ $m == '640 root freerad' || $m == '600 root root' || $m == '600 root freerad' ]] && pass "$f readable by root and freerad only" \
    || fail "$f is $m (want 640 root freerad: sudo bash radius/scripts/install.sh $INST)"
fi
[[ -s /etc/isp-app/files.env ]] && pass "KYC / logo files in the off-site bucket" \
  || warn "KYC / logo files on local disk (/var/lib/isp-files); bucket: docs/runbooks/kyc.md"

echo "[data]"
q() { docker exec isp-mongo mongosh --quiet -u root -p "$(cat /etc/isp-app/mongo_root_pw)" --authenticationDatabase admin "$1" --eval "$2" 2>/dev/null; }
MDB=isp; [[ ${PANEL_INST:-staging} == staging ]] && MDB=isp_staging
pv="$(q "$MDB" 'db.tenants.countDocuments({status: "active", "privacy.version": {$gte: 1}}) + "/" + db.tenants.countDocuments({status: "active"})')"
[[ $pv =~ ^([0-9]+)/([0-9]+)$ ]] && { [[ ${BASH_REMATCH[1]} == "${BASH_REMATCH[2]}" ]] && pass "privacy notice published ($pv ISPs)" || fail "privacy notice not published for every ISP ($pv): ISP settings → Privacy notice"; } \
  || warn "could not read MongoDB ($MDB)"
one="$(q "$MDB" 'db.plans.countDocuments({pricePaise: {$lte: 100}, status: {$ne: "archived"}})')"
[[ $one == 0 ]] && pass "no plan priced ₹1 or less" || warn "$one plan(s) priced ₹1 or less (O-21: set real MRP)"

echo "[backups]"
B=/var/backups/isp; M="$B/.metrics"
if [[ -s $M ]]; then
  for k in mongo postgres etc; do
    ts="$(sed -n "s/^isp_backup_last_success_timestamp_seconds{kind=\"$k\"} //p" "$M")"
    off="$(sed -n "s/^isp_backup_offsite{kind=\"$k\"} //p" "$M")"
    if [[ -z $ts ]]; then fail "no $k backup yet"
    elif (( $(age_h "$ts") > 26 )); then fail "$k backup $(age_h "$ts") h old"
    else pass "$k backup $(age_h "$ts") h old"; fi
    [[ $off == 1 ]] || warn "$k backup not copied off-site (RCLONE_REMOTE)"
  done
else
  fail "backups never ran: sudo bash deploy/ubuntu/backup/backup-setup.sh"
fi
if [[ -s $B/.restore-drill ]]; then
  d="$(cut -d' ' -f1 "$B/.restore-drill")"; ts="$(date -d "$d" +%s)"
  (( $(age_h "$ts") <= 24 * 35 )) && pass "restore drill passed $d" || warn "last restore drill $d (monthly)"
else
  fail "restore drill never passed: deploy/ubuntu/backup/restore-test.sh"
fi

echo "[host]"
pct="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
(( pct < 70 )) && pass "disk ${pct}% used" || { (( pct < 85 )) && warn "disk ${pct}% used" || fail "disk ${pct}% used"; }
[[ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" == yes ]] && pass "clock synchronised (NTP)" || fail "clock not NTP-synchronised"
docker ps --format '{{.Names}}' | grep -q '^isp-alertmanager$' && pass "Alertmanager running (Telegram alerts)" || warn "Alertmanager not running"

echo
echo "preflight $INST: $P passed, $W warnings, $F failed"
echo "Not checkable here: live gateway keys entered and old keys rotated (O-17), DLT SMS templates (O-7),"
echo "router secrets rotated (O-15, O-19), lawyer on retention / data abroad (O-11)."
((F == 0))
