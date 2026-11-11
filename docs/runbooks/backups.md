# Backups and restore (WP 4.8)

Nightly at **01:30 IST** (`isp-backup.timer`, before the 02:00 reconciliation). Scripts in `deploy/ubuntu/backup/`, installed to `/opt/isp-backup/`.

| Kind | What | Verified before keeping |
|---|---|---|
| `mongo` | All MongoDB databases (`mongodump --oplog`, consistent snapshot of the replica set) | `mongorestore --dryRun` |
| `postgres` | `radius` and `radius_staging` (`pg_dump -Fc`) | `pg_restore --list` |
| `etc` | `/etc/isp-radius`, `/etc/isp-app` (all server secrets) | `tar -t` |

- **Encryption:** every file is encrypted with [age](https://age-encryption.org) to the **owner's public key**. The private key is never on the server, so a stolen server or bucket does not expose backups. Lose the private key = lose the backups: keep two copies offline (password manager + printed/USB).
- **Where:** `/var/backups/isp/<UTC stamp>/` (7 days) + off-site copy with rclone (35 days) once the bucket is chosen (O-18). `SHA256SUMS` in each folder.
- **Monitoring:** `isp_backup_last_success_timestamp_seconds{kind}`, `isp_backup_size_bytes`, `isp_backup_offsite` → alerts `BackupMissing` (critical, 26 h) and `BackupNeverRan`.

Recovery point: up to 24 h for MongoDB and PostgreSQL. Continuous WAL archiving (PITR) is the next step once the bucket exists (plan item kept open in the gate).

## Setup (once)

On **your computer** (not the server):

```bash
age-keygen -o isp-backup.key        # prints "Public key: age1…"; keep isp-backup.key safe, offline, two copies
```

On the VPS:

```bash
cd ~/isp-platform && git pull
sudo bash deploy/ubuntu/backup/backup-setup.sh 'age1…'      # installs age + rclone, timer, runs the first backup
ls -l /var/backups/isp/*/                                     # mongo.archive.gz.age, radius.pgdump.age, …, SHA256SUMS
```

Off-site, after choosing the provider (any S3-compatible: AWS S3, Backblaze B2, Cloudflare R2, Wasabi, …):

```bash
sudo rclone config                                            # new remote named "offsite", type s3 (provider + keys)
sudo sed -i 's|^RCLONE_REMOTE=.*|RCLONE_REMOTE=offsite:<bucket>/isp-backups|' /etc/isp-backup/backup.env
sudo systemctl start isp-backup.service && journalctl -u isp-backup -n 20 --no-pager   # "off-site: copying …"
```

Use a bucket key that can write and list but not delete versions (object lock / versioning on), so ransomware on the server cannot erase old backups.

## Restore drill (monthly, and before each POP cutover)

Restores the newest backup into throw-away databases (`restore_*`) next to the live ones, compares record counts, drops them. Live data is not touched.

```bash
scp isp-backup.key deploy@154.49.142.251:/tmp/age.key          # from your computer
sudo install -m 0600 -o root /tmp/age.key /root/age.key && shred -u /tmp/age.key
sudo AGE_IDENTITY=/root/age.key bash /opt/isp-backup/restore-test.sh
sudo shred -u /root/age.key
```

Pass = `restore drill PASSED`. Record the date and result in the Step 4 gate.

## Real restore (disaster)

1. New server: run the base installs (`radius/scripts/install.sh all`, `deploy/ubuntu/app/app-up.sh`, monitoring).
2. Fetch and decrypt: `rclone copy offsite:<bucket>/isp-backups/<stamp> /root/r/ && cd /root/r && sha256sum -c SHA256SUMS && for f in *.age; do age -d -i /root/age.key -o "${f%.age}" "$f"; done`
3. Secrets: `tar -xzf etc.tar.gz -C /` (restores `/etc/isp-radius`, `/etc/isp-app`; re-run the installers so services pick them up).
4. PostgreSQL: `sudo -u postgres pg_restore --clean --if-exists -d radius radius.pgdump` (and staging).
5. MongoDB: `docker exec -i isp-mongo mongorestore -u root -p "$(cat /etc/isp-app/mongo_root_pw)" --authenticationDatabase admin --archive --gzip --oplogReplay --drop < mongo.archive.gz`
6. `sudo bash deploy/ubuntu/app/app-up.sh`, then check: panel login, a test PPPoE login (`probe.sh run`), wallet reconciliation (`$C run-job reconcile-wallets`).
