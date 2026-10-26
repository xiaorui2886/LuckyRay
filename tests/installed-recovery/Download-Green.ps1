param([Parameter(Mandatory)][string]$Destination)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
if($env:GITHUB_ACTIONS -cne 'true' -or $env:GITHUB_REPOSITORY -cne 'xiaorui2886/LuckyRay' -or $env:GITHUB_EVENT_NAME -cne 'workflow_dispatch' -or $env:RUNNER_OS -cne 'Windows'){throw 'trusted-manual-runner-required'}
$root=[IO.Path]::GetFullPath($Destination);$temp=[IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')+'\'
if(-not $root.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $root)){throw 'private-input-target-not-fresh'}
$spec=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'inputs-green.json') -Raw | ConvertFrom-Json
if($spec.schema -ne 1 -or $spec.repository -cne 'xiaorui2886/luckyray-app' -or $spec.asset.id -le 0 -or $spec.asset.sha256 -cnotmatch '^[a-f0-9]{64}$' -or $spec.source -cnotmatch '^[a-f0-9]{40}$'){throw 'fixed-green-inputs-invalid'}
New-Item -ItemType Directory -Path $root | Out-Null
$handler=[Net.Http.HttpClientHandler]::new();$handler.AllowAutoRedirect=$false
$client=[Net.Http.HttpClient]::new($handler);$client.Timeout=[TimeSpan]::FromMinutes(10)
$client.DefaultRequestHeaders.UserAgent.ParseAdd('LuckyRay-Synthetic-Installed-Acceptance/1')
$phase='capability';$httpStatus=$null
function Download([Uri]$uri,[string]$file){
 $response=$client.GetAsync($uri,[Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
 try{
  $script:httpStatus=[int]$response.StatusCode;if(-not $response.IsSuccessStatusCode){throw 'fixed-download-rejected'}
  $stream=[IO.File]::Create($file);try{[void]$response.Content.CopyToAsync($stream).GetAwaiter().GetResult()}finally{$stream.Dispose()}
 }finally{$response.Dispose()}
}
function Check-File([string]$file,$definition){
 if((Get-Item -LiteralPath $file).Length -ne $definition.bytes -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $definition.sha256){throw 'fixed-file-identity-mismatch'}
}
try{
 $uri=[Uri]$env:LUCKYRAY_FIXED_ASSET_DOWNLOAD_URL
 if(-not $uri.IsAbsoluteUri -or $uri.Scheme -cne 'https' -or $uri.Host -cne 'release-assets.githubusercontent.com' -or $uri.UserInfo -or $uri.Fragment){throw 'capability-origin-invalid'}
 $query=@{};foreach($item in $uri.Query.TrimStart('?').Split('&')){$pair=$item.Split('=',2);if($pair.Length -eq 2){$query[$pair[0]]=[Uri]::UnescapeDataString($pair[1])}}
 if(-not $query.ContainsKey('se') -or -not $query.ContainsKey('sig')){throw 'capability-expiry-missing'}
 $expires=[DateTimeOffset]::Parse($query['se']).ToUniversalTime()
 if($expires -le [DateTimeOffset]::UtcNow -or $expires -gt [DateTimeOffset]::UtcNow.AddMinutes(61)){throw 'capability-outside-short-lifetime'}
 $phase='private-fixed-archive';$archive=Join-Path $root 'fixed-inputs.zip';Download $uri $archive;Check-File $archive $spec.asset
 Remove-Item Env:LUCKYRAY_FIXED_ASSET_DOWNLOAD_URL -ErrorAction SilentlyContinue
 $phase='allowlisted-archive-extraction';$zip=[IO.Compression.ZipFile]::OpenRead($archive)
 try{
  $allowed=@('candidate-setup.exe','old021-setup.exe','old020-fixture.zip');$entries=@($zip.Entries)
  if($entries.Count -ne 3){throw 'private-archive-entry-set-invalid'}
  foreach($entry in $entries){
   if($entry.FullName -cnotin $allowed -or $entry.Length -gt 500000000 -or $entry.Length -le 0){throw 'private-archive-entry-invalid'}
   [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,(Join-Path $root $entry.FullName),$false)
  }
 }finally{$zip.Dispose()}
 Check-File (Join-Path $root 'candidate-setup.exe') $spec.candidate
 Check-File (Join-Path $root 'old021-setup.exe') $spec.old021
 Check-File (Join-Path $root 'old020-fixture.zip') $spec.old020Fixture
 $phase='public-old-198';$url=[Uri]$spec.oldPublic.url
 for($redirect=0;$redirect -lt 4;$redirect++){
  if($url.Scheme -cne 'https' -or $url.Host -notin @('github.com','release-assets.githubusercontent.com','objects.githubusercontent.com')){throw 'public-download-origin-invalid'}
  $response=$client.GetAsync($url,[Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult();$httpStatus=[int]$response.StatusCode
  if($httpStatus -in @(301,302,303,307,308)){$url=$response.Headers.Location;$response.Dispose();continue}
  break
 }
 try{
  if(-not $response.IsSuccessStatusCode){throw 'public-old-download-rejected'}
  $file=Join-Path $root 'old-setup.exe';$stream=[IO.File]::Create($file)
  try{[void]$response.Content.CopyToAsync($stream).GetAwaiter().GetResult()}finally{$stream.Dispose()}
 }finally{$response.Dispose()}
 Check-File $file $spec.oldPublic
 Write-Output 'Fixed private inputs and public old installer hashes verified. No repository token, private source or profile was transferred.'
}catch{
 $message=$_.Exception.Message;$code=if($message -cmatch '^[a-z][a-z0-9-]{2,100}$'){$message}else{'download-details-withheld'}
 [ordered]@{phase=$phase;httpStatus=$httpStatus;code=$code;errorType=$_.Exception.GetType().Name} | ConvertTo-Json -Compress | Write-Output
 exit 1
}finally{$client.Dispose();$handler.Dispose();Remove-Item Env:LUCKYRAY_FIXED_ASSET_DOWNLOAD_URL -ErrorAction SilentlyContinue}
