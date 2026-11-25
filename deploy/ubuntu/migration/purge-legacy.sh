#!/usr/bin/env bash
# Removes everything `cli.js import-legacy` created for one ISP, so a later import starts clean (per-POP re-import
# at cutover). Refuses if the ISP has any activity beyond the import: invoices, payments, recharges, tickets, KYC,
# top-ups, rates, reseller logins, subscribers/routers/resellers not from the import, or wallet movements by anyone
# but the importer. Audit logs are kept. Dry run by default; --apply takes a backup first.
# Usage: sudo bash deploy/ubuntu/migration/purge-legacy.sh --tenant bharat [--apply]
set -Eeuo pipefail
die() { echo "[purge-legacy] ERROR: $*" >&2; exit 1; }
log() { echo "[purge-legacy] $*"; }
trap 'die "failed at line $LINENO: $BASH_COMMAND"' ERR
[[ $EUID -eq 0 ]] || die "run as root"

SLUG=""; APPLY=false
while (($#)); do
  case "$1" in
    --tenant) SLUG="${2:-}"; shift 2 ;;
    --apply) APPLY=true; shift ;;
    *) die "usage: purge-legacy.sh --tenant <slug> [--apply]" ;;
  esac
done
[[ $SLUG =~ ^[a-z0-9-]+$ ]] || die "--tenant <slug> required"

INSTANCE="$(sed -n 's/^RADIUS_INSTANCE=//p' /etc/isp-app/settings.env)"
case "${INSTANCE:-staging}" in
  production) MDB=isp; PDB=radius ;;
  staging) MDB=isp_staging; PDB=radius_staging ;;
  *) die "unknown RADIUS_INSTANCE '$INSTANCE'" ;;
esac
ROOT_PW="$(cat /etc/isp-app/mongo_root_pw)"
msh() { docker exec -i isp-mongo mongosh --quiet -u root -p "$ROOT_PW" --authenticationDatabase admin "$MDB" --eval "$1"; }

COMMON='
const ACTOR = "cli:import-legacy";
const t = db.tenants.findOne({ slug: SLUG });
if (!t) throw new Error("tenant " + SLUG + " not found");
const T = t._id;
const ids = { reseller: [], plan: [], nas: [], subscriber: [] };
db.legacy_map.find({ tenantId: T }).forEach((m) => ids[m.kind] && ids[m.kind].push(m.entityId));
const col = { reseller: "resellers", plan: "plans", nas: "nas_devices", subscriber: "subscribers" };
'

PLAN_JS="const SLUG = '$SLUG';$COMMON"'
const guards = [];
const g = (what, n) => { if (n) guards.push(what + ": " + n); };
for (const c of ["invoices", "payments", "recharges", "credit_notes", "tickets", "kyc_documents", "topup_requests",
                 "reseller_rates", "import_batches"])
  g(c, db.getCollection(c).countDocuments({ tenantId: T }));
g("reseller logins", db.users.countDocuments({ tenantId: T, resellerId: { $exists: true, $ne: null } }));
for (const k of Object.keys(col)) {
  if (k !== "plan") /* plans made by hand stay; nothing else may hang off the imported tree */
    g(col[k] + " not from the import", db.getCollection(col[k]).countDocuments(
      { tenantId: T, _id: { $nin: ids[k] }, status: { $ne: "deleted" } }));
  g(col[k] + " matched to records made by hand", db.getCollection(col[k]).countDocuments(
    { tenantId: T, _id: { $in: ids[k] }, createdBy: { $ne: ACTOR } }));
}
g("wallet movements not by the importer", db.wallet_transfers.countDocuments({ tenantId: T, createdBy: { $ne: ACTOR } }));
const n = (c, f) => db.getCollection(c).countDocuments({ tenantId: T, ...f });
print(JSON.stringify({
  tenant: T.toHexString(),
  guards,
  counts: {
    resellers: ids.reseller.length, plans: ids.plan.length, routers: ids.nas.length, subscribers: ids.subscriber.length,
    wallets: n("wallets", {}), wallet_txns: n("wallet_txns", {}), wallet_transfers: n("wallet_transfers", {}),
    legacy_runs: n("legacy_runs", {}),
  },
  external: { subscriber: ids.subscriber.map(String), nas: ids.nas.map(String), plan: ids.plan.map(String) },
}));
'
plan="$(msh "$PLAN_JS")"
read -r TENANT GUARDS < <(python3 -c '
import json, sys
d = json.loads(sys.argv[1]); print(d["tenant"], len(d["guards"]))
for k, v in d["counts"].items(): print(f"  {k:17} {v}", file=sys.stderr)
for x in d["guards"]: print(f"  REFUSED: {x}", file=sys.stderr)' "$plan")
log "ISP $SLUG ($TENANT), $INSTANCE: MongoDB $MDB, PostgreSQL $PDB"
((GUARDS == 0)) || die "the ISP has data beyond the import (above); nothing changed"
pg_ids() { python3 -c 'import json, sys; print("{" + ",".join(json.loads(sys.argv[1])["external"][sys.argv[2]]) + "}")' "$plan" "$1"; }
SUBS="$(pg_ids subscriber)"; NAS="$(pg_ids nas)"; PLANS="$(pg_ids plan)"
pg_count() { echo "SELECT count(*) FROM $1 WHERE external_id = ANY(:'ids'::text[])" | runuser -u postgres -- psql -XtAq -d "$PDB" -v ids="$2"; }
log "RADIUS rows: subscribers $(pg_count subscribers "$SUBS"), routers $(pg_count nas "$NAS"), plans $(pg_count plans "$PLANS")"

if ! $APPLY; then log "dry run: nothing changed (add --apply)"; exit 0; fi

log "backup first"
systemctl start isp-backup.service || die "backup failed; nothing changed"

log "RADIUS: deleting subscribers, routers, plans"
runuser -u postgres -- psql -XtAq -v ON_ERROR_STOP=1 -d "$PDB" -v s="$SUBS" -v n="$NAS" -v p="$PLANS" <<'SQL'
BEGIN;
DELETE FROM subscribers WHERE external_id = ANY(:'s'::text[]);
DELETE FROM nas WHERE external_id = ANY(:'n'::text[]);
DELETE FROM plans WHERE external_id = ANY(:'p'::text[]);
COMMIT;
SQL

log "MongoDB: deleting imported records, wallets, import map"
msh "const SLUG = '$SLUG';$COMMON"'
const all = [].concat(ids.reseller, ids.plan, ids.nas, ids.subscriber);
const r = {};
for (const k of Object.keys(col)) r[col[k]] = db.getCollection(col[k]).deleteMany({ tenantId: T, _id: { $in: ids[k] } }).deletedCount;
for (const c of ["wallet_txns", "wallet_transfers", "wallets", "legacy_map", "legacy_runs"])
  r[c] = db.getCollection(c).deleteMany({ tenantId: T }).deletedCount;
r.outbox = db.outbox.deleteMany({ tenantId: T, entityId: { $in: all } }).deletedCount;
r.counters = db.counters.deleteMany({ _id: { $in: ["customerNo:" + T.toHexString(), "resellerCode:" + T.toHexString()] } }).deletedCount;
print(JSON.stringify(r));
'
/opt/isp-radius/scripts/maint.sh "$INSTANCE" nas-watch >/dev/null 2>&1 || true
log "done. Audit logs kept. Re-import: import-legacy --tenant $SLUG [--sites …] (dry run first)"
