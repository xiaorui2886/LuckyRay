[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression.FileSystem
$repo = Split-Path -Parent $PSScriptRoot
$app = Join-Path $repo 'luckyray-app'
$manifestPath = Join-Path $app 'third_party/native-video/manifest.json'
$spec = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$required = @($spec.files.PSObject.Properties.Name) + @('runtime-manifest.json')
if ($required.Count -ne 43) { throw 'public-native-video-material-count-changed' }
$stage = Join-Path ([IO.Path]::GetTempPath()) ('luckyray-public-native-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    $archive = Join-Path $stage 'source.zip'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/xiaorui2886/LuckyRay/releases/download/v1.9.10/LuckyRay-1.9.10-source.zip' -OutFile $archive
    if ((Get-Item -LiteralPath $archive).Length -ne 157353006 -or
        (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne '8abc9578b6699bcfbb53549081c614774994fde2619187ba3b7c496a6a1679f0') {
        throw 'public-native-video-source-archive-mismatch'
    }
    $materials = Join-Path $stage 'materials'
    New-Item -ItemType Directory -Path $materials | Out-Null
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        foreach ($name in $required) {
            if ([string]::IsNullOrWhiteSpace($name) -or $name -match '(^/|\\|:|(^|/)\.\.?(/|$)|//)') {
                throw 'public-native-video-resource-path-invalid'
            }
            $entryName = 'LuckyRay-1.9.10/luckyray-app/src-tauri/native-video/' + $name
            $entries = @($zip.Entries | Where-Object { $_.FullName -ceq $entryName })
            if ($entries.Count -ne 1) { throw "public-native-video-archive-entry-invalid:$name" }
            $entry = $entries[0]
            $expectedLength = if ($name -ceq 'runtime-manifest.json') { (Get-Item -LiteralPath $manifestPath).Length } else { $spec.files.PSObject.Properties[$name].Value.size }
            if ($entry.Length -ne $expectedLength -or (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) {
                throw "public-native-video-archive-size-or-type-invalid:$name"
            }
            $target = Join-Path $materials $name
            New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
        }
    } finally { $zip.Dispose() }
    # Existing product verifier binds every size/hash and full manifest bytes.
    & (Join-Path $app 'scripts/prepare-native-video.ps1') -ArtifactDirectory $materials
    & (Join-Path $app 'scripts/prepare-native-video.ps1') -VerifyOnly
} finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
