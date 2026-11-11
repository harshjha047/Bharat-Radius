#!/usr/bin/env bash
# Which routers may reach RADIUS (ufw). The list lives in /etc/isp-radius/<instance>.allow, so it survives
# reinstalls; ufw is rebuilt from it. One entry per line: "<ip or cidr> <name>"; "any <name>" = open to all.
#   sudo nas-allow.sh production list
#   sudo nas-allow.sh production add 160.191.125.238 fab5
#   sudo nas-allow.sh production remove fab5            # by name or ip
#   sudo nas-allow.sh staging   apply                   # rebuild ufw rules from the file
# Rules it manages carry the comment "isp-radius <instance>: <name>"; rules with other comments are left alone.
set -Eeuo pipefail
ETC_DIR="${ETC_DIR:-/etc/isp-radius}"
INST="${1:-}"; CMD="${2:-list}"
die() { echo "nas-allow: $*" >&2; exit 1; }
[[ $INST == production || $INST == staging ]] || die "usage: $0 <production|staging> <list|add|remove|apply> [ip] [name]"
[[ -f $ETC_DIR/$INST.conf ]] || die "$ETC_DIR/$INST.conf not found (RADIUS instance not installed)"
AUTH_PORT="$(sed -n 's/^AUTH_PORT=//p' "$ETC_DIR/$INST.conf")"
ACCT_PORT="$(sed -n 's/^ACCT_PORT=//p' "$ETC_DIR/$INST.conf")"
LIST="$ETC_DIR/$INST.allow"
TAG="isp-radius $INST:"
[[ -f $LIST ]] || install -m 0644 /dev/null "$LIST"

entries() { grep -Ev '^\s*(#|$)' "$LIST" || true; }

valid_ip() { python3 -c 'import ipaddress,sys; ipaddress.ip_network(sys.argv[1], strict=False)' "$1" 2>/dev/null; }

apply() {
  local st=""
  command -v ufw >/dev/null && st="$(ufw status 2>/dev/null || true)"
  if [[ $st != *"Status: active"* ]]; then
    echo "ufw is not active: list saved, no firewall change"; return 0
  fi
  # Remove every rule this tool (or the old installer: "isp-radius <instance>") created for the instance.
  while n="$(ufw status numbered | grep -E "# isp-radius $INST(:|\$| )" | sed -n 's/^\[ *\([0-9]*\)\].*/\1/p' | tail -1)"; [[ -n $n ]]; do
    ufw --force delete "$n" >/dev/null
  done
  local ip name
  while read -r ip name; do
    if [[ $ip == any ]]; then
      ufw allow "$AUTH_PORT,$ACCT_PORT/udp" comment "$TAG ${name:-any}" >/dev/null
    else
      ufw allow from "$ip" to any port "$AUTH_PORT,$ACCT_PORT" proto udp comment "$TAG ${name:-$ip}" >/dev/null
    fi
  done < <(entries)
  local others
  others="$(ufw status | grep -E "(^| )$AUTH_PORT,$ACCT_PORT/udp" | grep -v "# isp-radius $INST:" || true)"
  [[ -z $others ]] || printf 'note: other ufw rules for these ports (not managed here):\n%s\n' "$others"
  echo "ufw: $(entries | wc -l) rule(s) for $INST ($AUTH_PORT,$ACCT_PORT/udp)"
}

case "$CMD" in
  list)
    entries | awk '{ printf "%-20s %s\n", $1, $2 }'
    [[ -n "$(entries)" ]] || echo "(empty: no router can reach $INST RADIUS)"
    ;;
  add)
    ip="${3:-}"; name="${4:-}"
    [[ -n $ip && -n $name ]] || die "usage: $0 $INST add <ip|cidr|any> <name>"
    [[ $name =~ ^[A-Za-z0-9._-]{1,40}$ ]] || die "name: letters, digits, . _ - (max 40)"
    [[ $ip == any ]] || valid_ip "$ip" || die "not an IP address or CIDR: $ip"
    tmp="$(mktemp)"; awk -v ip="$ip" -v n="$name" '$1 != ip && $2 != n' "$LIST" >"$tmp"
    echo "$ip $name" >>"$tmp"; install -m 0644 "$tmp" "$LIST"; rm -f "$tmp"
    apply
    ;;
  remove)
    key="${3:-}"; [[ -n $key ]] || die "usage: $0 $INST remove <ip|name>"
    awk -v k="$key" '$1 == k || $2 == k { f = 1 } END { exit !f }' "$LIST" || die "$key is not in $LIST"
    tmp="$(mktemp)"; awk -v k="$key" '$1 != k && $2 != k' "$LIST" >"$tmp"
    install -m 0644 "$tmp" "$LIST"; rm -f "$tmp"
    apply
    ;;
  apply) apply ;;
  *) die "unknown command $CMD" ;;
esac
