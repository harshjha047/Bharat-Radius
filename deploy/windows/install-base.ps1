#Requires -RunAsAdministrator
<#
.SYNOPSIS
  WP 1.4 — Windows app host base: folders + ACLs, our own MongoDB service (isp-mongo, 127.0.0.1:27018, replica set
  rs-isp, auth + keyfile), PostgreSQL standby of the Ubuntu `radius` database (isp-pg-standby, port 5433), WinSW
  service for the API (isp-api, 127.0.0.1:4100), nginx site. Idempotent.
  Never modifies existing services: the shared MongoDB on 27017, BharatRadius' PostgreSQL on 5432, pm2 apps,
  or other nginx server blocks.

.PREREQUISITES (install by hand once; versions pinned in docs/runbooks/windows-base.md)
  Node.js 22 LTS, MongoDB Server 7.0+ binaries, mongosh, PostgreSQL 16 binaries, WinSW-x64.exe v2.12 in
  <AppRoot>\services, nginx running (its folder is detected from the running process).

.EXAMPLE
  .\install-base.ps1 -UbuntuHost 154.49.142.251 -Env staging
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$UbuntuHost,
  [ValidateSet('staging', 'production')][string]$Env = 'staging',
  [string]$AppRoot = 'C:\isp',
  [string]$NginxRoot = '',
  [int]$ApiPort = 4100,
  [int]$MongoPort = 27018,
  [string]$MongoReplSet = 'rs-isp',
  [int]$StandbyPort = 5433,
  [switch]$SkipStandby,
  [switch]$SkipMongo
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$RepoDeploy = $PSScriptRoot

function Log([string]$m) { Write-Host "[install-base] $m" -ForegroundColor Cyan }
function Fail([string]$m) { Write-Host "[install-base] ERROR: $m" -ForegroundColor Red; exit 1 }
function New-Secret([int]$bytes = 24) {
  $b = [byte[]]::new($bytes); [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  -join ($b | ForEach-Object { $_.ToString('x2') })
}
function Lock-Acl([string]$path, [string[]]$extra = @()) {
  icacls $path /inheritance:r /grant:r 'Administrators:(OI)(CI)F' 'SYSTEM:(OI)(CI)F' | Out-Null
  foreach ($e in $extra) { icacls $path /grant "${e}:(OI)(CI)R" | Out-Null }
}
# A port may be in use only by our own service (re-runs); anything else is a conflict.
function Assert-PortOurs([int]$port, [string]$ourService) {
  $c = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $c) { return }
  $svc = Get-CimInstance Win32_Service -Filter "Name='$ourService'" -ErrorAction SilentlyContinue
  if ($svc -and $svc.ProcessId -and ($svc.ProcessId -eq $c.OwningProcess -or
      (Get-CimInstance Win32_Process -Filter "ParentProcessId=$($svc.ProcessId)" | Where-Object ProcessId -eq $c.OwningProcess))) { return }
  $p = (Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue).ProcessName
  Fail "TCP $port is already used by '$p' (pid $($c.OwningProcess)); choose another port with -$(if ($port -eq $ApiPort) {'ApiPort'} elseif ($port -eq $MongoPort) {'MongoPort'} else {'StandbyPort'})"
}
function Wait-Port([int]$port, [int]$secs = 30) {
  for ($i = 0; $i -lt $secs; $i++) {
    if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) { return }
    Start-Sleep 1
  }
  Fail "nothing listening on $port after $secs s"
}

# ------------------------------------------------------------------ preflight
Log 'preflight'
Assert-PortOurs $ApiPort 'isp-api'
Assert-PortOurs $MongoPort 'isp-mongo'
Assert-PortOurs $StandbyPort 'isp-pg-standby'
if (-not $NginxRoot) {
  $ngx = Get-Process nginx -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $ngx) { Fail 'nginx is not running; pass -NginxRoot' }
  $NginxRoot = Split-Path $ngx.Path
}
Log "nginx: $NginxRoot; API 127.0.0.1:$ApiPort; MongoDB 127.0.0.1:$MongoPort ($MongoReplSet); standby :$StandbyPort"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail 'Node.js 22 not installed' }
$nodeMajor = [int]((& node -v).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) { Fail "Node.js >= 22 required, found $(& node -v)" }
$bharat = Get-Service | Where-Object { $_.Name -like 'postgresql*' -and $_.Name -ne 'isp-pg-standby' }
if ($bharat) { Log "existing PostgreSQL service(s) left untouched: $($bharat.Name -join ', ')" }

# ------------------------------------------------------------------ folders and ACLs
Log "folders under $AppRoot"
foreach ($d in 'releases', 'current', 'services', 'logs', 'secrets', 'tls', 'acme', 'mongo\data', 'mongo\log', 'pgstandby', 'backups') {
  New-Item -ItemType Directory -Force -Path (Join-Path $AppRoot $d) | Out-Null
}
Lock-Acl (Join-Path $AppRoot 'secrets') @('NT AUTHORITY\LocalService')
icacls (Join-Path $AppRoot 'logs') /grant 'NT AUTHORITY\LocalService:(OI)(CI)M' | Out-Null
$envFile = Join-Path $AppRoot "secrets\$Env.env"
if (-not (Test-Path $envFile)) {
  Log "creating $envFile (fill RADIUS_DB_URL / RADIUS_PW_KEY from the Ubuntu $Env.app.env)"
  @(
    "MONGO_URL=",
    "RADIUS_DB_URL=",
    "RADIUS_PW_KEY=",
    "JWT_SIGNING_KEY=$(New-Secret 32)",
    "REFRESH_TOKEN_PEPPER=$(New-Secret 32)",
    "FIELD_ENCRYPTION_KEY=$(New-Secret 32)",
    "TZ_BILLING=Asia/Kolkata"
  ) | Set-Content -Encoding ascii $envFile
}

# ------------------------------------------------------------------ our MongoDB (isp-mongo)
if (-not $SkipMongo) {
  $mongod = Get-ChildItem 'C:\Program Files\MongoDB\Server\*\bin\mongod.exe' -ErrorAction SilentlyContinue |
    Sort-Object { [version]($_.Directory.Parent.Name + '.0') } -Descending | Select-Object -First 1 -ExpandProperty FullName
  if (-not $mongod) { Fail 'mongod.exe not found under C:\Program Files\MongoDB\Server' }
  $mongosh = (Get-Command mongosh -ErrorAction SilentlyContinue).Source
  if (-not $mongosh) { Fail 'mongosh not found on PATH' }
  $cfg = Join-Path $AppRoot 'mongo\mongod.cfg'
  $keyFile = Join-Path $AppRoot 'secrets\mongo.keyfile'
  $mongoEnv = Join-Path $AppRoot 'secrets\mongo.env'
  if (-not (Test-Path $keyFile)) {
    $kb = [byte[]]::new(96); [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($kb)
    [Convert]::ToBase64String($kb) | Set-Content -NoNewline -Encoding ascii $keyFile
  }
  $template = (Get-Content (Join-Path $RepoDeploy 'mongo\mongod.cfg') -Raw).Replace('C:\isp', $AppRoot).
    Replace('__MONGO_PORT__', "$MongoPort").Replace('__REPLSET__', $MongoReplSet)
  $securedCfg = $template -replace '#SECURITY#', ''
  $openCfg = $template -replace '(?m)^#SECURITY#.*\r?\n', ''

  if (-not (Get-Service isp-mongo -ErrorAction SilentlyContinue)) {
    Log "registering service isp-mongo ($mongod)"
    Set-Content -Encoding ascii $cfg $openCfg
    New-Service -Name isp-mongo -DisplayName 'ISP MongoDB (isp-platform)' -StartupType Automatic `
      -BinaryPathName "`"$mongod`" --config `"$cfg`" --service --serviceName isp-mongo" | Out-Null
    Start-Service isp-mongo
    Wait-Port $MongoPort
  }
  if (-not (Test-Path $mongoEnv)) {
    Log "initiating replica set $MongoReplSet and creating users (one time)"
    & $mongosh --port $MongoPort --quiet --eval "try { rs.status().ok } catch (e) { rs.initiate({_id:'$MongoReplSet', members:[{_id:0, host:'127.0.0.1:$MongoPort'}]}) }" | Out-Null
    for ($i = 0; $i -lt 30; $i++) {
      if ((& $mongosh --port $MongoPort --quiet --eval 'db.hello().isWritablePrimary') -eq 'true') { break }
      Start-Sleep 1
    }
    $adminPw = New-Secret; $appPw = New-Secret
    @"
db.getSiblingDB('admin').createUser({ user: 'ispAdmin', pwd: '$adminPw', roles: ['root'] });
db.getSiblingDB('admin').createUser({ user: 'isp_app', pwd: '$appPw', roles: [
  { role: 'readWrite', db: 'isp' }, { role: 'readWrite', db: 'isp_staging' } ] });
"@ | & $mongosh --port $MongoPort --quiet | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail 'creating MongoDB users failed' }
    @("MONGO_ADMIN_PASSWORD=$adminPw", "MONGO_APP_PASSWORD=$appPw") | Set-Content -Encoding ascii $mongoEnv
    $db = if ($Env -eq 'production') { 'isp' } else { 'isp_staging' }
    (Get-Content $envFile) -replace '^MONGO_URL=.*$',
      "MONGO_URL=mongodb://isp_app:$appPw@127.0.0.1:$MongoPort/${db}?replicaSet=$MongoReplSet&authSource=admin" |
      Set-Content -Encoding ascii $envFile
  }
  if (-not (Test-Path $cfg) -or (Get-Content $cfg -Raw) -ne $securedCfg) {
    Log 'enabling MongoDB authorization + keyFile'
    Set-Content -Encoding ascii $cfg $securedCfg
    Restart-Service isp-mongo
    Wait-Port $MongoPort
  }
  $adminPw = ((Get-Content $mongoEnv) -match '^MONGO_ADMIN_PASSWORD=') -replace '^MONGO_ADMIN_PASSWORD=', ''
  $state = & $mongosh "mongodb://ispAdmin:$adminPw@127.0.0.1:$MongoPort/?authSource=admin&directConnection=true" --quiet --eval 'rs.status().members[0].stateStr'
  Log "isp-mongo: $state"
}

# ------------------------------------------------------------------ PostgreSQL standby (port $StandbyPort)
if (-not $SkipStandby) {
  $pgBin = Get-ChildItem 'C:\Program Files\PostgreSQL\16\bin\pg_ctl.exe' -ErrorAction SilentlyContinue
  if (-not $pgBin) { Fail 'PostgreSQL 16 binaries not found in C:\Program Files\PostgreSQL\16\bin' }
  $bin = $pgBin.DirectoryName
  $data = Join-Path $AppRoot 'pgstandby'
  $ca = Join-Path $AppRoot 'tls\radius-ca.crt'
  if (-not (Test-Path $ca)) { Fail "copy /etc/isp-radius/tls/ca.crt from the Ubuntu VPS to $ca" }
  if (-not (Get-Service isp-pg-standby -ErrorAction SilentlyContinue)) {
    if (Get-ChildItem $data -Force | Select-Object -First 1) { Fail "$data is not empty" }
    $sec = Read-Host -AsSecureString 'replicator password (Ubuntu /etc/isp-radius/replication.env)'
    $pw = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
    $pgpass = Join-Path $AppRoot 'secrets\pgpass.conf'
    "${UbuntuHost}:5432:replication:replicator:$pw" | Set-Content -Encoding ascii $pgpass
    $env:PGPASSFILE = $pgpass; $env:PGSSLMODE = 'verify-full'; $env:PGSSLROOTCERT = $ca
    Log "pg_basebackup from $UbuntuHost (slot windows_standby)"
    & "$bin\pg_basebackup.exe" -h $UbuntuHost -p 5432 -U replicator -D $data -X stream -S windows_standby -R --checkpoint=fast -P
    if ($LASTEXITCODE -ne 0) { Fail 'pg_basebackup failed' }
    $pgpassFwd = $pgpass.Replace('\', '/'); $caFwd = $ca.Replace('\', '/')
    # Ubuntu keeps postgresql.conf/pg_hba.conf in /etc, so the base backup has none: write standby-local ones.
    # Hot standby needs these limits >= the primary's (max_connections 200, max_wal_senders 5).
    @(
      "port = $StandbyPort",
      "listen_addresses = 'localhost'",
      "hot_standby = on",
      "max_connections = 200",
      "max_wal_senders = 5",
      "max_replication_slots = 5",
      "shared_buffers = 1GB",
      "primary_conninfo = 'host=$UbuntuHost port=5432 user=replicator passfile=''$pgpassFwd'' sslmode=verify-full sslrootcert=''$caFwd'' application_name=windows_standby'",
      "primary_slot_name = 'windows_standby'",
      "logging_collector = on",
      "log_directory = 'log'"
    ) | Set-Content -Encoding ascii (Join-Path $data 'postgresql.conf')
    '# managed by install-base.ps1' | Set-Content -Encoding ascii (Join-Path $data 'postgresql.auto.conf')
    @('host all all 127.0.0.1/32 scram-sha-256', 'host all all ::1/128 scram-sha-256') |
      Set-Content -Encoding ascii (Join-Path $data 'pg_hba.conf')
    '' | Set-Content -Encoding ascii (Join-Path $data 'pg_ident.conf')
    if (-not (Test-Path (Join-Path $data 'standby.signal'))) { New-Item (Join-Path $data 'standby.signal') | Out-Null }
    icacls $data /grant 'NT AUTHORITY\NetworkService:(OI)(CI)F' | Out-Null
    icacls $pgpass /grant 'NT AUTHORITY\NetworkService:R' | Out-Null
    & "$bin\pg_ctl.exe" register -N isp-pg-standby -D $data -S auto -U 'NT AUTHORITY\NetworkService'
    Start-Service isp-pg-standby
  }
  Log "standby: $((& "$bin\pg_controldata.exe" $data | Select-String 'Database cluster state').ToString())"
}

# ------------------------------------------------------------------ WinSW service for the API
$winsw = Join-Path $AppRoot 'services\WinSW-x64.exe'
if (-not (Test-Path $winsw)) { Fail "download WinSW-x64.exe v2.12.0 to $winsw" }
$apiExe = Join-Path $AppRoot 'services\isp-api.exe'
$apiXml = Join-Path $AppRoot 'services\isp-api.xml'
Copy-Item $winsw $apiExe -Force
(Get-Content (Join-Path $RepoDeploy 'winsw\isp-api.xml') -Raw).Replace('__APPROOT__', $AppRoot).Replace('__ENV__', $Env).Replace('__API_PORT__', "$ApiPort") |
  Set-Content -Encoding utf8 $apiXml
if (-not (Get-Service isp-api -ErrorAction SilentlyContinue)) { & $apiExe install | Out-Null; Log 'isp-api service registered' }
else { & $apiExe refresh | Out-Null }
icacls (Join-Path $AppRoot 'current') /grant 'NT AUTHORITY\LocalService:(OI)(CI)RX' | Out-Null

# ------------------------------------------------------------------ nginx site
$siteDir = Join-Path $NginxRoot 'conf\isp'
New-Item -ItemType Directory -Force -Path $siteDir | Out-Null
(Get-Content (Join-Path $RepoDeploy 'nginx\isp-staging.conf') -Raw).Replace('__API_PORT__', "$ApiPort").Replace('C:/isp', $AppRoot.Replace('\', '/')) |
  Set-Content -Encoding ascii (Join-Path $siteDir 'isp-staging.conf')
$mainConf = Get-Content (Join-Path $NginxRoot 'conf\nginx.conf') -Raw
if ($mainConf -notmatch 'include\s+isp/\*\.conf') {
  Log "ACTION: add 'include isp/*.conf;' inside http { } of $NginxRoot\conf\nginx.conf, then rerun"
} elseif (-not (Test-Path (Join-Path $AppRoot 'tls\new.bharatradius.com-chain.pem'))) {
  Log 'ACTION: issue the TLS certificate with win-acme (runbook), then rerun'
} else {
  Push-Location $NginxRoot
  & .\nginx.exe -t
  if ($LASTEXITCODE -ne 0) { Pop-Location; Fail 'nginx -t failed; site not reloaded' }
  & .\nginx.exe -s reload
  Pop-Location
  Log 'nginx reloaded'
}

# ------------------------------------------------------------------ firewall: walled-garden pay page
if (-not (Get-NetFirewallRule -DisplayName 'isp walled garden 8089' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName 'isp walled garden 8089' -Direction Inbound -Protocol TCP -LocalPort 8089 -Action Allow | Out-Null
}
Log 'done'
