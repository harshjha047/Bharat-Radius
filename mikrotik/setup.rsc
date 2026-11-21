# isp-platform MikroTik setup — RouterOS v6.49+ and v7.x
# Idempotent: everything it creates is tagged "isp-radius" and replaced on re-run. Rollback: /import remove.rsc
# Edit the values below, upload the file, then:  /import file-name=setup.rsc
# Existing PPPoE server, profiles and IP pools are not touched (Framed-Pool names must match /ip pool names).
{
:local radiusIp "154.49.142.251"
:local radiusSecret "CHANGE_ME_router_secret"
# production 1812/1813, staging 11812/11813
:local authPort 1812
:local acctPort 1813
# Source IP for Radius packets; must equal the router IP registered in the panel ("" = routing decides).
:local srcAddress ""
# Bharat Radius as fallback during migration ("" = none)
:local fallbackIp ""
:local fallbackSecret ""
:local fallbackAuthPort 1812
:local fallbackAcctPort 1813
# App server: CoA source and walled-garden page on HTTP port payPort (staging: the Radius VPS)
:local appIp "154.49.142.251"
:local payPort 8089
# true = expired users reach only DNS, the pay page and payment gateways; false = web traffic redirected, rest at slow speed
:local strictExpired false
:local payDomains {"api.razorpay.com";"checkout.razorpay.com";"cdn.razorpay.com";"lumberjack.razorpay.com";"api.cashfree.com";"sdk.cashfree.com";"payments.cashfree.com";"bharatradius.com";"new.bharatradius.com"}

:local tag "isp-radius"
:local ver [/system resource get version]
:local major [:tonum [:pick $ver 0 [:find $ver "."]]]
:local rest [:pick $ver ([:find $ver "."] + 1) [:len $ver]]
:local minor [:tonum [:pick $rest 0 [:find $rest "."]]]
:if ([:typeof $minor] = "nil") do={ :set minor [:tonum [:pick $rest 0 [:find $rest " "]]] }
:put "RouterOS $ver"

# ---- Radius servers (primary first; fallback answers only when primary times out)
/radius remove [find where comment~$tag]
:local p [/radius add address=$radiusIp secret=$radiusSecret service=ppp authentication-port=$authPort accounting-port=$acctPort timeout=1s comment="$tag primary"]
:if ($srcAddress != "") do={ /radius set $p src-address=$srcAddress }
:if ($fallbackIp != "") do={
  :local f [/radius add address=$fallbackIp secret=$fallbackSecret service=ppp authentication-port=$fallbackAuthPort accounting-port=$fallbackAcctPort timeout=1s comment="$tag fallback (Bharat Radius)"]
  :if ($srcAddress != "") do={ /radius set $f src-address=$srcAddress }
}
# Blast-RADIUS (CVE-2024-3596): RouterOS 7.15+ can require Message-Authenticator; our server always sends it.
:if (($major > 7) || ($major = 7 && $minor >= 15)) do={
  :do { /radius set [find where comment~$tag] require-message-auth=yes-for-request-resp } on-error={ :put "require-message-auth not supported on this build" }
}

# ---- PPP AAA and accounting every 5 minutes
/ppp aaa set use-radius=yes accounting=yes interim-update=5m

# ---- CoA / Disconnect from the app server only
/radius incoming set accept=yes port=3799
/ip firewall filter remove [find where comment~$tag]
:local hasFilter ([:len [/ip firewall filter find]] > 0)
:if ($hasFilter) do={
  /ip firewall filter add chain=input protocol=udp dst-port=3799 action=drop comment="$tag: CoA from others" place-before=0
  /ip firewall filter add chain=input protocol=udp dst-port=3799 src-address=$appIp action=accept comment="$tag: CoA from app server" place-before=0
  :if ($fallbackIp != "") do={
    /ip firewall filter add chain=input protocol=udp dst-port=3799 src-address=$fallbackIp action=accept comment="$tag: CoA from fallback (migration)" place-before=0
  }
} else={
  /ip firewall filter add chain=input protocol=udp dst-port=3799 src-address=$appIp action=accept comment="$tag: CoA from app server"
  # During migration the old Radius (fallback) still sends its own kicks and speed changes.
  :if ($fallbackIp != "") do={
    /ip firewall filter add chain=input protocol=udp dst-port=3799 src-address=$fallbackIp action=accept comment="$tag: CoA from fallback (migration)"
  }
  /ip firewall filter add chain=input protocol=udp dst-port=3799 action=drop comment="$tag: CoA from others"
}

# ---- Walled garden for expired users (Radius puts them in address list "expired")
/ip firewall address-list remove [find where comment~$tag]
/ip firewall address-list add list=isp-pay-allow address=$appIp comment=$tag
:foreach d in=$payDomains do={ /ip firewall address-list add list=isp-pay-allow address=$d comment=$tag }

/ip firewall nat remove [find where comment~$tag]
:local hasNat ([:len [/ip firewall nat find where chain=dstnat]] > 0)
:if ($hasNat) do={
  /ip firewall nat add chain=dstnat src-address-list=expired protocol=tcp dst-port=80 dst-address-list=!isp-pay-allow action=dst-nat to-addresses=$appIp to-ports=$payPort comment="$tag: expired -> pay page" place-before=0
} else={
  /ip firewall nat add chain=dstnat src-address-list=expired protocol=tcp dst-port=80 dst-address-list=!isp-pay-allow action=dst-nat to-addresses=$appIp to-ports=$payPort comment="$tag: expired -> pay page"
}

:if ($strictExpired) do={
  # Added bottom-up with place-before=0 so the final order is: DNS, pay, established, reject.
  /ip firewall filter add chain=forward src-address-list=expired action=reject reject-with=icmp-admin-prohibited comment="$tag: expired block" place-before=0
  /ip firewall filter add chain=forward src-address-list=expired connection-state=established,related action=accept comment="$tag: expired est" place-before=0
  /ip firewall filter add chain=forward src-address-list=expired dst-address-list=isp-pay-allow action=accept comment="$tag: expired pay" place-before=0
  /ip firewall filter add chain=forward src-address-list=expired protocol=tcp dst-port=53 action=accept comment="$tag: expired DNS tcp" place-before=0
  /ip firewall filter add chain=forward src-address-list=expired protocol=udp dst-port=53 action=accept comment="$tag: expired DNS udp" place-before=0
}

:put "isp-radius: done. Check: /radius print detail ; /ppp aaa print ; /radius incoming print"
}
