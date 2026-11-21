# Importing from the old BharatRadius (WP 4.7)

The old system (ASP.NET + PostgreSQL 16 `RadiusSoftwareDb`, Windows server) stays live until each POP's cutover.
Its dump is restored on the VPS into a scratch database and read from there; the old server is never touched.

## What is imported

| Old | New | Notes |
|---|---|---|
| `Sites` | resellers | Tree from `ParentSiteId`/`ParentSiteMsrNumber`; inactive → suspended; level 1 may add sub-resellers |
| `SiteWallets.Balance` | opening balance | Master → … → reseller transfers ("Opening balance from old BharatRadius"); negative balances start at ₹0 (owner, 18 Nov 2026) |
| `PackageProfiles` | plans | One plan per name + speed + validity + price; "1 Months" = 30 days; prepaid, SAC 998422, 18 %; an existing plan with the same name and speeds is reused |
| `NasDevices` | routers | Matched by IP (an existing router is kept); new ones get a fresh secret — reveal it in the panel when running `setup.rsc` |
| `Subscribers` | subscribers | Same PPPoE username and password (cleartext in the old DB, encrypted here); `ExpireDate` kept exactly (23:59:59 IST); `ConnectionEnabled = false` → disabled; no expiry → expired yesterday; owner = its site's reseller; `popName` = old router name |

Not imported: staff users (new logins), RADIUS/accounting logs (the dump is the archive), wallet history (opening
balance only), CAF files (on the old server's disk, WP 4.5), `Subscribers_DuplicatesBackup`, gateway/SMS keys.

Missing required fields are filled from the reseller, then the ISP, and the subscriber is tagged `legacy-fix` with a
note listing what was filled (filter the list by tag and correct them). Invalid optional values (email, GSTIN, MAC,
static IP) are left empty. Rows with an invalid username or password are not imported and are listed.

## 1. Restore the dump (once per fresh dump)

```bash
# dump arrives in /tmp via scp (never Drive/email); checksum from radius-data-sha256.txt
sudo install -d -m 700 -o postgres -g postgres /var/lib/isp-migration
sudo mv /tmp/radius-data-*.dump /var/lib/isp-migration/ && sudo chown postgres: /var/lib/isp-migration/*
sudo sha256sum /var/lib/isp-migration/radius-data-*.dump        # compare with the .txt
sudo -u postgres dropdb --if-exists bharatradius_legacy
sudo -u postgres createdb bharatradius_legacy
sudo -u postgres psql -c "REVOKE ALL ON DATABASE bharatradius_legacy FROM PUBLIC"
sudo -u postgres pg_restore --no-owner --no-acl -d bharatradius_legacy /var/lib/isp-migration/radius-data-<stamp>.dump
```

## 2. Dry run, then apply

```bash
cd ~/isp-platform
C="docker compose -f deploy/ubuntu/app/docker-compose.yml exec -T api node dist/cli.js"
X="sudo -u postgres psql -d bharatradius_legacy -XAtq"

$X < deploy/ubuntu/migration/legacy-export.sql | $C import-legacy --tenant bharat              # dry run
$X < deploy/ubuntu/migration/legacy-export.sql | $C import-legacy --tenant bharat --apply      # import
```

`--sites 5` (old site numbers, comma separated) limits the run to those resellers, their parents and their
customers — use it per POP. The snapshot goes through the pipe only; it is never written to disk.

The report shows created / updated / unchanged / failed per kind, notes (fields filled, plans still at ₹1, negative
balances), subscribers not imported, and after `--apply` a reconciliation: every old subscriber in scope must exist
with the same password, plan, validity, owner and status, and every opening balance must match. Exit code 2 on any
mismatch.

## 3. Re-runs and the cutover delta

Running again is safe: `legacy_map` links each old id to the new record. A later dump applies only what changed in
the old system: password, plan, validity, disabled/active and owner per subscriber; new subscribers, sites, plans and
routers are added; a higher old wallet balance tops up the difference. A *lower* balance is reported, not taken back.

At each POP cutover (IMPLEMENTATION_PLAN §8 step 3): fresh dump → restore → `import-legacy --sites <n> --apply` →
reconciliation "all match" → continue with step 4.

## Before the first apply

- Set the real MRP on every imported plan that the report lists at ₹1.
- A username already used by a subscriber that was not imported (for example a test user such as `john@123`) is
  refused; delete or rename one of them and run again.
- Each run is recorded in `legacy_runs`; every created or changed record is in the audit log as `*.legacy_import`
  / `subscriber.legacy_update` (actor "old BharatRadius importer").
