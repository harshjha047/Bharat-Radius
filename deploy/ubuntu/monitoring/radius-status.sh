#!/usr/bin/env bash
# Asks each FreeRADIUS instance for its Status-Server statistics and writes Prometheus metrics for the node exporter's
# textfile collector. Run by isp-radius-status.timer every 15 s. isp_radius_up = 0 when an instance does not answer.
set -uo pipefail
OUT_DIR="${OUT_DIR:-/var/lib/prometheus/node-exporter}"
tmp="$(mktemp "$OUT_DIR/.isp_radius.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

{
  echo '# HELP isp_radius_up 1 if the FreeRADIUS instance answered Status-Server.'
  echo '# TYPE isp_radius_up gauge'
  echo '# HELP isp_radius_status_seconds Status-Server round trip.'
  echo '# TYPE isp_radius_status_seconds gauge'
  for conf in /etc/isp-radius/production.conf /etc/isp-radius/staging.conf; do
    [[ -f $conf ]] || continue
    inst="$(sed -n 's/^INSTANCE=//p' "$conf")"
    port="$(sed -n 's/^STATUS_PORT=//p' "$conf")"
    secret="$(sed -n 's/^FR_STATUS_SECRET=//p' "/etc/isp-radius/$inst.env")"
    t0="$(date +%s.%N)"
    reply="$(printf 'Message-Authenticator = 0x00\nFreeRADIUS-Statistics-Type = All\nResponse-Packet-Type = Access-Accept\n' \
      | radclient -x -t 2 -r 2 "127.0.0.1:$port" status "$secret" 2>/dev/null)"
    t1="$(date +%s.%N)"
    if grep -q '^Received Access-Accept' <<<"$reply"; then
      echo "isp_radius_up{instance_name=\"$inst\"} 1"
      echo "isp_radius_status_seconds{instance_name=\"$inst\"} $(echo "$t1 - $t0" | bc -l | sed 's/^\./0./')"
      # FreeRADIUS-Total-Access-Requests = 5  ->  isp_radius_total_access_requests{instance_name="x"} 5
      sed -n 's/^\s*FreeRADIUS-\(Total-[A-Za-z-]*\|Queue-Len-[A-Za-z]*\|Queue-PPS-[A-Za-z]*\|Stats-Threads-[A-Za-z]*\) = \([0-9]\+\)$/\1 \2/p' <<<"$reply" \
        | grep -v -- '-Proxy-' \
        | while read -r name value; do
            m="isp_radius_$(tr 'A-Z-' 'a-z_' <<<"$name")"
            echo "$m{instance_name=\"$inst\"} $value"
          done
    else
      echo "isp_radius_up{instance_name=\"$inst\"} 0"
    fi
  done
} >"$tmp"
chmod 0644 "$tmp"
mv "$tmp" "$OUT_DIR/isp_radius.prom"
trap - EXIT
