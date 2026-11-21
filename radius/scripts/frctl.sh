#!/usr/bin/env bash
# Start/stop FreeRADIUS without systemd (CI containers, sandboxes). Production uses systemd units.
set -Eeuo pipefail
INSTANCE="${1:?instance}"; ACTION="${2:?start|stop|restart}"
. "/etc/isp-radius/$INSTANCE.conf"
PIDFILE="/var/run/isp-radius-$INSTANCE.pid"
LOG="/var/log/isp-radius-$INSTANCE.log"

stop() {
  if [[ -s "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    kill "$(cat "$PIDFILE")"
    for _ in $(seq 1 50); do kill -0 "$(cat "$PIDFILE")" 2>/dev/null || break; sleep 0.1; done
  fi
  rm -f "$PIDFILE"
}
start() {
  install -d -o freerad -g freerad /var/run/freeradius /var/run/freeradius-staging /var/log/freeradius /var/log/freeradius-staging
  ( set -a; . "/etc/isp-radius/$INSTANCE.env"; set +a
    exec setsid freeradius -f -d "$RADDB" -l stdout >>"$LOG" 2>&1 ) &
  echo $! >"$PIDFILE"
  for _ in $(seq 1 50); do
    ss -H -lun "sport = :$AUTH_PORT" | grep -q . && return 0
    kill -0 "$(cat "$PIDFILE")" 2>/dev/null || { tail -30 "$LOG" >&2; exit 1; }
    sleep 0.2
  done
  echo "FreeRADIUS $INSTANCE did not open UDP $AUTH_PORT" >&2; tail -30 "$LOG" >&2; exit 1
}
case "$ACTION" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
esac
