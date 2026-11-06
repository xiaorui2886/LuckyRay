# Run ONCE in an ordinary local PowerShell, not through an agent transcript.
# No profile override, client activation, network operation or publication.
param([ValidateSet('init','sign')][string]$Mode='init', [string]$CandidatePath, [string]$DescriptorPath, [string]$ContractPath, [string]$ApprovedPayloadSha256, [string]$EnvelopeOutput, [string]$ExistingSigningDirectory='')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($Mode -ne 'sign' -and $ExistingSigningDirectory) { throw 'Existing directory is supported only for signing, not root creation.' }
function ConvertTo-ExistingSigningDirectory([string]$InputPath) {
    $value = $InputPath.Trim()
    if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[$value.Length - 1] -eq '"') -or
        ($value[0] -eq "'" -and $value[$value.Length - 1] -eq "'"))) {
        $value = $value.Substring(1, $value.Length - 2)
    }
    if ($value -notmatch '^[A-Za-z]:[\\/]') { throw 'Absolute local drive path required.' }
    return [System.IO.Path]::GetFullPath($value)
}
function Resolve-ExistingSigningDirectory([string]$InputPath, [string]$ExpectedPublicKey) {
    $directory = ConvertTo-ExistingSigningDirectory $InputPath
    $rootItem = Get-Item -LiteralPath $directory -Force
    if (-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Existing signing directory must be a regular local directory.'
    }
    # A copied key folder may contain its original leaf. Only the direct
    # directory or a unique direct child with the pinned PUBLIC receipt is
    # selected. Private key contents are not opened by this lookup.
    $candidates = @($rootItem)
    if (-not (Test-Path -LiteralPath (Join-Path $directory 'public-root-receipt.json') -PathType Leaf)) {
        $children = @(Get-ChildItem -LiteralPath $directory -Directory -Force)
        if ($children.Count -gt 64) { throw 'Use the exact existing private signing leaf directory.' }
        $candidates += $children | Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) }
    }
    $matches = @()
    foreach ($candidate in $candidates) {
        $receipt = Join-Path $candidate.FullName 'public-root-receipt.json'
        $encrypted = Join-Path $candidate.FullName 'production-root.encrypted.pem'
        if (-not (Test-Path -LiteralPath $receipt -PathType Leaf) -or -not (Test-Path -LiteralPath $encrypted -PathType Leaf)) { continue }
        $items = @(Get-Item -LiteralPath $receipt,$encrypted -Force)
        if (@($items | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count -or $items[0].Length -gt 8192) { continue }
        try { $public = [IO.File]::ReadAllText($receipt, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { continue }
        if ($public.purpose -eq 'luckyray-production-root' -and $public.publicKey -ceq $ExpectedPublicKey) { $matches += $candidate.FullName }
    }
    if ($matches.Count -ne 1) { throw 'No unique existing signing directory matches the pinned public receipt. No key was read or generated.' }
    return $matches[0]
}
$signingInitialCandidate = $null
if ($CandidatePath -or $DescriptorPath -or $ContractPath -or $ApprovedPayloadSha256 -or $EnvelopeOutput) {
    if (-not $CandidatePath -or -not $DescriptorPath -or -not $ContractPath -or $ApprovedPayloadSha256 -cnotmatch '^[a-f0-9]{64}$' -or -not $EnvelopeOutput) { throw 'Complete centrally approved initial candidate inputs required.' }
    if (Test-Path -LiteralPath $EnvelopeOutput) { throw 'Signed envelope output must not exist.' }
    $signingInitialCandidate = @{ candidatePath=$CandidatePath; descriptorPath=$DescriptorPath; contract=(Get-Content -LiteralPath $ContractPath -Raw | ConvertFrom-Json); approvedPayloadSha256=$ApprovedPayloadSha256; output=$EnvelopeOutput }
}
Write-Host 'Production-only LSH signing operation. Do not paste secrets into chat.'
if ($Mode -eq 'init') {
    Write-Host 'Choose three NEW leaf directories outside repositories, installations, AppData and cloud sync.'
    Write-Host 'At least one backup must use a separate mounted volume. Keep the passphrase separately.'
    if ((Read-Host 'Confirm these locations are controlled by you, not installations or any sync service; type YES') -cne 'YES') { throw 'Storage confirmation required. No files or key created.' }
    $signingPrimary = Read-Host 'Private signing directory (absolute path)'
    $signingBackupOne = Read-Host 'First encrypted backup directory (absolute path)'
    $signingBackupTwo = Read-Host 'Second encrypted backup directory (absolute path)'
    $signingDirs = @($signingPrimary, $signingBackupOne, $signingBackupTwo) | ForEach-Object {
        if ($_ -notmatch '^[A-Za-z]:[\\/]') { throw 'Absolute local drive paths required. No key generated.' }
        [System.IO.Path]::GetFullPath($_).TrimEnd('\')
    }
    if (@($signingDirs | Select-Object -Unique).Count -ne 3 -or @($signingDirs | ForEach-Object { [System.IO.Path]::GetPathRoot($_).ToLowerInvariant() } | Select-Object -Unique).Count -lt 2) { throw 'Choose independent directories and a separate backup volume before continuing.' }
    foreach ($signingDirectory in $signingDirs) {
        $signingStorageResult = & (Join-Path $PSScriptRoot 'dsh-signing-storage.ps1') -Path $signingDirectory
        if ($signingStorageResult -cne 'SIGNING_STORAGE_VERIFIED') { throw 'Storage preflight stopped. No key generated.' }
    }
} else {
    if ($null -eq $signingInitialCandidate) { throw 'Signing requires the complete reviewed candidate inputs.' }
    $signingExistingPath = if ($ExistingSigningDirectory) { $ExistingSigningDirectory } else { Read-Host 'Existing private signing directory (absolute path)' }
    $signingSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../config/dsh-production-update-source.json') -Raw | ConvertFrom-Json
    $signingPrimary = Resolve-ExistingSigningDirectory $signingExistingPath $signingSource.publicKey
    $signingStorageResult = & (Join-Path $PSScriptRoot 'dsh-signing-storage.ps1') -Path $signingPrimary -VerifyOnly
    if ($signingStorageResult -cne 'SIGNING_STORAGE_VERIFIED') { throw 'Storage preflight stopped.' }
}
$signingPasswordPrompt = if ($Mode -eq 'init') { 'Strong NEW passphrase (20+ characters, preferably password-manager generated)' } else { 'Existing production key passphrase (not a new password)' }
$signingPassword = Read-Host $signingPasswordPrompt -AsSecureString
$signingConfirm = Read-Host 'Repeat passphrase' -AsSecureString
$signingBstr = [IntPtr]::Zero
$signingConfirmBstr = [IntPtr]::Zero
$signingProcess = $null
try {
    $signingBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($signingPassword)
    $signingConfirmBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($signingConfirm)
    $signingPlain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($signingBstr)
    if ($signingPlain.Length -lt 20 -or $signingPlain -cne [Runtime.InteropServices.Marshal]::PtrToStringBSTR($signingConfirmBstr)) { throw 'Passphrases do not match or are too short. No key generated.' }
    $signingInfo = New-Object System.Diagnostics.ProcessStartInfo
    $signingInfo.FileName = (Get-Command node.exe -ErrorAction Stop).Source
    $signingScript = Join-Path $PSScriptRoot 'dsh-production-maintenance.mjs'
    $signingInfo.Arguments = '"' + $signingScript + '" ' + $Mode
    $signingInfo.UseShellExecute = $false
    $signingInfo.CreateNoWindow = $true
    $signingInfo.RedirectStandardInput = $true
    $signingInfo.RedirectStandardOutput = $true
    $signingInfo.RedirectStandardError = $true
    $signingProcess = [System.Diagnostics.Process]::Start($signingInfo)
    if ($Mode -eq 'init') {
        $signingRequestObject = @{ primary=$signingDirs[0]; backupOne=$signingDirs[1]; backupTwo=$signingDirs[2]; passphrase=$signingPlain }
        if ($null -ne $signingInitialCandidate) { $signingRequestObject.initialCandidate = $signingInitialCandidate }
    } else {
        $signingRequestObject = @{ keyDirectory=$signingPrimary; passphrase=$signingPlain }
        foreach ($signingEntry in $signingInitialCandidate.GetEnumerator()) { $signingRequestObject[$signingEntry.Key] = $signingEntry.Value }
    }
    $signingRequest = $signingRequestObject | ConvertTo-Json -Depth 8 -Compress
    # Windows PowerShell 5.1 has no StandardInputEncoding property. Write UTF-8
    # bytes directly, without placing the request in arguments or a temp file.
    $signingInputBytes = [System.Text.Encoding]::UTF8.GetBytes($signingRequest)
    try {
        $signingProcess.StandardInput.BaseStream.Write($signingInputBytes, 0, $signingInputBytes.Length)
        $signingProcess.StandardInput.BaseStream.Flush()
    } finally { [Array]::Clear($signingInputBytes, 0, $signingInputBytes.Length) }
    $signingProcess.StandardInput.Close()
    $signingRequest = $null; $signingPlain = $null; $signingRequestObject.passphrase = $null
    $signingOutput = $signingProcess.StandardOutput.ReadToEnd()
    $signingError = $signingProcess.StandardError.ReadToEnd()
    $signingProcess.WaitForExit()
    if ($signingProcess.ExitCode -ne 0) { throw 'Initialization stopped. Keep created files; do not retry or delete keys. Ask the maintainer to inspect the non-secret operator state.' }
    $signingReceipt = $signingOutput | ConvertFrom-Json
    if ($Mode -eq 'init') {
        if ($signingReceipt.purpose -ne 'luckyray-production-root' -or -not $signingReceipt.restoreProof.verified) { throw 'Invalid public receipt.' }
        Write-Host 'Encrypted root, two backups and actual backup restore signing proof completed.'
    } else {
        if ($signingReceipt.outcome -ne 'SIGNED_NOT_PUBLISHED_OR_ACTIVATED') { throw 'Invalid signing receipt.' }
        Write-Host 'Reviewed candidate signed locally, not published or activated.'
    }
    Write-Host 'Share ONLY the following public receipt. Activation still requires central review.'
    Write-Output $signingOutput.Trim()
} finally {
    if ($signingBstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($signingBstr) }
    if ($signingConfirmBstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($signingConfirmBstr) }
    $signingPlain = $null; $signingRequest = $null
    $signingPassword.Dispose(); $signingConfirm.Dispose()
    if ($null -ne $signingProcess) { $signingProcess.Dispose() }
}
