param([Parameter(Mandatory=$true)][string]$Directory,[switch]$InitializeOnly)
$ErrorActionPreference='Stop'
try {
  [Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
  Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
  if (-not [IO.Path]::IsPathRooted($Directory) -or $Directory.StartsWith('\\')) { throw 'path' }
  for ($p=$Directory; $p; $p=[IO.Path]::GetDirectoryName($p)) {
    if ((Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'link' }
  }
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl=New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true,$false); $acl.SetOwner($sid)
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
  if (-not (Test-Path -LiteralPath $Directory)) { [void][IO.Directory]::CreateDirectory($Directory,$acl) }
  else {
    foreach($rule in (Get-Acl -LiteralPath $Directory).Access) {
      if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'acl' }
    }
  }
  if ($InitializeOnly) { exit 0 }
  $json=[Console]::In.ReadToEnd()
  if ($json.Length -gt 16384) { throw 'size' }
  $pair=$json | ConvertFrom-Json
  if ($pair.credential -cnotmatch '^[a-f0-9]{64}$' -or $pair.authKind -ne 'materials-mcp-scoped-v1') { throw 'pair' }
  $secure=ConvertTo-SecureString $json -AsPlainText -Force
  try { $sealed=ConvertFrom-SecureString $secure } finally { $secure.Dispose() }
  $file=[IO.File]::Open((Join-Path $Directory 'credential.dpapi'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try { $bytes=[Text.Encoding]::UTF8.GetBytes($sealed); $file.Write($bytes,0,$bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
  $json=$null; $pair=$null
} catch { [Console]::Error.WriteLine('private-binding-save-failed'); exit 1 }
