# Apaga el entorno de desarrollo (gateway, PostgREST y Postgres). Los datos de desarrollo se conservan en dev\datos.
$dev = $PSScriptRoot
foreach ($n in "gateway", "postgrest") {
  $f = "$dev\pids\$n.pid"
  if (Test-Path $f) { Stop-Process -Id ([int](Get-Content $f)) -Force -ErrorAction SilentlyContinue; Remove-Item $f }
}
& "$dev\pg\pgsql\bin\pg_ctl.exe" stop -D "$dev\datos" -m fast 2>$null | Out-Null
Write-Host "Entorno de desarrollo detenido."
