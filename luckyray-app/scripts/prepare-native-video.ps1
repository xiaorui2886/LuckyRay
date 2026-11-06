[CmdletBinding()]
param(
  [string]$ArtifactDirectory,
  [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\import-package-powershell-modules.ps1"
Set-StrictMode -Version Latest
$repo = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repo 'third_party/native-video/manifest.json'
$spec = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($spec.schemaVersion -ne 2 -or $spec.status -cne 'audited-local-lgpl-build' -or
    $spec.redistributionApproved -ne $true -or $spec.completeCorrespondingSource -ne $true) {
  throw 'native-video-corresponding-source-audit-incomplete'
}
$destination = Join-Path $repo 'src-tauri/native-video'
$source = if ([string]::IsNullOrWhiteSpace($ArtifactDirectory)) { $destination } else { [IO.Path]::GetFullPath($ArtifactDirectory) }
$required = @('libmpv-2.dll','README.md','LICENSES.md','RELINK.zh-CN.md','build-lgpl.sh','sources.tar.xz','SOURCE-INDEX.json','BUILD-INFO.json','licenses/mpv-LGPL-2.1.txt','licenses/FFmpeg-LGPL-3.0.txt','licenses/GPL-3.0.txt')
foreach ($name in $required) {
  if ($null -eq $spec.files.PSObject.Properties[$name]) { throw "native-video-required-material-missing:$name" }
}
function Verify-File([string]$Root, [string]$Name, $Expected) {
  if ($Name -match '(^/|\\|:|(^|/)\.\.?(/|$)|//)' -or [string]::IsNullOrWhiteSpace($Name)) { throw 'native-video-resource-path-invalid' }
  $item = Get-Item -LiteralPath (Join-Path $Root $Name)
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      $item.Length -ne $Expected.size) { throw "native-video-material-size-or-type-invalid:$Name" }
  if ((Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Expected.sha256) {
    throw "native-video-material-hash-invalid:$Name"
  }
}
if ((Get-Item -LiteralPath $source).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'native-video-resource-root-link-refused' }
$sourceItems = @(Get-ChildItem -LiteralPath $source -Force -Recurse)
if (@($sourceItems | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'native-video-resource-link-refused' }
$listed = @($spec.files.PSObject.Properties.Name) + @('runtime-manifest.json')
$sourceRoot = [IO.Path]::GetFullPath($source).TrimEnd('\') + '\'
foreach ($item in @($sourceItems | Where-Object { -not $_.PSIsContainer })) {
  $relative = $item.FullName.Substring($sourceRoot.Length).Replace('\','/')
  if ($relative -cnotin $listed) { throw "native-video-unlisted-material:$relative" }
}
foreach ($file in $spec.files.PSObject.Properties) { Verify-File $source $file.Name $file.Value }
Verify-File $source 'libmpv-2.dll' $spec.dll
if ((Get-FileHash -LiteralPath (Join-Path $source 'runtime-manifest.json')).Hash -cne
    (Get-FileHash -LiteralPath $manifestPath).Hash) { throw 'native-video-manifest-binding-invalid' }
if (-not $VerifyOnly -and $source -cne $destination) {
  if (Test-Path -LiteralPath $destination) {
    throw 'native-video-staging-already-exists-preserve-and-review'
  }
  New-Item -ItemType Directory -Path $destination | Out-Null
  foreach ($name in $listed) {
    $target = Join-Path $destination $name
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $source $name) -Destination $target
  }
  foreach ($file in $spec.files.PSObject.Properties) { Verify-File $destination $file.Name $file.Value }
}
[pscustomobject]@{
  component = 'libmpv'; status = 'verified'; materialFiles = $listed.Count
  sourceArchiveSha256 = $spec.files.'sources.tar.xz'.sha256
  dllSha256 = $spec.dll.sha256; verificationOnly = [bool]$VerifyOnly
} | ConvertTo-Json -Compress
