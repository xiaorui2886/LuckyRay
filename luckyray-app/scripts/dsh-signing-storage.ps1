param([Parameter(Mandatory=$true)][string]$Path, [switch]$VerifyOnly)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Public path arguments only. This guard never handles passwords or key bytes.
$signingOperator = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$signingSystem = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
try {
    if ($Path -notmatch '^[A-Za-z]:[\\/]' -or $Path.StartsWith('\\')) { throw 'absolute-local-path-required' }
    $signingPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    if ($signingPath -eq [System.IO.Path]::GetPathRoot($signingPath).TrimEnd('\') -or
        $signingPath -match '(?i)(^|[\\/])(AppData|OneDrive[^\\/]*|Dropbox|Google Drive|iCloudDrive|Windows|Program Files(?: \(x86\))?|ProgramData|\.git)([\\/]|$)') { throw 'protected-or-cloud-path' }
    $signingCursor = $signingPath
    while ($signingCursor) {
        if (Test-Path -LiteralPath $signingCursor) {
            $signingItem = Get-Item -LiteralPath $signingCursor -Force
            if (($signingItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'linked-path' }
            if (Test-Path -LiteralPath (Join-Path $signingCursor '.git')) { throw 'repository-path' }
            foreach ($signingInstallMarker in @('luckyray-app.exe', 'tauri.conf.json', 'Initialize-LshProductionRoot.ps1')) {
                if (Test-Path -LiteralPath (Join-Path $signingCursor $signingInstallMarker)) { throw 'installation-or-tool-directory' }
            }
        }
        $signingParent = [System.IO.Directory]::GetParent($signingCursor)
        if ($null -eq $signingParent) { break }
        $signingCursor = $signingParent.FullName
    }
    if (-not $VerifyOnly) {
        if (Test-Path -LiteralPath $signingPath) { throw 'choose-new-empty-leaf-directory' }
        $signingParentPath = Split-Path -Parent $signingPath
        if (-not (Test-Path -LiteralPath $signingParentPath -PathType Container)) { throw 'parent-directory-required' }
        # Create with the restricted security descriptor atomically; never a
        # briefly world-readable directory containing a secret.
        $signingAcl = New-Object System.Security.AccessControl.DirectorySecurity
        $signingAcl.SetOwner($signingOperator)
        $signingAcl.SetAccessRuleProtection($true, $false)
        foreach ($signingIdentity in @($signingOperator, $signingSystem)) {
            $signingRule = New-Object System.Security.AccessControl.FileSystemAccessRule($signingIdentity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
            $signingAcl.AddAccessRule($signingRule)
        }
        [System.IO.Directory]::CreateDirectory($signingPath, $signingAcl) | Out-Null
    }
    if (-not (Test-Path -LiteralPath $signingPath -PathType Container)) { throw 'directory-required' }
    # WindowsPowerShell 5.1 framework API avoids module autoload differences in
    # Node-launched children; permission checks below are exactly unchanged.
    $signingActual = [System.IO.Directory]::GetAccessControl($signingPath)
    if (-not $signingActual.AreAccessRulesProtected -or $signingActual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $signingOperator.Value) { throw 'owner-or-inheritance' }
    $signingRules = @($signingActual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    if ($signingRules.Count -ne 2) { throw 'unexpected-acl-entry' }
    foreach ($signingRule in $signingRules) {
        if ($signingRule.IdentityReference.Value -notin @($signingOperator.Value, $signingSystem.Value) -or
            $signingRule.AccessControlType -ne 'Allow' -or $signingRule.FileSystemRights -ne 'FullControl' -or
            $signingRule.InheritanceFlags -ne ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit) -or $signingRule.PropagationFlags -ne 'None') { throw 'unexpected-acl-entry' }
    }
    # Existing key/receipt copies inherit exactly this descriptor; reject an
    # independently exposed file or a substituted filesystem link.
    foreach ($signingChild in @(Get-ChildItem -LiteralPath $signingPath -Force)) {
        if ($signingChild.PSIsContainer -or ($signingChild.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unexpected-storage-entry' }
        $signingFileAcl = [System.IO.File]::GetAccessControl($signingChild.FullName)
        foreach ($signingRule in @($signingFileAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))) {
            if ($signingRule.IdentityReference.Value -notin @($signingOperator.Value, $signingSystem.Value) -or $signingRule.AccessControlType -ne 'Allow') { throw 'exposed-storage-file' }
        }
    }
    Write-Output 'SIGNING_STORAGE_VERIFIED'
} catch { Write-Error 'Signing storage rejected: use a new user-controlled, non-cloud, non-AppData directory outside repositories and installations, with only operator/SYSTEM ACL.'; exit 1 }
