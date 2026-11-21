#!/usr/bin/env bash
# Rotate the PPPoE password key (RADIUS_PW_KEY) of one instance: re-encrypt every subscriber password and switch
# The Radius engine (role setting app.pw_key) in one transaction, then update the env files.
#   sudo rotate-pw-key.sh staging
# The app stack must not write passwords with the old key meanwhile: isp-api and isp-workers are stopped here and
# come back with the new key only when you rerun deploy/ubuntu/app/app-up.sh (it reads <instance>.app.env).
set -Eeuo pipefail
INST="${1:-}"
ETC_DIR="${ETC_DIR:-/etc/isp-radius}"
die() { echo "rotate-pw-key: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "run as root"
[[ $INST == production || $INST == staging ]] || die "usage: $0 <production|staging>"
. "$ETC_DIR/$INST.conf"
APP_ENV="$ETC_DIR/$INST.app.env"
OLD="$(sed -n 's/^RADIUS_PW_KEY=//p' "$APP_ENV")"
[[ -n $OLD ]] || die "RADIUS_PW_KEY missing in $APP_ENV"
NEW="$(openssl rand -hex 32)"

if command -v docker >/dev/null; then
  for c in isp-workers isp-api; do
    if docker ps -q --filter "name=^$c\$" | grep -q .; then echo "stopping $c"; docker stop "$c" >/dev/null; fi
  done
fi

runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -v old="$OLD" -v new="$NEW" -v role="$FR_ROLE" <<'SQL'
BEGIN;
UPDATE subscribers SET password_enc = radius_encrypt_password(pgp_sym_decrypt(password_enc, :'old'), :'new')
 WHERE password_enc IS NOT NULL;
ALTER ROLE :"role" SET app.pw_key = :'new';
COMMIT;
SQL

for f in "$ETC_DIR/$INST.env" "$APP_ENV"; do
  [[ -f $f ]] || continue
  tmp="$(mktemp "$f.XXXX")"
  sed "s/^RADIUS_PW_KEY=.*/RADIUS_PW_KEY=$NEW/" "$f" >"$tmp"
  chmod --reference="$f" "$tmp"; chown --reference="$f" "$tmp"; mv "$tmp" "$f"
done

# Pooled connections keep the old setting until they reconnect.
if [[ -d /run/systemd/system ]]; then systemctl restart "$SERVICE"; else "$(dirname "$0")/frctl.sh" "$INST" restart; fi
echo "key rotated for $INST; the Radius engine restarted. Now: sudo bash deploy/ubuntu/app/app-up.sh (restarts API + workers)."
echo "Windows app host: update RADIUS_PW_KEY in C:\\isp\\secrets\\$INST.env from $APP_ENV and restart the services."
