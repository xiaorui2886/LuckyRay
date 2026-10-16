param(
  [Parameter(Mandatory=$true)][string]$TauriCli,
  [Parameter(Mandatory=$true)][string]$PrivateStore,
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$TrustJson
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Security
$cli = Get-Item -LiteralPath $TauriCli
$cliPackage = Get-Content -LiteralPath (Join-Path $cli.DirectoryName 'package.json') -Raw | ConvertFrom-Json
if ($cliPackage.name -cne '@tauri-apps/cli' -or $cliPackage.version -cne '2.11.2') { throw 'reviewed-official-signer-required' }
$file = Get-Item -LiteralPath $Installer
if ($file.Name -cnotmatch '^LuckyRay_(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)_x64-setup\.exe$') { throw 'canonical-installer-required' }
if (Test-Path -LiteralPath ($file.FullName + '.sig')) { throw 'signature-already-exists' }
$trust = Get-Content -LiteralPath $TrustJson -Raw | ConvertFrom-Json
if ($trust.enabled -ne $true -or $trust.identifier -cne 'com.luckyray.desktop' -or $trust.manifestUrl -cne 'https://github.com/xiaorui2886/LuckyRay/releases/latest/download/latest.json' -or [string]::IsNullOrEmpty($trust.publicKey)) { throw 'approved-production-trust-required' }
$before = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = (Get-Command node.exe).Source
$start.Arguments = '"' + $cli.FullName + '" signer sign "' + $file.FullName + '"'
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$entropy = [Text.Encoding]::UTF8.GetBytes('LuckyRay.desktop.update.production.v1')
$secret = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes((Join-Path $PrivateStore 'signer-key.dpapi')), $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
try {
  $start.EnvironmentVariables['TAURI_SIGNING_PRIVATE_KEY'] = [Text.Encoding]::UTF8.GetString($secret)
  $start.EnvironmentVariables['TAURI_SIGNING_PRIVATE_KEY_PASSWORD'] = ''
  $process = [Diagnostics.Process]::Start($start)
  $discardedOutput = $process.StandardOutput.ReadToEnd()
  $discardedError = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) { throw 'official-signing-failed' }
} finally {
  [Array]::Clear($secret, 0, $secret.Length)
  [void]$start.EnvironmentVariables.Remove('TAURI_SIGNING_PRIVATE_KEY')
  [void]$start.EnvironmentVariables.Remove('TAURI_SIGNING_PRIVATE_KEY_PASSWORD')
  $discardedOutput = $null; $discardedError = $null
}
if ((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash -cne $before) { throw 'installer-changed-during-signing' }
if (-not (Test-Path -LiteralPath ($file.FullName + '.sig') -PathType Leaf)) { throw 'official-signature-missing' }
[pscustomobject]@{installer=$file.Name;sha256=$before.ToLowerInvariant();signatureFile=$file.Name+'.sig';signatureSha256=(Get-FileHash -LiteralPath ($file.FullName+'.sig') -Algorithm SHA256).Hash.ToLowerInvariant();method='official Tauri 2.11.2; DPAPI unsealed only in short-lived child environment';verification='REQUIRED: run luckyray-update-verify before any manifest or delivery'} | ConvertTo-Json
