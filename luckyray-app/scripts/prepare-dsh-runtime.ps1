[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$NodeArchive,

  [Parameter(Mandatory = $true)]
  [string]$PnpmTarball,

  [Parameter(Mandatory = $true)]
  [string]$OfflineStore,

  [Parameter(Mandatory = $true)]
  [string]$OutputRoot,

  [switch]$ReleaseLayout
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\import-package-powershell-modules.ps1"
$repoRoot = Split-Path -Parent $PSScriptRoot
$authorityPath = Join-Path $repoRoot 'dsh-host\runtime-authority.json'
$recordsDirectory = Join-Path $repoRoot 'dsh-host\records'
$hostSource = Join-Path $repoRoot 'dsh-host'
$supplyChainScript = Join-Path $repoRoot 'scripts\dsh-supply-chain.mjs'
$publicationLock = Join-Path $repoRoot 'scripts\dsh-runtime-publication-lock.ps1'
. $publicationLock
$authority = Get-Content -Raw -LiteralPath $authorityPath | ConvertFrom-Json

function Get-DshFileSha256 {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)
  $stream = [System.IO.File]::OpenRead($LiteralPath)
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  }
  finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

function Invoke-AppOwnedNode {
  param(
    [Parameter(Mandatory = $true)][string]$NodeExe,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$PolicyRoot,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [hashtable]$EnvironmentEntries = @{}
  )

  $configHome = Join-Path $PolicyRoot 'config'
  $dataHome = Join-Path $PolicyRoot 'data'
  $cacheHome = Join-Path $PolicyRoot 'cache'
  $userHome = Join-Path $PolicyRoot 'home'
  New-Item -ItemType Directory -Path $configHome,$dataHome,$cacheHome,$userHome | Out-Null

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $process.StartInfo.FileName = $NodeExe
  $process.StartInfo.WorkingDirectory = $WorkingDirectory
  $process.StartInfo.UseShellExecute = $false
  $process.StartInfo.CreateNoWindow = $true
  $process.StartInfo.RedirectStandardOutput = $true
  $process.StartInfo.RedirectStandardError = $true
  $process.StartInfo.Environment.Clear()

  $process.StartInfo.Environment['SYSTEMROOT'] = $env:SYSTEMROOT
  $process.StartInfo.Environment['WINDIR'] = $env:WINDIR
  $process.StartInfo.Environment['COMSPEC'] = $env:COMSPEC
  $process.StartInfo.Environment['TEMP'] = $PolicyRoot
  $process.StartInfo.Environment['TMP'] = $PolicyRoot
  $process.StartInfo.Environment['PATH'] = (Split-Path -Parent $NodeExe)
  $process.StartInfo.Environment['HOME'] = $userHome
  $process.StartInfo.Environment['USERPROFILE'] = $userHome
  $process.StartInfo.Environment['APPDATA'] = $configHome
  $process.StartInfo.Environment['LOCALAPPDATA'] = $dataHome
  $process.StartInfo.Environment['XDG_CONFIG_HOME'] = $configHome
  $process.StartInfo.Environment['XDG_DATA_HOME'] = $dataHome
  $process.StartInfo.Environment['XDG_CACHE_HOME'] = $cacheHome
  $process.StartInfo.Environment['PNPM_HOME'] = (Join-Path $dataHome 'pnpm-home')
  foreach ($entry in $EnvironmentEntries.GetEnumerator()) {
    $process.StartInfo.Environment[[string]$entry.Key] = [string]$entry.Value
  }

  $argumentListProperty = $process.StartInfo.PSObject.Properties['ArgumentList']
  if ($null -ne $argumentListProperty) {
    foreach ($argument in $Arguments) {
      $process.StartInfo.ArgumentList.Add($argument)
    }
  } else {
    # Windows PowerShell 5.1 has no mutable ArgumentList. Inputs are already
    # app-owned and verified; quote each value for CommandLineToArgvW without
    # changing the hermetic child environment or policy.
    $process.StartInfo.Arguments = (($Arguments | ForEach-Object {
      '"' + ([string]$_).Replace('"','\"') + '"'
    }) -join ' ')
  }

  if (-not $process.Start()) { throw 'dsh-app-owned-node-failed' }
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  return [pscustomobject]@{
    ExitCode = $process.ExitCode
    StdOut = $stdout.Trim()
    StdErr = $stderr.Trim()
  }
}

function Invoke-HermeticPnpmInstall {
  param(
    [Parameter(Mandatory = $true)][string]$NodeExe,
    [Parameter(Mandatory = $true)][string]$SupplyChainScript,
    [Parameter(Mandatory = $true)][string]$AuthorityPath,
    [Parameter(Mandatory = $true)][string]$PnpmRoot,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$OfflineStorePath,
    [Parameter(Mandatory = $true)][string]$PolicyRoot,
    [switch]$ReleaseLayout
  )

  $installArguments = @(
    'install',
    '--offline',
    '--frozen-lockfile',
    '--ignore-scripts',
    '--ignore-pnpmfile',
    '--prod',
    '--package-import-method=copy',
    $(if ($ReleaseLayout) { '--node-linker=hoisted' } else { '--node-linker=isolated' })
  )
  if (-not $ReleaseLayout) { $installArguments += '--virtual-store-dir=node_modules/.pnpm' }
  $installArguments += @(
    '--strict-peer-dependencies=true',
    '--verify-store-integrity=true',
    '--store-dir', $OfflineStorePath
  )

  $result = Invoke-AppOwnedNode `
    -NodeExe $NodeExe `
    -WorkingDirectory $WorkingDirectory `
    -PolicyRoot $PolicyRoot `
    -EnvironmentEntries @{
      'CI' = 'true'
      'npm_config_registry' = 'http://127.0.0.1:9/'
      'npm_config_offline' = 'true'
    } `
    -Arguments (@(
      $SupplyChainScript,
      'run-pnpm',
      '--authority', $AuthorityPath,
      '--pnpm-root', $PnpmRoot,
      '--'
    ) + $installArguments)
  if ($result.ExitCode -ne 0) {
    throw 'dsh-offline-install-failed'
  }
  return $result.StdOut
}

function Invoke-DshStageAuthorityGates {
  param(
    [Parameter(Mandatory = $true)][string]$TrustedNodeExe,
    [Parameter(Mandatory = $true)][string]$StageRoot,
    [Parameter(Mandatory = $true)][string]$PolicyRoot,
    [switch]$ReleaseLayout
  )

  $verifyCommand = if ($ReleaseLayout) { 'verify-release-stage' } else { 'verify-stage' }

  $detached = Invoke-AppOwnedNode -NodeExe $TrustedNodeExe -WorkingDirectory $repoRoot -PolicyRoot (Join-Path $PolicyRoot 'detached') -Arguments @(
    $supplyChainScript, 'verify-detached', '--stage', $StageRoot
  )
  if ($detached.ExitCode -ne 0) { throw 'dsh-stage-not-detached' }
  $verified = Invoke-AppOwnedNode -NodeExe $TrustedNodeExe -WorkingDirectory $repoRoot -PolicyRoot (Join-Path $PolicyRoot 'stage') -Arguments @(
    $supplyChainScript, $verifyCommand, '--authority', $authorityPath, '--records', $recordsDirectory, '--stage', $StageRoot
  )
  if ($verified.ExitCode -ne 0) { throw 'dsh-stage-verification-failed' }
  $native = Invoke-AppOwnedNode -NodeExe $TrustedNodeExe -WorkingDirectory $repoRoot -PolicyRoot (Join-Path $PolicyRoot 'native') -Arguments @(
    $supplyChainScript, 'native-probe', '--stage', $StageRoot
  )
  if ($native.ExitCode -ne 0) { throw 'dsh-native-probe-failed' }
  $stageNode = Join-Path $StageRoot 'node\node.exe'
  $stageEntry = Join-Path $StageRoot 'host\node_modules\@deepseek-ai\dsh\lib\bin.js'
  $capability = Invoke-AppOwnedNode -NodeExe $stageNode -WorkingDirectory $StageRoot -PolicyRoot (Join-Path $PolicyRoot 'capability') -Arguments @(
    $stageEntry, '--version'
  )
  if ($capability.ExitCode -ne 0 -or $capability.StdOut -ne $authority.runtimePackage.version) {
    throw 'dsh-capability-probe-failed'
  }
  $sealedDetached = Invoke-AppOwnedNode -NodeExe $TrustedNodeExe -WorkingDirectory $repoRoot -PolicyRoot (Join-Path $PolicyRoot 'sealed-detached') -Arguments @(
    $supplyChainScript, 'verify-detached', '--stage', $StageRoot
  )
  if ($sealedDetached.ExitCode -ne 0) { throw 'dsh-stage-not-detached' }
  $sealedStage = Invoke-AppOwnedNode -NodeExe $TrustedNodeExe -WorkingDirectory $repoRoot -PolicyRoot (Join-Path $PolicyRoot 'sealed-stage') -Arguments @(
    $supplyChainScript, $verifyCommand, '--authority', $authorityPath, '--records', $recordsDirectory, '--stage', $StageRoot
  )
  if ($sealedStage.ExitCode -ne 0) { throw 'dsh-stage-verification-failed' }
  return [pscustomobject]@{
    Detached = $sealedDetached.StdOut
    Stage = $sealedStage.StdOut
    Native = $native.StdOut
    Version = $capability.StdOut
  }
}

$nodeArchivePath = (Resolve-Path -LiteralPath $NodeArchive).Path
$pnpmTarballPath = (Resolve-Path -LiteralPath $PnpmTarball).Path
$offlineStorePath = (Resolve-Path -LiteralPath $OfflineStore).Path
$outputPath = [System.IO.Path]::GetFullPath($OutputRoot)
$outputParent = Split-Path -Parent $outputPath
if (-not (Test-Path -LiteralPath $outputParent)) {
  New-Item -ItemType Directory -Path $outputParent | Out-Null
}
if (Test-Path -LiteralPath $outputPath) {
  throw 'dsh-stage-output-already-exists'
}

if ((Get-DshFileSha256 -LiteralPath $nodeArchivePath) -ne $authority.nodeRuntime.archiveSha256) {
  throw 'dsh-node-archive-invalid'
}
if ((Get-DshFileSha256 -LiteralPath $pnpmTarballPath) -ne $authority.packageManager.sha256) {
  throw 'dsh-pnpm-tarball-invalid'
}

$buildRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("luckyray-dsh0-build-{0}-{1}" -f $PID, [guid]::NewGuid().ToString('N'))
$partialPath = New-DshRuntimePublicationSiblingPath -DestinationRoot $outputPath -Kind Partial
try {
  New-Item -ItemType Directory -Path $buildRoot | Out-Null
  New-Item -ItemType Directory -Path $partialPath | Out-Null
  $nodeExtract = Join-Path $buildRoot 'node'
  $pnpmExtract = Join-Path $buildRoot 'pnpm'
  New-Item -ItemType Directory -Path $nodeExtract | Out-Null

  Expand-Archive -LiteralPath $nodeArchivePath -DestinationPath $nodeExtract

  $nodeRoot = Join-Path $nodeExtract ("node-v{0}-win-x64" -f $authority.nodeRuntime.version)
  $nodeExe = Join-Path $nodeRoot 'node.exe'
  $nodeLicense = Join-Path $nodeRoot 'LICENSE'
  if ((Get-DshFileSha256 -LiteralPath $nodeExe) -ne $authority.nodeRuntime.nodeExeSha256) {
    throw 'dsh-node-executable-invalid'
  }
  if ((Get-DshFileSha256 -LiteralPath $nodeLicense) -ne $authority.nodeRuntime.licenseSha256) {
    throw 'dsh-node-license-invalid'
  }
  $inputVerification = Invoke-AppOwnedNode -NodeExe $nodeExe -WorkingDirectory $repoRoot -PolicyRoot (Join-Path $buildRoot 'input-policy') -Arguments @(
    $supplyChainScript, 'verify-inputs', '--authority', $authorityPath, '--node-archive', $nodeArchivePath, '--pnpm-tarball', $pnpmTarballPath
  )
  if ($inputVerification.ExitCode -ne 0) { throw 'dsh-supply-input-invalid' }
  $pnpmExtraction = Invoke-AppOwnedNode -NodeExe $nodeExe -WorkingDirectory $repoRoot -PolicyRoot (Join-Path $buildRoot 'extract-policy') -Arguments @(
    $supplyChainScript, 'extract-pnpm', '--authority', $authorityPath, '--pnpm-tarball', $pnpmTarballPath, '--output', $pnpmExtract
  )
  if ($pnpmExtraction.ExitCode -ne 0) { throw 'dsh-pnpm-extract-failed' }

  $stageNode = Join-Path $partialPath 'node'
  $stageHost = Join-Path $partialPath 'host'
  New-Item -ItemType Directory -Path $stageNode | Out-Null
  New-Item -ItemType Directory -Path $stageHost | Out-Null
  Copy-Item -LiteralPath $nodeExe,$nodeLicense -Destination $stageNode
  Copy-Item -LiteralPath (Join-Path $hostSource 'package.json'),(Join-Path $hostSource '.npmrc'),(Join-Path $hostSource 'pnpm-lock.yaml'),(Join-Path $hostSource 'pnpm-workspace.yaml') -Destination $stageHost

  Invoke-HermeticPnpmInstall `
    -NodeExe $nodeExe `
    -SupplyChainScript $supplyChainScript `
    -AuthorityPath $authorityPath `
    -PnpmRoot $pnpmExtract `
    -WorkingDirectory $stageHost `
    -OfflineStorePath $offlineStorePath `
    -PolicyRoot (Join-Path $buildRoot 'pnpm-policy') `
    -ReleaseLayout:$ReleaseLayout | Out-Null

  if ($ReleaseLayout) {
    $projection = Invoke-AppOwnedNode -NodeExe $nodeExe -WorkingDirectory $repoRoot -PolicyRoot (Join-Path $buildRoot 'release-projection') -Arguments @(
      $supplyChainScript, 'project-release-stage', '--stage', $partialPath
    )
    if ($projection.ExitCode -ne 0) { throw 'dsh-release-projection-failed' }
  } else {
    $projection = Invoke-AppOwnedNode -NodeExe $nodeExe -WorkingDirectory $repoRoot -PolicyRoot (Join-Path $buildRoot 'distribution-projection') -Arguments @(
      $supplyChainScript, 'project-distribution-metadata', '--stage', $partialPath
    )
    if ($projection.ExitCode -ne 0) { throw 'dsh-distribution-projection-failed' }
  }

  $partialAuthority = Invoke-DshStageAuthorityGates -TrustedNodeExe $nodeExe -StageRoot $partialPath -PolicyRoot (Join-Path $buildRoot 'partial-authority') -ReleaseLayout:$ReleaseLayout
  Move-Item -LiteralPath $partialPath -Destination $outputPath
  if (-not $ReleaseLayout) {
    $resolverRebind = Invoke-AppOwnedNode -NodeExe $nodeExe -WorkingDirectory $repoRoot -PolicyRoot (Join-Path $buildRoot 'final-resolver-rebind') -Arguments @(
      $supplyChainScript, 'rebind-resolvers', '--authority', $authorityPath, '--records', $recordsDirectory, '--stage', $outputPath
    )
    if ($resolverRebind.ExitCode -ne 0) { throw 'dsh-final-resolver-rebind-failed' }
  }
  $finalAuthority = Invoke-DshStageAuthorityGates -TrustedNodeExe $nodeExe -StageRoot $outputPath -PolicyRoot (Join-Path $buildRoot 'final-authority') -ReleaseLayout:$ReleaseLayout
  if (
    $finalAuthority.Detached -ne $partialAuthority.Detached `
    -or $finalAuthority.Stage -ne $partialAuthority.Stage `
    -or $finalAuthority.Native -ne $partialAuthority.Native `
    -or $finalAuthority.Version -ne $partialAuthority.Version
  ) {
    throw 'dsh-final-authority-changed'
  }
  Write-Output $outputPath
}
finally {
  $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  $resolvedBuild = [System.IO.Path]::GetFullPath($buildRoot)
  if ($resolvedBuild.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedBuild).StartsWith('luckyray-dsh0-build-')) {
    if (Test-Path -LiteralPath $resolvedBuild) {
      Remove-Item -LiteralPath $resolvedBuild -Recurse -Force
    }
  }
}
