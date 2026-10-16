param(
  [string]$HostBinary = "",
  [string]$ManifestPath = "",
  [switch]$Unregister,
  [switch]$PlanOnly
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($HostBinary)) {
  $HostBinary = Join-Path $repo "src-tauri\target\debug\luckyray-native-host.exe"
}
if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
  $ManifestPath = Join-Path $env:LOCALAPPDATA "LuckyRay\NativeMessaging\com.luckyray.desktop.json"
}
$edgeKey = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.luckyray.desktop"
$chromeKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.luckyray.desktop"

if ($PlanOnly) {
  [pscustomobject]@{
    hostName = "com.luckyray.desktop"
    hostBinary = [IO.Path]::GetFullPath($HostBinary)
    manifestPath = [IO.Path]::GetFullPath($ManifestPath)
    registryKeys = @($edgeKey, $chromeKey)
    unregister = [bool]$Unregister
  } | ConvertTo-Json -Depth 4 -Compress
  exit 0
}

if ($Unregister) {
  Remove-Item -LiteralPath $edgeKey -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $chromeKey -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $ManifestPath -Force -ErrorAction SilentlyContinue
  exit 0
}

if (-not (Test-Path -LiteralPath $HostBinary -PathType Leaf)) {
  throw "Native host binary not found: $HostBinary"
}
New-Item -ItemType Directory -Path (Split-Path $ManifestPath) -Force | Out-Null
& $HostBinary --install-manifest $ManifestPath
if ($LASTEXITCODE -ne 0) { throw "Native host manifest generation failed." }
foreach ($key in @($edgeKey, $chromeKey)) {
  New-Item -Path $key -Force | Out-Null
  Set-Item -LiteralPath $key -Value ([IO.Path]::GetFullPath($ManifestPath))
}
