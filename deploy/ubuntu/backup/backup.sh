#!/usr/bin/env bash
# Nightly backup (WP 4.8), run as root by isp-backup.timer. Config: /etc/isp-backup/backup.env.
#   mongo     all databases of isp-mongo (mongodump archive, gzip)          → verified with mongorestore --dryRun
#   postgres  each RADIUS database (pg_dump custom format)                  → verified with pg_restore --list
#   etc       /etc/isp-radius /etc/isp-app (secrets: only ever stored age-encrypted) + log-archive manifests
#   files     /var/lib/isp-files (KYC, CAF, logos; already encrypted by the API) when files are kept on local disk
# Every file is age-encrypted to AGE_RECIPIENT (the owner's public key; the private key never touches this server),
# kept locally KEEP_LOCAL_DAYS and copied off-site with rclone to RCLONE_REMOTE when set (KEEP_REMOTE_DAYS there).
# Success per kind → isp_backup_last_success_timestamp_seconds{kind} (alerts BackupMissing / BackupNeverRan).
set -Eeuo pipefail
umask 077
CONF="${CONF:-/etc/isp-backup/backup.env}"
# shellcheck disable=SC1090
. "$CONF"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/isp}"
KEEP_LOCAL_DAYS="${KEEP_LOCAL_DAYS:-7}"
KEEP_REMOTE_DAYS="${KEEP_REMOTE_DAYS:-35}"
RCLONE_REMOTE="${RCLONE_REMOTE:-}"
AGE_RECIPIENT="${AGE_RECIPIENT:-}"
PG_DATABASES="${PG_DATABASES:-radius radius_staging}"
MONGO_CONTAINER="${MONGO_CONTAINER:-isp-mongo}"
OUT_DIR="${OUT_DIR:-/var/lib/prometheus/node-exporter}"
STAMP="$(date -u +%Y-%m-%dT%H%MZ)"
DAY_DIR="$BACKUP_DIR/$STAMP"
METRICS="$BACKUP_DIR/.metrics"

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }
[[ -n $AGE_RECIPIENT ]] || die "AGE_RECIPIENT is not set in $CONF (backups are never stored unencrypted)"
command -v age >/dev/null || die "age is not installed (apt-get install age)"
[[ -z $RCLONE_REMOTE ]] || command -v rclone >/dev/null || die "rclone is not installed (apt-get install rclone)"

install -d -m 0700 "$BACKUP_DIR" "$DAY_DIR"
touch "$METRICS"
WORK="$(mktemp -d "$BACKUP_DIR/.work.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# kind file → encrypt, checksum, keep; record success for the kind
seal() {
  local kind="$1" plain="$2" name="$3"
  age -r "$AGE_RECIPIENT" -o "$DAY_DIR/$name.age" "$plain"
  rm -f "$plain"
  (cd "$DAY_DIR" && sha256sum "$name.age" >>SHA256SUMS)
  local size; size="$(stat -c %s "$DAY_DIR/$name.age")"
  log "$kind: $name.age ($size bytes)"
  SIZE[$kind]=$(( ${SIZE[$kind]:-0} + size ))
}
declare -A SIZE=()

# ---- mongo
log "mongo: dumping all databases"
docker exec -i "$MONGO_CONTAINER" sh -c '
  umask 077; c=$(mktemp)
  printf "password: %s\n" "$(cat /etc/mongo/root_pw)" >"$c"
  mongodump --quiet --config "$c" --username root --authenticationDatabase admin --archive --gzip --oplog
  rc=$?; rm -f "$c"; exit $rc' >"$WORK/mongo.archive.gz"
docker exec -i "$MONGO_CONTAINER" sh -c '
  umask 077; c=$(mktemp)
  printf "password: %s\n" "$(cat /etc/mongo/root_pw)" >"$c"
  mongorestore --quiet --config "$c" --username root --authenticationDatabase admin --archive --gzip --dryRun
  rc=$?; rm -f "$c"; exit $rc' <"$WORK/mongo.archive.gz" || die "mongo archive failed verification"
seal mongo "$WORK/mongo.archive.gz" mongo.archive.gz

# ---- postgres
for db in $PG_DATABASES; do
  runuser -u postgres -- psql -XtAc "SELECT 1 FROM pg_database WHERE datname = '$db'" | grep -q 1 || { log "postgres: $db does not exist, skipped"; continue; }
  log "postgres: dumping $db"
  runuser -u postgres -- pg_dump -Fc -Z 6 "$db" >"$WORK/$db.pgdump"
  pg_restore --list "$WORK/$db.pgdump" >/dev/null || die "postgres $db dump failed verification"
  seal postgres "$WORK/$db.pgdump" "$db.pgdump"
done

# ---- etc (secrets)
log "etc: archiving configuration and secrets"
dirs=(); for d in /etc/isp-radius /etc/isp-app /var/log/isp-archive/MANIFEST; do [[ -d $d ]] && dirs+=("$d"); done
tar -czf "$WORK/etc.tar.gz" -C / "${dirs[@]#/}"
tar -tzf "$WORK/etc.tar.gz" >/dev/null || die "etc archive failed verification"
seal etc "$WORK/etc.tar.gz" etc.tar.gz

# ---- files (local store only; a bucket keeps its own copies)
if [[ ! -s /etc/isp-app/files.env && -d /var/lib/isp-files ]] && [[ -n $(ls -A /var/lib/isp-files 2>/dev/null) ]]; then
  log "files: archiving /var/lib/isp-files"
  tar -czf "$WORK/files.tar.gz" -C / var/lib/isp-files
  tar -tzf "$WORK/files.tar.gz" >/dev/null || die "files archive failed verification"
  seal files "$WORK/files.tar.gz" files.tar.gz
fi

# ---- off-site
OFFSITE=0
if [[ -n $RCLONE_REMOTE ]]; then
  log "off-site: copying to $RCLONE_REMOTE/$STAMP"
  rclone copy --checksum --no-traverse "$DAY_DIR" "$RCLONE_REMOTE/$STAMP"
  rclone check --one-way "$DAY_DIR" "$RCLONE_REMOTE/$STAMP" || die "off-site copy does not match"
  rclone delete --min-age "${KEEP_REMOTE_DAYS}d" "$RCLONE_REMOTE" && rclone rmdirs --leave-root "$RCLONE_REMOTE" || log "off-site prune failed (not fatal)"
  OFFSITE=1
else
  log "off-site: RCLONE_REMOTE not set — local copy only"
fi

# ---- local prune
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '20*' -mtime "+$KEEP_LOCAL_DAYS" -exec rm -rf {} +

# ---- metrics (kept per kind across runs; a skipped kind keeps its last success)
now="$(date +%s)"
for kind in "${!SIZE[@]}"; do
  size="${SIZE[$kind]}"
  grep -v "{kind=\"$kind\"}" "$METRICS" >"$METRICS.new" || true
  {
    cat "$METRICS.new"
    echo "isp_backup_last_success_timestamp_seconds{kind=\"$kind\"} $now"
    echo "isp_backup_size_bytes{kind=\"$kind\"} $size"
    echo "isp_backup_offsite{kind=\"$kind\"} $OFFSITE"
  } >"$METRICS"
done
rm -f "$METRICS.new"
# Files moved to the bucket (or none yet): no local files backup is expected, so drop its old metrics.
if [[ -z ${SIZE[files]:-} && -f $METRICS ]]; then
  grep -v '{kind="files"}' "$METRICS" >"$METRICS.new" || true
  mv "$METRICS.new" "$METRICS"
fi
if [[ -d $OUT_DIR ]]; then
  tmp="$(mktemp "$OUT_DIR/.isp_backup.XXXXXX")"
  {
    echo '# HELP isp_backup_last_success_timestamp_seconds Last verified backup per kind.'
    echo '# TYPE isp_backup_last_success_timestamp_seconds gauge'
    echo '# HELP isp_backup_size_bytes Size of the last encrypted backup file(s) per kind.'
    echo '# TYPE isp_backup_size_bytes gauge'
    echo '# HELP isp_backup_offsite 1 if the last backup was copied off-site.'
    echo '# TYPE isp_backup_offsite gauge'
    sort -u "$METRICS"
  } >"$tmp"
  chmod 0644 "$tmp"; mv "$tmp" "$OUT_DIR/isp_backup.prom"
fi
log "done: $DAY_DIR (off-site: $OFFSITE)"
