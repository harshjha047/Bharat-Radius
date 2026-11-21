#!/usr/bin/env bash
# Which routers may reach RADIUS (ufw). The list lives in /etc/isp-radius/<instance>.allow, so it survives
# reinstalls; ufw is rebuilt from it. One entry per line: "<ip or cidr> <name>"; "any <name>" = open to all.
#   sudo nas-allow.sh production list
#   sudo nas-allow.sh production add 160.191.125.238 fab5
#   sudo nas-allow.sh production remove fab5            # by name or ip
#   sudo nas-allow.sh staging   apply                   # make ufw match the file
#   sudo nas-allow.sh staging   sync                    # refresh "db-*" entries from the nas table, then apply
# "db-*" entries mirror the nas table (routers added in the panel) and are rewritten by sync, which the NAS watcher
# runs on every nas change; hand-added entries are kept. Rules it manages carry the comment
# "isp-radius <instance>: <name>"; rules with other comments are left alone.
set -Eeuo pipefail
ETC_DIR="${ETC_DIR:-/etc/isp-radius}"
INST="${1:-}"; CMD="${2:-list}"
die() { echo "nas-allow: $*" >&2; exit 1; }
[[ $INST == production || $INST == staging ]] || die "usage: $0 <production|staging> <list|add|remove|apply|sync> [ip] [name]"
[[ -f $ETC_DIR/$INST.conf ]] || die "$ETC_DIR/$INST.conf not found (RADIUS instance not installed)"
AUTH_PORT="$(sed -n 's/^AUTH_PORT=//p' "$ETC_DIR/$INST.conf")"
DB="$(sed -n 's/^DB=//p' "$ETC_DIR/$INST.conf")"
ACCT_PORT="$(sed -n 's/^ACCT_PORT=//p' "$ETC_DIR/$INST.conf")"
LIST="$ETC_DIR/$INST.allow"
TAG="isp-radius $INST:"
[[ -f $LIST ]] || install -m 0644 /dev/null "$LIST"

entries() { grep -Ev '^\s*(#|$)' "$LIST" || true; }

valid_ip() { python3 -c 'import ipaddress,sys; ipaddress.ip_network(sys.argv[1], strict=False)' "$1" 2>/dev/null; }

# Rules managed for this instance as "<number> <from> <name>", highest number first (safe deletion order).
managed_rules() {
  ufw status numbered | python3 -c '
import re, sys
tag = sys.argv[1]
rows = []
for line in sys.stdin:
    m = re.match(r"^\[\s*(\d+)\]\s+(.*?)\s+ALLOW(?: IN)?\s+(.*?)\s+# (.*)$", line.rstrip())
    if not m:
        continue
    num, _to, frm, comment = m.groups()
    if comment == tag.rstrip(":") or comment.startswith(tag + " ") or comment.startswith(tag.rstrip(":") + " "):
        name = comment[len(tag):].strip() if comment.startswith(tag) else ""
        frm = frm.replace(" (v6)", "")
        rows.append((int(num), "any" if frm == "Anywhere" else frm, name))
for n, f, name in sorted(rows, reverse=True):
    print(n, f, name or "-")
' "$TAG"
}

# The "From" column ufw shows for an entry: host address for /32 and /128, normalised network otherwise.
ufw_from() {
  [[ $1 == any ]] && { echo any; return; }
  python3 -c '
import ipaddress, sys
n = ipaddress.ip_network(sys.argv[1], strict=False)
print(n.network_address if n.prefixlen == n.max_prefixlen else n)' "$1"
}

apply() {
  local st=""
  command -v ufw >/dev/null && st="$(ufw status 2>/dev/null || true)"
  if [[ $st != *"Status: active"* ]]; then
    echo "ufw is not active: list saved, no firewall change"; return 0
  fi
  # Add first, then delete what is no longer listed: a router never loses access while rules are rebuilt.
  local ip name want=""
  while read -r ip name; do
    name="${name:-$ip}"
    want+="$(ufw_from "$ip") $name"$'\n'
    if [[ $ip == any ]]; then
      ufw allow "$AUTH_PORT,$ACCT_PORT/udp" comment "$TAG $name" >/dev/null
    else
      ufw allow from "$ip" to any port "$AUTH_PORT,$ACCT_PORT" proto udp comment "$TAG $name" >/dev/null
    fi
  done < <(entries)
  local n from removed=0
  while read -r n from name; do
    [[ -n $n ]] || continue
    grep -qxF "$from $name" <<<"$want" && continue
    ufw --force delete "$n" >/dev/null; removed=$((removed + 1))
  done < <(managed_rules)
  local others
  others="$(ufw status | grep -E "(^| )$AUTH_PORT,$ACCT_PORT/udp" | grep -v "# isp-radius $INST:" || true)"
  [[ -z $others ]] || printf 'note: other ufw rules for these ports (not managed here):\n%s\n' "$others"
  echo "ufw: $(entries | wc -l) entr(y/ies) for $INST ($AUTH_PORT,$ACCT_PORT/udp), $removed stale rule(s) removed"
}

sync_db() {
  local rows tmp
  # Name: db-<id>-<shortname>, restricted to the characters "add" accepts.
  rows="$(runuser -u postgres -- psql -XtA -v ON_ERROR_STOP=1 -d "$DB" -F ' ' -c \
    "SELECT host(nasname), left('db-' || id || '-' || regexp_replace(shortname, '[^A-Za-z0-9._-]+', '-', 'g'), 40)
       FROM nas ORDER BY id")"
  tmp="$(mktemp)"
  # Keep hand-added entries; drop old db-* rows and the installer's former open-to-all lab default.
  awk '$2 !~ /^db-/ && !($1 == "any" && $2 == "staging-lab")' "$LIST" >"$tmp"
  [[ -z $rows ]] || printf '%s\n' "$rows" >>"$tmp"
  if ! cmp -s "$tmp" "$LIST"; then install -m 0644 "$tmp" "$LIST"; fi
  rm -f "$tmp"
  apply
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
  sync) sync_db ;;
  *) die "unknown command $CMD" ;;
esac
