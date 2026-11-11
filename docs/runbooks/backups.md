# Backups

Metric contract (alerts `BackupMissing`, `BackupNeverRan`): each backup job writes
`isp_backup_last_success_timestamp_seconds{kind="mongo"|"postgres"|"etc"}` to
`/var/lib/prometheus/node-exporter/isp_backup.prom` after a successful, verified upload.

Jobs, schedule and restore drill: WP 4.8.
