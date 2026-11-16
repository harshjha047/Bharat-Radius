#!/usr/bin/env bash
# Which routers may send syslog/NAT logs (UDP 514). Same idea as radius nas-allow.sh: the list lives in
# /etc/isp-logs/routers.allow ("<ip> <name>" per line) and ufw is rebuilt from it.
#   sudo /opt/isp-logs/logs-allow.sh list | add <ip> <name> | remove <ip|name> | apply
set -Eeuo pipefail
LIST="${LIST:-/etc/isp-logs/routers.allow}"
CMD="${1:-list}"
TAG="isp-logs:"
die() { echo "logs-allow: $*" >&2; exit 1; }
install -d -m 0755 "$(dirname "$LIST")"
[[ -f $LIST ]] || install -m 0644 /dev/null "$LIST"
entries() { grep -Ev '^\s*(#|$)' "$LIST" || true; }
valid_ip() { python3 -c 'import ipaddress,sys; ipaddress.ip_network(sys.argv[1], strict=False)' "$1" 2>/dev/null; }

apply() {
  local st=""
  command -v ufw >/dev/null && st="$(ufw status 2>/dev/null || true)"
  if [[ $st != *"Status: active"* ]]; then echo "ufw is not active: list saved, no firewall change"; return 0; fi
  local n ip name
  while n="$(ufw status numbered | grep -F "# $TAG" | sed -n 's/^\[ *\([0-9]*\)\].*/\1/p' | tail -1)"; [[ -n $n ]]; do
    ufw --force delete "$n" >/dev/null
  done
  while read -r ip name; do
    ufw allow from "$ip" to any port 514 proto udp comment "$TAG ${name:-$ip}" >/dev/null
  done < <(entries)
  echo "ufw: $(entries | wc -l) router(s) may send logs to UDP 514"
}

case "$CMD" in
  list) entries | awk '{ printf "%-20s %s\n", $1, $2 }'; [[ -n "$(entries)" ]] || echo "(empty: no router can send logs)" ;;
  add)
    ip="${2:-}"; name="${3:-}"
    [[ -n $ip && -n $name ]] || die "usage: $0 add <ip|cidr> <name>"
    [[ $name =~ ^[A-Za-z0-9._-]{1,40}$ ]] || die "name: letters, digits, . _ - (max 40)"
    valid_ip "$ip" || die "not an IP address or CIDR: $ip"
    tmp="$(mktemp)"; awk -v ip="$ip" -v n="$name" '$1 != ip && $2 != n' "$LIST" >"$tmp"
    echo "$ip $name" >>"$tmp"; install -m 0644 "$tmp" "$LIST"; rm -f "$tmp"; apply ;;
  remove)
    key="${2:-}"; [[ -n $key ]] || die "usage: $0 remove <ip|name>"
    awk -v k="$key" '$1 == k || $2 == k { f = 1 } END { exit !f }' "$LIST" || die "$key is not in $LIST"
    tmp="$(mktemp)"; awk -v k="$key" '$1 != k && $2 != k' "$LIST" >"$tmp"
    install -m 0644 "$tmp" "$LIST"; rm -f "$tmp"; apply ;;
  apply) apply ;;
  *) die "unknown command $CMD" ;;
esac
