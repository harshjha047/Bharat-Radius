# Windows app host base (WP 1.4)

Bharat Radius keeps running. Nothing here edits existing services: the shared MongoDB on 27017 (used by other apps, no auth),
Bharat Radius' PostgreSQL on 5432, the pm2 apps (one of them on 4000), or other nginx server blocks.

| Ours | Where |
|---|---|
| `isp-mongo` | MongoDB 127.0.0.1:27018, replica set `rs-isp`, auth + keyfile, data in `C:\isp\mongo` |
| `isp-pg-standby` | PostgreSQL 16 standby of Ubuntu `radius`, 127.0.0.1:5433, data in `C:\isp\pgstandby` |
| `isp-api` | Node API 127.0.0.1:4100 (WinSW, LocalService) |
| nginx site | `<nginx>\conf\isp\isp-staging.conf`: new.bharatradius.com (80/443) and walled garden :8089 |

## Prerequisites (one-time, by hand)

| Item | Version | Note |
|---|---|---|
| Node.js | 22 LTS x64 MSI from nodejs.org | `node -v` ≥ 22 |
| MongoDB Server | 7.0+ binaries (already installed) | we register our own service `isp-mongo`; the existing `MongoDB` service is not touched |
| mongosh | latest MSI | on PATH |
| PostgreSQL | 16 binaries (already installed) | standby uses port 5433 |
| WinSW | v2.12.0 `WinSW-x64.exe` → `C:\isp\services\` | |
| win-acme | latest | TLS for new.bharatradius.com |
| windows_exporter, Prometheus, Grafana, blackbox_exporter | latest | WP 1.8 |

## Run

```powershell
# from the repo checkout on the Windows VPS, elevated PowerShell
.\deploy\windows\install-base.ps1 -UbuntuHost 154.49.142.251 -Env staging
```

It creates `C:\isp\{releases,current,secrets,logs,…}` with locked-down ACLs, registers `isp-mongo` (replica set `rs-isp`, users `ispAdmin`, `isp_app`, then auth + keyfile), builds the PostgreSQL standby on **port 5433** from slot `windows_standby` over verify-full TLS, registers `isp-api` with WinSW (runs as LocalService, secrets via `node --env-file`), renders the nginx site (nginx folder detected from the running process) and opens TCP 8089 for the walled garden.

Then by hand:

1. Add `include isp/*.conf;` inside `http { }` of `C:\nginx-1.30.2\conf\nginx.conf`.
2. `wacs.exe --target manual --host new.bharatradius.com --validation filesystem --webroot C:\isp\acme --store pemfiles --pemfilespath C:\isp\tls` (rename outputs to `new.bharatradius.com-chain.pem` / `-key.pem` if needed).
3. Rerun the script: it runs `nginx -t` and reloads only if the test passes.
4. Fill `RADIUS_DB_URL` and `RADIUS_PW_KEY` in `C:\isp\secrets\staging.env`.
5. Deploy a release to `C:\isp\current`, `Start-Service isp-api`, open `https://new.bharatradius.com/api/healthz` → `"status":"ok"`, `radiusDb.ssl: true`.

## Checks

```powershell
Get-Service isp-mongo, isp-pg-standby, isp-api
mongosh "mongodb://ispAdmin:<pw>@127.0.0.1:27018/?authSource=admin&directConnection=true" --eval "rs.status().members[0].stateStr"   # PRIMARY
& 'C:\Program Files\PostgreSQL\16\bin\pg_controldata.exe' C:\isp\pgstandby | Select-String state         # in archive recovery
```

On Ubuntu: `sudo -u postgres psql -c "select application_name, state, replay_lag from pg_stat_replication"`.

## Rollback

`isp-api.exe uninstall`; `Stop-Service isp-pg-standby; sc.exe delete isp-pg-standby`; `Stop-Service isp-mongo; sc.exe delete isp-mongo`; remove the nginx include line and reload. Existing services were never changed, so nothing else to restore. Drop the slot on Ubuntu if the standby is removed for good: `select pg_drop_replication_slot('windows_standby')` — otherwise WAL is retained (capped at 10 GB).
