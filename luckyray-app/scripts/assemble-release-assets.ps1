param(
  [Parameter(Mandatory = $true)]
  [string]$OutputRoot,
  [switch]$PlanOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$appRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$gitTopLevelOutput = @(& git -C $appRoot rev-parse --show-toplevel)
if ($LASTEXITCODE -ne 0 -or $gitTopLevelOutput.Count -ne 1) {
  throw "release-git-worktree-unavailable"
}
$gitRoot = [IO.Path]::GetFullPath([string]$gitTopLevelOutput[0])
$package = Get-Content -LiteralPath (Join-Path $appRoot "package.json") -Raw | ConvertFrom-Json
$version = [string]$package.version
if ($version -notmatch '^\d+\.\d+\.\d+$') {
  throw "release-version-invalid"
}

$installerName = "LuckyRay_${version}_x64-setup.exe"
$collectorName = "LuckyRay-Collector-${version}.zip"
$checksumsName = "SHA256SUMS.txt"
$targetRoot = if (Test-Path -LiteralPath "Env:CARGO_TARGET_DIR") {
  [IO.Path]::GetFullPath([string]$env:CARGO_TARGET_DIR)
} else {
  Join-Path $appRoot "src-tauri\target"
}
$plan = [ordered]@{
  schemaVersion = 1
  version = $version
  installer = $installerName
  collector = $collectorName
  checksums = $checksumsName
  collectorSource = "tracked-files-only"
  targetRoot = $targetRoot
}

if ($PlanOnly) {
  $plan | ConvertTo-Json -Compress -Depth 3
  exit 0
}

$output = [IO.Path]::GetFullPath($OutputRoot)
$gitPrefix = $gitRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if ($output -eq $gitRoot -or $output.StartsWith($gitPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "release-output-must-be-outside-repository"
}

$installerSource = Join-Path $targetRoot "release\bundle\nsis\$installerName"
if (-not (Test-Path -LiteralPath $installerSource -PathType Leaf)) {
  throw "release-installer-not-found"
}

New-Item -ItemType Directory -Path $output -Force | Out-Null
$installerOutput = Join-Path $output $installerName
$collectorOutput = Join-Path $output $collectorName
$checksumsOutput = Join-Path $output $checksumsName
foreach ($path in @($installerOutput, $collectorOutput, $checksumsOutput)) {
  if (Test-Path -LiteralPath $path) {
    throw "release-output-already-exists"
  }
}

$stageRoot = Join-Path $output (".collector-stage-" + $PID)
if (Test-Path -LiteralPath $stageRoot) {
  throw "release-collector-stage-already-exists"
}

try {
  New-Item -ItemType Directory -Path $stageRoot | Out-Null
  $tracked = @(& git -C $appRoot ls-files -- browser-extension-prototype)
  if ($LASTEXITCODE -ne 0 -or $tracked.Count -eq 0) {
    throw "release-collector-manifest-unavailable"
  }
  foreach ($relative in $tracked) {
    if (-not $relative.StartsWith("browser-extension-prototype/", [StringComparison]::Ordinal)) {
      throw "release-collector-path-invalid"
    }
    $inside = $relative.Substring("browser-extension-prototype/".Length).Replace('/', [IO.Path]::DirectorySeparatorChar)
    $source = Join-Path $appRoot $relative
    $destination = Join-Path $stageRoot $inside
    $destinationParent = Split-Path -Parent $destination
    New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination
  }

  Compress-Archive -Path (Join-Path $stageRoot "*") -DestinationPath $collectorOutput -CompressionLevel Optimal
  Copy-Item -LiteralPath $installerSource -Destination $installerOutput

  $artifacts = @($installerOutput, $collectorOutput) | ForEach-Object {
    $item = Get-Item -LiteralPath $_
    $hash = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()
    [ordered]@{ name = $item.Name; size = $item.Length; sha256 = $hash }
  }
  $checksumLines = $artifacts | ForEach-Object { "$($_.sha256)  $($_.name)" }
  $checksumLines | Set-Content -LiteralPath $checksumsOutput -Encoding ascii

  [ordered]@{
    schemaVersion = 1
    version = $version
    outputRoot = $output
    artifacts = $artifacts
    checksums = $checksumsName
  } | ConvertTo-Json -Compress -Depth 5
} finally {
  if (Test-Path -LiteralPath $stageRoot) {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force
  }
}
