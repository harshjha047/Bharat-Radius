#!/usr/bin/env bash
# One-time (safe to repeat) disk guard setup:  sudo bash deploy/ubuntu/disk/disk-setup.sh
#  - /opt/isp-disk/disk-guard.sh + isp-disk-guard.timer (every 5 min)
#  - /etc/isp-disk/guard.env (thresholds), /run/isp-guard (flags read by api, web, workers)
#  - a 5 GB emergency reserve file, released automatically at 95 %
set -Eeuo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ $EUID == 0 ]] || { echo "run as root" >&2; exit 1; }
install -d -m 0755 /opt/isp-disk
install -m 0755 "$DIR/disk-guard.sh" /opt/isp-disk/
install -d -m 0755 /etc/isp-disk
[[ -f /etc/isp-disk/guard.env ]] || cat >/etc/isp-disk/guard.env <<'CONF'
# Used-space thresholds in percent of / (see disk-guard.sh)
DRILL_AT=70
DRILL_OFF=65
MAINT_AT=85
MAINT_OFF=80
RESERVE_AT=95
RESERVE_GB=5
# During a drill, log days older than this move off-site (normally 60, offload.env)
DRILL_KEEP_DAYS=7
CONF
echo 'd /run/isp-guard 0755 root root -' >/etc/tmpfiles.d/isp-guard.conf
systemd-tmpfiles --create /etc/tmpfiles.d/isp-guard.conf
install -m 0644 "$DIR"/systemd/isp-disk-guard.* /etc/systemd/system/
systemctl daemon-reload
systemctl enable -q --now isp-disk-guard.timer
/opt/isp-disk/disk-guard.sh run
/opt/isp-disk/disk-guard.sh status
