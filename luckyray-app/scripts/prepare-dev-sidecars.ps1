$ErrorActionPreference = 'Stop'
$previousConfig = $env:TAURI_CONFIG
$previousPrepare = $env:LUCKYRAY_SIDECAR_PREPARE
try {
  $env:LUCKYRAY_SIDECAR_PREPARE = '1'
  & "$PSScriptRoot/prepare-native-host.ps1" -SidecarNames luckyray-cli
  if ($LASTEXITCODE -ne 0) { throw 'dev-cli-preparation-failed' }
  # Sidecar compilation does not publish app resources. In particular it must
  # not overwrite the Node executable being used by another preparation step.
  $env:TAURI_CONFIG = '{"bundle":{"externalBin":[],"resources":[]}}'
  & cargo build --locked --manifest-path "$PSScriptRoot/../src-tauri/Cargo.toml" --no-default-features --features sidecar-binaries --bin luckyray-browser-host
  if ($LASTEXITCODE -ne 0) { throw 'dev-browser-host-build-failed' }
} finally { $env:TAURI_CONFIG = $previousConfig; $env:LUCKYRAY_SIDECAR_PREPARE = $previousPrepare }
