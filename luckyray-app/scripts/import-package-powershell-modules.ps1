# Formal packaging runs under Windows PowerShell 5.1 child processes where
# module auto-loading is not a dependable build contract. Keep every cmdlet
# used by the resource preparation chain explicitly owned by these modules.
$moduleRoot = [IO.Path]::Combine($PSHOME, 'Modules')
foreach ($module in @(
  'Microsoft.PowerShell.Security',
  'Microsoft.PowerShell.Utility',
  'Microsoft.PowerShell.Management',
  'Microsoft.PowerShell.Archive'
)) {
  $manifest = [IO.Path]::Combine($moduleRoot, $module, "$module.psd1")
  Microsoft.PowerShell.Core\Import-Module $manifest -Global -ErrorAction Stop
}

foreach ($command in @(
  'ConvertFrom-Json',
  'ConvertTo-Json',
  'Expand-Archive',
  'Get-AuthenticodeSignature',
  'Invoke-WebRequest'
)) {
  Microsoft.PowerShell.Core\Get-Command $command -ErrorAction Stop | Out-Null
}
