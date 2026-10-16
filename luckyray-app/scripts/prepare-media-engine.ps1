[CmdletBinding()]
param(
    [string]$OutputRoot = "",
    [switch]$PlanOnly
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\import-package-powershell-modules.ps1"
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$sourceManifestPath = Join-Path $repoRoot "third_party\media-engine\manifest.json"
$runnerPath = Join-Path $repoRoot "third_party\media-engine\runner.py"
if (-not $OutputRoot) {
    $OutputRoot = Join-Path $repoRoot "src-tauri\media-engine"
}
$outputFull = [IO.Path]::GetFullPath($OutputRoot)
$allowedParent = [IO.Path]::GetFullPath((Join-Path $repoRoot "src-tauri"))
if (-not $outputFull.StartsWith($allowedParent + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
    [IO.Path]::GetFileName($outputFull) -ne "media-engine") {
    throw "media-engine-output-outside-workspace"
}

function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    try {
        $sha256 = [Security.Cryptography.SHA256]::Create()
        try {
            $digest = $sha256.ComputeHash($stream)
        } finally {
            $sha256.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
    return ([BitConverter]::ToString($digest)).Replace("-", "").ToLowerInvariant()
}

function Assert-ExactFile([string]$Path, [string]$ExpectedHash) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "media-engine-file-missing"
    }
    if ((Get-Sha256 $Path) -ne $ExpectedHash.ToLowerInvariant()) {
        throw "media-engine-file-hash-mismatch"
    }
}

function Test-Runtime([string]$Root) {
    $manifestPath = Join-Path $Root "runtime-manifest.json"
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { return $false }
    try {
        $runtime = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
        if ($runtime.schemaVersion -ne 1 -or -not $runtime.files -or
            [string]$runtime.pythonVersion -cne [string]$sourceManifest.python.version -or
            [string]$runtime.python -cne "python.exe") { return $false }
        if ([string]$runtime.sourceManifestSha256 -ne (Get-Sha256 $sourceManifestPath)) { return $false }
        if ((Get-Sha256 (Join-Path $Root "runner.py")) -ne (Get-Sha256 $runnerPath)) { return $false }
        foreach ($entry in $runtime.files) {
            $relative = [string]$entry.path
            if (-not $relative -or $relative.Contains("\") -or $relative.StartsWith("/") -or $relative.Contains("../")) {
                return $false
            }
            $path = Join-Path $Root ($relative.Replace("/", [IO.Path]::DirectorySeparatorChar))
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
            if ((Get-Item -LiteralPath $path).Length -ne [int64]$entry.size) { return $false }
            if ((Get-Sha256 $path) -ne [string]$entry.sha256) { return $false }
        }
        return $true
    } catch {
        return $false
    }
}

$sourceManifest = Get-Content -Raw -LiteralPath $sourceManifestPath | ConvertFrom-Json
if ($sourceManifest.schemaVersion -ne 1) { throw "media-engine-source-manifest-invalid" }
if ($PlanOnly) {
    [pscustomobject]@{
        outputRoot = $outputFull
        runtimeOwner = "media-engine"
        python = $sourceManifest.python.version
        pythonArchiveSha256 = $sourceManifest.python.sha256
        ytDlp = $sourceManifest.ytDlp.version
        ytDlpEjs = $sourceManifest.ytDlpEjs.version
        deno = $sourceManifest.deno.version
        ffmpeg = $sourceManifest.ffmpeg.version
        existingRuntimeValid = Test-Runtime $outputFull
    } | ConvertTo-Json
    exit 0
}
if (Test-Runtime $outputFull) {
    Write-Output "media-engine-ready"
    exit 0
}

$stage = Join-Path $allowedParent (".media-engine-stage-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    $downloads = Join-Path $stage "downloads"
    $runtime = Join-Path $stage "runtime"
    $wheels = Join-Path $runtime "wheels"
    $licenses = Join-Path $runtime "licenses"
    $ffmpegRuntime = Join-Path $runtime "ffmpeg"
    $denoRuntime = Join-Path $runtime "deno"
    New-Item -ItemType Directory -Path $downloads,$runtime,$wheels,$licenses,$ffmpegRuntime,$denoRuntime | Out-Null

    $artifacts = @($sourceManifest.python, $sourceManifest.ytDlp, $sourceManifest.ytDlpEjs, $sourceManifest.deno, $sourceManifest.ffmpeg)
    foreach ($artifact in $artifacts) {
        $destination = Join-Path $downloads ([string]$artifact.fileName)
        Invoke-WebRequest -UseBasicParsing -Uri ([string]$artifact.url) -OutFile $destination
        Assert-ExactFile $destination ([string]$artifact.sha256)
    }
    Copy-Item -LiteralPath (Join-Path $downloads $sourceManifest.ytDlp.fileName) -Destination $wheels
    Copy-Item -LiteralPath (Join-Path $downloads $sourceManifest.ytDlpEjs.fileName) -Destination $wheels
    Copy-Item -LiteralPath $runnerPath -Destination (Join-Path $runtime "runner.py")

    $pythonExpanded = Join-Path $stage "python-expanded"
    Expand-Archive -LiteralPath (Join-Path $downloads $sourceManifest.python.fileName) -DestinationPath $pythonExpanded
    foreach ($required in @("python.exe", "python311.dll", "python311.zip", "python311._pth", "LICENSE.txt")) {
        if (-not (Test-Path -LiteralPath (Join-Path $pythonExpanded $required) -PathType Leaf)) {
            throw "media-engine-python-layout-invalid"
        }
    }
    Get-ChildItem -LiteralPath $pythonExpanded | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $runtime -Recurse
    }
    $pythonExe = Join-Path $runtime "python.exe"
    $pythonSignature = Get-AuthenticodeSignature -LiteralPath $pythonExe
    if ($pythonSignature.Status -ne "Valid") {
        throw "media-engine-python-signature-invalid"
    }
    & $pythonExe -I -B -c "import sys; assert sys.version_info[:3] == (3, 11, 8)" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "media-engine-python-version-invalid"
    }
    New-Item -ItemType Directory -Path (Join-Path $licenses "cpython") | Out-Null
    Copy-Item -LiteralPath (Join-Path $pythonExpanded "LICENSE.txt") -Destination (Join-Path $licenses "cpython\LICENSE.txt")

    $ffmpegExpanded = Join-Path $stage "ffmpeg-expanded"
    Expand-Archive -LiteralPath (Join-Path $downloads $sourceManifest.ffmpeg.fileName) -DestinationPath $ffmpegExpanded
    $ffmpegExe = Get-ChildItem -Recurse -File -Filter "ffmpeg.exe" $ffmpegExpanded | Where-Object { $_.Directory.Name -eq "bin" } | Select-Object -First 1
    if (-not $ffmpegExe) { throw "media-engine-ffmpeg-layout-invalid" }
    Get-ChildItem -LiteralPath $ffmpegExe.Directory.FullName | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $ffmpegRuntime -Recurse
    }
    $configuration = & (Join-Path $ffmpegRuntime "ffmpeg.exe") -hide_banner -version 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or $configuration -notmatch "--enable-shared" -or $configuration -match "--enable-gpl" -or $configuration -match "--enable-nonfree") {
        throw "media-engine-ffmpeg-license-gate-failed"
    }

    $denoExpanded = Join-Path $stage "deno-expanded"
    Expand-Archive -LiteralPath (Join-Path $downloads $sourceManifest.deno.fileName) -DestinationPath $denoExpanded
    $denoExe = Get-ChildItem -Recurse -File -Filter "deno.exe" $denoExpanded | Select-Object -First 1
    if (-not $denoExe) { throw "media-engine-deno-layout-invalid" }
    Copy-Item -LiteralPath $denoExe.FullName -Destination (Join-Path $denoRuntime "deno.exe")

    foreach ($license in $sourceManifest.licenseFiles) {
        $destination = Join-Path $licenses ([string]$license.fileName)
        Invoke-WebRequest -UseBasicParsing -Uri ([string]$license.url) -OutFile $destination
        Assert-ExactFile $destination ([string]$license.sha256)
    }
    $archiveLicense = Get-ChildItem -Recurse -File $ffmpegExpanded | Where-Object { $_.Name -match '^LICENSE' } | Select-Object -First 1
    if ($archiveLicense) {
        Copy-Item -LiteralPath $archiveLicense.FullName -Destination (Join-Path $licenses "FFmpeg-LICENSE.txt")
    }

    $files = @()
    foreach ($file in Get-ChildItem -Recurse -File $runtime | Sort-Object FullName) {
        $relative = $file.FullName.Substring($runtime.Length + 1).Replace("\", "/")
        $files += [ordered]@{
            path = $relative
            size = [int64]$file.Length
            sha256 = Get-Sha256 $file.FullName
        }
    }
    $runtimeManifest = [ordered]@{
        schemaVersion = 1
        sourceManifestSha256 = Get-Sha256 $sourceManifestPath
        pythonVersion = [string]$sourceManifest.python.version
        python = "python.exe"
        ytDlpVersion = [string]$sourceManifest.ytDlp.version
        ytDlpWheel = "wheels/" + [string]$sourceManifest.ytDlp.fileName
        ytDlpEjsWheel = "wheels/" + [string]$sourceManifest.ytDlpEjs.fileName
        deno = "deno/deno.exe"
        ffmpeg = "ffmpeg/ffmpeg.exe"
        files = $files
    }
    $json = $runtimeManifest | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText((Join-Path $runtime "runtime-manifest.json"), $json, (New-Object Text.UTF8Encoding($false)))
    if (-not (Test-Runtime $runtime)) { throw "media-engine-runtime-verification-failed" }

    if (Test-Path -LiteralPath $outputFull) {
        $resolved = (Resolve-Path -LiteralPath $outputFull).Path
        if (-not $resolved.StartsWith($allowedParent + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
            throw "media-engine-existing-root-unsafe"
        }
        Remove-Item -Recurse -Force -LiteralPath $resolved
    }
    Move-Item -LiteralPath $runtime -Destination $outputFull
    if (-not (Test-Runtime $outputFull)) { throw "media-engine-activation-failed" }
    Write-Output "media-engine-prepared"
} finally {
    if (Test-Path -LiteralPath $stage) {
        Remove-Item -Recurse -Force -LiteralPath $stage
    }
}
