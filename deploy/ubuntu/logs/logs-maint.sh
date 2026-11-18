#!/usr/bin/env bash
# Daily seal of the log archive (WP 4.6), run as root by isp-logs-maint.timer (00:20 server time).
#  0. delete day files older than RETENTION_DAYS (default 1096 = 3 years), never newer ones, even when disk is low
#  1. compress every finished day file (*.log older than today) with gzip -9, then make it read-only
#  2. append each sealed file's SHA-256 to MANIFEST/<YYYY-MM-DD>.sha256; each manifest starts with the hash of the
#     previous one, so removing or editing an old file or manifest breaks the chain (verify: logs-maint.sh verify)
#  3. the manifests also go into the encrypted nightly backup (backup.sh), so deleting the newest one is caught too
#  4. write node-exporter metrics (archive size, free space, newest file per router) for the alerts
#  5. off-site (when LOG_REMOTE is set in /etc/isp-logs/offload.env): sealed files (already gzip -9) older than
#     KEEP_LOCAL_DAYS are uploaded as they are (LOG_ENCRYPT=yes: age-encrypted to the backup key first), checked
#     against the bucket's SHA-1, listed in MANIFEST/OFFSITE.list and only then removed here. `fetch <from> <to>`
#     brings days back (encrypted ones need the private key: AGE_IDENTITY).
set -Eeuo pipefail
umask 0027
ROOT="${ARCHIVE_ROOT:-/var/log/isp-archive}"
RETENTION_DAYS="${RETENTION_DAYS:-1096}"
OUT_DIR="${OUT_DIR:-/var/lib/prometheus/node-exporter}"
MANIFESTS="$ROOT/MANIFEST"
OFFSITE_LIST="$MANIFESTS/OFFSITE.list"
OFFLOAD_CONF="${OFFLOAD_CONF:-/etc/isp-logs/offload.env}"
# shellcheck disable=SC1090
[[ -r $OFFLOAD_CONF ]] && . "$OFFLOAD_CONF"
LOG_REMOTE="${LOG_REMOTE:-}"
KEEP_LOCAL_DAYS="${KEEP_LOCAL_DAYS_OVERRIDE:-${KEEP_LOCAL_DAYS:-60}}"
LOG_ENCRYPT="${LOG_ENCRYPT:-no}"
if [[ -z ${AGE_RECIPIENT:-} && -r /etc/isp-backup/backup.env ]]; then
  AGE_RECIPIENT="$(sed -n 's/^AGE_RECIPIENT=//p' /etc/isp-backup/backup.env)"
fi
TODAY="$(date +%F)"
log() { printf '%s %s\n' "$(date +%T)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

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
  if [[ -n $LOG_REMOTE ]]; then
    rclone delete --min-age "${RETENTION_DAYS}d" "$LOG_REMOTE" 2>/dev/null || log "off-site prune failed (not fatal)"
  fi
}

offloaded() { [[ -s $OFFSITE_LIST ]] && awk -v r="$1" '$1 == r { f = 1 } END { exit !f }' "$OFFSITE_LIST"; }

offload() {
  [[ -n $LOG_REMOTE ]] || return 0
  command -v rclone >/dev/null || { log "offload: rclone missing; skipped"; return 0; }
  local enc=no
  if [[ $LOG_ENCRYPT == yes ]]; then
    [[ -n ${AGE_RECIPIENT:-} ]] && command -v age >/dev/null || { log "offload: LOG_ENCRYPT=yes needs age + AGE_RECIPIENT; skipped"; return 0; }
    enc=yes
  fi
  local f rel tmp up name local_sha remote_sha n=0 kept=0
  touch "$OFFSITE_LIST"; chmod 0440 "$OFFSITE_LIST"; chgrp isp-archive "$OFFSITE_LIST"
  tmp="$(mktemp -d)"
  # File mtime = when it was sealed (or fetched back), so a fetched day stays KEEP_LOCAL_DAYS before going again.
  while IFS= read -r -d '' f; do
    rel="${f#"$ROOT"/}"
    if ! offloaded "$rel"; then
      if [[ $enc == yes ]]; then age -r "$AGE_RECIPIENT" -o "$tmp/x.age" "$f"; up="$tmp/x.age"; name="$rel.age"
      else up="$f"; name="$rel"; fi
      local_sha="$(sha1sum "$up" | cut -d' ' -f1)"
      if ! rclone copyto --retries 3 "$up" "$LOG_REMOTE/$name"; then
        log "offload: upload of $rel failed; kept locally"; kept=$((kept + 1)); continue
      fi
      remote_sha="$(rclone hashsum sha1 "$LOG_REMOTE/$name" 2>/dev/null | cut -d' ' -f1)"
      if [[ $local_sha != "$remote_sha" ]]; then
        log "offload: $rel did not verify in the bucket; kept locally"; kept=$((kept + 1)); continue
      fi
      printf '%s %s %s\n' "$rel" "$TODAY" "$([[ $enc == yes ]] && echo age || echo plain)" >>"$OFFSITE_LIST"
    fi
    rm -f "$f"; n=$((n + 1))
  done < <(find "$ROOT" -path "$MANIFESTS" -prune -o -type f -name '*.log.gz' -mtime +"$KEEP_LOCAL_DAYS" -print0 | sort -z)
  rm -rf "$tmp"
  find "$ROOT" -mindepth 3 -type d -empty -delete
  ((n + kept == 0)) || log "offload: $n file(s) moved to $LOG_REMOTE, $kept kept for retry"
}

# fetch <from YYYY-MM-DD> <to YYYY-MM-DD>: decrypt offloaded days back into the archive (panel lookups see them again)
fetch() {
  local from="${1:-}" to="${2:-${1:-}}" rel mode tmp n=0
  [[ $from =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ && $to =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || die "usage: fetch YYYY-MM-DD [YYYY-MM-DD]"
  [[ -n $LOG_REMOTE ]] || die "LOG_REMOTE is not set in $OFFLOAD_CONF"
  [[ -s $OFFSITE_LIST ]] || die "nothing has been moved off-site"
  tmp="$(mktemp -d)"
  while read -r rel mode; do
    [[ -e $ROOT/$rel ]] && continue
    install -d -g isp-archive -m 2750 "$(dirname "$ROOT/$rel")"
    if [[ $mode == age ]]; then
      [[ -r ${AGE_IDENTITY:-} ]] || die "$rel is encrypted: set AGE_IDENTITY to the private backup key file"
      rclone copyto "$LOG_REMOTE/$rel.age" "$tmp/x.age"
      age -d -i "$AGE_IDENTITY" -o "$ROOT/$rel" "$tmp/x.age"
    else
      rclone copyto "$LOG_REMOTE/$rel" "$ROOT/$rel"
    fi
    chmod 0440 "$ROOT/$rel"; chgrp isp-archive "$ROOT/$rel"; n=$((n + 1))
  done < <(awk -v a="$from" -v b="$to" '{ k = split($1, p, "/"); d = substr(p[k], 1, 10); m = ($3 == "" ? "age" : $3)
    if (d >= a && d <= b) print $1, m }' "$OFFSITE_LIST")
  rm -rf "$tmp"
  log "fetched $n file(s) for $from … $to; they stay $KEEP_LOCAL_DAYS days"
  verify
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
    if [[ -n $LOG_REMOTE ]]; then
      echo '# HELP isp_logarchive_offload_pending_files Sealed files past KEEP_LOCAL_DAYS + 2 still only on this server.'
      echo '# TYPE isp_logarchive_offload_pending_files gauge'
      echo "isp_logarchive_offload_pending_files $(find "$ROOT" -path "$MANIFESTS" -prune -o -type f -name '*.log.gz' -mtime +"$((KEEP_LOCAL_DAYS + 2))" -print | wc -l)"
    fi
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
    # Files moved off-site (OFFSITE.list) are checked there by SHA-1 at upload; check the rest here.
    (cd "$ROOT" && tail -n +2 "$MANIFESTS/$man" |
      awk -v c="$cutoff" -v root="$ROOT" -v list="$OFFSITE_LIST" '
        BEGIN { while ((getline l < list) > 0) { split(l, x, " "); off[x[1]] = 1 } }
        { n = split($2, p, "/"); if (substr(p[n], 1, 10) < c) next
          if (($2 in off) && system("test -e \"" root "/" $2 "\"") != 0) next
          print }' |
      sha256sum -c --quiet) || { echo "FILE CHANGED OR MISSING in $man"; bad=1; }
    prev="$man"
  done
  ((bad == 0)) && echo "archive verified: every sealed file matches its manifest and the chain is intact"
  return "$bad"
}

case "${1:-run}" in
  run) prune; seal; offload; metrics; log "sealed; archive $(du -sh "$ROOT" | cut -f1), free $(df -h --output=avail "$ROOT" | tail -1 | tr -d ' ')" ;;
  verify) verify ;;
  fetch) shift; fetch "$@" ;;
  offload) offload; metrics ;;
  metrics) metrics ;;
  *) echo "usage: $0 [run|verify|metrics|offload|fetch FROM [TO]]" >&2; exit 2 ;;
esac
