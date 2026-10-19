param(
  [Parameter(Mandatory=$true)][int]$InstallerPid,
  [Parameter(Mandatory=$true)][string]$ExpectedSha256,
  [Parameter(Mandatory=$true)][string]$AllowedCache,
  [Parameter(Mandatory=$true)][string]$InstallRoot,
  [Parameter(Mandatory=$true)][ValidateSet('1033','2052')][string]$ExpectedLanguage
)
$ErrorActionPreference='Stop'
Import-Module ([IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop
Set-StrictMode -Version Latest
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:USERNAME -notlike 'runner*') { throw 'disposable-hosted-runner-only' }
if ([IO.Path]::GetFullPath($InstallRoot) -cne 'D:\lr-formal-uat\安装 空格') { throw 'unexpected-install-root' }
$owner=Get-CimInstance Win32_Process -Filter "ProcessId=$InstallerPid"
if (-not $owner -or -not $owner.ExecutablePath.StartsWith($AllowedCache+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'installer-owner-path-mismatch' }
if ((Get-FileHash -LiteralPath $owner.ExecutablePath).Hash.ToLowerInvariant() -cne $ExpectedSha256) { throw 'installer-owner-hash-mismatch' }
foreach ($option in @('/P','/UPDATE','/R')) {
  if ($owner.CommandLine -cnotmatch ('(?:^|\s)'+[regex]::Escape($option)+'(?:\s|$)')) { throw "official-install-option-missing:$option" }
}
if (-not $owner.CommandLine.EndsWith('/D='+$InstallRoot,[StringComparison]::Ordinal)) { throw 'installer-original-directory-not-pinned' }
$process=Get-Process -Id $InstallerPid
$null=$process.Handle
$observations=@()
$deadline=[DateTime]::UtcNow.AddSeconds(180)
$languagePrompt=$false
while ([DateTime]::UtcNow -lt $deadline) {
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
$language=[string](Get-ItemProperty -LiteralPath 'HKCU:\Software\luckyray\LuckyRay').'Installer Language'
$result=@{installerPid=$InstallerPid;parentPid=$owner.ParentProcessId;installerExitCode=$code;processExited=$exited;languagePromptObserved=$languagePrompt;storedLanguage=$language;expectedLanguage=$ExpectedLanguage;originalDirectory=$InstallRoot;officialPassiveArgumentsVerified=$true;uiAutomationActions=0;manualInstallerLaunch=$false;securityPromptsBypassed=$false;observations=$observations}
$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath 'D:\lr-formal-uat\evidence\passive-installer-observation.json' -Encoding utf8
if ($languagePrompt) { throw 'BLOCKED: product displayed a language prompt; no UI workaround attempted' }
if (-not $exited) { throw 'BLOCKED: installer did not finish without input; no blind click or termination' }
if ($code -ne 0) { throw "installer-failed-or-cancelled:$code" }
if ($language -cne $ExpectedLanguage) { throw 'installer-language-not-inherited' }
$result | ConvertTo-Json -Depth 6 -Compress
