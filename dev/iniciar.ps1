# Levanta el entorno de DESARROLLO: Postgres 17 + PostgREST + gateway de Supabase. No toca producción.
# Uso:  powershell -ExecutionPolicy Bypass -File dev\iniciar.ps1
$ErrorActionPreference = "Stop"
$dev = $PSScriptRoot
$pg = "$dev\pg\pgsql\bin"
$env:PATH = "$pg;$env:PATH"
$datos = "$dev\datos"
$puerto = 54329

if (-not (Test-Path "$pg\postgres.exe")) { throw "Falta Postgres en dev\pg. Descargalo como indica dev\README.md" }

# 1) Clúster de Postgres (la primera vez)
if (-not (Test-Path "$datos\PG_VERSION")) {
  Write-Host "Creando el clúster de Postgres..."
  & "$pg\initdb.exe" -D $datos -U postgres -A trust -E UTF8 --locale=C | Out-Null
}
& "$pg\pg_ctl.exe" status -D $datos *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Iniciando Postgres en el puerto $puerto..."
  # Sin -w: en Windows pg_ctl no suelta la consola; se espera con pg_isready
  Start-Process "$pg\pg_ctl.exe" -ArgumentList "start -D `"$datos`" -o `"-p $puerto`" -l `"$dev\postgres.log`"" -WindowStyle Hidden
  for ($i = 0; $i -lt 40; $i++) { & "$pg\pg_isready.exe" -h 127.0.0.1 -p $puerto *> $null; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep 1 }
}

# 2) Base de datos y esquema (la primera vez)
$existe = & "$pg\psql.exe" -h 127.0.0.1 -p $puerto -U postgres -tAc "select 1 from pg_database where datname='eventosqr'"
if ($existe -ne "1") { & "$pg\psql.exe" -h 127.0.0.1 -p $puerto -U postgres -c "create database eventosqr" | Out-Null }
$psql = @("-h", "127.0.0.1", "-p", $puerto, "-U", "postgres", "-d", "eventosqr", "-v", "ON_ERROR_STOP=1", "-q")
$hayTablas = & "$pg\psql.exe" @psql -tAc "select to_regclass('public.usuarios') is not null"
if ($hayTablas -ne "t") {
  Write-Host "Aplicando el esquema (supabase\schema.sql)..."
  & "$pg\psql.exe" @psql -f "$dev\preambulo.sql" | Out-Null
  & "$pg\psql.exe" @psql -f "$dev\..\supabase\schema.sql" | Out-Null
}
& "$pg\psql.exe" @psql -f "$dev\posterior.sql" | Out-Null

# 3) Clave de desarrollo + PostgREST + gateway
node "$dev\generar-clave.mjs"
New-Item -ItemType Directory -Force "$dev\pids" | Out-Null
function Vivo($archivo) { if (Test-Path $archivo) { $p = Get-Process -Id ([int](Get-Content $archivo)) -ErrorAction SilentlyContinue; return [bool]$p } return $false }
if (-not (Vivo "$dev\pids\postgrest.pid")) {
  $p = Start-Process "$dev\postgrest\postgrest.exe" -ArgumentList "`"$dev\postgrest.conf`"" -WindowStyle Hidden -PassThru -RedirectStandardError "$dev\postgrest.log"
  $p.Id | Set-Content "$dev\pids\postgrest.pid"
}
if (-not (Vivo "$dev\pids\gateway.pid")) {
  $p = Start-Process node -ArgumentList "`"$dev\gateway.mjs`"" -WindowStyle Hidden -PassThru -RedirectStandardOutput "$dev\gateway.log" -RedirectStandardError "$dev\gateway-error.log"
  $p.Id | Set-Content "$dev\pids\gateway.pid"
}
Start-Sleep 2
$clave = (Get-Content "$dev\clave-dev.json" | ConvertFrom-Json).serviceRoleKey
Write-Host ""
Write-Host "Entorno de desarrollo listo. Variables para el API (.env):"
Write-Host "  SUPABASE_URL=http://127.0.0.1:54321"
Write-Host "  SUPABASE_SERVICE_ROLE_KEY=$clave"
