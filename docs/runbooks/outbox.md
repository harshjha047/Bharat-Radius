# Outbox: changes not reaching RADIUS

Every change to an ISP, router, plan (and from WP 2.6 subscriber) is saved in MongoDB together with an `outbox` row
in one transaction. `isp-workers` writes the entity's current state into PostgreSQL, normally within a second.
FreeRADIUS picks up router changes within 30 s (NAS watcher). For users online at the time, the worker then sends
CoA (new rate) or Disconnect-Request (state change, kick) from the VPS public IP to UDP 3799 on the router; each
result is in `coa_log` and on the subscriber page. Routers must accept 3799 from that IP (`setup.rsc` `appIp`).

Alerts: `OutboxStuck` (oldest unsynced row > 5 min), `OutboxNoLeader` (no worker holds the lease for 2 min).

## Check

```bash
docker ps --filter name=isp-workers --format '{{.Status}}'
docker exec isp-workers wget -qO- http://127.0.0.1:4101/metrics | grep isp_outbox
docker logs --since 30m isp-workers | grep -E 'sync failed|error'
# rows waiting, with their last error
docker exec -i isp-mongo mongosh --quiet -u root -p "$(sudo cat /etc/isp-app/mongo_root_pw)" --authenticationDatabase admin \
  isp_staging --eval 'db.outbox.find({status: {$ne: "done"}}, {entity:1, entityId:1, attempts:1, lastError:1, nextAttemptAt:1}).sort({createdAt: 1}).limit(20)'
```

## Common causes

| `lastError` | Cause | Fix |
|---|---|---|
| connection refused / timeout to `acs-prod:5432` | PostgreSQL down or TLS/pg_hba changed | `systemctl status postgresql`; rerun `install.sh` with `APP_SUBNET` |
| `tenant … missing in MongoDB` | Record points at a deleted ISP | Fix or delete the record; the row retries by itself |
| `duplicate key … nas_nasname_key` | Router IP held by a PostgreSQL row with another `external_id` (manual insert) | Delete the stray row in PostgreSQL |
| `duplicate key … plans_tenant_id_name_key` | Two plans swapped names | Rename one plan again |

Rows retry with backoff (5 s doubling to 5 min) forever; once the cause is fixed they drain by themselves.
To retry at once: `db.outbox.updateMany({status: "pending"}, {$set: {nextAttemptAt: new Date()}})`.

Only one `isp-workers` processes rows at a time (lease `_locks.outbox-worker`, 15 s). A second replica waits as
standby and takes over within 15 s.
