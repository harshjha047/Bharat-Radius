# Rollback for setup.rsc: removes everything tagged "isp-radius". PPP AAA and Radius incoming are left enabled
# (Bharat Radius needs them too); disable by hand if required:  /ppp aaa set use-radius=no
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
