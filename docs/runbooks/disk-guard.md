# Disk guard (100 GB VPS)

`isp-disk-guard.timer` runs `/opt/isp-disk/disk-guard.sh` every 5 minutes. It keeps room for PostgreSQL and MongoDB.
Thresholds: `/etc/isp-disk/guard.env`. Install: `sudo bash deploy/ubuntu/disk/disk-setup.sh`.

## Never touched

Database files (PostgreSQL, MongoDB), code, containers in use, configuration and secrets, today's logs, the last
7 days of logs, the newest local backup, and anything not yet confirmed in Backblaze. A file is deleted from the VPS
only after its off-site copy checks out (log days: SHA-1 in the bucket; backups: `rclone check`).

## Levels

| Used | What happens | Telegram |
|---|---|---|
| < 70 % | Normal. Log days move to Backblaze after 60 days (`logs-maint.sh`). | — |
| ≥ 70 % | **Drill.** Excel imports and `app-up.sh` rebuilds wait (`/run/isp-guard/pause-heavy`). Removed: Docker build cache, unused images, journal above 500 MB. Moved: log days older than 7 days, and local backups already in Backblaze (newest kept). | DiskGuardDrill |
| ≥ 85 % | **Maintenance page** for panel, reseller panel and portal (`/run/isp-guard/maintenance`). Still running: Radius (logins, sessions, speed changes), payment webhooks, the pay redirect and pay page, monitoring, the landing page. | DiskGuardMaintenance (critical) |
| ≥ 95 % | The 5 GB reserve file (`/var/lib/isp-guard/reserve.img`) is deleted so the databases keep writing. | DiskReserveReleased (critical) |

Maintenance ends below 80 %; the pause ends below 65 %, when the reserve is recreated. Customers see only
"scheduled maintenance"; staff calls get `503 MAINTENANCE`.

## When it fires

```bash
sudo /opt/isp-disk/disk-guard.sh status
sudo du -xh --max-depth=2 /var /home 2>/dev/null | sort -h | tail -15
docker system df
journalctl -u isp-disk-guard -n 50 --no-pager
```

Find what grew (the drill only removes safe things). After freeing space the guard clears itself within 5 minutes;
`sudo /opt/isp-disk/disk-guard.sh maintenance-off` lifts the page at once (it returns if still ≥ 85 %). A rebuild
during a drill: `sudo FORCE=1 bash deploy/ubuntu/app/app-up.sh`.

The drill moves files off-site only once Backblaze is set up (`docs/runbooks/backups.md` → Backblaze B2);
without it only the local clean-up runs.
