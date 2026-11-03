# Rollback for setup.rsc: removes everything tagged "isp-radius". PPP AAA and RADIUS incoming are left enabled
# (BharatRadius needs them too); disable by hand if required:  /ppp aaa set use-radius=no
{
:local tag "isp-radius"
/radius remove [find where comment~$tag]
/ip firewall filter remove [find where comment~$tag]
/ip firewall nat remove [find where comment~$tag]
/ip firewall address-list remove [find where comment~$tag]
:put "isp-radius entries removed"
}
