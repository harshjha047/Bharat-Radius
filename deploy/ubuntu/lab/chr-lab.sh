#!/usr/bin/env bash
# Lab MikroTik (CHR, RouterOS 7) + a PPPoE test customer on the RADIUS host, against the STAGING RADIUS instance.
# Private addresses only (VPS 10.99.0.1, CHR 10.99.0.2); no customer traffic, no public ports. Applies the repo's own
# mikrotik/setup.rsc to the CHR, so this also tests the script routers will run.
#
#   sudo bash deploy/ubuntu/lab/chr-lab.sh up              # first time: asks for the RADIUS secret of router 10.99.0.2
#   sudo bash deploy/ubuntu/lab/chr-lab.sh dial <username> # test customer dials PPPoE (asks for the PPPoE password)
#   sudo bash deploy/ubuntu/lab/chr-lab.sh hangup | status | console | winbox
#   sudo bash deploy/ubuntu/lab/chr-lab.sh down [--wipe]   # stop (and with --wipe delete the CHR disk)
set -Eeuo pipefail

CHR_VERSION="${CHR_VERSION:-7.16.2}"
LIB=/opt/isp-radius/lab
RUN=/run/isp-chr-lab
UNIT=isp-chr-lab
HOST_IP=10.99.0.1
CHR_IP=10.99.0.2
NS=labcpe
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SRC/../../.." 2>/dev/null && pwd || true)"

log() { printf '[chr-lab] %s\n' "$*"; }
die() { printf '[chr-lab] ERROR: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "run with sudo"

# ------------------------------------------------------------------ host network (idempotent; also run by systemd)
net_up() {
  ip link show brlab0 >/dev/null 2>&1 || ip link add brlab0 type bridge
  ip addr show dev brlab0 | grep -q "$HOST_IP/24" || ip addr add "$HOST_IP/24" dev brlab0
  ip link set brlab0 up
  ip link show brlab1 >/dev/null 2>&1 || ip link add brlab1 type bridge
  ip link set brlab1 up
  for t in chrlab0:brlab0 chrlab1:brlab1; do
    ip link show "${t%%:*}" >/dev/null 2>&1 || ip tuntap add "${t%%:*}" mode tap
    ip link set "${t%%:*}" master "${t##*:}" up
  done
  ip netns list | grep -qw "$NS" || ip netns add "$NS"
  if ! ip link show labcpe0br >/dev/null 2>&1; then
    ip link add labcpe0br type veth peer name labcpe0
    ip link set labcpe0 netns "$NS"
  fi
  ip link set labcpe0br master brlab1 up
  ip netns exec "$NS" ip link set lo up
  ip netns exec "$NS" ip link set labcpe0 up
}

net_down() {
  for l in labcpe0br chrlab0 chrlab1 brlab0 brlab1; do ip link del "$l" 2>/dev/null || true; done
  ip netns del "$NS" 2>/dev/null || true
}

ufw_rule() {
  command -v ufw >/dev/null && ufw status | grep -q "Status: active" || return 0
  if [[ $1 == add ]]; then ufw allow in on brlab0 comment "isp chr lab" >/dev/null
  else ufw delete allow in on brlab0 >/dev/null 2>&1 || true; fi
}

# ------------------------------------------------------------------ CHR VM
install_deps() {
  local need=()
  for p in qemu-system-x86:qemu-system-x86_64 socat:socat expect:expect ppp:pppd unzip:unzip; do
    command -v "${p##*:}" >/dev/null || need+=("${p%%:*}")
  done
  if ((${#need[@]})); then
    log "installing ${need[*]}"
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${need[@]}" >/dev/null
  fi
}

fetch_chr() {
  install -d -m 0700 "$LIB"
  local clean="$LIB/chr-$CHR_VERSION.img"
  if [[ ! -f $clean ]]; then
    local zip="$clean.zip"
    log "downloading CHR $CHR_VERSION"
    curl -fsSL -o "$zip" "https://download.mikrotik.com/routeros/$CHR_VERSION/chr-$CHR_VERSION.img.zip" ||
      die "download failed; check CHR_VERSION=$CHR_VERSION exists on mikrotik.com/download"
    unzip -o -q "$zip" -d "$LIB"
    rm -f "$zip" "$LIB/configured"
  fi
  # Until setup has completed once, every "up" starts from an untouched disk, so retries never trip over half a config.
  if [[ ! -f $LIB/configured ]]; then
    systemctl stop "$UNIT" 2>/dev/null || true
    cp --sparse=always "$clean" "$LIB/chr.img"
    rm -f "$LIB/admin_pw"
  fi
}

write_unit() {
  install -m 0755 "$SRC/chr-lab.sh" "$LIB/chr-lab.sh"
  local accel="-accel tcg"
  [[ -c /dev/kvm ]] && accel="-enable-kvm -cpu host"
  cat >"/etc/systemd/system/$UNIT.service" <<UNIT
[Unit]
Description=isp-platform lab MikroTik CHR (staging RADIUS tests)
After=network-online.target

[Service]
RuntimeDirectory=isp-chr-lab
ExecStartPre=/bin/bash $LIB/chr-lab.sh net
ExecStart=/usr/bin/qemu-system-x86_64 $accel -smp 1 -m 256 -nodefaults -display none \\
  -drive file=$LIB/chr.img,format=raw,if=virtio \\
  -netdev tap,id=n0,ifname=chrlab0,script=no,downscript=no -device virtio-net-pci,netdev=n0,mac=52:54:00:99:00:02 \\
  -netdev tap,id=n1,ifname=chrlab1,script=no,downscript=no -device virtio-net-pci,netdev=n1,mac=52:54:00:99:01:02 \\
  -serial unix:$RUN/console.sock,server=on,wait=off
CPUQuota=50%
MemoryMax=512M
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
}

# Runs one RouterOS command list on the serial console; fails on any RouterOS error.
ros() {
  local cmds="$1" pw exp rc=0
  pw="$(cat "$LIB/admin_pw")"
  exp="$(mktemp)"
  cat >"$exp" <<'EXP'
set timeout 240
log_user 0
log_file -a $env(CONSOLE_LOG)
# RouterOS's serial console drops characters when typed at full speed: ~200 chars/s, and settle after each prompt.
set send_slow {4 0.02}
set pw $env(ADMIN_PW)
set cur ""
# RouterOS redraws its prompts while typing and on Enter, so a prompt can match more than once. Answer each prompt once
# per appearance; the password goes once per login attempt, and again only after an explicit "Login failed".
set last ""
set pwsent 0
proc answer {what text} {
  global last
  if {$last eq $what} return
  set last $what
  send -s "$text\r"
}
spawn socat -,raw,echo=0 UNIX-CONNECT:$env(SOCK)
# Let socat put its terminal in raw mode first, or Ctrl+C would interrupt socat itself instead of reaching RouterOS.
sleep 1
# Ctrl+C first: discards anything a previous session left half-typed.
send "\003\r"
expect {
  -re {Login failed} { set last ""; set pwsent 0; exp_continue }
  # +c no colours, +t no terminal detection, +e "dumb" terminal (no line editing or redraws), 200 columns wide:
  # a prompt then only appears once a command has really finished.
  -re {Login: ?$} { answer login admin+cte200w; exp_continue }
  -re {Password: ?$} {
    if {!$pwsent} { set pwsent 1; set last pass; send -s "$cur\r"; set cur $pw }
    exp_continue
  }
  -re {software license.*\]: ?$} { answer license n; exp_continue }
  -re {repeat new password> ?$} { answer repeat $pw; exp_continue }
  -re {new password> ?$} { answer new $pw; exp_continue }
  -re {\] > } {}
  timeout { puts stderr "no RouterOS prompt on the console (transcript: $env(CONSOLE_LOG))"; exit 2 }
}
# Clear anything left on the command line (Ctrl+C) before the first command.
sleep 1
send "\003"
expect -re {\] > }
sleep 0.5
foreach c [split $env(CMDS) "\n"] {
  if {[string trim $c] eq ""} continue
  puts "  > $c"
  send -s "$c\r"
  expect {
    -re {(failure|Script Error|syntax error|expected end of command|bad command name|input does not match|no such item|ambiguous value)[^\r\n]*} {
      puts stderr "RouterOS: $expect_out(0,string)"
      puts stderr "console: [string range [regsub -all {\x1b\[[0-9;]*[A-Za-z]} $expect_out(buffer) {}] end-300 end]"
      puts stderr "full transcript: $env(CONSOLE_LOG)"
      exit 3 }
    -re {isp-radius: done} { puts "  setup.rsc finished"; exp_continue }
    -re {\] > } { sleep 0.5 }
    timeout { puts stderr "timed out after: $c"; exit 2 }
  }
}
send "/quit\r"
exit 0
EXP
  ADMIN_PW="$pw" SOCK="$RUN/console.sock" CMDS="$cmds" CONSOLE_LOG="$LIB/console.log" expect -f "$exp" || rc=$?
  rm -f "$exp"
  return "$rc"
}

wait_console() {
  for _ in $(seq 1 60); do [[ -S $RUN/console.sock ]] && return 0; sleep 1; done
  die "CHR console did not appear; see: journalctl -u $UNIT -n 50"
}

configure_chr() {
  [[ -f $LIB/configured ]] && return 0
  local secret
  read -rsp "RADIUS secret of router $CHR_IP (from the panel, Routers → Show RADIUS secret): " secret; echo
  [[ $secret =~ ^[A-Za-z0-9!#%+,.:=@_^~-]{16,64}$ ]] || die "that does not look like a panel RADIUS secret"
  [[ -f $LIB/admin_pw ]] || (umask 077; openssl rand -hex 12 >"$LIB/admin_pw")
  [[ -f $REPO/mikrotik/setup.rsc ]] || die "mikrotik/setup.rsc not found (run from the repository)"

  log "booting CHR (first boot takes ~30 s)"
  sleep 20
  log "base config: address, PPPoE server on ether2, test pool"
  ros "/system identity set name=isp-lab-chr
/ip address add address=$CHR_IP/24 interface=ether1
/ip route add gateway=$HOST_IP
/ip pool add name=lab-pool ranges=100.64.50.10-100.64.50.200
/ppp profile set default local-address=100.64.50.1 remote-address=lab-pool
/interface pppoe-server server add service-name=lab interface=ether2 default-profile=default one-session-per-host=yes authentication=pap,chap,mschap2 disabled=no"

  # The repo's setup.rsc with lab values: staging ports, local RADIUS/app server, CHR as source address.
  local tmp
  tmp="$(mktemp -d)"
  sed -e "s|^:local radiusIp \".*\"|:local radiusIp \"$HOST_IP\"|" \
    -e "s|^:local radiusSecret \".*\"|:local radiusSecret \"$secret\"|" \
    -e "s|^:local authPort .*|:local authPort 11812|" \
    -e "s|^:local acctPort .*|:local acctPort 11813|" \
    -e "s|^:local srcAddress \".*\"|:local srcAddress \"$CHR_IP\"|" \
    -e "s|^:local appIp \".*\"|:local appIp \"$HOST_IP\"|" \
    "$REPO/mikrotik/setup.rsc" >"$tmp/isp-setup.rsc"
  grep -q ":local radiusSecret \"$secret\"" "$tmp/isp-setup.rsc" || die "could not set values in setup.rsc"
  # One-off file server on the lab bridge only; stops by itself after 5 minutes at the latest.
  timeout 300 python3 -m http.server 18080 --bind "$HOST_IP" --directory "$tmp" >/dev/null 2>&1 &
  local http=$! rc=0
  sleep 1
  log "applying mikrotik/setup.rsc on the CHR"
  ros "/tool fetch url=\"http://$HOST_IP:18080/isp-setup.rsc\" dst-path=isp-setup.rsc
/import file-name=isp-setup.rsc
/file remove isp-setup.rsc" || rc=$?
  kill "$http" 2>/dev/null || true
  rm -rf "$tmp"
  ((rc == 0)) || die "setup.rsc failed on the CHR (see the RouterOS message above)"
  touch "$LIB/configured"
}

# ------------------------------------------------------------------ test customer (pppd in its own namespace)
plugin() {
  local p
  p="$(find /usr/lib/pppd -name 'pppoe.so' -o -name 'rp-pppoe.so' 2>/dev/null | head -1)"
  [[ -n $p ]] || die "pppd PPPoE plugin not found (apt install ppp)"
  echo "$p"
}

dial() {
  local user="${1:-}" pass opts
  [[ -n $user ]] || die "usage: dial <pppoe-username>"
  systemctl is-active -q "$UNIT" || die "lab is not running; run: up"
  hangup quiet
  modprobe -q ppp_generic 2>/dev/null || true
  modprobe -q pppoe 2>/dev/null || true
  [[ -c /dev/ppp ]] || die "this kernel has no PPP support (/dev/ppp missing)"
  read -rsp "PPPoE password for $user: " pass; echo
  opts="$(mktemp)"
  chmod 600 "$opts"
  # Real CPE behaviour: redials by itself after a kick or a session timeout.
  cat >"$opts" <<OPTS
plugin $(plugin)
labcpe0
user "$user"
password "$pass"
noauth
nodefaultroute
noipdefault
persist
holdoff 5
maxfail 0
lcp-echo-interval 20
lcp-echo-failure 3
linkname labcpe
logfile $RUN/pppd.log
updetach
OPTS
  log "dialing as $user"
  if ip netns exec "$NS" pppd file "$opts"; then
    rm -f "$opts"
    log "connected: $(ip netns exec "$NS" ip -4 -o addr show dev ppp0 | awk '{print $4}')"
  else
    rm -f "$opts"
    tail -n 15 "$RUN/pppd.log" >&2 || true
    die "login refused or no answer (the reason is also in the panel: subscriber → Login log)"
  fi
}

hangup() {
  local pid
  pid="$(cat /run/ppp-labcpe.pid 2>/dev/null || true)"
  if [[ -n $pid ]] && kill "$pid" 2>/dev/null; then sleep 1; [[ ${1:-} == quiet ]] || log "hung up"
  elif [[ ${1:-} != quiet ]]; then log "not connected"; fi
}

status() {
  printf 'CHR service : %s\n' "$(systemctl is-active "$UNIT" 2>/dev/null || true)"
  printf 'CHR reachable: %s\n' "$(ping -c1 -W1 "$CHR_IP" >/dev/null 2>&1 && echo yes || echo no)"
  local ip
  ip="$(ip netns exec "$NS" ip -4 -o addr show dev ppp0 2>/dev/null | awk '{print $4}' || true)"
  printf 'Test customer: %s\n' "${ip:+online, $ip}${ip:-offline}"
  if [[ -f $RUN/pppd.log ]]; then
    echo '--- last pppd log'
    tail -n 8 "$RUN/pppd.log"
  fi
}

case "${1:-}" in
  net) net_up ;;
  up)
    install_deps
    fetch_chr
    write_unit
    ufw_rule add
    systemctl enable -q --now "$UNIT"
    wait_console
    configure_chr
    status
    log "ready. Next: create a test subscriber in the panel, then: sudo bash $0 dial <username>"
    ;;
  dial) dial "${2:-}" ;;
  hangup) hangup ;;
  status) status ;;
  console)
    log "RouterOS console (admin password: sudo cat $LIB/admin_pw). Leave with Ctrl+C."
    socat -,raw,echo=0,escape=0x03 "UNIX-CONNECT:$RUN/console.sock"
    ;;
  winbox)
    echo "On your PC:  ssh -L 8291:$CHR_IP:8291 deploy@154.49.142.251"
    echo "Then Winbox: Connect to 127.0.0.1, login admin, password: sudo cat $LIB/admin_pw"
    ;;
  down)
    hangup quiet
    systemctl disable -q --now "$UNIT" 2>/dev/null || true
    rm -f "/etc/systemd/system/$UNIT.service"
    systemctl daemon-reload
    net_down
    ufw_rule delete
    if [[ ${2:-} == --wipe ]]; then rm -rf "$LIB"; log "removed, CHR disk deleted"; else log "stopped (disk kept in $LIB)"; fi
    ;;
  *) sed -n '2,10p' "$0"; exit 1 ;;
esac
