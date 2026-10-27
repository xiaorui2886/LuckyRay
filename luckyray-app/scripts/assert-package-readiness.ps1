[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Inputs', 'Prepared')]
  [string]$Phase
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\import-package-powershell-modules.ps1"
Set-StrictMode -Version Latest

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tauriRoot = Join-Path $repoRoot 'src-tauri'
$tauriConfigPath = Join-Path $tauriRoot 'tauri.conf.json'
$packagePath = Join-Path $repoRoot 'package.json'
$cargoPath = Join-Path $tauriRoot 'Cargo.toml'
$authorityPath = Join-Path $repoRoot 'dsh-host\runtime-authority.json'

function Assert-File([string]$LiteralPath, [string]$Code) {
  if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf)) { throw $Code }
}

function Invoke-CheckedVersion([string]$Command, [string[]]$Arguments, [string]$Code) {
  $output = @(& $Command @Arguments 2>&1)
  if ($LASTEXITCODE -ne 0) { throw $Code }
  return ($output -join "`n").Trim()
}

foreach ($command in @('powershell.exe','node.exe','pnpm.cmd','cargo.exe','rustc.exe','rustup.exe')) {
  Get-Command $command -CommandType Application -ErrorAction Stop | Out-Null
}

$package = Get-Content -Raw -LiteralPath $packagePath | ConvertFrom-Json
$tauri = Get-Content -Raw -LiteralPath $tauriConfigPath | ConvertFrom-Json
$cargoVersion = [regex]::Match((Get-Content -Raw -LiteralPath $cargoPath), '(?m)^version = "([^"]+)"\r?$').Groups[1].Value
if (-not $cargoVersion -or [string]$package.version -cne [string]$tauri.version -or
    [string]$package.version -cne $cargoVersion) {
  throw 'package-version-contract-invalid'
}

$expectedResources = [ordered]@{
  'dsh/' = 'lr-lsh/199-1/deepseek-harness/'
  'dsh-host/' = 'lr-lsh/199-1/dsh-host/'
  'media-engine/' = 'media-engine/'
  '../third-party-notices/' = 'third-party-notices/'
}
$resourceProperties = @($tauri.bundle.resources.PSObject.Properties)
if ($resourceProperties.Count -ne $expectedResources.Count) {
  throw 'package-resource-contract-invalid'
}
foreach ($source in $expectedResources.Keys) {
  $property = $tauri.bundle.resources.PSObject.Properties[$source]
  if ($null -eq $property -or [string]$property.Value -cne [string]$expectedResources[$source]) {
    throw 'package-resource-contract-invalid'
  }
}
$resources = [ordered]@{}
foreach ($property in $resourceProperties) { $resources[[string]$property.Name] = [string]$property.Value }
if (($resources | ConvertTo-Json -Compress) -match '(?i)agent-engine|hermes') {
  throw 'package-forbidden-runtime-declared'
}

foreach ($relative in @(
  'scripts\prepare-media-engine.ps1',
  'scripts\prepare-dsh-package-runtime.ps1',
  'scripts\prepare-dsh-runtime.ps1',
  'scripts\prepare-native-host.ps1',
  'scripts\dsh-supply-chain.mjs',
  'third_party\media-engine\manifest.json',
  'third_party\media-engine\runner.py',
  'dsh-host\runtime-authority.json',
  'dsh-host\records\dependency-audit.json',
  'dsh-host\records\launch-manifest.json',
  'dsh-host\records\runtime-manifest.json',
  'third-party-notices\README.md',
  'third-party-notices\deno-2.9.4\INDEX.json',
  'third-party-notices\deno-2.9.4\NATIVE-INDEX.json',
  'third-party-notices\seahash-4.1.0\LICENSE'
)) {
  Assert-File (Join-Path $repoRoot $relative) 'package-required-input-missing'
}

$nodeVersion = Invoke-CheckedVersion 'node.exe' @('--version') 'package-node-unavailable'
$pnpmVersion = Invoke-CheckedVersion 'pnpm.cmd' @('--version') 'package-pnpm-unavailable'
$cargoToolchain = Invoke-CheckedVersion 'cargo.exe' @('--version') 'package-cargo-unavailable'
$rustcHost = Invoke-CheckedVersion 'rustc.exe' @('-vV') 'package-rustc-unavailable'
$targets = Invoke-CheckedVersion 'rustup.exe' @('target','list','--installed') 'package-rust-target-unavailable'
if ($targets -notmatch '(?m)^x86_64-pc-windows-msvc$' -or $rustcHost -notmatch '(?m)^host: x86_64-pc-windows-msvc$') {
  throw 'package-rust-target-unavailable'
}
$tauriCli = Invoke-CheckedVersion 'pnpm.cmd' @('exec','tauri','--version') 'package-tauri-cli-unavailable'

if ($Phase -ceq 'Prepared') {
  foreach ($relative in @(
    'dist\index.html',
    'src-tauri\media-engine\runtime-manifest.json',
    'src-tauri\dsh\node\node.exe',
    'src-tauri\dsh\host\node_modules\@deepseek-ai\dsh\lib\bin.js',
    'src-tauri\binaries\luckyray-native-host-x86_64-pc-windows-msvc.exe',
    'src-tauri\binaries\luckyray-cli-x86_64-pc-windows-msvc.exe',
    'src-tauri\binaries\luckyray-cli-x86_64-pc-windows-msvc.exe.identity.json',
    'src-tauri\binaries\luckyray-mcp-x86_64-pc-windows-msvc.exe',
    'src-tauri\binaries\luckyray-browser-host-x86_64-pc-windows-msvc.exe',
    'src-tauri\binaries\luckyray-sidecars.origin.identity.json'
  )) {
    Assert-File (Join-Path $repoRoot $relative) 'package-prepared-output-missing'
  }

  # makensis cannot open resource source paths beyond the classic Windows
  # compiler boundary. The map above preserves the installed resource names;
  # this gate only constrains the repository-external packaging worktree path.
  $nsisMaxSourcePath = 259
  foreach ($source in $expectedResources.Keys) {
    $sourcePath = Join-Path $tauriRoot $source.TrimEnd('/')
    foreach ($file in Get-ChildItem -LiteralPath $sourcePath -File -Recurse -Force) {
      if ($file.FullName.Length -gt $nsisMaxSourcePath) {
        throw "package-nsis-resource-source-path-too-long:$($file.FullName.Length)"
      }
    }
  }
}

[pscustomobject]@{
  schemaVersion = 1
  phase = $Phase.ToLowerInvariant()
  appVersion = [string]$package.version
  node = $nodeVersion
  pnpm = $pnpmVersion
  cargo = $cargoToolchain
  tauri = $tauriCli
  target = 'x86_64-pc-windows-msvc'
  resources = $resources
  noHermes = $true
} | ConvertTo-Json -Compress -Depth 4
