$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $repo 'src-tauri/target/debug/luckyray-app.exe'
$expectedHash = 'D3619F471D0D03D8C5B0B1AA226EC02A33DC21992045818FEBB276D100F1816F'
$feedPort = 38491

if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
  throw 'Issue 189 epoch386 test application is missing.'
}
if ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -ne $expectedHash) {
  throw 'Issue 189 epoch386 test application has changed; refusing to launch an unverified build.'
}
if (-not (Test-Path -LiteralPath (Join-Path $repo 'src-tauri/target/debug/deepseek-harness-issue189-old/host') -PathType Container)) {
  throw 'The frozen old-engine resource is missing.'
}
if (-not (Get-NetTCPConnection -LocalPort $feedPort -State Listen -ErrorAction SilentlyContinue)) {
  throw 'The isolated signed development feed is not listening; ask the maintainer to restore it before checking for updates.'
}

$running = @(Get-CimInstance Win32_Process -Filter "Name = 'luckyray-app.exe'" |
  Where-Object { $_.ExecutablePath -eq $exe })
if ($running.Count -ne 0) {
  Write-Host "Issue 189 epoch386 test application is already running (PID $($running[0].ProcessId))."
  exit 0
}

$env:LUCKYRAY_APP_PROFILE = 'issue189-epoch386-e2e'
Write-Host 'Starting isolated LuckyRay Issue 189 Epoch 386 E2E (old engine 0.1.5-rc.2).'
Write-Host 'This is not the regular development or production profile.'
Push-Location (Split-Path -Parent $exe)
try {
  & $exe
} finally {
  Pop-Location
}
