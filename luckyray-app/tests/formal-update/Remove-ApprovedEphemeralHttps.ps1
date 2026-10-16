param([Parameter(Mandatory=$true)][ValidateNotNullOrEmpty()][string]$OwnerApprovalReference)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:GITHUB_REPOSITORY -cne 'xiaorui2886/LuckyRay' -or $env:USERNAME -notlike 'runner*' -or $PSVersionTable.PSEdition -ne 'Desktop') { throw 'disposable-public-native-windows-powershell-only' }
if ($OwnerApprovalReference -notmatch '\A[a-zA-Z0-9][a-zA-Z0-9._-]{3,79}\z') { throw 'fresh-owner-approval-reference-required' }
$root='D:\lr-formal-uat'
if (-not (Test-Path -LiteralPath "$root/private/test-certificates.json")) { return }
if ((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'unexpected-test-root-link' }
if ((Get-Item -LiteralPath "$root/private").Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'unexpected-test-private-link' }
$state=Get-Content -LiteralPath "$root/private/test-certificates.json" -Raw | ConvertFrom-Json
if ($state.approvalReference -cne $OwnerApprovalReference) { throw 'cleanup-approval-reference-mismatch' }
$env:PSModulePath=$PSHOME+'\Modules'
Import-Module ($PSHOME+'\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$removed=@()
foreach ($entry in @(
  @{store='LocalMachine\Root';thumbprint=$state.caThumbprint;subject='CN=LuckyRay disposable CI update replay';deleteKey=$false},
  @{store='CurrentUser\My';thumbprint=$state.leafThumbprint;subject='CN=github.com';deleteKey=$true},
  @{store='CurrentUser\My';thumbprint=$state.caThumbprint;subject='CN=LuckyRay disposable CI update replay';deleteKey=$true}
)) {
  if (-not $entry.thumbprint) { continue }
  if ($entry.thumbprint -notmatch '\A[0-9a-fA-F]{40}\z') { throw 'cleanup-certificate-identity-invalid' }
  $certificatePath="Cert:\$($entry.store)\$($entry.thumbprint)"
  if (-not (Test-Path -LiteralPath $certificatePath)) { continue }
  $certificate=Get-Item -LiteralPath $certificatePath
  if ($certificate.Subject -cne $entry.subject) { throw 'cleanup-certificate-subject-mismatch' }
  if ($entry.deleteKey) { Remove-Item -LiteralPath $certificatePath -DeleteKey -Confirm:$false }
  else { Remove-Item -LiteralPath $certificatePath -Confirm:$false }
  if (Test-Path -LiteralPath $certificatePath) { throw 'cleanup-certificate-still-present' }
  $removed+=@{store=$entry.store;thumbprint=$entry.thumbprint;privateKeyDeleted=$entry.deleteKey}
}
# Explicit task-owned transient files only. No recursive deletion or profile cleanup.
$deletedFiles=@()
foreach ($name in @('replay-leaf.pfx','tls.json','paths.json','replay-ca.cer','test-certificates.json')) {
  $file=[IO.Path]::GetFullPath("$root/private/$name")
  if ([IO.Path]::GetDirectoryName($file) -cne "$root\private") { throw 'cleanup-target-outside-test-private-directory' }
  if (Test-Path -LiteralPath $file) {
    if ((Get-Item -LiteralPath $file).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'cleanup-target-link-refused' }
    Remove-Item -LiteralPath $file -Force
    $deletedFiles+=$name
  }
}
@{status='PASS_APPROVED_TEST_CONFIGURATION_REMOVED';removedCertificates=$removed;deletedTransientFiles=$deletedFiles;userComputerChanged=$false;productionTrustChanged=$false;privateMaterialUploaded=$false;profileDeleted=$false} | ConvertTo-Json -Depth 6 | Set-Content "$root/evidence/HTTPS-TEST-CLEANUP.json" -Encoding utf8
