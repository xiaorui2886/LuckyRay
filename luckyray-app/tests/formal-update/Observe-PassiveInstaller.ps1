param(
  [Parameter(Mandatory=$true)][string]$ReadyFile,
  [Parameter(Mandatory=$true)][string]$CancelFile,
  [Parameter(Mandatory=$true)][string]$ExpectedSha256,
  [Parameter(Mandatory=$true)][string]$AllowedCache,
  [Parameter(Mandatory=$true)][string]$InstallRoot,
  [Parameter(Mandatory=$true)][ValidateSet('1033','2052')][string]$ExpectedLanguage
)
function Get-ObservedExecutablePath($Candidate) {
  # A newly-created process can have a handle before its main module exists.
  $module=$Candidate.MainModule
  if ($null -eq $module) { return $null }
  return $module.FileName
}
function Get-ObservedFileSha256([string]$Path) {
  $stream=[IO.File]::OpenRead($Path)
  $sha=[Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
  finally { $sha.Dispose(); $stream.Dispose() }
}
$ErrorActionPreference='Stop' 
Set-StrictMode -Version Latest
$env:PSModulePath=$PSHOME+'\Modules'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:USERNAME -notlike 'runner*') { throw 'disposable-hosted-runner-only' }
if ([IO.Path]::GetFullPath($InstallRoot) -cne 'D:\lr-formal-uat\安装 空格') { throw 'unexpected-install-root' }
$InstallRoot=[IO.Path]::GetFullPath($InstallRoot)
$privateRoot='D:\lr-formal-uat\private'
foreach ($file in @($ReadyFile,$CancelFile)) {
  if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($file)) -cne $privateRoot) { throw 'observer-control-outside-private-root' }
  if (Test-Path -LiteralPath $file) { throw 'observer-control-already-exists' }
}
# Arm before the triggering action. Hold the OS process handle immediately,
# before CIM inspection, file hashing, or waiting for the parent to exit.
if (@([Diagnostics.Process]::GetProcessesByName('LuckyRay-update')).Count) { throw 'preexisting-installer-refused' }
[IO.File]::WriteAllText($ReadyFile,'READY')
$deadline=[DateTime]::UtcNow.AddSeconds(180)
$process=$null
$owner=$null
while ([DateTime]::UtcNow -lt $deadline -and -not $process) {
  if (Test-Path -LiteralPath $CancelFile) { throw 'observer-cancelled-before-installer' }
  foreach ($candidate in [Diagnostics.Process]::GetProcessesByName('LuckyRay-update')) {
    try {
      $null=$candidate.Handle
      $candidatePath=Get-ObservedExecutablePath $candidate
      if ([string]::IsNullOrWhiteSpace($candidatePath)) { $candidate.Dispose(); continue }
      if (-not $candidatePath.StartsWith($AllowedCache+'\',[StringComparison]::OrdinalIgnoreCase)) { $candidate.Dispose(); continue }
      $candidateOwner=Get-CimInstance Win32_Process -Filter "ProcessId=$($candidate.Id)" -OperationTimeoutSec 5
      if ($null -eq $candidateOwner -or [string]::IsNullOrWhiteSpace($candidateOwner.ExecutablePath) -or [string]::IsNullOrWhiteSpace($candidateOwner.CommandLine)) { $candidate.Dispose(); continue }
      $process=$candidate
      $owner=$candidateOwner
      break
    } catch [System.InvalidOperationException] { $candidate.Dispose(); $process=$null; $owner=$null }
      catch [System.ComponentModel.Win32Exception] {
        $candidate.Dispose(); $process=$null; $owner=$null
        if ($_.Exception.NativeErrorCode -notin @(6,299)) { throw }
      }
  }
  if (-not $process) { Start-Sleep -Milliseconds 40 }
}
if (-not $process -or -not $owner) { throw 'installer-start-not-observed' }
$InstallerPid=$process.Id
if (-not $owner.ExecutablePath.StartsWith($AllowedCache+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'installer-owner-path-mismatch' }
# Record identity while alive, including its parent. Validate parent in the
# caller against the actual A / scheduled-start PID, never by process name.
@{installerPid=$InstallerPid;parentPid=$owner.ParentProcessId;exe=$owner.ExecutablePath;observedAtUtc=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress | Set-Content -LiteralPath 'D:\lr-formal-uat\evidence\installer-start.json' -Encoding utf8
if ((Get-ObservedFileSha256 $owner.ExecutablePath) -cne $ExpectedSha256) { throw 'installer-owner-hash-mismatch' }
foreach ($option in @('/P','/UPDATE','/R')) {
  if ($owner.CommandLine -cnotmatch ('(?:^|\s)'+[regex]::Escape($option)+'(?:\s|$)')) { throw "official-install-option-missing:$option" }
}
if (-not $owner.CommandLine.EndsWith('/D='+$InstallRoot,[StringComparison]::Ordinal)) { throw 'installer-original-directory-not-pinned' }
$observations=@()
$deadline=[DateTime]::UtcNow.AddSeconds(180)
$languagePrompt=$false
while ([DateTime]::UtcNow -lt $deadline) {
  if (Test-Path -LiteralPath $CancelFile) { throw 'observer-cancelled-during-installer' }
  $process.Refresh()
  if ($process.HasExited) { break }
  $title=$process.MainWindowTitle
  $observations+=@{atUtc=[DateTime]::UtcNow.ToString('o');title=$title}
  if ($title -match 'Installer Language|安装程序语言|安装语言') { $languagePrompt=$true; break }
  Start-Sleep -Milliseconds 500
}
$process.Refresh()
$exited=$process.HasExited
$code=if($exited){$process.ExitCode}else{$null}
$language=$null
$languageReadError=$null
try { $language=[string](Get-ItemProperty -LiteralPath 'HKCU:\Software\luckyray\LuckyRay').'Installer Language' }
catch { $languageReadError=$_.Exception.Message }
$result=@{installerPid=$InstallerPid;parentPid=$owner.ParentProcessId;installerExitCode=$code;processExited=$exited;languagePromptObserved=$languagePrompt;storedLanguage=$language;languageReadError=$languageReadError;expectedLanguage=$ExpectedLanguage;originalDirectory=$InstallRoot;installerSha256=$ExpectedSha256;observerArmedBeforeTrigger=$true;officialPassiveArgumentsVerified=$true;uiAutomationActions=0;manualInstallerLaunch=$false;securityPromptsBypassed=$false;observations=$observations}
$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath 'D:\lr-formal-uat\evidence\passive-installer-observation.json' -Encoding utf8
if ($languagePrompt) { throw 'BLOCKED: product displayed a language prompt; no UI workaround attempted' }
if (-not $exited) { throw 'BLOCKED: installer did not finish without input; no blind click or termination' }
if ($code -ne 0) { throw "installer-failed-or-cancelled:$code" }
if ($language -cne $ExpectedLanguage) { throw 'installer-language-not-inherited' }
$result | ConvertTo-Json -Depth 6 -Compress
