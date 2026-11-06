$ErrorActionPreference = 'Stop'

# Cargo's top-level debug executables may be hard links to its deps artifacts.
# Tauri copies the staged sidecars over them on startup, changing the link count
# and invalidating the byte-and-metadata cache. Detach only these generated
# copies, verify their bytes, and retain the backup if replacement verification
# fails. No app profile or user data is touched.
function Detach-DevSidecar([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "dev-sidecar-path-invalid: $Path"
  }
  $stage = "$Path.stage-$PID-$([Guid]::NewGuid().ToString('N'))"
  $backup = "$Path.backup-$PID-$([Guid]::NewGuid().ToString('N'))"
  try {
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash
    Copy-Item -LiteralPath $Path -Destination $stage
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $stage).Hash -cne $hash) {
      throw "dev-sidecar-copy-hash-mismatch: $Path"
    }
    [IO.File]::Replace($stage, $Path, $backup, $true)
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash -cne $hash) {
      throw "dev-sidecar-replacement-hash-mismatch; backup retained: $backup"
    }
    Remove-Item -LiteralPath $backup -Force
  } finally {
    if (Test-Path -LiteralPath $stage -PathType Leaf) { Remove-Item -LiteralPath $stage -Force }
  }
}

$previousConfig = $env:TAURI_CONFIG
$previousPrepare = $env:LUCKYRAY_SIDECAR_PREPARE
try {
  $env:LUCKYRAY_SIDECAR_PREPARE = '1'
  # Stage both registered externalBin files through the existing checked
  # publisher. Otherwise Tauri overwrites the browser-host build with the
  # debug placeholder, making every next start recompile and leaving it unusable.
  & "$PSScriptRoot/prepare-native-host.ps1" -SidecarNames @('luckyray-cli', 'luckyray-browser-host')
  if ($LASTEXITCODE -ne 0) { throw 'dev-sidecar-preparation-failed' }
  $tauri = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../src-tauri'))
  $target = if ([string]::IsNullOrWhiteSpace($env:CARGO_TARGET_DIR)) {
    Join-Path $tauri 'target'
  } elseif ([IO.Path]::IsPathRooted($env:CARGO_TARGET_DIR)) {
    [IO.Path]::GetFullPath($env:CARGO_TARGET_DIR)
  } else {
    [IO.Path]::GetFullPath((Join-Path $tauri $env:CARGO_TARGET_DIR))
  }
  foreach ($name in @('luckyray-cli', 'luckyray-browser-host')) {
    Detach-DevSidecar (Join-Path $target "debug/$name.exe")
  }
} finally { $env:TAURI_CONFIG = $previousConfig; $env:LUCKYRAY_SIDECAR_PREPARE = $previousPrepare }
