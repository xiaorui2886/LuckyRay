# One user-local entry. Request contains public reviewed metadata only.
# Never run through an agent transcript; private paths/passphrase stay local.
param([Parameter(Mandatory=$true)][string]$RequestPath, [switch]$CheckOnly)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$reviewedRequestFile = Get-Item -LiteralPath $RequestPath -Force
if ($reviewedRequestFile.PSIsContainer -or $reviewedRequestFile.Length -lt 1 -or $reviewedRequestFile.Length -gt 16384 -or
    ($reviewedRequestFile.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Invalid public signing request.' }
$reviewedRequest = Get-Content -LiteralPath $reviewedRequestFile.FullName -Raw | ConvertFrom-Json
$reviewedFields = @($reviewedRequest.PSObject.Properties.Name | Sort-Object)
$reviewedExpected = @('schema','state','centralReview','sourceHead','candidatePath','descriptorPath','contractPath','approvedPayloadSha256','envelopeOutput') | Sort-Object
if (($reviewedFields -join '|') -cne ($reviewedExpected -join '|') -or $reviewedRequest.schema -ne 1 -or
    $reviewedRequest.state -cne 'approved-final-first-signing') { throw 'Final combined candidate review is pending. No key, private directory or prompt opened.' }
if ($reviewedRequest.centralReview -cnotmatch '^https://github\.com/xiaorui2886/luckyray-app/issues/195#issuecomment-[0-9]{1,20}$' -or
    $reviewedRequest.sourceHead -cnotmatch '^[a-f0-9]{40}$' -or $reviewedRequest.approvedPayloadSha256 -cnotmatch '^[a-f0-9]{64}$') {
    throw 'Missing exact central review/source/payload identity.'
}
$reviewedAppRoot = Split-Path -Parent $PSScriptRoot
$reviewedHead = & git.exe -C $reviewedAppRoot rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $reviewedHead.Trim() -cne $reviewedRequest.sourceHead) { throw 'Reviewed source HEAD differs. No signing started.' }
# CLI identity attestation and unrelated docs are not authority inputs. Changed
# maintainer, host, adapter or broker source must be reviewed, never silently used.
& git.exe -C $reviewedAppRoot diff --quiet HEAD -- scripts config src src-tauri/src src-tauri/build.rs src-tauri/dsh-host tests
if ($LASTEXITCODE -ne 0) { throw 'Reviewed signing/host source has changed. No signing started.' }
foreach ($reviewedName in @('candidatePath','descriptorPath','contractPath','envelopeOutput')) {
    if ($reviewedRequest.$reviewedName -cnotmatch '^[A-Za-z]:[\\/]') { throw 'Reviewed public inputs need absolute local paths.' }
}
foreach ($reviewedName in @('candidatePath','descriptorPath','contractPath')) {
    if (-not (Test-Path -LiteralPath $reviewedRequest.$reviewedName -PathType Leaf)) { throw 'Reviewed public input is missing. No signing started.' }
}
$reviewedPayloadFile = Get-Item -LiteralPath $reviewedRequest.candidatePath -Force
if ($reviewedPayloadFile.Length -lt 1 -or $reviewedPayloadFile.Length -gt 65536) { throw 'Reviewed payload size differs. No signing started.' }
# Use the framework directly: a clean WindowsPowerShell child may not inherit
# a compatible PSModulePath for Get-FileHash. No module install is required.
$reviewedHashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
$reviewedPayloadStream = [System.IO.File]::OpenRead($reviewedPayloadFile.FullName)
try { $reviewedPayloadHash = [BitConverter]::ToString($reviewedHashAlgorithm.ComputeHash($reviewedPayloadStream)).Replace('-','').ToLowerInvariant() }
finally { $reviewedPayloadStream.Dispose(); $reviewedHashAlgorithm.Dispose() }
if ($reviewedPayloadHash -cne $reviewedRequest.approvedPayloadSha256) { throw 'Reviewed payload bytes differ. No signing started.' }
if (Test-Path -LiteralPath $reviewedRequest.envelopeOutput) { throw 'Signed output already exists. Preserve it; do not initialize again.' }
if ($CheckOnly) {
    Write-Output 'REVIEWED_PUBLIC_REQUEST_PREFLIGHT_PASS_NO_PRIVATE_OPERATION'
    return
}
Write-Host 'Final reviewed production initialization and first signature. No network, client or profile changes.'
& (Join-Path $PSScriptRoot 'Initialize-LshProductionRoot.ps1') -CandidatePath $reviewedRequest.candidatePath -DescriptorPath $reviewedRequest.descriptorPath -ContractPath $reviewedRequest.contractPath -ApprovedPayloadSha256 $reviewedRequest.approvedPayloadSha256 -EnvelopeOutput $reviewedRequest.envelopeOutput
