#Requires -RunAsAdministrator
<#
.SYNOPSIS
  WP 1.4 — Windows app host base: folders + ACLs, MongoDB replica set rs0, PostgreSQL standby of the Ubuntu
  `radius` database (port 5433, beside BharatRadius' own PostgreSQL), WinSW service for the API, nginx site.
  Idempotent. Does not modify BharatRadius services, its nginx server blocks or its PostgreSQL.

.PREREQUISITES (install by hand once; versions pinned in docs/runbooks/windows-base.md)
  Node.js 22 LTS (MSI), MongoDB Server 8.0 (MSI, service "MongoDB"), mongosh, PostgreSQL 16 binaries (EDB installer,
  untick "PostgreSQL Server" service creation is fine), WinSW-x64.exe v2.12 in <AppRoot>\services, nginx already running.

.EXAMPLE
  .\install-base.ps1 -UbuntuHost radius.example.net -Env staging
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$UbuntuHost,
  [ValidateSet('staging', 'production')][string]$Env = 'staging',
  [string]$AppRoot = 'C:\isp',
  [string]$NginxRoot = 'C:\nginx',
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
  $b = [byte[]]::new($bytes); [Security.Cryptography.RandomNumberGenerator]::Fill($b)
  -join ($b | ForEach-Object { $_.ToString('x2') })
}
function Lock-Acl([string]$path, [string[]]$extra = @()) {
  icacls $path /inheritance:r /grant:r 'Administrators:(OI)(CI)F' 'SYSTEM:(OI)(CI)F' | Out-Null
  foreach ($e in $extra) { icacls $path /grant "${e}:(OI)(CI)R" | Out-Null }
}
function Test-PortOwner([int]$port, [string[]]$allowed) {
  $c = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $c) { return }
  $p = (Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue).ProcessName
  if ($allowed -notcontains $p) { Fail "TCP $port is used by '$p'" }
}

# ------------------------------------------------------------------ preflight
Log 'preflight'
Test-PortOwner 4000 @('node')
Test-PortOwner 3000 @('node')
Test-PortOwner 27017 @('mongod')
Test-PortOwner $StandbyPort @('postgres')
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

# ------------------------------------------------------------------ MongoDB replica set rs0
if (-not $SkipMongo) {
  $svc = Get-Service MongoDB -ErrorAction SilentlyContinue
  if (-not $svc) { Fail 'MongoDB service not found (install MongoDB 8.0 MSI first)' }
  $mongod = (Get-CimInstance Win32_Service -Filter "Name='MongoDB'").PathName -replace '^"([^"]+)".*', '$1'
  $mongosh = (Get-Command mongosh -ErrorAction SilentlyContinue).Source
  if (-not $mongosh) { Fail 'mongosh not found on PATH' }
  $cfg = Join-Path $AppRoot 'mongo\mongod.cfg'
  $keyFile = Join-Path $AppRoot 'secrets\mongo.keyfile'
  $mongoEnv = Join-Path $AppRoot 'secrets\mongo.env'
  if (-not (Test-Path $keyFile)) {
    $kb = [byte[]]::new(96); [Security.Cryptography.RandomNumberGenerator]::Fill($kb)
    [Convert]::ToBase64String($kb) | Set-Content -NoNewline -Encoding ascii $keyFile
  }
  $mongoAcct = (Get-CimInstance Win32_Service -Filter "Name='MongoDB'").StartName
  icacls $keyFile /grant "${mongoAcct}:R" | Out-Null
  icacls (Join-Path $AppRoot 'mongo') /grant "${mongoAcct}:(OI)(CI)M" | Out-Null
  $template = Get-Content (Join-Path $RepoDeploy 'mongo\mongod.cfg') -Raw
  $secured = (Test-Path $mongoEnv)
  $content = if ($secured) { $template -replace '#SECURITY#', '' } else { $template -replace '(?m)^#SECURITY#.*\r?\n', '' }
  $content = $content.Replace('C:\isp', $AppRoot)
  $changed = -not (Test-Path $cfg) -or ((Get-Content $cfg -Raw) -ne $content)
  if ($changed) {
    Log 'configuring MongoDB service with replica set rs0'
    Set-Content -Encoding ascii $cfg $content
    Stop-Service MongoDB
    & sc.exe config MongoDB binPath= "`"$mongod`" --config `"$cfg`" --service" | Out-Null
    Start-Service MongoDB
    Start-Sleep 3
  }
  if (-not $secured) {
    Log 'initiating rs0 and creating users (one time)'
    & $mongosh --quiet --eval "try { rs.status().ok } catch (e) { rs.initiate({_id:'rs0', members:[{_id:0, host:'127.0.0.1:27017'}]}) }" | Out-Null
    Start-Sleep 5
    $adminPw = New-Secret; $appPw = New-Secret
    $js = @"
db.getSiblingDB('admin').createUser({ user: 'ispAdmin', pwd: '$adminPw', roles: ['root'] });
db.getSiblingDB('admin').createUser({ user: 'isp_app', pwd: '$appPw', roles: [
  { role: 'readWrite', db: 'isp' }, { role: 'readWrite', db: 'isp_staging' } ] });
"@
    $js | & $mongosh --quiet | Out-Null
    @("MONGO_ADMIN_PASSWORD=$adminPw", "MONGO_APP_PASSWORD=$appPw") | Set-Content -Encoding ascii $mongoEnv
    $db = if ($Env -eq 'production') { 'isp' } else { 'isp_staging' }
    (Get-Content $envFile) -replace '^MONGO_URL=.*$', "MONGO_URL=mongodb://isp_app:$appPw@127.0.0.1:27017/${db}?replicaSet=rs0&authSource=admin" | Set-Content -Encoding ascii $envFile
    Log 'enabling authorization + keyFile'
    Set-Content -Encoding ascii $cfg (($template -replace '#SECURITY#', '').Replace('C:\isp', $AppRoot))
    Restart-Service MongoDB
  }
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
(Get-Content (Join-Path $RepoDeploy 'winsw\isp-api.xml') -Raw).Replace('__APPROOT__', $AppRoot).Replace('__ENV__', $Env) |
  Set-Content -Encoding utf8 $apiXml
if (-not (Get-Service isp-api -ErrorAction SilentlyContinue)) { & $apiExe install | Out-Null; Log 'isp-api service registered' }
else { & $apiExe refresh | Out-Null }
icacls (Join-Path $AppRoot 'current') /grant 'NT AUTHORITY\LocalService:(OI)(CI)RX' | Out-Null

# ------------------------------------------------------------------ nginx site
$siteDir = Join-Path $NginxRoot 'conf\isp'
New-Item -ItemType Directory -Force -Path $siteDir | Out-Null
Copy-Item (Join-Path $RepoDeploy 'nginx\isp-staging.conf') (Join-Path $siteDir 'isp-staging.conf') -Force
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
