param([Parameter(Mandatory=$true)][ValidateNotNullOrEmpty()][string]$OwnerApprovalReference)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:GITHUB_REPOSITORY -cne 'xiaorui2886/LuckyRay' -or $env:USERNAME -notlike 'runner*' -or $PSVersionTable.PSEdition -ne 'Desktop') { throw 'disposable-public-native-windows-powershell-only' }
if ($OwnerApprovalReference -notmatch '\A[a-zA-Z0-9][a-zA-Z0-9._-]{3,79}\z') { throw 'fresh-owner-approval-reference-required' }
# A Windows PowerShell child inherits PowerShell7's module search path in Actions.
# Select only this native host's standard modules, in this child process only.
$env:PSModulePath=$PSHOME+'\Modules'
$root='D:\lr-formal-uat'
if (-not (Test-Path -LiteralPath "$root/private") -or -not (Test-Path -LiteralPath "$root/evidence")) { throw 'approved-test-root-required' }
function Stage([string]$name) { @{atUtc=[DateTime]::UtcNow.ToString('o');stage=$name} | ConvertTo-Json -Compress | Tee-Object -FilePath "$root/evidence/HTTPS-PREPARE-STAGES.jsonl" -Append }
Stage 'initialize-native-certificate-provider'
# The native PKI cmdlet does not itself guarantee Cert: provider initialization.
# No store or machine policy is changed by importing the standard modules.
Import-Module ($PSHOME+'\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
Import-Module PKI -ErrorAction Stop
$null=Get-PSDrive -Name Cert -ErrorAction Stop
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'existing-runner-administrator-required-no-elevation' }
Stage 'create-ephemeral-ca'
$expiry=(Get-Date).AddDays(1)
$ca=New-SelfSignedCertificate -Type Custom -Subject 'CN=LuckyRay disposable CI update replay' -CertStoreLocation Cert:\CurrentUser\My -KeyUsage CertSign,CRLSign -TextExtension @('2.5.29.19={critical}{text}ca=TRUE&pathlength=0') -NotAfter $expiry
Stage 'create-github-leaf'
$leaf=New-SelfSignedCertificate -Type Custom -Subject 'CN=github.com' -DnsName github.com -Signer $ca -CertStoreLocation Cert:\CurrentUser\My -KeyUsage DigitalSignature,KeyEncipherment -TextExtension @('2.5.29.19={text}ca=FALSE','2.5.29.37={text}1.3.6.1.5.5.7.3.1') -NotAfter $expiry
Stage 'export-public-ca'
Export-Certificate -Cert $ca -FilePath "$root/private/replay-ca.cer" | Out-Null
Stage 'import-approved-ephemeral-machine-ca'
# Owner separately approved this disposable runner's LocalMachine Root store.
# Use the runner's existing administrator identity, never prompt or self-elevate.
# CA/leaf private keys remain in CurrentUser My and never leave this runner.
$imported=Import-Certificate -FilePath "$root/private/replay-ca.cer" -CertStoreLocation Cert:\LocalMachine\Root -Confirm:$false
$readback=Get-Item -LiteralPath "Cert:\LocalMachine\Root\$($ca.Thumbprint)" -ErrorAction Stop
if ($imported.Thumbprint -cne $ca.Thumbprint -or [Convert]::ToBase64String($readback.RawData) -cne [Convert]::ToBase64String($ca.RawData)) { throw 'approved-ca-import-readback-mismatch' }
Stage 'approved-ephemeral-machine-ca-import-verified'
$random=New-Object byte[] 32
$rng=[Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($random) } finally { $rng.Dispose() }
$password=[Convert]::ToBase64String($random)
$secure=ConvertTo-SecureString $password -AsPlainText -Force
Stage 'export-private-leaf-locally-only'
Export-PfxCertificate -Cert $leaf -FilePath "$root/private/replay-leaf.pfx" -Password $secure -CryptoAlgorithmOption AES256_SHA256 | Out-Null
@{pfx="$root/private/replay-leaf.pfx";password=$password} | ConvertTo-Json | Set-Content "$root/private/tls.json" -Encoding utf8
@{install="$root/安装 空格";profile="$env:APPDATA/com.luckyray.desktop";local=$env:LOCALAPPDATA;tls="$root/private/tls.json"} | ConvertTo-Json | Set-Content "$root/private/paths.json" -Encoding utf8
@{scope='Owner-approved disposable GitHub runner LocalMachine Root only';rootStore='LocalMachine';existingRunnerAdministrator=$true;selfElevationAttempted=$false;certificateExpiresAt=$expiry.ToUniversalTime().ToString('o');caThumbprint=$ca.Thumbprint;productionTrustChanged=$false;userComputerChanged=$false;publicFeedChanged=$false;privateCertificateFilesUploaded=$false;securityPromptsClicked=$false;nativeCertificateProviderInitialized=$true} | ConvertTo-Json | Set-Content "$root/evidence/HTTPS-TEST-SCOPE.json" -Encoding utf8
$password=$null;$secure=$null
[Array]::Clear($random,0,$random.Length)
Stage 'ephemeral-https-prepare-complete'
