# Builds the community fixture bundle + host (debug, extension-runtime-fixture) and
# launches one isolated instance. Never touches the development/production profile.
[CmdletBinding()]
param(
  [switch]$BuildOnly,
  [string]$Assets = "target/extension-community-fixture",
  [int]$TimeoutSec = 1800
)
$ErrorActionPreference = "Stop"
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
Push-Location $repoRoot
try {
  & node tests/extension-v1-community/build.mjs
  if ($LASTEXITCODE -ne 0) { throw "fixture bundle build failed" }
  $env:TAURI_CONFIG = '{"identifier":"com.luckyray.extensionfixture","bundle":{"resources":[],"externalBin":[]}}'
  & cargo build --manifest-path src-tauri/Cargo.toml --bin luckyray-app --features extension-runtime-fixture --target-dir target/extension-app
  if ($LASTEXITCODE -ne 0) { throw "fixture host build failed" }
  if ($BuildOnly) { return }
  $env:LUCKYRAY_APP_PROFILE = ""
  $env:LUCKYRAY_FIXTURE_TIMEOUT_SECS = "$TimeoutSec"
  & target/extension-app/debug/luckyray-app.exe --extension-community-fixture $Assets
} finally {
  Pop-Location
}
