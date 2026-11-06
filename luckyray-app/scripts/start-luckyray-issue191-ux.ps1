param([switch]$PlanOnly)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$issue191Repo = Split-Path -Parent $PSScriptRoot
$issue191Config = Get-Content -LiteralPath (Join-Path $issue191Repo 'src-tauri/tauri.issue191-fixture.conf.json') -Raw | ConvertFrom-Json
$issue191Identifier = 'com.luckyray.desktop.issue191-ux'
if ($issue191Config.identifier -cne $issue191Identifier -or $issue191Config.bundle.active -ne $false) {
  throw 'issue191-fixture-config-invalid'
}
$issue191Exe = [IO.Path]::GetFullPath((Join-Path $issue191Repo 'src-tauri/target/debug/luckyray-app.exe'))
$issue191ReceiptPath = Join-Path $issue191Repo 'src-tauri/target/debug/issue191-ux-receipt.json'
$issue191Profile = Join-Path $env:APPDATA $issue191Identifier
if ($PlanOnly) {
  [ordered]@{ identifier=$issue191Identifier; marker='issue191-ux'; executable=$issue191Exe;
    profile=$issue191Profile; receipt=$issue191ReceiptPath; engine='0.1.7-rc.2'; updateTrust='unconfigured';
    builds=$false; startsGateway=$false; copiesUserData=$false } | ConvertTo-Json
  exit 0
}
# Never inherit a packaged host's virtualized AppData into a physical UI test.
if (-not ('LuckyRayIssue191PackageCheck' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LuckyRayIssue191PackageCheck {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
  public static extern int GetCurrentPackageFullName(ref uint length, IntPtr name);
}
'@
}
[uint32]$issue191PackageLength = 0
if ([LuckyRayIssue191PackageCheck]::GetCurrentPackageFullName([ref]$issue191PackageLength, [IntPtr]::Zero) -ne 15700) {
  throw 'issue191-packaged-host: open Start-LuckyRayIssue191.cmd from ordinary Windows Explorer. No data was changed.'
}
& (Join-Path $PSScriptRoot 'assert-dev-physical-profile.ps1') -ProfileRoot $issue191Profile
$issue191Existing = @(Get-CimInstance Win32_Process | Where-Object {
  ([string]$_.ExecutablePath).Replace('\\?\','') -ieq $issue191Exe
})
if ($issue191Existing.Count -gt 0) {
  Write-Host 'Issue 191 test is already running. Keep that window; no second instance was started.'
  exit 0
}
if (-not (Test-Path -LiteralPath $issue191ReceiptPath) -or -not (Test-Path -LiteralPath $issue191Exe)) {
  throw 'issue191-candidate-not-prepared: ask Sol for the frozen candidate; this entry never rebuilds.'
}
$issue191Receipt = Get-Content -LiteralPath $issue191ReceiptPath -Raw | ConvertFrom-Json
if ($issue191Receipt.identifier -cne $issue191Identifier -or $issue191Receipt.updateTrust -cne 'unconfigured' -or
    $issue191Receipt.engine -cne '0.1.7-rc.2' -or
    (Get-FileHash -LiteralPath $issue191Exe -Algorithm SHA256).Hash -cne $issue191Receipt.executableSha256) {
  throw 'issue191-candidate-receipt-mismatch: do not bypass verification or use another EXE.'
}
$issue191CurrentHead = (& git -C $issue191Repo rev-parse HEAD | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $issue191CurrentHead -cne $issue191Receipt.sourceHead) {
  throw 'issue191-source-head-mismatch: candidate is not frozen; ask Sol before testing.'
}
foreach ($issue191Variable in @('LUCKYRAY_DSH_UPDATE_FEED','LUCKYRAY_DSH_UPDATE_PUBLIC_KEY',
    'LUCKYRAY_DEV_DSH_UPDATE_FEED','LUCKYRAY_DEV_DSH_UPDATE_PUBLIC_KEY','LUCKYRAY_DEV_DSH_UPDATE_CA_PEM',
    'LUCKYRAY_DSH_TEST_PROFILE_ROOT','LUCKYRAY_DSH_TEST_RUNTIME_ROOT')) {
  if (Test-Path -LiteralPath ('Env:' + $issue191Variable)) { Remove-Item -LiteralPath ('Env:' + $issue191Variable) }
}
$env:LUCKYRAY_APP_PROFILE = 'issue191-ux'
Write-Host ('Starting frozen Issue 191 UX test: ' + $issue191Receipt.sourceHead)
Write-Host 'Separate empty test profile; real engine 0.1.7-rc.2; no local update feed or automatic pairing/grants.'
Write-Host 'Regular development and historical tests are not stopped or modified.'
Push-Location $issue191Repo
try { & $issue191Exe; if ($LASTEXITCODE -ne 0) { throw ('issue191-test-exit-code: ' + $LASTEXITCODE) } }
finally { Pop-Location }
