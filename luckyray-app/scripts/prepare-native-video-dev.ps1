param([Parameter(Mandatory=$true)][string]$ArtifactDirectory)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo=Split-Path -Parent $PSScriptRoot
$specPath=Join-Path $repo 'third_party/native-video/manifest.json'
$spec=Get-Content -LiteralPath $specPath -Raw | ConvertFrom-Json
if($spec.status -cne 'local-development-only' -or $spec.redistributionApproved -ne $false){throw 'native-video-dev-manifest-invalid'}
$source=(Resolve-Path -LiteralPath $ArtifactDirectory).Path
function Verify([string]$Path,$Expected){
 $item=Get-Item -LiteralPath $Path
 if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -ne $Expected.size){throw 'native-video-artifact-size-or-type-invalid'}
 if((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Expected.sha256){throw 'native-video-artifact-hash-invalid'}
}
Verify (Join-Path $source $spec.archive.fileName) $spec.archive
Verify (Join-Path $source $spec.dll.fileName) $spec.dll
$destination=Join-Path $repo 'src-tauri/native-video'
if(Test-Path -LiteralPath $destination){
 if((Get-Item -LiteralPath $destination).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'native-video-destination-reparse-refused'}
 $existing=Join-Path $destination $spec.dll.fileName
 if(Test-Path -LiteralPath $existing){Verify $existing $spec.dll}
}else{New-Item -ItemType Directory -Path $destination|Out-Null}
# Only the exact verified DLL and checked-in provenance are copied. No source
# directory/profile, PDB, configuration, keys or alternate DLL dependencies.
Copy-Item -LiteralPath (Join-Path $source $spec.dll.fileName) -Destination $destination
Copy-Item -LiteralPath $specPath -Destination (Join-Path $destination 'runtime-manifest.json')
Copy-Item -LiteralPath (Join-Path $repo 'third_party/native-video/README.md') -Destination (Join-Path $destination 'README.md')
Verify (Join-Path $destination $spec.dll.fileName) $spec.dll
Write-Output 'NATIVE_VIDEO_LOCAL_DEV_STAGED: pinned upstream DLL, no installation or launch, redistribution NOT approved.'
