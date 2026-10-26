param([Parameter(Mandatory)][string]$Destination)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if($env:GITHUB_ACTIONS -cne 'true' -or $env:GITHUB_REPOSITORY -cne 'xiaorui2886/LuckyRay' -or $env:GITHUB_EVENT_NAME -cne 'workflow_dispatch' -or $env:RUNNER_OS -cne 'Windows'){throw 'trusted-manual-runner-required'}
if(-not $env:LUCKYRAY_CANDIDATE_READ_TOKEN){throw 'candidate-read-secret-not-configured'}
$root=[IO.Path]::GetFullPath($Destination)
$tempRoot=[IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')+'\'
if(-not $root.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $root)){throw 'private-download-target-not-fresh'}
New-Item -ItemType Directory -Path $root | Out-Null
$spec=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'inputs.json') -Raw | ConvertFrom-Json
if($spec.schema -ne 1 -or $spec.red.repository -cne 'xiaorui2886/luckyray-app' -or $spec.red.releaseId -ne 424207031){throw 'download-contract-invalid'}
$client=[Net.Http.HttpClient]::new()
$client.Timeout=[TimeSpan]::FromMinutes(8)
$client.DefaultRequestHeaders.UserAgent.ParseAdd('LuckyRay-Synthetic-Installed-Acceptance/1')
try{
 foreach($asset in $spec.red.assets){
  if($asset.id -ne 678062686 -or $asset.name -cne 'red-setup.exe'){throw 'asset-not-in-fixed-allowlist'}
  $request=[Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get,"https://api.github.com/repos/xiaorui2886/luckyray-app/releases/assets/$($asset.id)")
  $request.Headers.Authorization=[Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer',$env:LUCKYRAY_CANDIDATE_READ_TOKEN)
  $request.Headers.Accept.ParseAdd('application/octet-stream')
  $response=$client.SendAsync($request,[Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
  try{
   if(-not $response.IsSuccessStatusCode){throw 'private-asset-download-rejected'}
   $output=Join-Path $root $asset.name
   $stream=[IO.File]::Create($output)
   try{$response.Content.CopyToAsync($stream).GetAwaiter().GetResult()}finally{$stream.Dispose()}
   if((Get-Item -LiteralPath $output).Length -ne $asset.bytes -or (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant() -cne $asset.sha256){throw 'private-asset-identity-mismatch'}
  }finally{$response.Dispose();$request.Dispose()}
 }
 # Public released old installer uses a separate unauthenticated request.
 $response=$client.GetAsync($spec.oldPublic.url,[Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
 try{
  if(-not $response.IsSuccessStatusCode){throw 'old-public-download-rejected'}
  $output=Join-Path $root 'old-setup.exe';$stream=[IO.File]::Create($output)
  try{$response.Content.CopyToAsync($stream).GetAwaiter().GetResult()}finally{$stream.Dispose()}
  if((Get-Item -LiteralPath $output).Length -ne $spec.oldPublic.bytes -or (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant() -cne $spec.oldPublic.sha256){throw 'old-public-identity-mismatch'}
 }finally{$response.Dispose()}
 Write-Output 'Fixed installer identities verified; private bytes retained only in disposable runner temp.'
}catch{
 # Exception messages/response bodies/headers never enter public logs.
 Write-Error 'fixed-candidate-download-or-verification-failed' -ErrorAction Continue
 exit 1
}finally{
 $client.Dispose()
 Remove-Item Env:LUCKYRAY_CANDIDATE_READ_TOKEN -ErrorAction SilentlyContinue
}
