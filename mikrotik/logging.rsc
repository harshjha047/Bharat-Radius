# isp-platform router logging — RouterOS v6.49+ and v7.x. Opt-in per router (DoT/DPDP log retention, WP 4.6).
# Sends PPP logins/logouts, router logins, errors and (optionally) one NAT line per new connection to our log
# archive over syslog (UDP 514). The server keeps everything 3 years.
#   1. Edit the values below.  2. On the server: sudo /opt/isp-logs/logs-allow.sh add <this router's public IP> <pop-name>
#   3. /import file-name=logging.rsc        Rollback: /import remove.rsc (turns NAT logging off, removes the action)
# NAT logging adds log=yes + log-prefix=ISPNAT to this router's existing srcnat masquerade/src-nat rules (nothing else
# about them changes). It logs the first packet of every connection: try it on one router first and watch its CPU.
{
:local syslogIp "154.49.142.251"
:local syslogPort 514
# Source IP for syslog packets; must be the IP added with logs-allow.sh ("" = routing decides)
:local srcAddress ""
# true = log NAT translations (needed when customers share public IPs); false = PPP/system logs only
:local natLog true
:local act "isp-archive"

/system logging remove [find where action=$act]
/system logging action remove [find where name=$act]
:if ($srcAddress = "") do={
  /system logging action add name=$act target=remote remote=$syslogIp remote-port=$syslogPort bsd-syslog=yes syslog-facility=local5
} else={
  /system logging action add name=$act target=remote remote=$syslogIp remote-port=$syslogPort bsd-syslog=yes syslog-facility=local5 src-address=$srcAddress
}
/system logging add topics=ppp action=$act
/system logging add topics=account action=$act
/system logging add topics=system,info action=$act
/system logging add topics=critical action=$act
/system logging add topics=error action=$act
/system logging add topics=warning action=$act

/ip firewall nat set [find where log-prefix="ISPNAT"] log=no log-prefix=""
:if ($natLog) do={
  /system logging add topics=firewall action=$act
  :local rules [/ip firewall nat find where chain=srcnat and (action=masquerade or action=src-nat) and disabled=no]
  :if ([:len $rules] > 0) do={
    /ip firewall nat set $rules log=yes log-prefix="ISPNAT"
    :put ("isp-logs: NAT logging on " . [:len $rules] . " srcnat rule(s)")
  } else={
    :put "isp-logs: no srcnat masquerade/src-nat rule here (customers have public IPs?)"
  }
}
:put "isp-logs: done. Check: /system logging print ; /system logging action print ; /ip firewall nat print where log=yes"
}
