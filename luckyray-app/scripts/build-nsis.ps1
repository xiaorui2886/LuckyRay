param(
  [string]$ExtensionOrigins = '',
  [switch]$LshBackgroundPreload,
  [switch]$PlanOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'release-extension-origins.ps1')
$hasExplicitOverride = $PSBoundParameters.ContainsKey('ExtensionOrigins')
if (-not $hasExplicitOverride -and (Test-Path -LiteralPath 'Env:LUCKYRAY_EXTENSION_ORIGINS')) {
  $ExtensionOrigins = [string]$env:LUCKYRAY_EXTENSION_ORIGINS
  $hasExplicitOverride = $true
}
$releaseOrigins = Resolve-LuckyRayReleaseExtensionOrigins -RepoRoot $repoRoot -Override $ExtensionOrigins -OverrideProvided:$hasExplicitOverride
$releaseFeatures = if ($LshBackgroundPreload) { 'browser-host-runtime,lsh-background-surface-preload' } else { 'browser-host-runtime' }
if ($PlanOnly) {
  [pscustomobject]@{
    schemaVersion = 1
    profile = "release"
    originSource = [string]$releaseOrigins.source
    extensionOriginCount = @($releaseOrigins.origins).Count
    originFingerprint = [string]$releaseOrigins.originFingerprint
    originConfigSha256 = [string]$releaseOrigins.configSha256
    sidecarStaging = "tauri-before-build"
    command = @("pnpm.cmd", "tauri", "build", "--bundles", "nsis", "--", "--no-default-features", "--features", $releaseFeatures, "--bin", "luckyray-app")
  } | ConvertTo-Json -Compress -Depth 4
  exit 0
}
$env:LUCKYRAY_EXTENSION_ORIGINS = [string]$releaseOrigins.effectiveOriginsCsv

# rquickjs-sys compiles QuickJS C sources whose MSVC assert macros embed the
# absolute build path (wide __FILE__) into the binary. Release artifacts must not
# carry the builder's worktree/user paths, so compile the C side with NDEBUG like
# upstream release builds; Rust paths are already remapped by the sidecar script.
foreach ($cflagName in @('CFLAGS_x86_64_pc_windows_msvc', 'CFLAGS')) {
  $current = [Environment]::GetEnvironmentVariable($cflagName)
  if ([string]::IsNullOrEmpty($current)) {
    Set-Item -Path ("Env:" + $cflagName) -Value '/DNDEBUG'
  } elseif ($current -notmatch '(^| )/DNDEBUG( |$)') {
    Set-Item -Path ("Env:" + $cflagName) -Value ($current + ' /DNDEBUG')
  }
}

$previousEncodedRustFlags = $env:CARGO_ENCODED_RUSTFLAGS
$separator = [string][char]0x1f
$sourceRoot = [IO.Path]::GetFullPath($repoRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
$userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
$releaseFlags = @('-C', 'strip=symbols', "--remap-path-prefix=$sourceRoot=.", "--remap-path-prefix=$userProfile=.") -join $separator
$env:CARGO_ENCODED_RUSTFLAGS = if ([string]::IsNullOrWhiteSpace($previousEncodedRustFlags)) {
  $releaseFlags
} else { "$previousEncodedRustFlags$separator$releaseFlags" }

Push-Location $repoRoot
try {
  # Tauri's beforeBuildCommand is the sole release staging entry. Keeping
  # sidecar preparation there prevents this NSIS wrapper from compiling a
  # second, potentially different externalBin set before packaging.
  & pnpm.cmd tauri build --bundles nsis -- --no-default-features --features $releaseFeatures --bin luckyray-app
  if ($LASTEXITCODE -ne 0) {
    throw "Tauri NSIS packaging failed"
  }
} finally {
  if ($null -eq $previousEncodedRustFlags) {
    Remove-Item Env:CARGO_ENCODED_RUSTFLAGS -ErrorAction SilentlyContinue
  } else { $env:CARGO_ENCODED_RUSTFLAGS = $previousEncodedRustFlags }
  Pop-Location
}
