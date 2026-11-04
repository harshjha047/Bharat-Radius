# Usage roll-up and FUP

`isp-workers` runs the `usage` job every 15 minutes (one replica at a time, lease in MongoDB `_jobs`):

1. `SELECT * FROM radius_usage_rollup()` adds what each session transferred since the last run to `usage_daily`
   (IST day). `usage_seen` remembers what was already counted, so overlapping or repeated runs never double count.
2. For every plan with a data cap, each active subscriber's usage since the cycle start is compared with the cap
   (cycle: plan `fupCycle` = `calendar_month`, or `billing_cycle` = expiry − validity for prepaid). Crossing the cap
   sets `fup.active` and queues a sync + Disconnect, so the router re-dials into the FUP speed and address list.
   A new cycle (or a cap removed from the plan) lifts it the same way.

Alert `UsageJobStale`: no successful run for 45 minutes.

```bash
docker exec isp-workers wget -qO- http://127.0.0.1:4101/metrics | grep isp_job
docker logs --since 1h isp-workers | grep -E '"job":"usage"|job failed|FUP'
docker exec -i isp-mongo mongosh --quiet -u root -p "$(sudo cat /etc/isp-app/mongo_root_pw)" --authenticationDatabase admin \
  isp_staging --eval 'db._jobs.find()'
```

| Symptom | Cause | Fix |
|---|---|---|
| `permission denied for function radius_usage_rollup` / `usage_seen` | Grants not reapplied | `sudo bash radius/scripts/install.sh all` |
| `relation "usage_seen" does not exist` | Migration 003 not applied | same |
| Job stuck with a lease | Worker killed mid-run | Lease expires after 10 min; the next replica takes over |

Attribution: usage is booked on the IST day of the run, so traffic in the 15 minutes before midnight can land on
the next day. Totals per session are exact.
