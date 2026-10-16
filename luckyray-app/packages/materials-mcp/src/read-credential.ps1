param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
  Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
  $item = Get-Item -LiteralPath $Path
  if ($item.Length -gt 131072 -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'invalid' }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $acl = Get-Acl -LiteralPath $Path
  foreach ($rule in $acl.Access) {
    $id = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($rule.AccessControlType -eq 'Allow' -and $id -notin @($sid,'S-1-5-18','S-1-5-32-544')) { throw 'acl' }
  }
  $secret = ConvertTo-SecureString ([IO.File]::ReadAllText($Path))
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
  try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr); $secret.Dispose() }
} catch { [Console]::Error.WriteLine('authorization-unavailable'); exit 1 }
