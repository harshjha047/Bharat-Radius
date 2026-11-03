# Windows app host base (WP 1.4)

BharatRadius keeps running. Nothing here edits its services, its nginx server blocks or its PostgreSQL.

## Prerequisites (one-time, by hand)

| Item | Version | Note |
|---|---|---|
| Node.js | 22 LTS x64 MSI from nodejs.org | `node -v` ≥ 22 |
| MongoDB Server | 8.0 MSI, "Install as a Service" | service name `MongoDB` |
| mongosh | latest MSI | on PATH |
| PostgreSQL | 16 (EDB installer) | binaries only are enough; **do not** use port 5432 (BharatRadius' PostgreSQL may be there) |
| WinSW | v2.12.0 `WinSW-x64.exe` → `C:\isp\services\` | |
| win-acme | latest | TLS for new.bharatradius.com |
| windows_exporter, Prometheus, Grafana, blackbox_exporter | latest | WP 1.8 |

## Run

```powershell
# from the repo checkout on the Windows VPS, elevated PowerShell
.\deploy\windows\install-base.ps1 -UbuntuHost <PG_TLS_HOSTNAME> -Env staging
```

It creates `C:\isp\{releases,current,secrets,logs,…}` with locked-down ACLs, turns MongoDB into replica set `rs0` (users `ispAdmin`, `isp_app`, then enables auth + keyfile), builds the PostgreSQL standby on **port 5433** from slot `windows_standby` over verify-full TLS, registers `isp-api` with WinSW (runs as LocalService, secrets via `node --env-file`), copies the nginx site and opens TCP 8089 for the walled garden.

Then by hand:

1. Add `include isp/*.conf;` inside `http { }` of `C:\nginx\conf\nginx.conf`.
2. `wacs.exe --target manual --host new.bharatradius.com --validation filesystem --webroot C:\isp\acme --store pemfiles --pemfilespath C:\isp\tls` (rename outputs to `new.bharatradius.com-chain.pem` / `-key.pem` if needed).
3. Rerun the script: it runs `nginx -t` and reloads only if the test passes.
4. Fill `RADIUS_DB_URL` and `RADIUS_PW_KEY` in `C:\isp\secrets\staging.env`.
5. Deploy a release to `C:\isp\current`, `Start-Service isp-api`, open `https://new.bharatradius.com/api/healthz` → `"status":"ok"`, `radiusDb.ssl: true`.

## Checks

```powershell
Get-Service MongoDB, isp-pg-standby, isp-api
mongosh "mongodb://ispAdmin:<pw>@127.0.0.1/?authSource=admin" --eval "rs.status().members[0].stateStr"   # PRIMARY
& 'C:\Program Files\PostgreSQL\16\bin\pg_controldata.exe' C:\isp\pgstandby | Select-String state         # in archive recovery
```

On Ubuntu: `sudo -u postgres psql -c "select application_name, state, replay_lag from pg_stat_replication"`.

## Rollback

`isp-api.exe uninstall`; `Stop-Service isp-pg-standby; sc.exe delete isp-pg-standby`; remove the nginx include line and reload; restore the original MongoDB `binPath` (`sc.exe qc MongoDB` shows the current one). Drop the slot on Ubuntu if the standby is removed for good: `select pg_drop_replication_slot('windows_standby')` — otherwise WAL is retained (capped at 10 GB).
