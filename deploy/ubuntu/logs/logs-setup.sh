#!/usr/bin/env bash
# One-time (and safe to repeat) log archive setup (WP 4.6):  sudo bash deploy/ubuntu/logs/logs-setup.sh
#  - group isp-archive (gid 2470), /var/log/isp-archive (root:isp-archive 0750)
#  - rsyslog: UDP 514 listener for routers + archive rules (/etc/rsyslog.d/30-isp-archive.conf), syntax-checked first
#  - journald forwards to rsyslog (so FreeRADIUS and Docker container logs reach the archive)
#  - isp-logs-maint.timer: daily seal + 3-year prune + metrics
# Routers still need UDP 514 opened at NetForChoice and in ufw (logs-allow.sh) before their logs arrive.
set -Eeuo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ $EUID == 0 ]] || { echo "run as root" >&2; exit 1; }
log() { printf '[logs-setup] %s\n' "$*"; }

command -v rsyslogd >/dev/null || { log "installing rsyslog"; apt-get install -y -qq rsyslog >/dev/null; }
getent group isp-archive >/dev/null || groupadd -g 2470 isp-archive
[[ "$(getent group isp-archive | cut -d: -f3)" == 2470 ]] || { echo "group isp-archive exists with a gid other than 2470" >&2; exit 1; }
install -d -m 0750 -g isp-archive /var/log/isp-archive
for d in routers nat radius app host MANIFEST; do install -d -m 0750 -g isp-archive "/var/log/isp-archive/$d"; done

install -d /etc/systemd/journald.conf.d
install -m 0644 "$DIR/journald-isp.conf" /etc/systemd/journald.conf.d/isp-archive.conf
systemctl restart systemd-journald

install -m 0644 "$DIR/rsyslog-isp.conf" /etc/rsyslog.d/30-isp-archive.conf
rsyslogd -N1 >/dev/null 2>&1 || { rsyslogd -N1; echo "rsyslog config check failed; nothing restarted" >&2; exit 1; }
systemctl restart rsyslog
systemctl enable -q rsyslog

install -d -m 0755 /opt/isp-logs
install -m 0755 "$DIR/logs-maint.sh" "$DIR/logs-allow.sh" /opt/isp-logs/
install -m 0644 "$DIR"/systemd/isp-logs-*.service "$DIR"/systemd/isp-logs-*.timer /etc/systemd/system/
systemctl daemon-reload
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
