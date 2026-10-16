[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$ScratchRoot)
# Engineering reproducibility test, NOT an end-user installation entry point.
# Only a newly created scratch root is accepted. Never consumes a machine store.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\import-package-powershell-modules.ps1"
Set-StrictMode -Version Latest
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$root = [IO.Path]::GetFullPath($ScratchRoot)
if (Test-Path -LiteralPath $root) { throw 'clean-assembly-root-must-not-exist' }
if ((Split-Path -Leaf $root) -notmatch '^luckyray-dsh-clean-[a-zA-Z0-9-]+$') {
  throw 'clean-assembly-root-name-invalid'
}
New-Item -ItemType Directory -Path $root | Out-Null
$authorityFile = Join-Path $repo 'dsh-host\runtime-authority.json'
$authority = Get-Content -Raw -LiteralPath $authorityFile | ConvertFrom-Json
$chain = Join-Path $repo 'scripts\dsh-supply-chain.mjs'
$cache = Join-Path $root 'cache'
$inputs = Join-Path $cache 'inputs'
$store = Join-Path $cache 'offline-store'
New-Item -ItemType Directory -Path $inputs,$store | Out-Null

function Save-TestInput([string]$Uri, [string]$Destination, [string]$Hash) {
  $allowed = @('nodejs.org','registry.npmjs.org')
  $parsed = [uri]$Uri
  if ($parsed.Scheme -cne 'https' -or $parsed.Host -notin $allowed -or $parsed.Query -or $parsed.UserInfo) {
    throw 'clean-assembly-input-origin-invalid'
  }
  Invoke-WebRequest -UseBasicParsing -Uri $Uri -MaximumRedirection 0 -TimeoutSec 180 -OutFile $Destination
  if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Hash) {
    throw 'clean-assembly-input-hash-invalid'
  }
  Write-Output ("input-verified {0} bytes={1}" -f (Split-Path -Leaf $Destination),(Get-Item -LiteralPath $Destination).Length)
}

function Invoke-TestNode([string]$Node, [string]$Working, [string]$Label, [string[]]$Arguments, [bool]$Online = $false) {
  $policy = Join-Path $root $Label
  $policyHome = Join-Path $policy 'home'
  $config = Join-Path $policy 'config'
  $data = Join-Path $policy 'data'
  $temp = Join-Path $policy 'temp'
  New-Item -ItemType Directory -Path $policyHome,$config,$data,$temp | Out-Null
  $process = [Diagnostics.Process]::new()
  $process.StartInfo.FileName = $Node
  $process.StartInfo.WorkingDirectory = $Working
  $process.StartInfo.UseShellExecute = $false
  $process.StartInfo.CreateNoWindow = $true
  $process.StartInfo.RedirectStandardOutput = $true
  $process.StartInfo.RedirectStandardError = $true
  $process.StartInfo.Environment.Clear()
  foreach ($environmentName in @('SYSTEMROOT','WINDIR','COMSPEC')) {
    $value = [Environment]::GetEnvironmentVariable($environmentName)
    if ($value) { $process.StartInfo.Environment[$environmentName] = $value }
  }
  $process.StartInfo.Environment['PATH'] = Split-Path -Parent $Node
  $process.StartInfo.Environment['TEMP'] = $temp
  $process.StartInfo.Environment['TMP'] = $temp
  $process.StartInfo.Environment['HOME'] = $policyHome
  $process.StartInfo.Environment['USERPROFILE'] = $policyHome
  $process.StartInfo.Environment['APPDATA'] = $config
  $process.StartInfo.Environment['LOCALAPPDATA'] = $data
  $process.StartInfo.Environment['XDG_CONFIG_HOME'] = $config
  $process.StartInfo.Environment['XDG_DATA_HOME'] = $data
  $process.StartInfo.Environment['XDG_CACHE_HOME'] = (Join-Path $policy 'cache')
  $process.StartInfo.Environment['PNPM_HOME'] = (Join-Path $data 'pnpm-home')
  $process.StartInfo.Environment['CI'] = 'true'
  $process.StartInfo.Environment['npm_config_registry'] = $(if ($Online) { 'https://registry.npmjs.org/' } else { 'http://127.0.0.1:9/' })
  $process.StartInfo.Arguments = (($Arguments | ForEach-Object { '"' + ([string]$_).Replace('"','\"') + '"' }) -join ' ')
  if (-not $process.Start()) { throw 'clean-assembly-child-start-failed' }
  # Drain both pipes concurrently; retain exact diagnostic output in scratch only.
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  $process.WaitForExit()
  $stdout.GetAwaiter().GetResult() | Out-File -LiteralPath (Join-Path $root "$Label.stdout.log") -Encoding utf8
  $stderr.GetAwaiter().GetResult() | Out-File -LiteralPath (Join-Path $root "$Label.stderr.log") -Encoding utf8
  if ($process.ExitCode -ne 0) { throw "clean-assembly-child-failed:$Label" }
  Write-Output "child-passed $Label"
  $process.Dispose()
}

$nodeArchive = Join-Path $inputs 'node-v22.19.0-win-x64.zip'
$pnpmArchive = Join-Path $inputs 'pnpm-11.7.0.tgz'
Save-TestInput ([string]$authority.nodeRuntime.archive) $nodeArchive ([string]$authority.nodeRuntime.archiveSha256)
Save-TestInput ([string]$authority.packageManager.tarball) $pnpmArchive ([string]$authority.packageManager.sha256)
$nodeExtract = Join-Path $root 'bootstrap-node'
Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeExtract
$node = Join-Path $nodeExtract 'node-v22.19.0-win-x64\node.exe'
if ((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$authority.nodeRuntime.nodeExeSha256) {
  throw 'clean-assembly-node-invalid'
}
$pnpm = Join-Path $root 'bootstrap-pnpm'
Invoke-TestNode $node $repo 'extract' @($chain,'extract-pnpm','--authority',$authorityFile,'--pnpm-tarball',$pnpmArchive,'--output',$pnpm)
$fetchProject = Join-Path $root 'fetch-project'
New-Item -ItemType Directory -Path $fetchProject | Out-Null
foreach ($name in @('package.json','.npmrc','pnpm-lock.yaml','pnpm-workspace.yaml')) {
  Copy-Item -LiteralPath (Join-Path $repo "dsh-host\$name") -Destination $fetchProject
}
Invoke-TestNode $node $fetchProject 'empty-cache-fetch' @(
  $chain,'run-pnpm','--authority',$authorityFile,'--pnpm-root',$pnpm,'--',
  'fetch','--frozen-lockfile','--ignore-scripts','--ignore-pnpmfile','--prod',
  '--strict-peer-dependencies=true','--verify-store-integrity=true','--store-dir',$store
) $true

$stages = @()
foreach ($label in @('a','b')) {
  $stage = Join-Path $root "stage-$label"
  $timer = [Diagnostics.Stopwatch]::StartNew()
  & (Join-Path $PSScriptRoot 'prepare-dsh-runtime.ps1') -NodeArchive $nodeArchive -PnpmTarball $pnpmArchive -OfflineStore $store -OutputRoot $stage -ReleaseLayout
  $timer.Stop()
  Invoke-TestNode $node $repo "stage-$label-authority" @($chain,'verify-release-stage','--authority',$authorityFile,'--records',(Join-Path $repo 'dsh-host\records'),'--stage',$stage)
  Invoke-TestNode $node $repo "stage-$label-native" @($chain,'native-probe','--stage',$stage)
  $stages += [ordered]@{ label=$label; milliseconds=$timer.ElapsedMilliseconds; authority='passed'; native='passed' }
}
[ordered]@{
  outcome='CLEAN_OFFICIAL_FROZEN_ASSEMBLY'; runtime='0.1.7-rc.2'
  cacheInitiallyEmpty=$true; acquisition='official-node-and-npm-frozen-fetch'
  storeCopiedFromMachine=$false; offlineAssemblyRoots=2
  completeBaselineSealMatched=$true; stages=$stages
  clientInstallerImplemented=$false; rustHostTest='pending-build-window'
} | ConvertTo-Json -Depth 5
