# Alert: RadiusDown / RadiusDatabaseDown

Logins stop on the primary; routers with BharatRadius as fallback keep working after a 1 s timeout per attempt.

1. `systemctl status freeradius postgresql@16-main --no-pager`
2. FreeRADIUS failed to start → `sudo bash -c 'set -a; . /etc/isp-radius/production.env; freeradius -XC'` shows the config error. Last good config: `/var/backups/isp-radius/`.
3. PostgreSQL down → `tail -100 /var/log/postgresql/postgresql-16-main.log`; disk full is the usual cause (`df -h`, check `isp_replication_retained_wal_bytes` for a stuck slot).
4. FreeRADIUS answers nothing while PostgreSQL is down **by design** (no false rejects); it recovers by itself when the DB returns.
5. Ubuntu VPS lost → promote the Windows standby (`pg_ctl promote -D C:\isp\pgstandby`) and follow TRD §11 for a temporary Linux FreeRADIUS.
