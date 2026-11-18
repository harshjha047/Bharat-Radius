#!/usr/bin/env bash
# CI: disk-guard.sh levels with a fake disk (df), Docker, journal, rclone and logs-maint stand-ins.
set -Eeuo pipefail
G="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/disk-guard.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/flags" "$T/state" "$T/prom" "$T/bk/2026-11-16T2000Z" "$T/bk/2026-11-17T2000Z" "$T/bk/2026-11-18T2000Z"
cat >"$T/bin/df" <<STUB
#!/usr/bin/env bash
p=\$(cat "$T/pct"); if [[ \$* == *pcent* ]]; then echo Use%; echo " \$p%"; else echo Avail; echo \$(( (100 - p) * 1000000000 )); fi
STUB
printf '#!/usr/bin/env bash\necho "docker $*" >>"%s/calls"\n' "$T" >"$T/bin/docker"
printf '#!/usr/bin/env bash\necho "journalctl $*" >>"%s/calls"\n' "$T" >"$T/bin/journalctl"
printf '#!/usr/bin/env bash\ntouch "${@: -1}"\n' >"$T/bin/fallocate"
# only the 16 Nov backup is confirmed off-site
printf '#!/usr/bin/env bash\n[[ $1 == check && $3 == *2026-11-16* ]]\n' >"$T/bin/rclone"
printf '#!/usr/bin/env bash\necho "logs-maint $* keep=$KEEP_LOCAL_DAYS_OVERRIDE" >>"%s/calls"\n' "$T" >"$T/logsmaint"
echo 'RCLONE_REMOTE=offsite:b/isp-backups' >"$T/backup.env"
chmod +x "$T"/bin/* "$T/logsmaint"
export PATH="$T/bin:$PATH" CONF=/dev/null FLAGS="$T/flags" STATE_DIR="$T/state" OUT_DIR="$T/prom" \
  LOGS_MAINT="$T/logsmaint" BACKUP_ENV="$T/backup.env" BACKUP_DIR="$T/bk"

fail=0
expect() { # pct  pause  maint  reserve  level
  echo "$1" >"$T/pct"
  bash "$G" run >/dev/null
  local got level
  got="$(bash "$G" status)"
  level="$(sed -n 's/^isp_disk_guard_level //p' "$T/prom/isp_disk_guard.prom")"
  if [[ $got != "used $1%  pause-heavy=$2  maintenance=$3  reserve=$4" || $level != "$5" ]]; then
    echo "FAIL at $1%: $got level=$level (want pause=$2 maint=$3 reserve=$4 level=$5)"; fail=1
  else echo "ok   $1%: $got level=$level"; fi
}
expect 50 off off present 0
expect 72 on off present 1
expect 68 on off present 1   # stays until below 65
expect 86 on on present 2
expect 82 on on present 2    # maintenance stays until below 80
expect 79 on off present 1
expect 97 on on absent 3     # reserve released
expect 90 on on absent 3
expect 60 off off present 0  # all clear, reserve recreated

grep -q 'logs-maint offload keep=7' "$T/calls" || { echo "FAIL: drill did not offload logs older than 7 days"; fail=1; }
[[ ! -d $T/bk/2026-11-16T2000Z ]] || { echo "FAIL: confirmed backup not removed"; fail=1; }
[[ -d $T/bk/2026-11-17T2000Z ]] || { echo "FAIL: unconfirmed backup removed"; fail=1; }
[[ -d $T/bk/2026-11-18T2000Z ]] || { echo "FAIL: newest backup removed"; fail=1; }
((fail == 0)) && echo "disk guard: all levels correct"
exit "$fail"
