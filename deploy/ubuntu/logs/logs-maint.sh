#!/usr/bin/env bash
# Daily seal of the log archive (WP 4.6), run as root by isp-logs-maint.timer (00:20 server time).
#  0. delete day files older than RETENTION_DAYS (default 1096 = 3 years), never newer ones, even when disk is low
#  1. compress every finished day file (*.log older than today) with gzip -9, then make it read-only
#  2. append each sealed file's SHA-256 to MANIFEST/<YYYY-MM-DD>.sha256; each manifest starts with the hash of the
#     previous one, so removing or editing an old file or manifest breaks the chain (verify: logs-maint.sh verify)
#  3. the manifests also go into the encrypted nightly backup (backup.sh), so deleting the newest one is caught too
#  4. write node-exporter metrics (archive size, free space, newest file per router) for the alerts
set -Eeuo pipefail
umask 0027
ROOT="${ARCHIVE_ROOT:-/var/log/isp-archive}"
RETENTION_DAYS="${RETENTION_DAYS:-1096}"
OUT_DIR="${OUT_DIR:-/var/lib/prometheus/node-exporter}"
MANIFESTS="$ROOT/MANIFEST"
TODAY="$(date +%F)"
log() { printf '%s %s\n' "$(date +%T)" "$*"; }

day_of() { local b; b="$(basename "$1")"; echo "${b:0:10}"; }

seal() {
  install -d -m 0750 -g isp-archive "$MANIFESTS"
  # One manifest per run, named by the run date; its first line is the hash of the previous manifest.
  local man="$MANIFESTS/$TODAY.sha256" prev f day gz n=0
  if [[ ! -e $man ]]; then
    prev="$(find "$MANIFESTS" -name '*.sha256' -printf '%f\n' | sort | tail -1)"
    if [[ -n $prev ]]; then echo "# previous $(sha256sum "$MANIFESTS/$prev" | cut -d' ' -f1)  $prev" >"$man.tmp"
    else echo "# previous none" >"$man.tmp"; fi
  else
    cp "$man" "$man.tmp"
  fi
  while IFS= read -r -d '' f; do
    day="$(day_of "$f")"
    [[ $day =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ && $day < "$TODAY" ]] || continue
    gz="$f.gz"
    # rsyslog reopened a sealed day (late packet): keep both, never overwrite a sealed file
    [[ ! -e $gz ]] || gz="${f%.log}.late-$(date +%s).log.gz"
    gzip -9 -c "$f" >"$gz.tmp" && gzip -t "$gz.tmp" && mv "$gz.tmp" "$gz" && rm -f "$f"
    chmod 0440 "$gz"; chgrp isp-archive "$gz"
    (cd "$ROOT" && sha256sum "${gz#"$ROOT"/}") >>"$man.tmp"
    n=$((n + 1))
  done < <(find "$ROOT" -path "$MANIFESTS" -prune -o -type f -name '*.log' -print0 | sort -z)
  if ((n > 0)) || [[ ! -e $man ]]; then
    chmod 0440 "$man.tmp"; chgrp isp-archive "$man.tmp"; mv -f "$man.tmp" "$man"
  else
    rm -f "$man.tmp"
  fi
  log "sealed $n file(s) → $(basename "$man")"
}

prune() {
  local cutoff n=0 f
  cutoff="$(date -d "-$RETENTION_DAYS days" +%F)"
  while IFS= read -r -d '' f; do
    [[ "$(day_of "$f")" < "$cutoff" ]] || continue
    rm -f "$f"; n=$((n + 1))
  done < <(find "$ROOT" -type f \( -name '*.log.gz' -o -name '*.sha256' \) -print0)
  find "$ROOT" -mindepth 2 -type d -empty -delete
  ((n == 0)) || log "pruned $n file(s) older than $cutoff ($RETENTION_DAYS days)"
}

metrics() {
  [[ -d $OUT_DIR ]] || return 0
  local tmp dir ip newest
  tmp="$(mktemp "$OUT_DIR/.isp_logarchive.XXXXXX")"
  {
    echo '# HELP isp_logarchive_bytes Size of the log archive on disk.'
    echo '# TYPE isp_logarchive_bytes gauge'
    echo "isp_logarchive_bytes $(du -sb "$ROOT" | cut -f1)"
    echo '# HELP isp_logarchive_free_bytes Free space on the archive filesystem.'
    echo '# TYPE isp_logarchive_free_bytes gauge'
    echo "isp_logarchive_free_bytes $(df -B1 --output=avail "$ROOT" | tail -1 | tr -d ' ')"
    echo '# HELP isp_logarchive_size_bytes Size of the archive filesystem.'
    echo '# TYPE isp_logarchive_size_bytes gauge'
    echo "isp_logarchive_size_bytes $(df -B1 --output=size "$ROOT" | tail -1 | tr -d ' ')"
    echo '# HELP isp_logarchive_last_seal_timestamp_seconds Last successful daily seal.'
    echo '# TYPE isp_logarchive_last_seal_timestamp_seconds gauge'
    echo "isp_logarchive_last_seal_timestamp_seconds $(date +%s)"
    echo '# HELP isp_logarchive_source_last_write_timestamp_seconds Newest archive file per router and kind.'
    echo '# TYPE isp_logarchive_source_last_write_timestamp_seconds gauge'
    for dir in "$ROOT"/routers/* "$ROOT"/nat/*; do
      [[ -d $dir ]] || continue
      ip="$(basename "$dir")"
      newest="$(find "$dir" -type f -printf '%T@\n' | sort -n | tail -1)"
      [[ -n $newest ]] && echo "isp_logarchive_source_last_write_timestamp_seconds{kind=\"$(basename "$(dirname "$dir")")\",source=\"$ip\"} ${newest%.*}"
    done
  } >"$tmp"
  chmod 0644 "$tmp"; mv "$tmp" "$OUT_DIR/isp_logarchive.prom"
}

verify() {
  local bad=0 man prev want got cutoff
  cutoff="$(date -d "-$RETENTION_DAYS days" +%F)"
  prev=""
  for man in $(find "$MANIFESTS" -name '*.sha256' -printf '%f\n' | sort); do
    want="$(head -1 "$MANIFESTS/$man")"
    if [[ -z $prev ]]; then got="# previous none"; else got="# previous $(sha256sum "$MANIFESTS/$prev" | cut -d' ' -f1)  $prev"; fi
    # The first manifest after a 3-year prune legitimately points at a deleted one.
    if [[ $want != "$got" && -n $prev ]]; then echo "CHAIN BROKEN at $man"; bad=1; fi
    # Files past the retention period were deleted on purpose; check everything else.
    (cd "$ROOT" && tail -n +2 "$MANIFESTS/$man" | awk -v c="$cutoff" '{ n = split($2, p, "/"); if (substr(p[n], 1, 10) >= c) print }' |
      sha256sum -c --quiet) || { echo "FILE CHANGED OR MISSING in $man"; bad=1; }
    prev="$man"
  done
  ((bad == 0)) && echo "archive verified: every sealed file matches its manifest and the chain is intact"
  return "$bad"
}

case "${1:-run}" in
  run) prune; seal; metrics; log "sealed; archive $(du -sh "$ROOT" | cut -f1), free $(df -h --output=avail "$ROOT" | tail -1 | tr -d ' ')" ;;
  verify) verify ;;
  metrics) metrics ;;
  *) echo "usage: $0 [run|verify|metrics]" >&2; exit 2 ;;
esac
