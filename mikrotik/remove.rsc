# Rollback for setup.rsc: removes everything tagged "isp-radius". PPP AAA and RADIUS incoming are left enabled
# (BharatRadius needs them too); disable by hand if required:  /ppp aaa set use-radius=no
# Hotspot profiles and DHCP servers switched to RADIUS are left as they are; revert by hand if required:
#   /ip hotspot profile set [find name=<p>] use-radius=no ;  /ip dhcp-server set [find name=<d>] use-radius=no
{
:local tag "isp-radius"
/radius remove [find where comment~$tag]
/ip firewall filter remove [find where comment~$tag]
/ip firewall nat remove [find where comment~$tag]
/ip firewall address-list remove [find where comment~$tag]
# logging.rsc
/system logging remove [find where action="isp-archive"]
/system logging action remove [find where name="isp-archive"]
/ip firewall nat set [find where log-prefix="ISPNAT"] log=no log-prefix=""
:put "isp-radius entries removed"
}
