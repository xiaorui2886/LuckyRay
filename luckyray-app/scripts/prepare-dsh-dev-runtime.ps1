[CmdletBinding()]
param(
  [string]$InputRoot,
  [string]$DestinationRoot,
  [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$authorityPath = Join-Path $repoRoot 'dsh-host\runtime-authority.json'
$recordsRoot = Join-Path $repoRoot 'dsh-host\records'
$supplyChain = Join-Path $repoRoot 'scripts\dsh-supply-chain.mjs'
$prepareRuntime = Join-Path $repoRoot 'scripts\prepare-dsh-runtime.ps1'
$publicationLock = Join-Path $repoRoot 'scripts\dsh-runtime-publication-lock.ps1'
. $publicationLock
$authority = Get-Content -Raw -LiteralPath $authorityPath | ConvertFrom-Json
$expectedNodeHash = [string]$authority.nodeRuntime.nodeExeSha256
$expectedVersion = [string]$authority.runtimePackage.version

if (-not $DestinationRoot) {
  $DestinationRoot = Join-Path $repoRoot 'src-tauri\target\debug\lr-lsh\199-1\deepseek-harness'
}
if (-not $InputRoot) {
  $InputRoot = Join-Path $env:LOCALAPPDATA ("LuckyRay\verified-runtime-cache\inputs\{0}" -f $expectedVersion)
}
$destination = [System.IO.Path]::GetFullPath($DestinationRoot)
$inputs = [System.IO.Path]::GetFullPath($InputRoot)
$generatedRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot 'src-tauri\target'))
$generatedPrefix = $generatedRoot.TrimEnd('\') + '\'
if (-not $destination.StartsWith($generatedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'dsh-dev-runtime-output-outside-generated-root'
}

function Get-FileSha256 {
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

function Invoke-TrustedNode {
  param(
    [Parameter(Mandatory = $true)][string]$NodeExe,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$PolicyLabel
  )
  $policyRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
    'luckyray-dsh-dev-policy-{0}-{1}-{2}' -f $PID,$PolicyLabel,[guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $policyRoot | Out-Null
  try {
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $process.StartInfo.FileName = $NodeExe
    $process.StartInfo.WorkingDirectory = $repoRoot
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    $process.StartInfo.Environment.Clear()
    foreach ($name in 'SYSTEMROOT','WINDIR','COMSPEC') {
      $value = [Environment]::GetEnvironmentVariable($name)
      if ($value) { $process.StartInfo.Environment[$name] = $value }
    }
    $process.StartInfo.Environment['TEMP'] = $policyRoot
    $process.StartInfo.Environment['TMP'] = $policyRoot
    $process.StartInfo.Environment['HOME'] = $policyRoot
    $process.StartInfo.Environment['USERPROFILE'] = $policyRoot
    $process.StartInfo.Environment['APPDATA'] = $policyRoot
    $process.StartInfo.Environment['LOCALAPPDATA'] = $policyRoot
    $process.StartInfo.Environment['PATH'] = (Split-Path -Parent $NodeExe)
    if ($null -ne $process.StartInfo.ArgumentList) {
      foreach ($argument in $Arguments) { $process.StartInfo.ArgumentList.Add($argument) }
    } else {
      $process.StartInfo.Arguments = (($Arguments | ForEach-Object {
        '"' + ([string]$_).Replace('"','\"') + '"'
      }) -join ' ')
    }
    if (-not $process.Start()) { throw 'dsh-dev-runtime-verifier-start-failed' }
    $stdout = $process.StandardOutput.ReadToEnd().Trim()
    $stderr = $process.StandardError.ReadToEnd().Trim()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
      $safeCode = if ($stderr -match '\A[a-z0-9-]+\z') { $stderr } else { 'unknown' }
      throw "dsh-dev-runtime-verifier-failed:${PolicyLabel}:$safeCode"
    }
    return $stdout
  }
  finally {
    if (Test-Path -LiteralPath $policyRoot) {
      Remove-Item -LiteralPath $policyRoot -Recurse -Force
    }
  }
}

function Test-VerifiedRuntime {
  param([Parameter(Mandatory = $true)][string]$Root)
  try {
    $canonical = (Resolve-Path -LiteralPath $Root).Path
    $nodeExe = Join-Path $canonical 'node\node.exe'
    $entry = Join-Path $canonical 'host\node_modules\@deepseek-ai\dsh\lib\bin.js'
    if (-not (Test-Path -LiteralPath $nodeExe -PathType Leaf) -or
        -not (Test-Path -LiteralPath $entry -PathType Leaf)) { return $false }
    if ((Get-FileSha256 -LiteralPath $nodeExe) -ne $expectedNodeHash) {
      return $false
    }
    Invoke-TrustedNode -NodeExe $nodeExe -PolicyLabel 'detached' -Arguments @(
      $supplyChain,'verify-detached','--stage',$canonical) | Out-Null
    # The dev startup cache refuses reparse points. The isolated pnpm layout
    # may be a valid DSH stage, but it cannot be a reusable debug output.
    # Reject it here so the publication lock quarantines and replaces it with
    # the same verified, link-free release projection used for bundled DSH.
    Invoke-TrustedNode -NodeExe $nodeExe -PolicyLabel 'stage' -Arguments @(
      $supplyChain,'verify-release-stage','--authority',$authorityPath,'--records',$recordsRoot,'--stage',$canonical) | Out-Null
    Invoke-TrustedNode -NodeExe $nodeExe -PolicyLabel 'native' -Arguments @(
      $supplyChain,'native-probe','--stage',$canonical) | Out-Null
    $version = Invoke-TrustedNode -NodeExe $nodeExe -PolicyLabel 'version' -Arguments @($entry,'--version')
    return $version -eq $expectedVersion
  }
  catch {
    Write-Host "[dsh-dev] validation failed: $($_.Exception.Message)"
    return $false
  }
}

$validateRuntime = {
  param([string]$Root)
  Test-VerifiedRuntime -Root $Root
}
$publishRuntime = {
  param([string]$Root)
  $nodeArchive = Join-Path $inputs 'node-v22.19.0-win-x64.zip'
  $pnpmTarball = Join-Path $inputs 'pnpm-11.7.0.tgz'
  $offlineStore = Join-Path $inputs 'offline-store'
  if (-not (Test-Path -LiteralPath $nodeArchive -PathType Leaf) -or
      -not (Test-Path -LiteralPath $pnpmTarball -PathType Leaf) -or
      -not (Test-Path -LiteralPath $offlineStore -PathType Container)) {
    throw 'dsh-dev-runtime-input-cache-unavailable'
  }
  if ((Get-FileSha256 -LiteralPath $nodeArchive) -ne
      [string]$authority.nodeRuntime.archiveSha256 -or
      (Get-FileSha256 -LiteralPath $pnpmTarball) -ne
      [string]$authority.packageManager.sha256) {
    throw 'dsh-dev-runtime-input-cache-invalid'
  }

  & $prepareRuntime -NodeArchive $nodeArchive -PnpmTarball $pnpmTarball `
    -OfflineStore $offlineStore -OutputRoot $Root -ReleaseLayout | Out-Null
}

if ($ValidateOnly) {
  if (-not (Test-VerifiedRuntime -Root $destination)) { throw 'dsh-dev-runtime-validation-failed-no-files-changed' }
  Write-Output 'dsh-dev-runtime-valid'
  return
}

Invoke-DshRuntimePublication -DestinationRoot $destination `
  -ValidateRuntime $validateRuntime -PublishRuntime $publishRuntime
