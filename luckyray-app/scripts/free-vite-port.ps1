$ErrorActionPreference = "Stop"

$port = 1420
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$expectedDevApp = [System.IO.Path]::GetFullPath((Join-Path $repoRoot "src-tauri\target\debug\luckyray-app.exe"))

# A previous `tauri dev` app can outlive its Vite/Cargo parent. Starting a new
# watcher beside that stale window makes the user interact with an old binary.
# Only stop the debug executable owned by this exact checkout; an installed
# LuckyRay or a different checkout is outside this script's authority.
$staleDevApps = @(Get-CimInstance Win32_Process -Filter "Name='luckyray-app.exe'" -ErrorAction SilentlyContinue)
foreach ($staleDevApp in $staleDevApps) {
  $executablePath = [string]$staleDevApp.ExecutablePath
  if ([string]::IsNullOrWhiteSpace($executablePath)) {
    continue
  }
  $resolvedExecutable = [System.IO.Path]::GetFullPath($executablePath)
  if (-not $resolvedExecutable.Equals($expectedDevApp, [System.StringComparison]::OrdinalIgnoreCase)) {
    continue
  }
  Write-Host "[luckyray] stopping stale app from this checkout (pid $($staleDevApp.ProcessId))"
  Stop-Process -Id ([int]$staleDevApp.ProcessId) -Force
}

$connections = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)

foreach ($connection in $connections) {
  $processId = [int]$connection.OwningProcess
  if ($processId -le 0) {
    continue
  }

  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
  if (-not $process) {
    continue
  }

  $commandLine = [string]$process.CommandLine
  $isProjectVite = $process.Name -ieq "node.exe" -and
    $commandLine -like "*vite*" -and
    $commandLine -like "*$repoRoot*"

  if ($isProjectVite) {
    Write-Host "[luckyray] stopping stale Vite dev server on port $port (pid $processId)"
    Stop-Process -Id $processId -Force
    continue
  }

  Write-Error "Port $port is already used by pid $processId ($($process.Name)). CommandLine: $commandLine"
}
