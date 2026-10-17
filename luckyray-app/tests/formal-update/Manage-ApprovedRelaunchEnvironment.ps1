param(
  [Parameter(Mandatory=$true)][ValidateSet('Prepare','Remove')][string]$Mode,
  [Parameter(Mandatory=$true)][ValidateNotNullOrEmpty()][string]$OwnerApprovalReference,
  [string]$ProxyUrl
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:GITHUB_REPOSITORY -cne 'xiaorui2886/LuckyRay' -or $env:USERNAME -notlike 'runner*' -or $PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5) { throw 'disposable-public-native-windows-powershell-only' }
if ($OwnerApprovalReference -notmatch '\A[a-zA-Z0-9][a-zA-Z0-9._-]{3,79}\z') { throw 'fresh-owner-approval-reference-required' }
if ($env:GITHUB_RUN_ID -notmatch '\A[0-9]+\z') { throw 'run-identity-required' }
$env:PSModulePath=$PSHOME+'\Modules'
$root='D:\lr-formal-uat'
$journal="$root\private\relaunch-environment.json"
foreach ($directory in @($root,"$root\private","$root\evidence")) {
  $item=Get-Item -LiteralPath $directory
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'unexpected-test-directory' }
}
function Get-ExpectedValues([string]$Url) {
  if ($Url -cnotmatch '\Ahttp://127\.0\.0\.1:([0-9]{1,5})\z' -or [int]$Matches[1] -lt 1 -or [int]$Matches[1] -gt 65535) { throw 'loopback-proxy-url-required' }
  return [ordered]@{HTTPS_PROXY=$Url;HTTP_PROXY=$Url;NO_PROXY='127.0.0.1,localhost';WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9391'}
}
function Write-SafeEvidence([string]$Status,$Values) {
  @{status=$Status;approvalReference=$OwnerApprovalReference;runId=$env:GITHUB_RUN_ID;scope='HKCU Environment exact four temporary test values';values=$Values;machineEnvironmentChanged=$false;broadcastSent=$false;atUtc=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$root\evidence\RELAUNCH-ENVIRONMENT-$Mode.json" -Encoding utf8
}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$key=$null
$expected=$null
try {
  if ($Mode -eq 'Remove' -and -not [IO.File]::Exists($journal)) { return }
  if ([IO.File]::Exists($journal) -and ((Get-Item -LiteralPath $journal).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'unexpected-journal-link' }
  $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$true)
  if ($null -eq $key) { throw 'existing-user-environment-key-required' }
  if ($Mode -eq 'Prepare') {
    $expected=Get-ExpectedValues $ProxyUrl
    if ([IO.File]::Exists($journal)) { throw 'relaunch-journal-already-exists' }
    foreach ($name in $expected.Keys) {
      if (@($key.GetValueNames() | Where-Object { [string]::Equals($_,$name,[StringComparison]::OrdinalIgnoreCase) }).Count) { throw 'preexisting-test-environment-value-refused' }
    }
    # Exclusive journal creation happens before the first registry write. A failed
    # prepare leaves this complete intended ownership set for exact-value cleanup.
    $state=@{schema=1;approvalReference=$OwnerApprovalReference;runId=$env:GITHUB_RUN_ID;userSid=$identity.User.Value;proxyUrl=$ProxyUrl;kind='String';values=$expected}
    $bytes=[Text.Encoding]::UTF8.GetBytes(($state | ConvertTo-Json -Depth 5))
    $file=[IO.File]::Open($journal,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $file.Write($bytes,0,$bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
    foreach ($name in $expected.Keys) {
      # Recheck immediately before writing; never intentionally overwrite a value.
      if (@($key.GetValueNames() | Where-Object { [string]::Equals($_,$name,[StringComparison]::OrdinalIgnoreCase) }).Count) { throw 'test-environment-value-appeared-before-write' }
      $key.SetValue($name,$expected[$name],[Microsoft.Win32.RegistryValueKind]::String)
    }
    $key.Flush()
    foreach ($name in $expected.Keys) {
      if ($key.GetValueKind($name) -ne [Microsoft.Win32.RegistryValueKind]::String -or $key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -cne $expected[$name]) { throw 'test-environment-registry-readback-mismatch' }
    }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LuckyRayRelaunchEnvironment {
  [DllImport("userenv.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool CreateEnvironmentBlock(out IntPtr block, IntPtr token, [MarshalAs(UnmanagedType.Bool)] bool inherit);
  [DllImport("userenv.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool DestroyEnvironmentBlock(IntPtr block);
}
'@
    $block=[IntPtr]::Zero
    if (-not [LuckyRayRelaunchEnvironment]::CreateEnvironmentBlock([ref]$block,$identity.Token,$false)) { throw 'test-user-environment-block-unavailable' }
    $observed=@{}
    try {
      $cursor=$block
      while ([Runtime.InteropServices.Marshal]::ReadInt16($cursor) -ne 0) {
        $entry=[Runtime.InteropServices.Marshal]::PtrToStringUni($cursor)
        $separator=$entry.IndexOf('=')
        if ($separator -gt 0) {
          $name=$entry.Substring(0,$separator)
          if ($expected.Contains($name)) { $observed[$name]=$entry.Substring($separator+1) }
        }
        $cursor=[IntPtr]::Add($cursor,($entry.Length+1)*2)
      }
    } finally { $null=[LuckyRayRelaunchEnvironment]::DestroyEnvironmentBlock($block) }
    foreach ($name in $expected.Keys) {
      if (-not $observed.ContainsKey($name) -or $observed[$name] -cne $expected[$name]) { throw 'test-user-environment-block-readback-mismatch' }
    }
    Write-SafeEvidence 'PASS_EXACT_USER_ENVIRONMENT_BLOCK_READBACK' $observed
  } else {
    $state=[IO.File]::ReadAllText($journal) | ConvertFrom-Json
    if ($state.schema -ne 1 -or $state.approvalReference -cne $OwnerApprovalReference -or $state.runId -cne $env:GITHUB_RUN_ID -or $state.userSid -cne $identity.User.Value -or $state.kind -cne 'String') { throw 'relaunch-journal-ownership-mismatch' }
    $expected=Get-ExpectedValues $state.proxyUrl
    if (@($state.values.PSObject.Properties).Count -ne 4) { throw 'relaunch-journal-values-invalid' }
    foreach ($name in $expected.Keys) {
      if ($state.values.$name -cne $expected[$name]) { throw 'relaunch-journal-values-invalid' }
    }
    # Validate the whole set first. Missing keys are safe after partial prepare or
    # partial cleanup; changed keys are never deleted and the journal is retained.
    foreach ($name in $expected.Keys) {
      if ($key.GetValueNames() -icontains $name) {
        if ($key.GetValueKind($name) -ne [Microsoft.Win32.RegistryValueKind]::String -or $key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -cne $expected[$name]) { throw 'relaunch-cleanup-value-altered-refused' }
      }
    }
    foreach ($name in $expected.Keys) {
      if ($key.GetValueNames() -icontains $name) {
        if ($key.GetValueKind($name) -ne [Microsoft.Win32.RegistryValueKind]::String -or $key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -cne $expected[$name]) { throw 'relaunch-cleanup-value-altered-refused' }
        $key.DeleteValue($name,$true)
      }
    }
    $key.Flush()
    foreach ($name in $expected.Keys) { if ($key.GetValueNames() -icontains $name) { throw 'relaunch-cleanup-value-still-present' } }
    Write-SafeEvidence 'PASS_EXACT_TEST_USER_ENVIRONMENT_REMOVED' $expected
    [IO.File]::Delete($journal)
  }
} catch {
  # Static status and validated expected values only; never serialize an exception
  # or arbitrary environment contents. Keep the journal for exact cleanup.
  try { Write-SafeEvidence 'BLOCKED_RELAUNCH_ENVIRONMENT_JOURNAL_RETAINED_IF_CREATED' $expected } catch {}
  throw
} finally {
  if ($null -ne $key) { $key.Dispose() }
  $identity.Dispose()
}
