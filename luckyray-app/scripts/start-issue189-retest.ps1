$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $repo 'src-tauri/target/debug/luckyray-app.exe'
$expectedHash = 'F2064D27928D2AA13DD9B8941D3F5516786A0794A81BECFF77525695756732AA'
$feedPort = 38491

if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
  throw 'Issue 189 repaired retest application is missing.'
}
if ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -ne $expectedHash) {
  throw 'Issue 189 repaired retest application has changed; refusing to launch an unverified build.'
}
if (-not (Test-Path -LiteralPath (Join-Path $repo 'src-tauri/target/debug/deepseek-harness-issue189-old/host') -PathType Container)) {
  throw 'The frozen 0.1.5-rc.2 old-engine resource is missing.'
}
if (-not (Get-NetTCPConnection -LocalPort $feedPort -State Listen -ErrorAction SilentlyContinue)) {
  throw 'The isolated signed development feed is not listening; ask the maintainer to restore it before checking for updates.'
}

$running = @(Get-CimInstance Win32_Process -Filter "Name = 'luckyray-app.exe'" |
  Where-Object { $_.ExecutablePath -eq $exe })
if ($running.Count -ne 0) {
  Write-Host "Issue 189 repaired retest application is already running (PID $($running[0].ProcessId))."
  exit 0
}

$env:LUCKYRAY_APP_PROFILE = 'issue189-epoch387-retest'
Write-Host 'Starting isolated LuckyRay Issue 189 repaired retest (old engine 0.1.5-rc.2).'
Write-Host 'This is not the previous test, regular development, or production profile.'
Push-Location (Split-Path -Parent $exe)
try {
  & $exe
} finally {
  Pop-Location
}
