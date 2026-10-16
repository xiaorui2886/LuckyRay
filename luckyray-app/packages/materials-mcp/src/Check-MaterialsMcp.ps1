param([Parameter(Mandatory=$true)][string]$ConfigPath,[switch]$Pause)
$ErrorActionPreference='Stop'
$code=1
try {
  $node=(Get-Command node.exe -ErrorAction Stop).Source
  & $node (Join-Path $PSScriptRoot 'server.mjs') --config $ConfigPath --check
  $code=$LASTEXITCODE
  if($code -eq 0){Write-Host 'ONLINE: exact desktop + fixed library proof verified.' -ForegroundColor Green}
  else {Write-Host 'OFFLINE / NOT AUTHORIZED: use the error code above; no alternate instance was selected.' -ForegroundColor Yellow}
} catch {Write-Host 'CHECK FAILED: Node or configuration unavailable.' -ForegroundColor Red}
if($Pause){[void](Read-Host 'Press Enter to close')}
exit $code
