[CmdletBinding()]
param(
  [string]$OutputRoot = '',
  [string]$CacheRoot = '',
  [switch]$PlanOnly
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\import-package-powershell-modules.ps1"
Set-StrictMode -Version Latest

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tauriRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'src-tauri'))
$authorityPath = Join-Path $repoRoot 'dsh-host\runtime-authority.json'
$hostRoot = Join-Path $repoRoot 'dsh-host'
$supplyChain = Join-Path $PSScriptRoot 'dsh-supply-chain.mjs'
$prepareRuntime = Join-Path $PSScriptRoot 'prepare-dsh-runtime.ps1'
$authority = Get-Content -Raw -LiteralPath $authorityPath | ConvertFrom-Json

if (-not $OutputRoot) { $OutputRoot = Join-Path $tauriRoot 'dsh' }
$outputPath = [IO.Path]::GetFullPath($OutputRoot)
if ((Split-Path -Parent $outputPath) -cne $tauriRoot -or (Split-Path -Leaf $outputPath) -cne 'dsh') {
  throw 'dsh-package-output-outside-workspace'
}

if ($PlanOnly) {
  [pscustomobject]@{
    schemaVersion = 1
    runtimeOwner = 'dsh-host'
    outputRoot = $outputPath
    runtimePackage = [string]$authority.runtimePackage.version
    node = [string]$authority.nodeRuntime.version
    nodeArchiveSha256 = [string]$authority.nodeRuntime.archiveSha256
    pnpm = [string]$authority.packageManager.version
    pnpmTarballSha256 = [string]$authority.packageManager.sha256
    dependencyLockSha256 = [string]$authority.dependencyClosure.sha256
    offlineStage = $true
    installScripts = $false
    releaseLayout = [ordered]@{
      nodeLinker = 'hoisted'
      packageImportMethod = 'copy'
      reparsePoints = 0
      fixedEntryPoint = 'host/node_modules/@deepseek-ai/dsh/lib/bin.js'
    }
  } | ConvertTo-Json -Compress
  exit 0
}

function Get-DshPackageSha256([string]$LiteralPath) {
  $stream = [IO.File]::OpenRead($LiteralPath)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }
  finally { $sha.Dispose(); $stream.Dispose() }
}

function Save-VerifiedDownload([string]$Uri, [string]$Destination, [string]$ExpectedHash) {
  if ((Test-Path -LiteralPath $Destination -PathType Leaf) -and
      (Get-DshPackageSha256 $Destination) -ceq $ExpectedHash) { return }
  $partial = "$Destination.partial.$([guid]::NewGuid().ToString('N'))"
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $partial
    if ((Get-DshPackageSha256 $partial) -cne $ExpectedHash) { throw 'dsh-package-download-hash-invalid' }
    Move-Item -LiteralPath $partial -Destination $Destination -Force
  } finally {
    if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
  }
}

function Invoke-IsolatedNode(
  [string]$NodeExe,
  [string]$WorkingDirectory,
  [string]$PolicyRoot,
  [string[]]$Arguments,
  [hashtable]$EnvironmentEntries = @{}
) {
  $config = Join-Path $PolicyRoot 'config'
  $data = Join-Path $PolicyRoot 'data'
  $policyHome = Join-Path $PolicyRoot 'home'
  $temp = Join-Path $PolicyRoot 'temp'
  New-Item -ItemType Directory -Force -Path $config,$data,$policyHome,$temp | Out-Null
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = [Diagnostics.ProcessStartInfo]::new()
  $process.StartInfo.FileName = $NodeExe
  $process.StartInfo.WorkingDirectory = $WorkingDirectory
  $process.StartInfo.UseShellExecute = $false
  $process.StartInfo.CreateNoWindow = $true
  $process.StartInfo.RedirectStandardOutput = $true
  $process.StartInfo.RedirectStandardError = $true
  $process.StartInfo.Environment.Clear()
  foreach ($name in @('SYSTEMROOT','WINDIR','COMSPEC')) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($value) { $process.StartInfo.Environment[$name] = $value }
  }
  $process.StartInfo.Environment['PATH'] = Split-Path -Parent $NodeExe
  $process.StartInfo.Environment['TEMP'] = $temp
  $process.StartInfo.Environment['TMP'] = $temp
  $process.StartInfo.Environment['HOME'] = $policyHome
  $process.StartInfo.Environment['USERPROFILE'] = $policyHome
  $process.StartInfo.Environment['APPDATA'] = $config
  $process.StartInfo.Environment['LOCALAPPDATA'] = $data
  $process.StartInfo.Environment['XDG_CONFIG_HOME'] = $config
  $process.StartInfo.Environment['XDG_DATA_HOME'] = $data
  $process.StartInfo.Environment['XDG_CACHE_HOME'] = (Join-Path $PolicyRoot 'cache')
  $process.StartInfo.Environment['PNPM_HOME'] = (Join-Path $data 'pnpm-home')
  foreach ($entry in $EnvironmentEntries.GetEnumerator()) {
    $process.StartInfo.Environment[[string]$entry.Key] = [string]$entry.Value
  }
  $argumentListProperty = $process.StartInfo.PSObject.Properties['ArgumentList']
  if ($null -ne $argumentListProperty) {
    foreach ($argument in $Arguments) { $process.StartInfo.ArgumentList.Add($argument) }
  } else {
    $process.StartInfo.Arguments = (($Arguments | ForEach-Object {
      '"' + ([string]$_).Replace('"','\"') + '"'
    }) -join ' ')
  }
  if (-not $process.Start()) { throw 'dsh-package-node-start-failed' }
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) {
    $safeCode = if ($stderr.Trim() -match '\A[a-z0-9-]+\z') { $stderr.Trim() } else { 'child-failed' }
    throw "dsh-package-node-failed:$safeCode"
  }
  return $stdout.Trim()
}

function Test-DshPackageRuntime([string]$Root) {
  try {
    $node = Join-Path $Root 'node\node.exe'
    $entry = Join-Path $Root 'host\node_modules\@deepseek-ai\dsh\lib\bin.js'
    if (-not (Test-Path -LiteralPath $node -PathType Leaf) -or
        -not (Test-Path -LiteralPath $entry -PathType Leaf) -or
        (Get-DshPackageSha256 $node) -cne [string]$authority.nodeRuntime.nodeExeSha256) { return $false }
    $policy = Join-Path ([IO.Path]::GetTempPath()) ("luckyray-dsh-package-verify-$PID-$([guid]::NewGuid().ToString('N'))")
    try {
      Invoke-IsolatedNode $node $repoRoot $policy @(
        $supplyChain,'verify-release-stage','--authority',$authorityPath,'--records',(Join-Path $hostRoot 'records'),'--stage',$Root
      ) | Out-Null
      Invoke-IsolatedNode $node $repoRoot (Join-Path $policy 'native') @(
        $supplyChain,'native-probe','--stage',$Root
      ) | Out-Null
      $version = Invoke-IsolatedNode $node $Root (Join-Path $policy 'version') @($entry,'--version')
      return $version -ceq [string]$authority.runtimePackage.version
    } finally {
      if (Test-Path -LiteralPath $policy) { Remove-Item -LiteralPath $policy -Recurse -Force }
    }
  } catch { return $false }
}

if (Test-Path -LiteralPath $outputPath) {
  if (-not (Test-DshPackageRuntime $outputPath)) { throw 'dsh-package-existing-runtime-invalid' }
  Write-Output 'dsh-package-runtime-ready'
  exit 0
}

if (-not $CacheRoot) {
  $cacheIdentity = '{0}-{1}-{2}' -f $authority.runtimePackage.version,
    ([string]$authority.nodeRuntime.archiveSha256).Substring(0,12),
    ([string]$authority.packageManager.sha256).Substring(0,12)
  $CacheRoot = Join-Path ([IO.Path]::GetTempPath()) (Join-Path 'luckyray-package-cache\dsh' $cacheIdentity)
}
$cachePath = [IO.Path]::GetFullPath($CacheRoot)
$inputs = Join-Path $cachePath 'inputs'
$offlineStore = Join-Path $cachePath 'offline-store'
New-Item -ItemType Directory -Force -Path $inputs,$offlineStore | Out-Null
$nodeArchive = Join-Path $inputs (Split-Path -Leaf ([uri][string]$authority.nodeRuntime.archive).AbsolutePath)
$pnpmTarball = Join-Path $inputs (Split-Path -Leaf ([uri][string]$authority.packageManager.tarball).AbsolutePath)
Save-VerifiedDownload ([string]$authority.nodeRuntime.archive) $nodeArchive ([string]$authority.nodeRuntime.archiveSha256)
Save-VerifiedDownload ([string]$authority.packageManager.tarball) $pnpmTarball ([string]$authority.packageManager.sha256)

$bootstrap = Join-Path ([IO.Path]::GetTempPath()) ("luckyray-dsh-package-bootstrap-$PID-$([guid]::NewGuid().ToString('N'))")
try {
  $nodeExtract = Join-Path $bootstrap 'node'
  $pnpmExtract = Join-Path $bootstrap 'pnpm'
  New-Item -ItemType Directory -Force -Path $nodeExtract | Out-Null
  Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeExtract
  $nodeExe = Join-Path $nodeExtract ("node-v{0}-win-x64\node.exe" -f $authority.nodeRuntime.version)
  if ((Get-DshPackageSha256 $nodeExe) -cne [string]$authority.nodeRuntime.nodeExeSha256) {
    throw 'dsh-package-node-executable-invalid'
  }
  Invoke-IsolatedNode $nodeExe $repoRoot (Join-Path $bootstrap 'extract-policy') @(
    $supplyChain,'extract-pnpm','--authority',$authorityPath,'--pnpm-tarball',$pnpmTarball,'--output',$pnpmExtract
  ) | Out-Null
  Invoke-IsolatedNode $nodeExe $hostRoot (Join-Path $bootstrap 'fetch-policy') @(
    $supplyChain,'run-pnpm','--authority',$authorityPath,'--pnpm-root',$pnpmExtract,'--',
    'fetch','--frozen-lockfile','--ignore-scripts','--ignore-pnpmfile','--prod',
    '--strict-peer-dependencies=true','--verify-store-integrity=true','--store-dir',$offlineStore
  ) @{
    'CI' = 'true'
    'npm_config_registry' = 'https://registry.npmjs.org/'
  } | Out-Null

  & $prepareRuntime -NodeArchive $nodeArchive -PnpmTarball $pnpmTarball -OfflineStore $offlineStore -OutputRoot $outputPath -ReleaseLayout | Out-Null
  if (-not (Test-DshPackageRuntime $outputPath)) { throw 'dsh-package-runtime-verification-failed' }
  Write-Output 'dsh-package-runtime-prepared'
} finally {
  if (Test-Path -LiteralPath $bootstrap) { Remove-Item -LiteralPath $bootstrap -Recurse -Force }
}
