param([Parameter(Mandatory=$true)][string]$Directory,
      [ValidateSet('initialize','write','read','remove')][string]$Action='initialize',
      [ValidateSet('tunnel-key','credential')][string]$Name='tunnel-key')
$ErrorActionPreference='Stop'
try {
  [Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
  [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
  Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
  if(-not [IO.Path]::IsPathRooted($Directory) -or $Directory.StartsWith('\\')){throw 'path'}
  for($p=$Directory;$p;$p=[IO.Path]::GetDirectoryName($p)){
    if((Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'link'}
  }
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl=New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true,$false);$acl.SetOwner($sid)
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
  if(-not (Test-Path -LiteralPath $Directory)){[void][IO.Directory]::CreateDirectory($Directory,$acl)}
  foreach($rule in (Get-Acl -LiteralPath $Directory).Access){
    if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'acl'}
  }
  if($Action -eq 'initialize'){exit 0}
  $path=Join-Path $Directory ($Name+'.dpapi')
  if(Test-Path -LiteralPath $path){
    $item=Get-Item -LiteralPath $path -Force
    if($item.Length -gt 65536 -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'file'}
  }
  if($Action -eq 'remove'){if(Test-Path -LiteralPath $path){[IO.File]::Delete($path)};exit 0}
  if($Action -eq 'read'){
    $secure=ConvertTo-SecureString ([IO.File]::ReadAllText($path))
    $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try{[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr))}
    finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr);$secure.Dispose()}
    exit 0
  }
  $value=[Console]::In.ReadToEnd()
  if(-not $value -or $value.Length -gt 16384){throw 'input'}
  $secure=ConvertTo-SecureString $value -AsPlainText -Force
  try{$sealed=ConvertFrom-SecureString $secure}finally{$secure.Dispose()}
  $tmp=Join-Path $Directory ('.secret-'+[Guid]::NewGuid().ToString('N')+'.tmp')
  $file=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$bytes=[Text.Encoding]::UTF8.GetBytes($sealed);$file.Write($bytes,0,$bytes.Length);$file.Flush($true)}finally{$file.Dispose()}
  if(Test-Path -LiteralPath $path){[IO.File]::Replace($tmp,$path,[NullString]::Value)}else{[IO.File]::Move($tmp,$path)}
  $value=$null;$sealed=$null
} catch {[Console]::Error.WriteLine('private-secret-storage-failed');exit 1}
