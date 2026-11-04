# Monitoring on the Ubuntu VPS (WP 1.8)

| Part | Where | What |
|---|---|---|
| `isp-radius-status.timer` | host, every 15 s | asks both FreeRADIUS instances for Status-Server counters → `isp_radius_*` (node exporter textfile) |
| node exporter | host :9100 | CPU, memory, disk, systemd units, `isp_radius_*` |
| postgres exporter | host :9187 | `pg_up`, auth results/min with reasons, online sessions per ISP, login SQL time, default-partition rows |
| `isp-prometheus` | container | scrapes the above + API health (blackbox), 15 days kept, alert rules in `prometheus/alerts.yml` |
| `isp-alertmanager` | container | Telegram; critical alerts after 10 s, others after 30 s; repeats every 4 h |
| `isp-grafana` | https://new.bharatradius.com/grafana/ | dashboard "ISP RADIUS" (folder isp-platform); user `admin` |

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

## Gate check: alert within 2 minutes when RADIUS stops

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
