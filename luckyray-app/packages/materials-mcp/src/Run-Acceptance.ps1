param([Parameter(Mandatory=$true)][string]$ConfigPath,[string]$ReportPath,[switch]$ExpectRevoked)
$ErrorActionPreference='Stop'
$node=(Get-Command node.exe -ErrorAction Stop).Source
$arguments=@((Join-Path $PSScriptRoot 'acceptance.mjs'),'--config',$ConfigPath)
if($ExpectRevoked){$arguments+='--expect-revoked'}
else {
  Write-Host 'This uses the paired library only. It imports two public python-pptx test fixtures (PNG 6111 bytes, PPTX 15802 bytes).'
  Write-Host 'It then inspects/searches each asset and imports it again to confirm the same assetId. No deletion or Main restart.'
  Write-Host 'Use an explicitly authorized synthetic test library; existing duplicate names may make name checks inconclusive.'
  if((Read-Host 'Run these real file imports now? Type YES') -cne 'YES'){return}
  $arguments+='--import-fixtures'
}
if($ReportPath){$arguments+=@('--report',$ReportPath)}
& $node @arguments
exit $LASTEXITCODE
