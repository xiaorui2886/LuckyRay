param(
  [Parameter(Mandatory=$true)][string]$SourceEncryptedFile,
  [Parameter(Mandatory=$true)][string]$DestinationStore
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# Preserve the existing DPAPI ciphertext only. Never decrypt, re-key, or upload.
if (Test-Path -LiteralPath $DestinationStore) { throw 'encrypted-backup-destination-already-exists' }
if (-not [IO.Path]::IsPathRooted($DestinationStore) -or $DestinationStore.StartsWith('\\')) { throw 'local-absolute-store-required' }
$source = Get-Item -LiteralPath $SourceEncryptedFile
if ($source.Name -cne 'signer-key.dpapi' -or $source.Length -gt 32768 -or $source.Length -lt 100) { throw 'encrypted-key-container-invalid' }
$directory = New-Item -ItemType Directory -Path $DestinationStore
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true,$false)
$acl.SetOwner($user)
foreach ($sid in @($user,$system)) {
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
}
Set-Acl -LiteralPath $directory.FullName -AclObject $acl
$target = Join-Path $directory.FullName 'signer-key.dpapi'
$encrypted = [IO.File]::ReadAllBytes($source.FullName)
$stream = [IO.File]::Open($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try { $stream.Write($encrypted,0,$encrypted.Length);$stream.Flush($true) } finally {$stream.Dispose()}
$before=(Get-FileHash -LiteralPath $source.FullName -Algorithm SHA256).Hash
$after=(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
if ($before -cne $after) { throw 'encrypted-copy-mismatch' }
[pscustomobject]@{encryptedBackupPath=$target;bytes=$encrypted.Length;ciphertextSha256=$after.ToLowerInvariant();privateKeyDecrypted=$false;keyChanged=$false;sourcePreserved=$true;aclProtected=(Get-Acl -LiteralPath $directory.FullName).AreAccessRulesProtected;scope='same DPAPI CurrentUser ciphertext; outside repo and package cache'} | ConvertTo-Json
