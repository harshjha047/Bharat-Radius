#!/usr/bin/env bash
# One-time backup setup (WP 4.8):  sudo bash deploy/ubuntu/backup/backup-setup.sh 'age1…public-key'
# Installs age + rclone, /etc/isp-backup/backup.env (root-only), the nightly timer (01:30 IST), and runs one backup.
# Off-site: run `sudo rclone config` (remote name "offsite") for the chosen S3-compatible bucket, then set
# RCLONE_REMOTE=offsite:<bucket>/isp-backups in /etc/isp-backup/backup.env.
set -Eeuo pipefail
RECIPIENT="${1:-}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ $EUID == 0 ]] || { echo "run as root" >&2; exit 1; }
[[ $RECIPIENT =~ ^age1[0-9a-z]{58}$ ]] || {
  echo "usage: $0 'age1…'   (public key from: age-keygen -o isp-backup.key  — on YOUR computer, keep the key file safe)" >&2
  exit 2
}
apt-get install -y -qq age rclone >/dev/null
install -d -m 0700 /etc/isp-backup /opt/isp-backup
install -m 0755 "$DIR/backup.sh" "$DIR/restore-test.sh" /opt/isp-backup/
if [[ ! -f /etc/isp-backup/backup.env ]]; then
  cat >/etc/isp-backup/backup.env <<CONF
# age public key of the owner: backups are encrypted to it; the private key is NOT on this server.
AGE_RECIPIENT=$RECIPIENT
# rclone remote for the off-site copy, e.g. offsite:my-bucket/isp-backups (empty = local only)
RCLONE_REMOTE=
BACKUP_DIR=/var/backups/isp
KEEP_LOCAL_DAYS=7
KEEP_REMOTE_DAYS=35
PG_DATABASES="radius radius_staging"
CONF
else
  sed -i "s|^AGE_RECIPIENT=.*|AGE_RECIPIENT=$RECIPIENT|" /etc/isp-backup/backup.env
fi
chmod 0600 /etc/isp-backup/backup.env
install -m 0644 "$DIR"/systemd/isp-backup.service "$DIR"/systemd/isp-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable -q --now isp-backup.timer
echo "running the first backup…"
systemctl start isp-backup.service
journalctl -u isp-backup.service -n 20 --no-pager
