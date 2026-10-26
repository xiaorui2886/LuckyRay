param([Parameter(Mandatory)][string]$Destination)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if($env:GITHUB_ACTIONS -cne 'true' -or $env:GITHUB_REPOSITORY -cne 'xiaorui2886/LuckyRay' -or $env:GITHUB_EVENT_NAME -cne 'workflow_dispatch' -or $env:RUNNER_OS -cne 'Windows'){throw 'trusted-manual-runner-required'}
if(-not $env:LUCKYRAY_FIXED_ASSET_DOWNLOAD_URL){throw 'fixed-asset-capability-not-configured'}
$root=[IO.Path]::GetFullPath($Destination)
$tempRoot=[IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')+'\'
if(-not $root.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $root)){throw 'private-download-target-not-fresh'}
New-Item -ItemType Directory -Path $root | Out-Null
$spec=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'inputs.json') -Raw | ConvertFrom-Json
if($spec.schema -ne 1 -or $spec.red.repository -cne 'xiaorui2886/luckyray-app' -or $spec.red.assets.Count -ne 1 -or $spec.red.assets[0].id -ne 678062686){throw 'download-contract-invalid'}
$handler=[Net.Http.HttpClientHandler]::new();$handler.AllowAutoRedirect=$false
$client=[Net.Http.HttpClient]::new($handler);$client.Timeout=[TimeSpan]::FromMinutes(8)
$client.DefaultRequestHeaders.UserAgent.ParseAdd('LuckyRay-Synthetic-Installed-Acceptance/1')
$phase='capability-validation';$httpStatus=$null;$actualBytes=$null
try{
 $uri=[Uri]$env:LUCKYRAY_FIXED_ASSET_DOWNLOAD_URL
 if(-not $uri.IsAbsoluteUri -or $uri.Scheme -cne 'https' -or $uri.Host -cne 'release-assets.githubusercontent.com' -or $uri.UserInfo -or $uri.Fragment){throw 'capability-origin-invalid'}
 $query=@{};foreach($item in $uri.Query.TrimStart('?').Split('&')){$pair=$item.Split('=',2);if($pair.Length -eq 2){$query[$pair[0]]=[Uri]::UnescapeDataString($pair[1])}}
 if(-not $query.ContainsKey('se') -or -not $query.ContainsKey('sig')){throw 'capability-expiry-missing'}
 $expires=[DateTimeOffset]::Parse($query['se']).ToUniversalTime()
 if($expires -le [DateTimeOffset]::UtcNow -or $expires -gt [DateTimeOffset]::UtcNow.AddMinutes(61)){throw 'capability-outside-short-lifetime'}
 $phase='fixed-private-download'
 $response=$client.GetAsync($uri,[Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
 try{
  $httpStatus=[int]$response.StatusCode
  if(-not $response.IsSuccessStatusCode){throw 'fixed-private-download-rejected'}
  $asset=$spec.red.assets[0];$output=Join-Path $root 'red-setup.exe';$stream=[IO.File]::Create($output)
  try{[void]$response.Content.CopyToAsync($stream).GetAwaiter().GetResult()}finally{$stream.Dispose()}
  $phase='private-identity';$actualBytes=(Get-Item -LiteralPath $output).Length
  if($actualBytes -ne $asset.bytes -or (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant() -cne $asset.sha256){throw 'private-identity-mismatch'}
 }finally{$response.Dispose()}
 # No authorization header or repository credential exists in this job.
 # Public released input follows only GitHub's approved release hosts.
 $phase='old-public-download';$httpStatus=$null;$actualBytes=$null
 $url=[Uri]$spec.oldPublic.url
 for($redirect=0;$redirect -lt 4;$redirect++){
  if($url.Scheme -cne 'https' -or $url.Host -notin @('github.com','release-assets.githubusercontent.com','objects.githubusercontent.com')){throw 'public-download-origin-invalid'}
  $response=$client.GetAsync($url,[Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
  $httpStatus=[int]$response.StatusCode
  if($httpStatus -in @(301,302,303,307,308)){$url=$response.Headers.Location;$response.Dispose();continue}
  break
 }
 try{
  if(-not $response.IsSuccessStatusCode){throw 'old-public-download-rejected'}
  $output=Join-Path $root 'old-setup.exe';$stream=[IO.File]::Create($output)
  try{[void]$response.Content.CopyToAsync($stream).GetAwaiter().GetResult()}finally{$stream.Dispose()}
  $phase='old-public-identity';$actualBytes=(Get-Item -LiteralPath $output).Length
  if($actualBytes -ne $spec.oldPublic.bytes -or (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant() -cne $spec.oldPublic.sha256){throw 'old-public-identity-mismatch'}
 }finally{$response.Dispose()}
 Write-Output 'Fixed installer hashes verified; no repository token provided to this job.'
}catch{
 $message=$_.Exception.Message
 $code=if($message -cmatch '^[a-z][a-z0-9-]{2,100}$'){$message}else{'download-details-withheld'}
 [ordered]@{phase=$phase;httpStatus=$httpStatus;actualBytes=$actualBytes;code=$code;errorType=$_.Exception.GetType().Name} | ConvertTo-Json -Compress | Write-Output
 exit 1
}finally{
 $client.Dispose();$handler.Dispose()
 Remove-Item Env:LUCKYRAY_FIXED_ASSET_DOWNLOAD_URL -ErrorAction SilentlyContinue
}
