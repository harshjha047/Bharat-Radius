# Monitoring on the Ubuntu VPS (WP 1.8)

| Part | Where | What |
|---|---|---|
| `isp-radius-status.timer` | host, every 15 s | asks both Radius engine instances for Status-Server counters → `isp_radius_*` (node exporter textfile) |
| node exporter | host :9100 | CPU, memory, disk, systemd units, `isp_radius_*` |
| postgres exporter | host :9187 | `pg_up`, auth results/min with reasons, online sessions per ISP, login SQL time, default-partition rows |
| `isp-prometheus` | container | scrapes the above + API health (blackbox), 15 days kept, alert rules in `prometheus/alerts.yml` |
| `isp-alertmanager` | container | Telegram; critical alerts after 10 s, others after 30 s; repeats every 4 h |
| `isp-grafana` | https://new.bharatradius.com/grafana/ | dashboard "ISP Radius" (folder isp-platform); user `admin` |

Exporter ports are reachable only from Docker networks (ufw `172.16.0.0/12`) and are closed at NetForChoice.

## Install

```bash
cd ~/isp-platform && git pull
sudo bash deploy/ubuntu/install-exporters.sh
sudo bash deploy/ubuntu/app/app-up.sh                         # adds the /grafana route to Caddy
sudo TELEGRAM_CHAT_ID=<id> bash deploy/ubuntu/monitoring/mon-up.sh --test-alert
```

Telegram token: `/etc/isp-app/telegram_token` (root, 0400), created once as in the Step 1 checklist. Grafana password:
`sudo cat /etc/isp-app/mon/grafana_admin_pw`.

## Gate check: alert within 2 minutes when Radius stops

```bash
sudo systemctl stop freeradius;  date      # wait for the Telegram message (tested: alert fires at ~76 s)
sudo systemctl start freeradius; date      # a "resolved" message follows
```

The rule timing is also unit-tested in CI (`prometheus/alerts.test.yml`).

## Rollback

```bash
docker compose -f deploy/ubuntu/monitoring/docker-compose.yml down      # -v also deletes history and Grafana data
sudo systemctl disable --now isp-radius-status.timer prometheus-postgres-exporter
```

## Alerts added in Step 4 (WP 4.9)

| Alert | Fires when | First look |
|---|---|---|
| RadiusLoginProbeFailing (critical) | The synthetic PPPoE login to production is not accepted for 2 min | `journalctl -u isp-radius-probe -n 20`; then radius-down.md |
| RadiusStagingLoginProbeFailing | Same on staging for 5 min | |
| RadiusLoginSlow | Production synthetic login > 1 s for 5 min | PostgreSQL load, `RadiusLoginSqlSlow` |
| RadiusProbeStale | Probe did not run for 5 min | `systemctl status isp-radius-probe.timer` |
| OutboxErrors | > 10 Radius sync errors in 15 min, for 15 min | outbox.md (rows retry with backoff) |
| OutboxStuck *(existing)* | Oldest unsynced change > 5 min | outbox.md |
| WalletFrozen *(existing)* | Reconciliation found balance ≠ ledger and froze a wallet | billing.md |
| ReconcileStale | Nightly reconciliation has not succeeded for 26 h | billing.md; `$C run-job reconcile-wallets` |
| BackupMissing (critical) | A backup kind (`mongo`, `postgres`, `etc`) not successful for 26 h | backups.md |
| BackupNeverRan | No backup metric at all for 26 h (backups not installed) | backups.md |

### Synthetic login

`/opt/isp-radius/scripts/probe.sh run` (timer `isp-radius-probe.timer`, every minute) sends one PAP Access-Request per instance from `127.0.0.2` for user `probe` in the hidden Radius tenant `zz-probe` (no `external_id`, so the app never syncs or deletes it) and verifies the reply authenticator. Metrics: `isp_radius_probe_success`, `isp_radius_probe_seconds`, `isp_radius_probe_timestamp_seconds`.

Set up (done by `radius/scripts/install.sh` when the node exporter is installed; safe to repeat):

```bash
cd ~/isp-platform && git pull
sudo bash radius/scripts/install.sh all          # or, without reinstalling:
sudo install -m 0755 radius/scripts/probe.sh radius/scripts/probe.py /opt/isp-radius/scripts/
sudo install -m 0644 radius/scripts/systemd/isp-radius-probe.* /etc/systemd/system/
sudo systemctl daemon-reload && sudo /opt/isp-radius/scripts/probe.sh setup
sudo systemctl enable --now isp-radius-probe.timer
cat /var/lib/prometheus/node-exporter/isp_radius_probe.prom
```

`probe.sh setup` adds router `127.0.0.2` to each instance's `nas` table, so the Radius engine restarts once (nas-watch). Credentials: `/etc/isp-radius/probe.env` (root-only).
