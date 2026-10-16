[CmdletBinding()]
param(
  [switch]$PlanOnly
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\import-package-powershell-modules.ps1"
Set-StrictMode -Version Latest

function Get-ConfiguredExternalBinNames([string]$ConfigPath) {
  try {
    $config = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
  } catch {
    throw "tauri-external-bin-config-invalid"
  }

  $configured = @($config.bundle.externalBin)
  if ($configured.Count -eq 0) {
    throw "tauri-external-bin-config-empty"
  }

  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  $names = [Collections.Generic.List[string]]::new()
  foreach ($entry in $configured) {
    $relative = ([string]$entry).Replace("\", "/")
    if ($relative -notmatch '^binaries/([a-z0-9][a-z0-9-]*)$') {
      throw "tauri-external-bin-config-invalid"
    }
    $name = $Matches[1]
    if (-not $seen.Add($name)) {
      throw "tauri-external-bin-config-duplicate"
    }
    $names.Add($name)
  }
  return @($names.ToArray())
}

function Assert-PreparedReleaseSidecars([object]$Prepared, [string[]]$ExpectedNames) {
  if ([string]$Prepared.profile -cne "release") {
    throw "tauri-release-sidecar-profile-invalid"
  }
  $binaries = @($Prepared.binaries)
  if ($binaries.Count -ne $ExpectedNames.Count) {
    throw "tauri-release-sidecar-set-invalid"
  }
  $actualNames = @($binaries | ForEach-Object { [string]$_.name })
  if (@(Compare-Object -CaseSensitive -ReferenceObject $ExpectedNames -DifferenceObject $actualNames).Count -ne 0) {
    throw "tauri-release-sidecar-set-invalid"
  }
  foreach ($binary in $binaries) {
    $destination = [string]$binary.destination
    if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) {
      throw "tauri-release-sidecar-missing"
    }
    $stream = [IO.File]::OpenRead($destination)
    try {
      if (($stream.ReadByte() -ne 0x4D) -or ($stream.ReadByte() -ne 0x5A)) {
        throw "tauri-release-sidecar-invalid"
      }
    } finally {
      $stream.Dispose()
    }
    if ([string]$binary.name -ceq "luckyray-cli" -and
        -not (Test-Path -LiteralPath "$destination.identity.json" -PathType Leaf)) {
      throw "tauri-release-cli-contract-missing"
    }
  }
  if ($null -eq $Prepared.originContract -or [string]$Prepared.originContract.sha256 -notmatch '\A[0-9a-f]{64}\z') {
    throw "tauri-release-sidecar-origin-contract-missing"
  }
}

function Remove-ReleaseSidecarIntermediates([object]$Prepared, [string]$RepoRoot) {
  $releaseRoot = [IO.Path]::GetFullPath((Join-Path $RepoRoot "src-tauri\target\release"))
  $releasePrefix = $releaseRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  foreach ($binary in @($Prepared.binaries)) {
    $name = [string]$binary.name
    $source = [IO.Path]::GetFullPath([string]$binary.source)
    $expectedFileName = "$name.exe"
    if ([IO.Path]::GetFileName($source) -cne $expectedFileName) {
      throw "tauri-release-sidecar-intermediate-invalid"
    }
    if (-not $source.StartsWith($releasePrefix, [StringComparison]::OrdinalIgnoreCase)) {
      # A caller may intentionally set CARGO_TARGET_DIR outside the repository.
      # Those intermediates are not discoverable from the repository's default
      # release target, and this build entry must never delete an external cache.
      continue
    }
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
      throw "tauri-release-sidecar-intermediate-missing"
    }
    # Tauri may otherwise discover these Cargo intermediates in addition to the
    # explicitly registered externalBin resources. Only the exact staged
    # sidecars inside this repository's release target are eligible for removal.
    Remove-Item -LiteralPath $source -Force -ErrorAction Stop
  }
}

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$tauriConfig = Join-Path $repoRoot "src-tauri\tauri.conf.json"
$readiness = Join-Path $PSScriptRoot "assert-package-readiness.ps1"
$mediaPrepare = Join-Path $PSScriptRoot "prepare-media-engine.ps1"
$dshPrepare = Join-Path $PSScriptRoot "prepare-dsh-package-runtime.ps1"
$sidecarPrepare = Join-Path $PSScriptRoot "prepare-native-host.ps1"
. (Join-Path $PSScriptRoot 'release-extension-origins.ps1')
$hasExplicitOverride = Test-Path -LiteralPath 'Env:LUCKYRAY_EXTENSION_ORIGINS'
$explicitOverride = if ($hasExplicitOverride) { [string]$env:LUCKYRAY_EXTENSION_ORIGINS } else { '' }
$releaseOrigins = Resolve-LuckyRayReleaseExtensionOrigins -RepoRoot $repoRoot -Override $explicitOverride -OverrideProvided:$hasExplicitOverride
$extensionOrigins = [string]$releaseOrigins.effectiveOriginsCsv
$sidecarNames = @(Get-ConfiguredExternalBinNames $tauriConfig)

$plan = [ordered]@{
  schemaVersion = 1
  profile = "release"
  originSource = [string]$releaseOrigins.source
  extensionOriginCount = @($releaseOrigins.origins).Count
  originFingerprint = [string]$releaseOrigins.originFingerprint
  originConfigSha256 = [string]$releaseOrigins.configSha256
  sidecarNames = $sidecarNames
  steps = @(
    [ordered]@{ name = "readiness-inputs"; script = "scripts/assert-package-readiness.ps1"; phase = "Inputs" },
    [ordered]@{ name = "media-engine"; script = "scripts/prepare-media-engine.ps1" },
    [ordered]@{ name = "dsh-runtime"; script = "scripts/prepare-dsh-package-runtime.ps1"; output = "src-tauri/dsh" },
    [ordered]@{ name = "external-bins"; script = "scripts/prepare-native-host.ps1"; release = $true; sidecarNames = $sidecarNames },
    [ordered]@{ name = "frontend"; command = @("pnpm.cmd", "build") },
    [ordered]@{ name = "readiness-prepared"; script = "scripts/assert-package-readiness.ps1"; phase = "Prepared" }
  )
}
if ($PlanOnly) {
  $plan | ConvertTo-Json -Compress -Depth 8
  exit 0
}

# This is intentionally the only production Tauri before-build sequence. It
# never invokes `pnpm tauri build`, so the Tauri CLI cannot recursively enter
# its own beforeBuildCommand.
& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $readiness -Phase Inputs
if ($LASTEXITCODE -ne 0) {
  throw "release package input readiness failed"
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $mediaPrepare
if ($LASTEXITCODE -ne 0) {
  throw "release media engine preparation failed"
}

& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $dshPrepare
if ($LASTEXITCODE -ne 0) {
  throw "release DSH runtime preparation failed"
}

$sidecarArgument = $sidecarNames -join ','
$prepareOutput = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $sidecarPrepare -Release -ExtensionOrigins $extensionOrigins -SidecarNames $sidecarArgument)
if ($LASTEXITCODE -ne 0) {
  throw "release sidecar preparation failed"
}
$preparedJson = @($prepareOutput | Where-Object { ([string]$_).TrimStart().StartsWith("{") } | Select-Object -Last 1)
if ($preparedJson.Count -ne 1) {
  throw "release sidecar preparation returned no product manifest"
}
try {
  $prepared = $preparedJson[0] | ConvertFrom-Json
} catch {
  throw "release sidecar preparation returned an invalid product manifest"
}
Assert-PreparedReleaseSidecars $prepared $sidecarNames
Remove-ReleaseSidecarIntermediates $prepared $repoRoot

Push-Location $repoRoot
try {
  & pnpm.cmd build
  if ($LASTEXITCODE -ne 0) {
    throw "frontend build failed"
  }
} finally {
  Pop-Location
}

& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $readiness -Phase Prepared
if ($LASTEXITCODE -ne 0) {
  throw "release package prepared readiness failed"
}

[pscustomobject]@{
  profile = "release"
  sidecarNames = $sidecarNames
  frontend = "built"
} | ConvertTo-Json -Compress -Depth 4
