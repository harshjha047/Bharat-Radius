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
  for p in qemu-system-x86:qemu-system-x86_64 socat:socat ppp:pppd unzip:unzip; do
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

# First-boot provisioning: RouterOS runs /rw/autorun.scr from its own disk once, at boot, then deletes it. Writing it
# into the image before the first start avoids driving the serial console (whose line editor is unreliable to script).
provision_disk() {
  [[ -f $LIB/configured ]] && return 0
  local secret
  read -rsp "RADIUS secret of router $CHR_IP (from the panel, Routers → Show RADIUS secret): " secret; echo
  [[ $secret =~ ^[A-Za-z0-9!#%+,.:=@_^~-]{16,64}$ ]] || die "that does not look like a panel RADIUS secret"
  [[ -f $REPO/mikrotik/setup.rsc ]] || die "mikrotik/setup.rsc not found (run from the repository)"
  (umask 077; openssl rand -hex 12 >"$LIB/admin_pw")

  local script
  script="$(mktemp)"
  {
    cat <<RSC
:delay 5s
/system identity set name=isp-lab-chr
/user set admin password="$(cat "$LIB/admin_pw")"
/ip address add address=$CHR_IP/24 interface=ether1
/ip route add gateway=$HOST_IP
/ip pool add name=lab-pool ranges=100.64.50.10-100.64.50.200
/ppp profile set default local-address=100.64.50.1 remote-address=lab-pool
/interface pppoe-server server add service-name=lab interface=ether2 default-profile=default one-session-per-host=yes authentication=pap,chap,mschap2 disabled=no
/ip service set www disabled=no address=$HOST_IP/32
RSC
    # The repo's setup.rsc with lab values: staging ports, local RADIUS/app server, CHR as source address.
    sed -e "s|^:local radiusIp \".*\"|:local radiusIp \"$HOST_IP\"|" \
      -e "s|^:local radiusSecret \".*\"|:local radiusSecret \"$secret\"|" \
      -e "s|^:local authPort .*|:local authPort 11812|" \
      -e "s|^:local acctPort .*|:local acctPort 11813|" \
      -e "s|^:local srcAddress \".*\"|:local srcAddress \"$CHR_IP\"|" \
      -e "s|^:local appIp \".*\"|:local appIp \"$HOST_IP\"|" \
      "$REPO/mikrotik/setup.rsc"
  } >"$script"
  grep -q ":local radiusSecret \"$secret\"" "$script" || { rm -f "$script"; die "could not set values in setup.rsc"; }

  log "writing first-boot script into the CHR disk"
  # Mount each partition at its byte offset (no partition devices or udev needed); RouterOS keeps /rw on one of them.
  local start mnt rc=1
  mnt="$(mktemp -d)"
  while read -r start; do
    if mount -o "loop,offset=$((start * 512))" "$LIB/chr.img" "$mnt" 2>/dev/null; then
      if [[ -d $mnt/rw ]]; then
        install -m 0644 "$script" "$mnt/rw/autorun.scr" && rc=0
        umount "$mnt"
        break
      fi
      umount "$mnt"
    fi
  done < <(partx -g -o START "$LIB/chr.img")
  rmdir "$mnt"
  rm -f "$script"
  ((rc == 0)) || die "could not find RouterOS's rw partition in the CHR image"
}

# Waits for the CHR to come up with our address, then reads back what autorun.scr configured.
verify_chr() {
  [[ -f $LIB/configured ]] && return 0
  log "waiting for the CHR to boot and apply the first-boot script (up to 2 min)"
  local ok=0
  for _ in $(seq 1 120); do
    if ping -c1 -W1 "$CHR_IP" >/dev/null 2>&1; then ok=1; break; fi
    sleep 1
  done
  ((ok)) || die "CHR did not answer on $CHR_IP; the first-boot script failed. Look: sudo bash $0 console"
  local pw name radius
  pw="$(cat "$LIB/admin_pw")"
  api() { curl -fsS --max-time 5 -u "admin:$pw" "http://$CHR_IP/rest/$1"; }
  for _ in $(seq 1 30); do name="$(api system/identity 2>/dev/null || true)"; [[ -n $name ]] && break; sleep 2; done
  if [[ -z $name ]]; then
    # The address answering already proves the first-boot script ran; the dial test checks RADIUS end to end.
    log "warning: could not read the CHR's settings back over its web API; continuing (dial test will tell)"
  else
    [[ $name == *isp-lab-chr* ]] || die "CHR is up but not configured as expected (identity: $name)"
    radius="$(api radius 2>/dev/null || true)"
    [[ $radius == *"$HOST_IP"* && $radius == *11812* ]] ||
      die "setup.rsc did not configure RADIUS on the CHR (got: ${radius:-nothing}). Look: sudo bash $0 console"
    log "CHR configured: identity isp-lab-chr, RADIUS $HOST_IP:11812/11813 (staging)"
  fi
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
    provision_disk
    write_unit
    ufw_rule add
    systemctl enable -q --now "$UNIT"
    verify_chr
    status
    log "ready. Next: create a test subscriber in the panel, then: sudo bash $0 dial <username>"
    ;;
  dial) dial "${2:-}" ;;
  hangup) hangup ;;
  status) status ;;
  console)
    log "RouterOS console (login admin, password: sudo cat $LIB/admin_pw; /log print shows first-boot errors). Leave with Ctrl+C."
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
