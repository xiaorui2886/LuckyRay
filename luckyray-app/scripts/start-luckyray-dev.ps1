param(
  [switch]$PlanOnly,
  [switch]$PrepareOnly,
  [switch]$RuntimesOnly,
  [switch]$LshBackgroundPreload,
  [ValidateRange(1,65535)][int]$FrontendPort = 1420
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$relativeConfig = "src-tauri/tauri.dev.conf.json"
$configPath = Join-Path $repoRoot $relativeConfig
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json

if ([string]$config.identifier -cne "com.luckyray.desktop.dev" -or
    -not $config.bundle -or
    $config.bundle.active -ne $false) {
  throw "luckyray-development-config-invalid"
}

. (Join-Path $PSScriptRoot 'release-extension-origins.ps1')
$configuredOrigins = [Environment]::GetEnvironmentVariable('LUCKYRAY_DEV_EXTENSION_ORIGINS')
if ([string]::IsNullOrWhiteSpace($configuredOrigins)) {
  $manifest = Get-Content -LiteralPath (Join-Path $repoRoot 'browser-extension-prototype/manifest.json') -Encoding UTF8 -Raw | ConvertFrom-Json
  $extensionId = Get-LuckyRayChromiumExtensionId (Get-LuckyRayManifestPublicKey $manifest)
  # Keep the existing unpacked development identity alongside the checked-in public key.
  $developmentOrigins = @('chrome-extension://bckeanklmbjhjjomobmfkfjmeokdcfid', "chrome-extension://$extensionId") | Select-Object -Unique
} else {
  $developmentOrigins = @($configuredOrigins.Split(',') | ForEach-Object { $_.Trim() })
}
$developmentOrigins = @(ConvertTo-LuckyRayCanonicalOriginSet $developmentOrigins)

$tauriArgs = @("tauri", "dev", "--config", $relativeConfig)
$frontendBuild = [ordered]@{
  devUrl = "http://127.0.0.1:$FrontendPort"
  beforeDevCommand = "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/assert-runtime-profile.ps1 && node scripts/dev-frontend.mjs --port $FrontendPort"
}
if ($FrontendPort -ne 1420) {
  # Explicit per-launch override, never an automatic fallback to an unknown server.
  # Keep the checked-in identity and all other configuration unchanged.
  $portConfig = Join-Path $repoRoot "src-tauri/target/.dev-startup/frontend-$FrontendPort.json"
  $tauriArgs += @('--config', $portConfig)
}
if ($LshBackgroundPreload) {
  # Preview-only opt-in; the ordinary launcher and packaged builds stay off.
  $tauriArgs += @("--features", "lsh-background-surface-preload")
}

$plan = [ordered]@{
  schemaVersion = 1
  profile = "development"
  identifier = [string]$config.identifier
  command = @("pnpm.cmd") + $tauriArgs
  extensionOrigins = $developmentOrigins
  frontendPort = $FrontendPort
  frontendBuild = $frontendBuild
}

if ($PlanOnly) {
  $plan | ConvertTo-Json -Compress -Depth 3
  exit 0
}

# MSIX hosts can redirect the same APPDATA string into their LocalCache. Refuse
# that ambiguous deployment rather than start an old, unrelated dev identity.
if (-not ('LuckyRayMainDevPackageCheck' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LuckyRayMainDevPackageCheck {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetCurrentPackageFullName(ref uint length, IntPtr name);
}
'@
}
[uint32]$packageNameLength = 0
$packageStatus = [LuckyRayMainDevPackageCheck]::GetCurrentPackageFullName([ref]$packageNameLength, [IntPtr]::Zero)
if ($packageStatus -ne 15700) {
  throw 'luckyray-development-packaged-host: start from an ordinary Windows host; see docs/integration/MAIN-DEV-PHYSICAL-PROFILE.md. Do not copy AppData or re-pair.'
}

# Package identity 15700 can still coexist with inherited AppData redirection.
# Check the actual file handles before any path that can launch the desktop.
if (-not $PrepareOnly -and -not $RuntimesOnly) {
  & (Join-Path $PSScriptRoot 'assert-dev-physical-profile.ps1')
}

$env:LUCKYRAY_APP_PROFILE = "development"
$env:LUCKYRAY_DEV_EXTENSION_ORIGINS = $developmentOrigins -join ','
if ($env:CARGO_TARGET_DIR -and [IO.Path]::GetFullPath($env:CARGO_TARGET_DIR) -ine [IO.Path]::GetFullPath((Join-Path $repoRoot 'src-tauri/target'))) {
  throw 'luckyray-development-target-override: this entry uses the checkout target; remove CARGO_TARGET_DIR or use a separately configured checkout'
}
$startupClock = [Diagnostics.Stopwatch]::StartNew()
. (Join-Path $PSScriptRoot 'dsh-runtime-publication-lock.ps1')
$mutexName = (Get-DshRuntimePublicationMutexName -DestinationRoot $repoRoot) + '-DesktopStartup'
$mutex = [Threading.Mutex]::new($false, $mutexName)
$acquired = $false
$vite = $null
Push-Location $repoRoot
try {
  try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
  if (-not $acquired) { throw 'luckyray-development-already-starting: use the existing dev terminal; no process was stopped' }
  $debugRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'src-tauri/target/debug')).TrimEnd('\') + '\'
  foreach ($child in @(Get-CimInstance Win32_Process)) {
    $executable = ([string]$child.ExecutablePath).Replace('\\?\','')
    if ($executable -and $executable.StartsWith($debugRoot, [StringComparison]::OrdinalIgnoreCase)) {
      throw "luckyray-development-runtime-in-use: pid $($child.ProcessId) ($($child.Name)); close this checkout's app normally before starting a build"
    }
  }
  $cargoLock = Join-Path $debugRoot '.cargo-lock'
  if (Test-Path -LiteralPath $cargoLock) {
    try { $probe = [IO.File]::Open($cargoLock, 'Open', 'ReadWrite', 'None'); $probe.Dispose() }
    catch { throw 'luckyray-development-cargo-busy: another build holds this target; wait for that build instead of starting a second one' }
  }
  & node scripts/dev-frontend.mjs --status --port $FrontendPort
  $frontendStatus = $LASTEXITCODE
  & (Join-Path $PSScriptRoot 'assert-dev-frontend-status.ps1') -Status $frontendStatus -Port $FrontendPort
  if ($FrontendPort -ne 1420) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $portConfig) -Force | Out-Null
    [IO.File]::WriteAllText($portConfig, (@{ build = $frontendBuild } | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
  }
  $prepareArgs = @('scripts/prepare-dev-startup.mjs')
  if ($RuntimesOnly) { $prepareArgs += '--runtimes-only' }
  & node @prepareArgs
  if ($LASTEXITCODE -ne 0) { throw 'luckyray-development-preparation-failed: see the named stage above; Tauri was not started' }
  if ($PrepareOnly -or $RuntimesOnly) { return }
  if ($frontendStatus -eq 3) {
    $logs = Join-Path $repoRoot 'src-tauri/target/.dev-startup'
    # Raise the HTTP request-header ceiling for THIS Vite process only.
    #
    # Why: cookies are not port-scoped, so cookies issued to 127.0.0.1 by another
    # local service are also sent to Vite. A large accumulated cookie set pushes
    # the request headers past Node's 16 KiB default and Vite answers 431, which
    # breaks module loading (the canvas route is the first big dynamic import).
    #
    # Scope: passed as a node argument on this command line only. NODE_OPTIONS is
    # deliberately NOT set, so nothing propagates to LSH, the Gateway, or any
    # other child process, and no listening address changes.
    #
    # Rollback: remove this one argument (or revert this commit) and start again.
    # This is a temporary mitigation for an upstream accumulation problem, not a
    # fix for the cookie growth itself.
    $vite = Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList @('--max-http-header-size=65536','node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',"$FrontendPort",'--strictPort') -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs 'vite.out.log') -RedirectStandardError (Join-Path $logs 'vite.err.log')
    $ready = $false
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
      & node scripts/dev-frontend.mjs --status --port $FrontendPort
      if ($LASTEXITCODE -eq 0) { $ready = $true; break }
      $vite.Refresh()
      if ($vite.HasExited) { throw "luckyray-development-vite-exited: see $logs/vite.err.log (EACCES means bind denied; EADDRINUSE means another listener)" }
      Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $ready) { throw "luckyray-development-vite-timeout: see $logs/vite.err.log" }
  }
  Write-Host "[dev] preparation + frontend ready in $($startupClock.Elapsed.TotalSeconds.ToString('F2'))s; starting incremental Tauri build"
  & pnpm.cmd @tauriArgs
  if ($LASTEXITCODE -ne 0) {
    throw "luckyray-development-start-failed"
  }
} finally {
  # Never terminate a reused Vite or an unrelated process. The owned frontend
  # child only belongs to this invocation and is stopped with its dev terminal.
  if ($null -ne $vite) { $vite.Refresh(); if (-not $vite.HasExited) { $vite.Kill() } }
  if ($acquired) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
  Pop-Location
}
