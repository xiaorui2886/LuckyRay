param([Parameter(Mandatory)][string]$InputRoot,[Parameter(Mandatory)][string]$EvidenceRoot)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if($env:GITHUB_ACTIONS -cne 'true' -or $env:GITHUB_REPOSITORY -cne 'xiaorui2886/LuckyRay' -or $env:GITHUB_EVENT_NAME -cne 'workflow_dispatch' -or $env:RUNNER_OS -cne 'Windows' -or $env:USERNAME -cne 'runneradmin'){throw 'disposable-manual-windows-only'}
foreach($entry in @(Get-ChildItem Env:)){
 if($entry.Name -match '(?i)(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)' -or $entry.Name -match '^(LUCKYRAY_|VITE_)' -or $entry.Name -eq 'NODE_OPTIONS'){Remove-Item -LiteralPath ('Env:'+$entry.Name)}
}
$installRoot='D:\LuckyRay 覆盖安装 验收'
$profile=Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'com.luckyray.desktop'
if((Test-Path -LiteralPath $installRoot) -or (Test-Path -LiteralPath $profile) -or @(Get-Process -Name 'luckyray-app' -ErrorAction SilentlyContinue).Count){throw 'disposable-target-not-fresh'}
if(Test-Path -LiteralPath $EvidenceRoot){throw 'evidence-target-not-fresh'}
New-Item -ItemType Directory -Path $EvidenceRoot | Out-Null
$record=[ordered]@{schema=1;case='old-public-install-then-frozen-red-overlay';status='FAIL';stage='old-install';source='839c53911e32ac21e58b4f61c354677a33425fea';oldInstallerSha256='2aa1d70187b706e523c576ddbdde2e981a84c31a59e9c003e155d1e766aa5a7e';redInstallerSha256='4ac3f8cc7a1c8b8740ed62cd3ec97f01f6e26069b0ed0657c92039e957ed6b43';actualProductExe=$true;modelRequests=0;userData=$false;realPhone='NOT_RUN';oldSessionsAttachments='NOT_RUN';normalStart='NOT_RUN';compatibleStart='NOT_RUN';rawLogsPublic=$false}
function Hash([string]$path){(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}
function Install([string]$name,[string]$hash){
 $file=Join-Path $InputRoot $name
 if((Hash $file) -cne $hash){throw 'installer-hash-mismatch'}
 $process=Start-Process -FilePath $file -ArgumentList @('/S',"/D=$installRoot") -WindowStyle Hidden -PassThru
 if(-not $process.WaitForExit(300000)){throw 'installer-timed-out'}
 if($process.ExitCode -ne 0){throw 'installer-failed'}
}
$script:cdpSequence=0
$script:cdpPort=50891
function Evaluate([string]$expression){
 $targets=Invoke-RestMethod -Uri "http://127.0.0.1:$script:cdpPort/json/list" -TimeoutSec 3
 $page=@($targets | Where-Object {$_.type -eq 'page' -and $_.url -match '^https?://tauri\.localhost'} | Select-Object -First 1)
 if($page.Count -ne 1){throw 'main-webview-cdp-not-ready'}
 $socket=[Net.WebSockets.ClientWebSocket]::new()
 $cancel=[Threading.CancellationTokenSource]::new(45000)
 try{
  [void]$socket.ConnectAsync([Uri]$page[0].webSocketDebuggerUrl,$cancel.Token).GetAwaiter().GetResult()
  $script:cdpSequence+=1
  $payload=@{id=$script:cdpSequence;method='Runtime.evaluate';params=@{expression=$expression;awaitPromise=$true;returnByValue=$true}} | ConvertTo-Json -Compress -Depth 6
  $bytes=[Text.Encoding]::UTF8.GetBytes($payload)
  [void]$socket.SendAsync([ArraySegment[byte]]::new($bytes),[Net.WebSockets.WebSocketMessageType]::Text,$true,$cancel.Token).GetAwaiter().GetResult()
  while($true){
   $buffer=[byte[]]::new(65536);$message=[IO.MemoryStream]::new()
   do{
    $received=$socket.ReceiveAsync([ArraySegment[byte]]::new($buffer),$cancel.Token).GetAwaiter().GetResult()
    $message.Write($buffer,0,$received.Count)
    if($message.Length -gt 262144){throw 'cdp-response-too-large'}
   }while(-not $received.EndOfMessage)
   $value=[Text.Encoding]::UTF8.GetString($message.ToArray()) | ConvertFrom-Json
   $message.Dispose()
   if($value.PSObject.Properties.Name -contains 'id' -and $value.id -eq $script:cdpSequence){
    if($value.PSObject.Properties.Name -contains 'error' -or $value.result.PSObject.Properties.Name -contains 'exceptionDetails'){throw 'cdp-evaluation-failed'}
    return $value.result.result.value
   }
  }
 }finally{$socket.Dispose();$cancel.Dispose()}
}
try{
 Install 'old-setup.exe' $record.oldInstallerSha256
 $record.oldInstalledVersion=(Get-Item -LiteralPath (Join-Path $installRoot 'luckyray-app.exe')).VersionInfo.ProductVersion
 if($record.oldInstalledVersion -cne '1.9.8'){throw 'old-product-version-mismatch'}
 $record.oldRuntimeFiles=@(Get-ChildItem -LiteralPath (Join-Path $installRoot 'deepseek-harness') -File -Recurse -Force).Count
 $record.stage='red-overlay'
 Install 'red-setup.exe' $record.redInstallerSha256
 $exe=Join-Path $installRoot 'luckyray-app.exe'
 $record.exeSha256=Hash $exe
 if($record.exeSha256 -cne '6d97366ba82220d66ce7d331e72d26f4b331c83bd3dc13130fe1e6c67a5ca2da'){throw 'red-product-identity-mismatch'}
 $record.overlayRuntimeFiles=@(Get-ChildItem -LiteralPath (Join-Path $installRoot 'deepseek-harness') -File -Recurse -Force).Count
 $record.stage='actual-product-normal-start'
 # Process-scoped loopback DevTools on this disposable VM only. No models,
 # alternate host, global security policy, caller validation bypass or profile override.
 $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=50891 --remote-debugging-address=127.0.0.1'
 $app=Start-Process -FilePath $exe -WorkingDirectory $installRoot -WindowStyle Normal -PassThru
 $deadline=[DateTime]::UtcNow.AddSeconds(90);$connected=$false
 while([DateTime]::UtcNow -lt $deadline){
  $app.Refresh();if($app.HasExited){throw 'actual-product-exited'}
  try{$connected=Evaluate 'Boolean(window.__TAURI_INTERNALS__)';if($connected){break}}catch{}
  Start-Sleep -Seconds 2
 }
 if(-not $connected){throw 'actual-product-webview-not-accessible'}
 $record.respondingWindow=$app.MainWindowHandle.ToInt64() -ne 0 -and $app.Responding
 $status=Evaluate '(async()=>{const s=await window.__TAURI_INTERNALS__.invoke("dsh_host_status");return {stage:s.stage,canProbe:s.canProbe,canRetry:s.canRetry}})()'
 $record.normalStart=$status.stage
 $record.hostCanProbe=$status.canProbe
 $record.hostCanRetry=$status.canRetry
 $record.normalSurface=Evaluate '(async()=>{try{const s=await window.__TAURI_INTERNALS__.invoke("dsh_native_surface_open",{bounds:{x:100,y:100,width:700,height:500}});return {ok:true,stage:s?.stage??"unknown"}}catch(e){return {ok:false,code:typeof e==="string"&&/^[a-z][a-z0-9-]{2,100}$/.test(e)?e:"unknown"}}})()'
 $record.compatibleStart=Evaluate '(async()=>{try{const s=await window.__TAURI_INTERNALS__.invoke("dsh_plugin_compat_apply",{action:{kind:"compatible"}});return {ok:true,outcome:s?.outcome??"unknown"}}catch(e){return {ok:false,code:typeof e==="string"&&/^[a-z][a-z0-9-]{2,100}$/.test(e)?e:"unknown"}}})()'
 $all=@(Get-CimInstance Win32_Process);$owned=@($app.Id)
 do{$new=@($all | Where-Object {$_.ParentProcessId -in $owned -and $_.ProcessId -notin $owned} | Select-Object -ExpandProperty ProcessId);$owned+=$new}while($new.Count)
 $record.ownedNodeCount=@($all | Where-Object {$_.ProcessId -in $owned -and $_.Name -eq 'node.exe'}).Count
 $errorFile=Join-Path $profile 'dsh-engine-updates/last-switch-error.json'
 if(Test-Path -LiteralPath $errorFile){
  $errorRecord=Get-Content -LiteralPath $errorFile -Raw | ConvertFrom-Json
  $record.admissionErrorCategory=$errorRecord.errorCategory
  $record.admissionErrorStage=$errorRecord.stage
 }
 $record.stage='red-observation-complete'
 $record.status=if($status.stage -eq 'unavailable' -and $record.ownedNodeCount -eq 0 -and $record.overlayRuntimeFiles -ne 35192){'RED_REPRODUCED_ACTUAL_PRODUCT_OVERLAY'}else{'RED_NOT_REPRODUCED'}
 # Existing ordinary full-quit path, not a forced termination.
 try{Evaluate 'window.__TAURI_INTERNALS__.invoke("close_window").then(()=>true)' | Out-Null}catch{}
 $record.normalExitObserved=$app.WaitForExit(20000)
}catch{
 $message=$_.Exception.Message
 $record.failure=if($message -cmatch '^[a-z][a-z0-9-]{2,100}$'){$message}else{'unexpected-details-withheld'}
 $record.errorType=$_.Exception.GetType().Name
}finally{
 $record | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $EvidenceRoot 'red-result.json') -Encoding utf8
 $record | ConvertTo-Json -Depth 6
}
if($record.status -cne 'RED_REPRODUCED_ACTUAL_PRODUCT_OVERLAY'){exit 1}
