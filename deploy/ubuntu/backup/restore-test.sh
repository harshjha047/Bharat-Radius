#!/usr/bin/env bash
# Restore drill (WP 4.8): restores a backup into throw-away databases next to the live ones, compares record
# counts, then drops them. Live data is never touched.
#   sudo AGE_IDENTITY=/root/age.key bash restore-test.sh [STAMP]     # STAMP = folder name, default: newest
# The age private key is the owner's; copy it in only for the drill and remove it afterwards (shred -u).
set -Eeuo pipefail
umask 077
CONF="${CONF:-/etc/isp-backup/backup.env}"
# shellcheck disable=SC1090
. "$CONF"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/isp}"
RCLONE_REMOTE="${RCLONE_REMOTE:-}"
MONGO_CONTAINER="${MONGO_CONTAINER:-isp-mongo}"
AGE_IDENTITY="${AGE_IDENTITY:?set AGE_IDENTITY to the path of the owner age private key file}"
STAMP="${1:-}"
log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }
FAIL=0
bad() { log "MISMATCH: $*"; FAIL=1; }

if [[ -z $STAMP ]]; then
  STAMP="$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '20*' -printf '%f\n' | sort | tail -1)"
  [[ -n $STAMP || -z $RCLONE_REMOTE ]] || STAMP="$(rclone lsf --dirs-only "$RCLONE_REMOTE" | sort | tail -1)"
  STAMP="${STAMP%/}"
fi
[[ -n $STAMP ]] || die "no backup found"
WORK="$(mktemp -d "$BACKUP_DIR/.restore.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
SRC="$BACKUP_DIR/$STAMP"
if [[ ! -d $SRC ]]; then
  [[ -n $RCLONE_REMOTE ]] || die "$SRC not found and no RCLONE_REMOTE"
  log "fetching $STAMP from $RCLONE_REMOTE"
  rclone copy "$RCLONE_REMOTE/$STAMP" "$WORK/src"
  SRC="$WORK/src"
fi
log "drill on $STAMP"
(cd "$SRC" && sha256sum -c --quiet SHA256SUMS) || die "checksums do not match"
open_() { age -d -i "$AGE_IDENTITY" -o "$WORK/$1" "$SRC/$1.age"; }

msh() { docker exec -i "$MONGO_CONTAINER" sh -c 'mongosh --quiet -u root -p "$(cat /etc/mongo/root_pw)" --authenticationDatabase admin --eval "$1"' _ "$1"; }

# ---- mongo → restore_<db>
open_ mongo.archive.gz
log "mongo: restoring into restore_* databases"
docker exec -i "$MONGO_CONTAINER" sh -c '
  umask 077; c=$(mktemp)
  printf "password: %s\n" "$(cat /etc/mongo/root_pw)" >"$c"
  mongorestore --quiet --config "$c" --username root --authenticationDatabase admin --archive --gzip \
    --nsExclude "admin.*" --nsExclude "config.*" --nsExclude "local.*" \
    --nsFrom "\$db\$.\$coll\$" --nsTo "restore_\$db\$.\$coll\$" --drop
  rc=$?; rm -f "$c"; exit $rc' <"$WORK/mongo.archive.gz"
report="$(msh '
  const out = [];
  for (const d of db.adminCommand({ listDatabases: 1 }).databases.map((x) => x.name)) {
    if (!d.startsWith("restore_")) continue;
    const live = db.getSiblingDB(d.slice(8)), back = db.getSiblingDB(d);
    for (const c of ["subscribers", "invoices", "payments", "wallet_txns", "recharges", "tickets"]) {
      const b = back.getCollection(c).estimatedDocumentCount(), l = live.getCollection(c).estimatedDocumentCount();
      out.push([d.slice(8), c, b, l].join(" "));
    }
  }
  out.join("\n")')"
while read -r dbn coll back live; do
  [[ -n ${dbn:-} ]] || continue
  log "mongo $dbn.$coll backup=$back live=$live"
  if (( back > live )) || (( live > 0 && back == 0 )); then bad "mongo $dbn.$coll"; fi
done <<<"$report"
msh 'db.adminCommand({ listDatabases: 1 }).databases.filter((x) => x.name.startsWith("restore_")).forEach((x) => db.getSiblingDB(x.name).dropDatabase())' >/dev/null

# ---- postgres → restore_<db>
for f in "$SRC"/*.pgdump.age; do
  [[ -e $f ]] || continue
  name="$(basename "$f" .age)"; db="${name%.pgdump}"; scratch="restore_$db"
  open_ "$name"
  log "postgres: restoring $db into $scratch"
  runuser -u postgres -- dropdb --if-exists "$scratch"
  runuser -u postgres -- createdb "$scratch"
  chown postgres "$WORK" "$WORK/$name"
  # Root opens the root-only dump and streams it: the postgres user cannot read $WORK (0700 root).
  runuser -u postgres -- pg_restore --no-owner --no-privileges -d "$scratch" <"$WORK/$name" || bad "pg_restore $db"
  for t in subscribers nas plans radacct radpostauth usage_daily; do
    back="$(runuser -u postgres -- psql -XtAd "$scratch" -c "SELECT count(*) FROM $t" 2>/dev/null || echo -1)"
    live="$(runuser -u postgres -- psql -XtAd "$db" -c "SELECT count(*) FROM $t" 2>/dev/null || echo -1)"
    log "postgres $db.$t backup=$back live=$live"
    if (( back < 0 || back > live )) || (( live > 0 && back == 0 )); then bad "postgres $db.$t"; fi
  done
  runuser -u postgres -- dropdb "$scratch"
done

# ---- etc
open_ etc.tar.gz
n="$(tar -tzf "$WORK/etc.tar.gz" | wc -l)"
log "etc: $n entries"
(( n > 0 )) || bad "etc archive empty"

if (( FAIL )); then die "restore drill FAILED for $STAMP"; fi
log "restore drill PASSED for $STAMP (backup ≤ live everywhere, nothing empty that is not empty live)"
# Last passed drill, read by deploy/ubuntu/preflight.sh (monthly drill before and after go-live).
printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$STAMP" >"$BACKUP_DIR/.restore-drill"
