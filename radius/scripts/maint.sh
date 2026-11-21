#!/usr/bin/env bash
# Maintenance tasks run by systemd timers: maint.sh <instance> <stale|partitions|nas-watch>
set -Eeuo pipefail
INSTANCE="${1:?instance}"; TASK="${2:?task}"
ETC_DIR=/etc/isp-radius; STATE_DIR=/var/lib/isp-radius
. "$ETC_DIR/$INSTANCE.conf"
q() { runuser -u postgres -- psql -XtA -v ON_ERROR_STOP=1 -d "$DB" -c "$1"; }

case "$TASK" in
  stale)
    n="$(q "SELECT radius_close_stale_sessions()")"
    [[ "$n" == 0 ]] || echo "closed $n stale sessions"
    ;;
  partitions)
    echo "created $(q "SELECT radius_ensure_partitions(1)") partitions; dropped $(q "SELECT radius_drop_old_postauth(${POSTAUTH_KEEP_DAYS:-1100})") radpostauth partitions"
    q "DELETE FROM radius_events WHERE minute < now() - interval '30 days'" >/dev/null
    ;;
  nas-watch)
    new="$(q "SELECT radius_nas_hash()")"
    old="$(cat "$STATE_DIR/$INSTANCE.nas.hash" 2>/dev/null || true)"
    [[ "$new" == "$old" ]] && exit 0
    # Firewall first, so a router added in the panel is reachable as soon as the Radius engine knows it.
    "$(dirname "$0")/nas-allow.sh" "$INSTANCE" sync || echo "firewall sync failed (nas-allow.sh $INSTANCE sync)" >&2
    if ! ( set -a; . "$ETC_DIR/$INSTANCE.env"; set +a; freeradius -XC -d "$RADDB" >"$STATE_DIR/$INSTANCE.configcheck.log" 2>&1 ); then
      echo "nas table changed but the Radius engine config check failed; not restarting" >&2
      tail -20 "$STATE_DIR/$INSTANCE.configcheck.log" >&2
      exit 1
    fi
    if [[ -d /run/systemd/system ]]; then systemctl restart "$SERVICE"; else "$(dirname "$0")/frctl.sh" "$INSTANCE" restart; fi
    echo "$new" >"$STATE_DIR/$INSTANCE.nas.hash"
    echo "nas table changed; $SERVICE restarted"
    ;;
  *) echo "unknown task $TASK" >&2; exit 2 ;;
esac
