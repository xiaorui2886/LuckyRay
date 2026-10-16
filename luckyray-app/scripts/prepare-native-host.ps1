param(
  [switch]$Release,
  [string]$ExtensionOrigins = "",
  [switch]$PlanOnly,
  [string]$DestinationRoot = "",
  [string[]]$SidecarNames = @()
)

$ErrorActionPreference = "Stop"

function Get-Sha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  try {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
      return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    } finally {
      $algorithm.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Assert-WindowsPe([string]$Path, [string]$Name) {
  $stream = [IO.File]::OpenRead($Path)
  try {
    if (($stream.ReadByte() -ne 0x4D) -or ($stream.ReadByte() -ne 0x5A)) {
      throw "Built sidecar is not a Windows PE file: $Name"
    }
  } finally {
    $stream.Dispose()
  }
}

function Assert-ReleaseCliHygiene([string]$Path, [string]$Repo, [string]$UserProfile) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  $ascii = [Text.Encoding]::ASCII.GetString($bytes)
  $utf16 = [Text.Encoding]::Unicode.GetString($bytes)
  foreach ($forbidden in @($Repo, $UserProfile, 'C:\Users\')) {
    if (-not [string]::IsNullOrWhiteSpace($forbidden) -and ($ascii.Contains($forbidden) -or $utf16.Contains($forbidden))) {
      throw "Release luckyray-cli contains a disallowed user or build absolute path."
    }
  }
}

function Get-CargoTargetDirectory([string]$TauriRoot) {
  $configured = [string]$env:CARGO_TARGET_DIR
  if ([string]::IsNullOrWhiteSpace($configured)) {
    return [IO.Path]::GetFullPath((Join-Path $TauriRoot 'target'))
  }
  if ([IO.Path]::IsPathRooted($configured)) {
    return [IO.Path]::GetFullPath($configured)
  }
  # Cargo resolves a relative target directory from the package working
  # directory. Mirror that behavior before constructing the fixed sidecar
  # source path, rather than silently falling back to src-tauri\\target.
  return [IO.Path]::GetFullPath((Join-Path $TauriRoot $configured))
}

function Publish-StagedFile([string]$Source, [string]$Destination) {
  if ((Test-Path -LiteralPath $Destination -PathType Leaf) -and
      (Get-Sha256 $Source) -ceq (Get-Sha256 $Destination)) {
    return (Get-Sha256 $Destination)
  }
  $stage = "$Destination.stage-$PID-$([Guid]::NewGuid().ToString('N'))"
  $backup = "$Destination.backup-$PID-$([Guid]::NewGuid().ToString('N'))"
  try {
    Copy-Item -LiteralPath $Source -Destination $stage -Force
    $sourceHash = Get-Sha256 $Source
    $stageHash = Get-Sha256 $stage
    if ($sourceHash -ne $stageHash) {
      throw "Staged sidecar hash mismatch: $(Split-Path -Leaf $Destination)"
    }
    if (Test-Path -LiteralPath $Destination -PathType Leaf) {
      [IO.File]::Replace($stage, $Destination, $backup, $true)
      Remove-Item -LiteralPath $backup -Force -ErrorAction Stop
    } else {
      [IO.File]::Move($stage, $Destination)
    }
    $destinationHash = Get-Sha256 $Destination
    if ($sourceHash -ne $destinationHash) {
      throw "Published sidecar hash mismatch: $(Split-Path -Leaf $Destination)"
    }
    return $destinationHash
  } finally {
    if (Test-Path -LiteralPath $stage -PathType Leaf) {
      Remove-Item -LiteralPath $stage -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $backup -PathType Leaf) {
      Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
    }
  }
}

function Write-CliContract([pscustomobject]$Binary, [string]$Repo, [string]$Tauri, [string]$Triple, [string]$Hardening) {
  $identityOutput = @(& $Binary.destination protocol identity)
  if ($LASTEXITCODE -ne 0) {
    throw "Built luckyray-cli did not accept the fixed protocol identity command."
  }
  $identity = ($identityOutput -join "`n") | ConvertFrom-Json
  if ($identity.ok -ne $true -or $identity.protocol -ne 'luckyray-cli-contract-v1' -or $identity.identity -notmatch '^[a-f0-9]{64}$') {
    throw "Built luckyray-cli returned an invalid protocol identity."
  }
  $contract = [ordered]@{
    schemaVersion = 1
    protocol = $identity.protocol
    identity = $identity.identity
    target = $Triple
    binarySha256 = $Binary.sha256
    sourceHead = (& git -C $Repo rev-parse HEAD).Trim()
    cargoLockSha256 = Get-Sha256 (Join-Path $Tauri 'Cargo.lock')
    profile = $Binary.profile
    hardening = $Hardening
  }
  $temporary = "$($Binary.destination).identity.stage-$PID-$([Guid]::NewGuid().ToString('N')).json"
  $destination = "$($Binary.destination).identity.json"
  if (Test-Path -LiteralPath $destination -PathType Leaf) {
    $existing = Get-Content -LiteralPath $destination -Raw | ConvertFrom-Json
    $same = $true
    foreach ($key in $contract.Keys) {
      # Keep the original build provenance when executable/contract bytes did
      # not change. A new unrelated Git commit is not a reason to recompile.
      if ($key -ne 'sourceHead' -and $existing.$key -cne $contract[$key]) { $same = $false }
    }
    if ($same) {
      $Binary | Add-Member -NotePropertyName protocol -NotePropertyValue $identity.protocol
      $Binary | Add-Member -NotePropertyName protocolIdentity -NotePropertyValue $identity.identity
      $Binary | Add-Member -NotePropertyName contract -NotePropertyValue ([pscustomobject]@{ destination = $destination; sha256 = (Get-Sha256 $destination) })
      return
    }
  }
  try {
    [IO.File]::WriteAllText(
      $temporary,
      (($contract | ConvertTo-Json -Compress) + [Environment]::NewLine),
      (New-Object System.Text.UTF8Encoding($false))
    )
    $contractHash = Publish-StagedFile $temporary $destination
    $Binary | Add-Member -NotePropertyName protocol -NotePropertyValue $identity.protocol
    $Binary | Add-Member -NotePropertyName protocolIdentity -NotePropertyValue $identity.identity
    $Binary | Add-Member -NotePropertyName contract -NotePropertyValue ([pscustomobject]@{
      destination = $destination
      sha256 = $contractHash
    })
  } finally {
    if (Test-Path -LiteralPath $temporary -PathType Leaf) {
      Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
  }
}

function Write-ReleaseOriginContract([pscustomobject[]]$Binaries, [string]$BinaryDirectory, [string]$Tauri, [string]$Triple, [pscustomobject]$Origins) {
  $expected = @('luckyray-browser-host', 'luckyray-cli', 'luckyray-mcp', 'luckyray-native-host')
  $actual = @($Binaries | ForEach-Object { [string]$_.name } | Sort-Object)
  if (@(Compare-Object -CaseSensitive -ReferenceObject $expected -DifferenceObject $actual).Count -ne 0) {
    throw 'release-sidecar-origin-contract-set-invalid'
  }
  $contract = [ordered]@{
    schemaVersion = 1
    profile = 'release'
    target = $Triple
    origins = @($Origins.origins)
    originFingerprint = [string]$Origins.originFingerprint
    canonicalConfigSha256 = [string]$Origins.configSha256
    manifestPublicKeySha256 = [string]$Origins.manifestPublicKeySha256
    cargoLockSha256 = Get-Sha256 (Join-Path $Tauri 'Cargo.lock')
    binaries = @($Binaries | Sort-Object name | ForEach-Object {
      [ordered]@{ name = [string]$_.name; sha256 = [string]$_.sha256 }
    })
  }
  $destination = Join-Path $BinaryDirectory 'luckyray-sidecars.origin.identity.json'
  $temporary = "$destination.stage-$PID-$([Guid]::NewGuid().ToString('N')).json"
  try {
    [IO.File]::WriteAllText(
      $temporary,
      (($contract | ConvertTo-Json -Compress -Depth 6) + [Environment]::NewLine),
      (New-Object System.Text.UTF8Encoding($false))
    )
    return [pscustomobject]@{ schemaVersion = 1; sha256 = Publish-StagedFile $temporary $destination }
  } finally {
    if (Test-Path -LiteralPath $temporary -PathType Leaf) {
      Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
  }
}

$repo = Split-Path -Parent $PSScriptRoot
$tauri = Join-Path $repo "src-tauri"
$cargoTargetDirectory = Get-CargoTargetDirectory $tauri
. (Join-Path $PSScriptRoot 'release-extension-origins.ps1')
$extensionOriginsExplicit = $PSBoundParameters.ContainsKey('ExtensionOrigins')
if (-not $extensionOriginsExplicit -and (Test-Path -LiteralPath 'Env:LUCKYRAY_EXTENSION_ORIGINS')) {
  $ExtensionOrigins = [string]$env:LUCKYRAY_EXTENSION_ORIGINS
  $extensionOriginsExplicit = $true
}
$profile = if ($Release) { "release" } else { "debug" }
$hardening = if ($Release) { "release-path-remap-v1" } else { "development-unhardened" }
$releaseOrigins = $null
if ($Release) {
  $releaseOrigins = Resolve-LuckyRayReleaseExtensionOrigins -RepoRoot $repo -Override $ExtensionOrigins -OverrideProvided:$extensionOriginsExplicit
  $ExtensionOrigins = [string]$releaseOrigins.effectiveOriginsCsv
  $env:LUCKYRAY_EXTENSION_ORIGINS = $ExtensionOrigins
}

$triple = ((& rustc -vV | Select-String '^host:').Line -split '\s+')[1]
$binaryDir = if ([string]::IsNullOrWhiteSpace($DestinationRoot)) {
  Join-Path $tauri "binaries"
} else {
  [IO.Path]::GetFullPath($DestinationRoot)
}
$allBinaryNames = @("luckyray-native-host", "luckyray-cli", "luckyray-mcp", "luckyray-browser-host")
$requestedSidecarNames = [Collections.Generic.List[string]]::new()
foreach ($requested in $SidecarNames) {
  foreach ($part in ([string]$requested).Split(',', [StringSplitOptions]::None)) {
    $name = $part.Trim()
    if ([string]::IsNullOrWhiteSpace($name)) {
      throw "Unknown sidecar name requested."
    }
    $requestedSidecarNames.Add($name)
  }
}
$binaryNames = if ($requestedSidecarNames.Count -eq 0) {
  $allBinaryNames
} else {
  $unique = @($requestedSidecarNames | Select-Object -Unique)
  $invalid = @($unique | Where-Object { $_ -notin $allBinaryNames })
  if ($invalid.Count -ne 0) {
    throw "Unknown sidecar name requested."
  }
  $unique
}
if ($Release -and @($binaryNames | Sort-Object).Count -ne $allBinaryNames.Count) {
  throw 'release-sidecar-origin-contract-set-invalid'
}
$binaries = @($binaryNames | ForEach-Object {
  [pscustomobject]@{
    name = $_
    profile = $profile
    source = Join-Path $cargoTargetDirectory "$profile\$_.exe"
    destination = Join-Path $binaryDir "$_-$triple.exe"
    nativeMessagingHost = ($_ -eq "luckyray-native-host")
  }
})
if ($PlanOnly) {
  [pscustomobject]@{
    profile = $profile
    triple = $triple
    destinationRoot = $binaryDir
    originSource = if ($Release) { [string]$releaseOrigins.source } else { 'debug' }
    extensionOriginCount = if ($Release) { @($releaseOrigins.origins).Count } else { 0 }
    originFingerprint = if ($Release) { [string]$releaseOrigins.originFingerprint } else { '' }
    originConfigSha256 = if ($Release) { [string]$releaseOrigins.configSha256 } else { '' }
    binaries = $binaries
  } | ConvertTo-Json -Compress -Depth 5
  exit 0
}

Push-Location $tauri
try {
  $previousTauriConfig = $env:TAURI_CONFIG
  $previousSidecarPrepare = $env:LUCKYRAY_SIDECAR_PREPARE
  $previousEncodedRustFlags = $env:CARGO_ENCODED_RUSTFLAGS
  $env:TAURI_CONFIG = '{"bundle":{"externalBin":[],"resources":[]}}'
  # The release app/package build validates the registered CLI identity. During
  # this narrowly-scoped sidecar compilation the identity record cannot exist
  # yet, so only this controlled staging process may bypass that preflight.
  $env:LUCKYRAY_SIDECAR_PREPARE = '1'
  if ($Release) {
    $separator = [string][char]0x1f
    $sourceRoot = [IO.Path]::GetFullPath($repo).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    $releaseFlags = @(
      '-C',
      'strip=symbols',
      "--remap-path-prefix=$sourceRoot=.",
      "--remap-path-prefix=$userProfile=."
    )
    $encodedReleaseFlags = $releaseFlags -join $separator
    $env:CARGO_ENCODED_RUSTFLAGS = if ([string]::IsNullOrWhiteSpace($previousEncodedRustFlags)) {
      $encodedReleaseFlags
    } else {
      "$previousEncodedRustFlags$separator$encodedReleaseFlags"
    }
    # NDEBUG keeps QuickJS C asserts (wide __FILE__) from embedding the builder's
    # absolute worktree path into the release sidecars; the hygiene check below
    # rejects exactly those paths. Idempotent when the outer script already set it.
    foreach ($cflagName in @('CFLAGS_x86_64_pc_windows_msvc', 'CFLAGS')) {
      $current = [Environment]::GetEnvironmentVariable($cflagName)
      if ([string]::IsNullOrEmpty($current)) {
        Set-Item -Path ("Env:" + $cflagName) -Value '/DNDEBUG'
      } elseif ($current -notmatch '(^| )/DNDEBUG( |$)') {
        Set-Item -Path ("Env:" + $cflagName) -Value ($current + ' /DNDEBUG')
      }
    }
  }
  New-Item -ItemType Directory -Path $binaryDir -Force | Out-Null
  $cargoArgs = @("build", "--locked", "--features", "sidecar-binaries")
  foreach ($binary in $binaries) {
    $cargoArgs += @("--bin", $binary.name)
  }
  if ($Release) { $cargoArgs += "--release" }
  & cargo @cargoArgs
  if ($LASTEXITCODE -ne 0) { throw "LuckyRay sidecar build failed." }
  foreach ($binary in $binaries) {
    if (-not (Test-Path -LiteralPath $binary.source -PathType Leaf)) {
      throw "Built sidecar is missing: $($binary.name)"
    }
    Assert-WindowsPe $binary.source $binary.name
    if ($Release -and $binary.name -eq 'luckyray-cli') {
      Assert-ReleaseCliHygiene $binary.source $repo $userProfile
    }
    $destinationHash = Publish-StagedFile $binary.source $binary.destination
    $binary | Add-Member -NotePropertyName sha256 -NotePropertyValue $destinationHash
    $binary | Add-Member -NotePropertyName size -NotePropertyValue (Get-Item -LiteralPath $binary.destination).Length
    if ($binary.name -eq 'luckyray-cli') {
      Write-CliContract $binary $repo $tauri $triple $hardening
    }
  }
  $originContract = if ($Release) {
    Write-ReleaseOriginContract $binaries $binaryDir $tauri $triple $releaseOrigins
  } else {
    $null
  }
  [pscustomobject]@{
    profile = $profile
    triple = $triple
    destinationRoot = $binaryDir
    originSource = if ($Release) { [string]$releaseOrigins.source } else { 'debug' }
    extensionOriginCount = if ($Release) { @($releaseOrigins.origins).Count } else { 0 }
    originFingerprint = if ($Release) { [string]$releaseOrigins.originFingerprint } else { '' }
    originConfigSha256 = if ($Release) { [string]$releaseOrigins.configSha256 } else { '' }
    originContract = $originContract
    binaries = $binaries
  } | ConvertTo-Json -Compress -Depth 5
} finally {
  if ($null -eq $previousTauriConfig) {
    Remove-Item Env:TAURI_CONFIG -ErrorAction SilentlyContinue
  } else {
    $env:TAURI_CONFIG = $previousTauriConfig
  }
  if ($null -eq $previousSidecarPrepare) {
    Remove-Item Env:LUCKYRAY_SIDECAR_PREPARE -ErrorAction SilentlyContinue
  } else {
    $env:LUCKYRAY_SIDECAR_PREPARE = $previousSidecarPrepare
  }
  if ($null -eq $previousEncodedRustFlags) {
    Remove-Item Env:CARGO_ENCODED_RUSTFLAGS -ErrorAction SilentlyContinue
  } else {
    $env:CARGO_ENCODED_RUSTFLAGS = $previousEncodedRustFlags
  }
  Pop-Location
}
