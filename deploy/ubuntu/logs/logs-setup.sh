#!/usr/bin/env bash
# One-time (and safe to repeat) log archive setup (WP 4.6):  sudo bash deploy/ubuntu/logs/logs-setup.sh
#  - group isp-archive (gid 2470), /var/log/isp-archive (syslog:isp-archive 2750: rsyslogd runs as syslog)
#  - /var/log/syslog rotated at 1 GB (logrotate hourly)
#  - rsyslog: UDP 514 listener for routers + archive rules (/etc/rsyslog.d/30-isp-archive.conf), syntax-checked first
#  - journald forwards to rsyslog (so Radius engine and Docker container logs reach the archive)
#  - isp-logs-maint.timer: daily seal + 3-year prune + metrics
# Routers still need UDP 514 opened at NetForChoice and in ufw (logs-allow.sh) before their logs arrive.
set -Eeuo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ $EUID == 0 ]] || { echo "run as root" >&2; exit 1; }
log() { printf '[logs-setup] %s\n' "$*"; }

command -v rsyslogd >/dev/null || { log "installing rsyslog"; apt-get install -y -qq rsyslog >/dev/null; }
getent group isp-archive >/dev/null || groupadd -g 2470 isp-archive
[[ "$(getent group isp-archive | cut -d: -f3)" == 2470 ]] || { echo "group isp-archive exists with a gid other than 2470" >&2; exit 1; }
# rsyslogd runs as user syslog: it must own the directories it writes into. setgid (2750) makes everything it
# creates inherit group isp-archive. Existing subdirectories (per router, per program) are fixed too; sealed
# files keep root ownership. MANIFEST is written only by logs-maint.sh (root).
WRITER=syslog; id -u syslog >/dev/null 2>&1 || WRITER=root
install -d -o "$WRITER" -g isp-archive -m 2750 /var/log/isp-archive
for d in routers nat radius app host; do install -d -o "$WRITER" -g isp-archive -m 2750 "/var/log/isp-archive/$d"; done
find /var/log/isp-archive -mindepth 2 -type d -not -path '/var/log/isp-archive/MANIFEST*' \
  -exec chown "$WRITER:isp-archive" {} + -exec chmod 2750 {} +
find /var/log/isp-archive -type f -name '*.log' -not -user "$WRITER" -exec chown "$WRITER:isp-archive" {} +
install -d -o root -g isp-archive -m 0750 /var/log/isp-archive/MANIFEST

# /var/log/syslog must never fill the disk again: rotate at 1 GB, checked hourly.
LR=/etc/logrotate.d/rsyslog
if [[ -f $LR ]] && ! grep -q 'maxsize' "$LR"; then
  cp -p "$LR" "$LR.isp-bak"
  sed -i '0,/^{/s//{\n\tmaxsize 1G/' "$LR"
  if logrotate -d /etc/logrotate.conf 2>&1 | grep -q "error: $LR:"; then
    mv -f "$LR.isp-bak" "$LR"; echo "logrotate rejected maxsize in $LR; restored it" >&2; exit 1
  fi
  rm -f "$LR.isp-bak"
fi
install -d /etc/systemd/system/logrotate.timer.d
printf '[Timer]\nOnCalendar=\nOnCalendar=hourly\nAccuracySec=1m\n' >/etc/systemd/system/logrotate.timer.d/isp-hourly.conf

install -d /etc/systemd/journald.conf.d
install -m 0644 "$DIR/journald-isp.conf" /etc/systemd/journald.conf.d/isp-archive.conf
systemctl restart systemd-journald

install -m 0644 "$DIR/rsyslog-isp.conf" /etc/rsyslog.d/30-isp-archive.conf
rsyslogd -N1 >/dev/null 2>&1 || { rsyslogd -N1; echo "rsyslog config check failed; nothing restarted" >&2; exit 1; }
systemctl restart rsyslog
systemctl enable -q rsyslog

install -d -m 0755 /opt/isp-logs
# Off-site copy of old archive days (same bucket as backups); empty LOG_REMOTE = everything stays here.
install -d -m 0700 /etc/isp-logs
[[ -f /etc/isp-logs/offload.env ]] || cat >/etc/isp-logs/offload.env <<'CONF'
# rclone remote for sealed log days older than KEEP_LOCAL_DAYS, e.g. offsite:my-bucket/isp-logs (empty = keep all here)
LOG_REMOTE=
KEEP_LOCAL_DAYS=60
# Day files are already gzip -9. yes = also age-encrypt to the backup key (fetching then needs the private key).
LOG_ENCRYPT=no
CONF
chmod 0600 /etc/isp-logs/offload.env
install -m 0755 "$DIR/logs-maint.sh" "$DIR/logs-allow.sh" /opt/isp-logs/
install -m 0644 "$DIR"/systemd/isp-logs-*.service "$DIR"/systemd/isp-logs-*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl restart logrotate.timer
systemctl enable -q --now isp-logs-maint.timer isp-logs-metrics.timer
/opt/isp-logs/logs-maint.sh metrics

logger -t logs-setup-test "log archive installed"
sleep 2
if grep -rqs "log archive installed" /var/log/isp-archive/host/system/; then
  log "OK: archive is receiving local logs (/var/log/isp-archive/host/system/$(date +%F).log)"
else
  log "WARNING: test message not found in the archive yet; check: journalctl -u rsyslog -n 20"
fi
log "Container logs reach the archive after the next app deploy (docker-compose.yml uses the journald driver):"
log "  cd ~/isp-platform && sudo bash deploy/ubuntu/app/app-up.sh"
