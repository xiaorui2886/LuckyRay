param(
  [Parameter(Mandatory=$true)][string]$TauriCli,
  [Parameter(Mandatory=$true)][string]$StoreRoot,
  [Parameter(Mandatory=$true)][string]$PublicRecord,
  [switch]$UserApprovedProductionTrust
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $UserApprovedProductionTrust) { throw 'production-signing-approval-required' }
if (-not [IO.Path]::IsPathRooted($StoreRoot) -or (Test-Path -LiteralPath $StoreRoot)) { throw 'new-private-store-required' }
$cli = Get-Item -LiteralPath $TauriCli
$cliPackage = Get-Content -LiteralPath (Join-Path $cli.DirectoryName 'package.json') -Raw | ConvertFrom-Json
if ($cliPackage.name -cne '@tauri-apps/cli' -or $cliPackage.version -cne '2.11.2') { throw 'reviewed-official-signer-required' }
if (Test-Path -LiteralPath $PublicRecord) { throw 'public-record-already-exists' }
Add-Type -AssemblyName System.Security
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$directory = New-Item -ItemType Directory -Path $StoreRoot
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($sid)
foreach ($identity in @($sid, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) {
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $directory.FullName -AclObject $acl
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = (Get-Command node.exe).Source
$start.Arguments = '"' + $cli.FullName + '" signer generate --ci'
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
# The official CLI prints its pair when no --write-keys is given. Capture only
# in memory: never return it, persist it, include it in exceptions, or log it.
$process = [Diagnostics.Process]::Start($start)
$raw = $process.StandardOutput.ReadToEnd()
$discardedError = $process.StandardError.ReadToEnd()
$process.WaitForExit()
if ($process.ExitCode -ne 0) { throw 'official-key-generation-failed' }
$match = [regex]::Match($raw, '(?s)Private: \(Keep it secret!\)\s*([A-Za-z0-9+/=]+)\s+Public:\s*([A-Za-z0-9+/=]+)\s')
if (-not $match.Success) { throw 'official-key-output-shape-invalid' }
$secret = [Text.Encoding]::UTF8.GetBytes($match.Groups[1].Value)
$public = $match.Groups[2].Value
$entropy = [Text.Encoding]::UTF8.GetBytes('LuckyRay.desktop.update.production.v1')
$restored = $null
try {
  $encrypted = [Security.Cryptography.ProtectedData]::Protect($secret, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  $keyPath = Join-Path $directory.FullName 'signer-key.dpapi'
  $stream = [IO.File]::Open($keyPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($encrypted, 0, $encrypted.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  $restored = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($keyPath), $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  if ([Convert]::ToBase64String($restored) -cne [Convert]::ToBase64String($secret)) { throw 'encrypted-key-roundtrip-failed' }
} finally {
  if ($null -ne $secret) { [Array]::Clear($secret, 0, $secret.Length) }
  if ($null -ne $restored) { [Array]::Clear($restored, 0, $restored.Length) }
  $raw = $null; $match = $null; $discardedError = $null
}
$hash = [Security.Cryptography.SHA256]::Create()
try { $fingerprint = ([BitConverter]::ToString($hash.ComputeHash([Convert]::FromBase64String($public)))).Replace('-', '').ToLowerInvariant() } finally { $hash.Dispose() }
$record = [ordered]@{schemaVersion=1;createdAtUtc=[DateTime]::UtcNow.ToString('o');algorithm='Tauri 2.11.2 Minisign';publicKey=$public;publicKeySha256=$fingerprint;privateStorage='Windows DPAPI CurrentUser; restricted local directory; no plaintext key file';publicFeedSwitched=$false;approval='Explicit human approval 2026-10-16'}
$json = $record | ConvertTo-Json -Depth 4
$stream = [IO.File]::Open($PublicRecord, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try { $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($json + "`n"); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
$json
