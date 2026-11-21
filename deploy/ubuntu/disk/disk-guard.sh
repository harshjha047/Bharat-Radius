#!/usr/bin/env bash
# Disk guard, every 5 minutes (isp-disk-guard.timer). Keeps room for PostgreSQL and MongoDB on the 100 GB disk.
# Never touches database files, code, containers, configuration, secrets, today's logs, or anything not yet
# confirmed off-site. Config: /etc/isp-disk/guard.env. Flags for the app: /run/isp-guard/{pause-heavy,maintenance}.
#
#   >= DRILL_AT (70 %)   pause-heavy: imports and app rebuilds wait; drill: build cache, unused images, journal,
#                        log days older than DRILL_KEEP_DAYS (7) moved off-site, local backups already off-site
#   >= MAINT_AT (85 %)   maintenance: panel, reseller panel and portal show a maintenance page
#                        (Radius, payment webhooks and the pay page keep running)
#   >= RESERVE_AT (95 %) the reserve file is released so the databases can keep writing; critical alert
#   below MAINT_OFF (80 %) maintenance ends; below DRILL_OFF (65 %) pause ends and the reserve is recreated
set -Eeuo pipefail
umask 022
CONF="${CONF:-/etc/isp-disk/guard.env}"
# shellcheck disable=SC1090
[[ -r $CONF ]] && . "$CONF"
DRILL_AT="${DRILL_AT:-70}"; DRILL_OFF="${DRILL_OFF:-65}"
MAINT_AT="${MAINT_AT:-85}"; MAINT_OFF="${MAINT_OFF:-80}"
RESERVE_AT="${RESERVE_AT:-95}"; RESERVE_GB="${RESERVE_GB:-5}"
DRILL_KEEP_DAYS="${DRILL_KEEP_DAYS:-7}"
FS="${FS:-/}"
FLAGS="${FLAGS:-/run/isp-guard}"
STATE_DIR="${STATE_DIR:-/var/lib/isp-guard}"
RESERVE="$STATE_DIR/reserve.img"
OUT_DIR="${OUT_DIR:-/var/lib/prometheus/node-exporter}"
LOGS_MAINT="${LOGS_MAINT:-/opt/isp-logs/logs-maint.sh}"
BACKUP_ENV="${BACKUP_ENV:-/etc/isp-backup/backup.env}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/isp}"
log() { printf '%s %s\n' "$(date +%T)" "$*"; }

used_pct() { df --output=pcent "$FS" | tail -1 | tr -dc '0-9'; }
avail_bytes() { df -B1 --output=avail "$FS" | tail -1 | tr -d ' '; }
flag() { install -d -m 0755 "$FLAGS"; if [[ $2 == on ]]; then touch "$FLAGS/$1"; else rm -f "$FLAGS/$1"; fi; }
on() { [[ -e $FLAGS/$1 ]]; }

# Local backup folders whose off-site copy checks out (rclone check); the newest folder always stays.
prune_backups() {
  local remote dir newest
  remote="$(sed -n 's/^RCLONE_REMOTE=//p' "$BACKUP_ENV" 2>/dev/null || true)"
  [[ -n $remote && -d $BACKUP_DIR ]] && command -v rclone >/dev/null || return 0
  newest="$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '20*' -printf '%f\n' | sort | tail -1)"
  while IFS= read -r dir; do
    [[ $dir == "$newest" ]] && continue
    if rclone check --one-way "$BACKUP_DIR/$dir" "$remote/$dir" >/dev/null 2>&1; then
      rm -rf "${BACKUP_DIR:?}/$dir"; log "drill: removed local backup $dir (confirmed off-site)"
    fi
  done < <(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '20*' -printf '%f\n' | sort)
}

drill() {
  log "drill at ${1}% used"
  if command -v docker >/dev/null; then
    docker builder prune -af >/dev/null 2>&1 || true
    docker image prune -f >/dev/null 2>&1 || true
  fi
  journalctl --vacuum-size=500M >/dev/null 2>&1 || true
  [[ -x $LOGS_MAINT ]] && KEEP_LOCAL_DAYS_OVERRIDE="$DRILL_KEEP_DAYS" "$LOGS_MAINT" offload || true
  prune_backups
}

make_reserve() {
  [[ -e $RESERVE ]] && return 0
  local need=$((RESERVE_GB * 1024 * 1024 * 1024))
  # Only when it cannot itself push the disk to the drill line.
  (($(avail_bytes) > need * 3)) || return 0
  install -d -m 0700 "$STATE_DIR"
  fallocate -l "${RESERVE_GB}G" "$RESERVE" 2>/dev/null || { rm -f "$RESERVE"; return 0; }
  chmod 0600 "$RESERVE"
  (($(used_pct) < DRILL_AT)) || { rm -f "$RESERVE"; return 0; }
  log "reserve of ${RESERVE_GB} GB in place ($RESERVE)"
}

metrics() {
  [[ -d $OUT_DIR ]] || return 0
  local tmp level=0
  on pause-heavy && level=1
  on maintenance && level=2
  [[ -e $STATE_DIR/reserve-released ]] && level=3
  tmp="$(mktemp "$OUT_DIR/.isp_disk_guard.XXXXXX")"
  {
    echo '# HELP isp_disk_guard_level 0 normal, 1 drill (heavy jobs paused), 2 maintenance page, 3 reserve released.'
    echo '# TYPE isp_disk_guard_level gauge'
    echo "isp_disk_guard_level $level"
    echo '# HELP isp_disk_guard_used_percent Used space on the guarded filesystem.'
    echo '# TYPE isp_disk_guard_used_percent gauge'
    echo "isp_disk_guard_used_percent $(used_pct)"
    echo '# HELP isp_disk_guard_freed_bytes Space freed by the last drill.'
    echo '# TYPE isp_disk_guard_freed_bytes gauge'
    echo "isp_disk_guard_freed_bytes ${FREED:-0}"
    echo '# HELP isp_disk_guard_reserve_present 1 while the emergency reserve file exists.'
    echo '# TYPE isp_disk_guard_reserve_present gauge'
    echo "isp_disk_guard_reserve_present $([[ -e $RESERVE ]] && echo 1 || echo 0)"
    echo '# HELP isp_disk_guard_last_run_timestamp_seconds Last guard run.'
    echo '# TYPE isp_disk_guard_last_run_timestamp_seconds gauge'
    echo "isp_disk_guard_last_run_timestamp_seconds $(date +%s)"
  } >"$tmp"
  chmod 0644 "$tmp"; mv "$tmp" "$OUT_DIR/isp_disk_guard.prom"
}

run() {
  local pct before
  pct="$(used_pct)"
  if ((pct >= DRILL_AT)); then
    on pause-heavy || log "pause-heavy on (${pct}%)"
    flag pause-heavy on
    before="$(avail_bytes)"
    drill "$pct"
    FREED=$(($(avail_bytes) - before)); ((FREED > 0)) || FREED=0
    pct="$(used_pct)"
    log "drill freed $((FREED / 1048576)) MB, now ${pct}%"
  fi
  if ((pct >= MAINT_AT)); then
    on maintenance || log "maintenance ON (${pct}%)"
    flag maintenance on
  elif ((pct < MAINT_OFF)) && on maintenance; then
    log "maintenance off (${pct}%)"; flag maintenance off
  fi
  if ((pct >= RESERVE_AT)) && [[ -e $RESERVE ]]; then
    rm -f "$RESERVE"; install -d -m 0700 "$STATE_DIR"; touch "$STATE_DIR/reserve-released"
    log "RESERVE RELEASED at ${pct}%: ${RESERVE_GB} GB given back to the databases"
    pct="$(used_pct)"
  fi
  if ((pct < DRILL_OFF)); then
    on pause-heavy && log "pause-heavy off (${pct}%)"
    flag pause-heavy off; flag maintenance off
    rm -f "$STATE_DIR/reserve-released"
    make_reserve
  fi
  metrics
}

case "${1:-run}" in
  run) exec 9>"/run/lock/isp-disk-guard.lock"; flock -n 9 || exit 0; run ;;
  status) printf 'used %s%%  pause-heavy=%s  maintenance=%s  reserve=%s\n' "$(used_pct)" \
    "$(on pause-heavy && echo on || echo off)" "$(on maintenance && echo on || echo off)" \
    "$([[ -e $RESERVE ]] && echo present || echo absent)" ;;
  maintenance-off) flag maintenance off; metrics; log "maintenance cleared by hand (comes back if the disk is still >= ${MAINT_AT}%)" ;;
  *) echo "usage: $0 [run|status|maintenance-off]" >&2; exit 2 ;;
esac
