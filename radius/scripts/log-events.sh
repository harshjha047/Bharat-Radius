#!/usr/bin/env bash
# F-17: record RADIUS packets that could not be used, so the panel can say why a router gets no answer.
#   log-events.sh <instance>            ingest new lines since the last run (systemd timer, every minute)
#   log-events.sh <instance> parse      read log lines on stdin, print "kind<TAB>who<TAB>port<TAB>time" (tests)
# Sources:
#   FreeRADIUS log (logdir/radius.log): "unknown client <ip>" and "invalid Message-/Request Authenticator"
#     (= wrong shared secret; accounting lines name the router by its short name).
#   Kernel log (journald): "[UFW BLOCK]" for this instance's RADIUS ports = an address not on the allow-list.
# Rows go to radius_events (one per kind, address, port and minute). Both sources rate-limit their messages,
# so counts are "at least". Offsets: /var/lib/isp-radius/<instance>.radlog.pos, <instance>.kernel.cursor.
set -Eeuo pipefail
export LC_ALL=C
INSTANCE="${1:?instance}"; MODE="${2:-ingest}"
ETC_DIR=/etc/isp-radius; STATE_DIR=/var/lib/isp-radius
# shellcheck disable=SC1090
. "$ETC_DIR/$INSTANCE.conf"
case "$INSTANCE" in
  production) RADLOG=/var/log/freeradius/radius.log ;;
  staging) RADLOG=/var/log/freeradius-staging/radius.log ;;
  *) echo "instance must be production or staging" >&2; exit 2 ;;
esac

# FreeRADIUS lines start "Thu Nov 19 13:00:01 2026 : Error: ..."; kernel lines are prefixed by us with the time.
parse() {
  awk -v auth="$AUTH_PORT" -v acct="$ACCT_PORT" '
    function ts(line) { return substr(line, 1, 24) }
    / from unknown client / {
      if (match($0, /from unknown client [0-9a-fA-F:.]+/)) {
        ip = substr($0, RSTART + 20, RLENGTH - 20)
        port = (match($0, /port [0-9]+ bound/)) ? substr($0, RSTART + 5, RLENGTH - 11) : 0
        printf "unknown_client\t%s\t%s\t%s\n", ip, port, ts($0)
      }
      next
    }
    /Received packet from [0-9a-fA-F:.]+( port [0-9]+)? with invalid Message-Authenticator/ {
      match($0, /Received packet from [0-9a-fA-F:.]+/)
      printf "bad_secret\t%s\t%s\t%s\n", substr($0, RSTART + 21, RLENGTH - 21), auth, ts($0)
      next
    }
    /packet from client .* with invalid Request Authenticator/ {
      match($0, /packet from client [^ ]+/)
      printf "bad_secret_name\t%s\t%s\t%s\n", substr($0, RSTART + 19, RLENGTH - 19), acct, ts($0)
      next
    }
    /\[UFW BLOCK\]/ && / PROTO=UDP / {
      if (match($0, / DPT=[0-9]+/)) {
        dpt = substr($0, RSTART + 5, RLENGTH - 5)
        if (dpt != auth && dpt != acct) next
        match($0, / SRC=[0-9a-fA-F:.]+/)
        printf "firewall_block\t%s\t%s\t%s\n", substr($0, RSTART + 5, RLENGTH - 5), dpt, ts($0)
      }
    }'
}

if [[ $MODE == parse ]]; then parse; exit 0; fi
[[ $MODE == ingest ]] || { echo "usage: $0 <instance> [parse]" >&2; exit 2; }

install -d -m 0700 "$STATE_DIR"
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT

# ---- FreeRADIUS log since the last offset (restart from 0 after rotation)
if [[ -r $RADLOG ]]; then
  POS_FILE="$STATE_DIR/$INSTANCE.radlog.pos"
  read -r ino pos <"$POS_FILE" 2>/dev/null || { ino=0; pos=0; }
  cur_ino="$(stat -c %i "$RADLOG")"; size="$(stat -c %s "$RADLOG")"
  if [[ $cur_ino != "$ino" || $size -lt $pos ]]; then
    # First run: only the last 1 MB, not years of history.
    [[ $ino == 0 && $size -gt 1048576 ]] && pos=$((size - 1048576)) || pos=0
  fi
  tail -c +"$((pos + 1))" "$RADLOG" | head -c "$((size - pos))" | parse >>"$TMP" || true
  echo "$cur_ino $size" >"$POS_FILE"
fi

# ---- kernel firewall log (journald), "Mon DD HH:MM:SS"-free: we print our own timestamp per line
CURSOR="$STATE_DIR/$INSTANCE.kernel.cursor"
since=(); [[ -s $CURSOR ]] || since=(--since "-10 min")
journalctl -k --no-pager -q --cursor-file="$CURSOR" "${since[@]}" -o short-unix 2>/dev/null \
  | awk '/\[UFW BLOCK\]/ { t = int($1); $1 = ""; cmd = "date -d @" t " +\"%a %b %e %H:%M:%S %Y\""; cmd | getline d; close(cmd); print d " :" $0 }' \
  | parse >>"$TMP" || true

[[ -s $TMP ]] || exit 0
TZNAME="$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo UTC)"
{
  echo "CREATE TEMP TABLE e (kind text, who text, port int, t text);"
  echo "COPY e FROM STDIN;"
  cat "$TMP"
  echo '\.'
  cat <<SQL
INSERT INTO radius_events (kind, src_ip, dst_port, minute, packets)
SELECT k, ip, port, m, count(*) FROM (
  SELECT CASE WHEN e.kind = 'bad_secret_name' THEN 'bad_secret' ELSE e.kind END AS k,
         CASE WHEN e.kind = 'bad_secret_name'
              THEN (SELECT n.nasname FROM nas n WHERE n.shortname = e.who ORDER BY n.id LIMIT 1)
              ELSE e.who::inet END AS ip,
         e.port,
         date_trunc('minute', to_timestamp(regexp_replace(e.t, '\s+', ' ', 'g'), 'Dy Mon DD HH24:MI:SS YYYY')::timestamp
                              AT TIME ZONE '$TZNAME') AS m
    FROM e
) x WHERE ip IS NOT NULL
GROUP BY 1, 2, 3, 4
ON CONFLICT (kind, src_ip, dst_port, minute) DO UPDATE SET packets = radius_events.packets + EXCLUDED.packets;
SQL
} | runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -d "$DB" >/dev/null
