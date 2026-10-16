param([string]$Destination)
$ErrorActionPreference='Stop'
if(-not $Destination){$Destination=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) ('LuckyRay-Materials-MCP/pair-'+[DateTime]::Now.ToString('yyyyMMdd-HHmmss'))}
& (Join-Path $PSScriptRoot 'Pair-MaterialsMcp.ps1') -Destination $Destination
$config=Join-Path $Destination 'connection.json'
if(-not (Test-Path -LiteralPath $config)){Write-Host 'No pairing saved; stopped.';return}
# A separate child keeps the check helper's exit from ending this setup script.
& (Join-Path $PSHOME 'powershell.exe') -NoProfile -File (Join-Path $PSScriptRoot 'Check-MaterialsMcp.ps1') -ConfigPath $config
if($LASTEXITCODE -ne 0){Write-Host 'Binding saved; online check failed. No import attempted.';return}
& (Join-Path $PSHOME 'powershell.exe') -NoProfile -File (Join-Path $PSScriptRoot 'Run-Acceptance.ps1') -ConfigPath $config -ReportPath (Join-Path $Destination 'import-receipt.json')
Write-Host 'For the revocation check, revoke this test client in Main Settings > Storage > Materials MCP access.'
if((Read-Host 'After revoking, type REVOKED to check rejection, or press Enter to leave it for later') -ceq 'REVOKED'){
 & (Join-Path $PSHOME 'powershell.exe') -NoProfile -File (Join-Path $PSScriptRoot 'Run-Acceptance.ps1') -ConfigPath $config -ReportPath (Join-Path $Destination 'revocation-receipt.json') -ExpectRevoked
}
Write-Host ('Receipts and secret-free client configuration: '+$Destination)
Write-Host 'Share only import-receipt.json / revocation-receipt.json. Never share credential.dpapi or one-time JSON.'
