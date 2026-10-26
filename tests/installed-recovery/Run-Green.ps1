param(
 [Parameter(Mandatory)][string]$InputRoot,
 [Parameter(Mandatory)][string]$EvidenceRoot,
 [Parameter(Mandatory)][ValidateSet('fresh','old020','old021')][string]$Case
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if($env:GITHUB_ACTIONS -cne 'true' -or $env:GITHUB_REPOSITORY -cne 'xiaorui2886/LuckyRay' -or $env:GITHUB_EVENT_NAME -cne 'workflow_dispatch' -or $env:RUNNER_OS -cne 'Windows' -or $env:USERNAME -cne 'runneradmin'){throw 'disposable-manual-windows-only'}
foreach($entry in @(Get-ChildItem Env:)){
 if($entry.Name -match '(?i)(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)' -or $entry.Name -match '^(LUCKYRAY_|VITE_)' -or $entry.Name -eq 'NODE_OPTIONS'){Remove-Item -LiteralPath ('Env:'+$entry.Name)}
}
$spec=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'inputs-green.json') -Raw | ConvertFrom-Json
$installRoot='D:\LuckyRay 中文 安装验收'
$profile=Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'com.luckyray.desktop'
if((Test-Path -LiteralPath $installRoot) -or (Test-Path -LiteralPath $profile) -or @(Get-Process -Name 'luckyray-app' -ErrorAction SilentlyContinue).Count){throw 'disposable-target-not-fresh'}
if(Test-Path -LiteralPath $EvidenceRoot){throw 'evidence-target-not-fresh'}
New-Item -ItemType Directory -Path $EvidenceRoot | Out-Null
$record=[ordered]@{schema=1;case=$Case;status='FAIL';stage='preflight';source=$spec.source;installerSha256=$spec.candidate.sha256;actualProductExe=$true;modelRequests=0;userData=$false;realAndroid='NOT_RUN';userInstalled='NOT_RUN';rawLogsPublic=$false;checks=@()}
$script:cdpSequence=0; $script:cdpPort=50891; $script:app=$null
$slot=Join-Path $installRoot 'lr-lsh\199-1'
$exe=Join-Path $installRoot 'luckyray-app.exe'
$proof=Join-Path $InputRoot 'synthetic-protected.json'
function Hash([string]$path){(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}
function Check([string]$name,[bool]$ok){$script:record.checks+=@{name=$name;passed=$ok};if(-not $ok){throw ('check-failed-'+$name)}}
function Confirm-CompatStatus($applied,$status){
 $expected=@($applied.quarantineSet | Sort-Object -Unique)
 $actual=@($status.quarantineSet | Sort-Object -Unique)
 Check 'compatible-quarantine-selection-preserved' (@(Compare-Object -ReferenceObject $expected -DifferenceObject $actual).Count -eq 0)
 # Native compatMode means that a real guard overlay was loaded. An empty
 # third-party composition has no guard, even after an accepted compatible
 # action. Do not invent an isolated plugin or claim that isolation was tested.
 Check 'compatible-guard-state-matches-real-selection' ($status.compatMode -eq ($expected.Count -gt 0) -and $applied.guardActive -eq ($expected.Count -gt 0))
 $script:record.compatibleTargetCount=$expected.Count
 $script:record.compatibleExtensionIsolation=if($expected.Count){'PASS_GUARD_SELECTED'}else{'NOT_APPLICABLE_NO_THIRD_PARTY_TARGETS'}
}
function Install([string]$name,[string]$hash){
 $file=Join-Path $InputRoot $name
 if((Hash $file) -cne $hash){throw 'installer-hash-mismatch'}
 $process=Start-Process -FilePath $file -ArgumentList @('/S',"/D=$installRoot") -WindowStyle Hidden -PassThru
 if(-not $process.WaitForExit(300000)){throw 'installer-timed-out'}
 if($process.ExitCode -ne 0){throw 'installer-failed'}
}
function Evaluate([string]$expression,[switch]$Lsh){
 $targets=Invoke-RestMethod -Uri "http://127.0.0.1:$script:cdpPort/json/list" -TimeoutSec 3
 $page=@($targets | Where-Object {
  if($_.type -ne 'page'){return $false}
  $uri=[Uri]$_.url
  if($Lsh){return $uri.IsAbsoluteUri -and $uri.Scheme -eq 'http' -and $uri.Host -eq '127.0.0.1'}
  return $_.url -match '^https?://tauri\.localhost'
 } | Select-Object -First 1)
 if($page.Count -ne 1){throw 'product-webview-not-ready'}
 $socket=[Net.WebSockets.ClientWebSocket]::new();$cancel=[Threading.CancellationTokenSource]::new(60000)
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
   $value=[Text.Encoding]::UTF8.GetString($message.ToArray()) | ConvertFrom-Json; $message.Dispose()
   if($value.PSObject.Properties.Name -contains 'id' -and $value.id -eq $script:cdpSequence){
    if($value.PSObject.Properties.Name -contains 'error' -or $value.result.PSObject.Properties.Name -contains 'exceptionDetails'){throw 'cdp-evaluation-failed'}
    return $value.result.result.value
   }
  }
 }finally{$socket.Dispose();$cancel.Dispose()}
}
function Start-Product([switch]$Legacy) {
 $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=50891 --remote-debugging-address=127.0.0.1'
 $script:app=Start-Process -FilePath $exe -WorkingDirectory $installRoot -WindowStyle Normal -PassThru
 $began=[DateTime]::UtcNow;$deadline=$began.AddSeconds(90);$connected=$false;$domReady=$false
 while([DateTime]::UtcNow -lt $deadline){
  $script:app.Refresh();if($script:app.HasExited){throw 'actual-product-exited'}
  try{
   $connected=Evaluate 'Boolean(window.__TAURI_INTERNALS__)'
   $domReady=if($Legacy){$connected}else{Evaluate 'Boolean(document.querySelector(".nav-item[data-control-id=ai]"))'}
   if($connected -and $domReady){break}
  }catch{}
  Start-Sleep -Milliseconds 700
 }
 Check 'actual-main-window' ($connected -and $script:app.MainWindowHandle.ToInt64() -ne 0 -and $script:app.Responding)
 if(-not $script:record.Contains('mainWindowReadiness')){$script:record.mainWindowReadiness=@()}
 $script:record.mainWindowReadiness+=@{legacy=[bool]$Legacy;ipcReady=[bool]$connected;sidebarReady=[bool]$domReady;elapsedMs=[int]([DateTime]::UtcNow-$began).TotalMilliseconds}
 if(-not $Legacy){Check 'actual-rendered-sidebar-ready' ([bool]$domReady)}
}
function Stop-Product {
 if($null -eq $script:app -or $script:app.HasExited){return}
 try{Evaluate 'window.__TAURI_INTERNALS__.invoke("close_window").then(()=>true)' | Out-Null}catch{}
 Check 'ordinary-exit' ($script:app.WaitForExit(25000))
 $script:app=$null
}
function Surface-Check([string]$label){
 # Drive the existing frontend coordinator, which joins its one startup flight.
 # Direct native open bypassed that queue and raced the app-owned preload.
 # Do not add a fixed sleep, retry a failed startup, or manufacture readiness.
 $clicked=Evaluate '(()=>{const row=document.querySelector(".nav-item[data-control-id=ai]");if(!row)return false;row.click();return true})()'
 Check ($label+'-actual-sidebar-entry') ([bool]$clicked)
 $deadline=[DateTime]::UtcNow.AddSeconds(120);$surface=$null;$dom=$false;$status=$null
 $observed=[Collections.Generic.List[string]]::new()
 while([DateTime]::UtcNow -lt $deadline){
  try{
   $status=Evaluate 'window.__TAURI_INTERNALS__.invoke("dsh_host_status").then(s=>({stage:s.stage,latestProbePassed:s.latestProbePassed}))'
   if(-not $observed.Contains([string]$status.stage)){$observed.Add([string]$status.stage)}
   if($status.stage -ceq 'unavailable'){break}
   $dom=Evaluate 'Boolean(document.body && document.body.children.length && document.readyState==="complete")' -Lsh
   $surface=Evaluate 'window.__TAURI_INTERNALS__.invoke("dsh_native_surface_status").then(s=>({stage:s.stage,ready:s.ready}))'
  }catch{}
  if($dom -and $null -ne $surface -and $surface.ready -and $surface.stage -in @('client-ready','session-open')){break}; Start-Sleep -Milliseconds 500
 }
 if(-not $script:record.Contains('hostTransitions')){$script:record.hostTransitions=@()}
 $script:record.hostTransitions+=@{label=$label;stages=@($observed.ToArray());lastSurfaceStage=if($null -ne $surface){$surface.stage}else{'unknown'}}
 Check ($label+'-host-probe-completed') ($null -ne $status -and $status.stage -ceq 'probe-completed' -and $status.latestProbePassed)
 Check ($label+'-lsh-webview-client-ready') ([bool]$dom -and $null -ne $surface -and $surface.ready -and $surface.stage -in @('client-ready','session-open'))
 $all=@(Get-CimInstance Win32_Process);$owned=@($script:app.Id)
 do{$new=@($all | Where-Object {$_.ParentProcessId -in $owned -and $_.ProcessId -notin $owned} | Select-Object -ExpandProperty ProcessId);$owned+=$new}while($new.Count)
 $nodes=@($all | Where-Object {$_.ProcessId -in $owned -and $_.Name -eq 'node.exe'})
 Check ($label+'-owned-node-carrier') ($nodes.Count -ge 2)
 Check ($label+'-selected-owned-node') (@($nodes | Where-Object {$_.ExecutablePath -ieq (Join-Path $slot 'deepseek-harness\node\node.exe')}).Count -eq $nodes.Count)
 $active=Get-Content -LiteralPath (Join-Path $profile 'dsh-engine-updates\active.json') -Raw | ConvertFrom-Json
 Check ($label+'-selected-rc3') ($active.schema -eq 2 -and $active.version -ceq '0.2.1-rc.3')
 $script:record.selected='0.2.1-rc.3';$script:record.ownedNodeCount=$nodes.Count
}
function Synthetic-Check([string]$mode,[string]$runtime,[string]$host){
 $node=Join-Path $runtime 'node\node.exe'
 & $node (Join-Path $PSScriptRoot 'Synthetic-Data.mjs') $mode $runtime $host $profile $proof *> (Join-Path $InputRoot ("synthetic-$mode-private.log"))
 Check ('synthetic-data-'+$mode) ($LASTEXITCODE -eq 0)
}
function Prepare-Qualified020 {
 $archive=Join-Path $InputRoot 'old020-fixture.zip'
 Check 'qualified020-fixture-identity' ((Hash $archive) -ceq $spec.old020Fixture.sha256)
 $store=Join-Path $profile 'dsh-engine-updates'
 if(Test-Path -LiteralPath $store){throw 'synthetic-update-store-not-fresh'}
 New-Item -ItemType Directory -Path $store -Force | Out-Null
 $prefix=[IO.Path]::GetFullPath($store).TrimEnd('\')+'\'
 $artifact='8341da97364d1dc8ee2a32f9c36b1f9da04efd87a0e9853a50a905c1e6aeb7e6'
 $zip=[IO.Compression.ZipFile]::OpenRead($archive);$seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
 try{
  if($zip.Entries.Count -gt 80000){throw 'synthetic-legacy-archive-too-large'}
  foreach($entry in $zip.Entries){
   $name=$entry.FullName.Replace('\','/')
   if($name -cnotin @('active.json','transaction.json','versions/') -and -not $name.StartsWith(('versions/'+$artifact+'/'),[StringComparison]::Ordinal)){throw 'synthetic-legacy-entry-not-allowlisted'}
   if($name.Split('/') -contains '..' -or $name.Contains(':') -or -not $seen.Add($name)){throw 'synthetic-legacy-entry-unsafe'}
   $path=[IO.Path]::GetFullPath((Join-Path $store $name))
   if(-not $path.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){throw 'synthetic-legacy-entry-outside-store'}
   if($name.EndsWith('/')){[IO.Directory]::CreateDirectory($path)|Out-Null;continue}
   [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))|Out-Null
   [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$path,$false)
  }
 }finally{$zip.Dispose()}
 $runtime=Join-Path $store ('versions\'+$artifact)
 $version=(Get-Content -LiteralPath (Join-Path $runtime 'host\node_modules\@deepseek-ai\dsh\package.json') -Raw | ConvertFrom-Json).version
 Check 'qualified020-runtime-version-and-count' ($version -ceq '0.2.0-rc.2' -and @(Get-ChildItem -LiteralPath $runtime -File -Recurse -Force).Count -eq 25810)
 Check 'qualified020-active-record-exact' ((Hash (Join-Path $store 'active.json')) -ceq $spec.old020Fixture.activeSha256)
 Check 'qualified020-journal-record-exact' ((Hash (Join-Path $store 'transaction.json')) -ceq $spec.old020Fixture.journalSha256)
 return $runtime
}
function Draft-Check([switch]$Write){
 $saved=Get-Content -LiteralPath $proof -Raw | ConvertFrom-Json
 $key='dsh.conversation.'+[string]$saved.sessionId
 $deadline=[DateTime]::UtcNow.AddSeconds(20);$editable=$false
 while([DateTime]::UtcNow -lt $deadline){
  $editable=Evaluate '(()=>{const notice=[...document.querySelectorAll("button")].filter(x=>["继续","Continue"].includes(x.textContent.trim())&&x.getBoundingClientRect().height>0);if(notice.length===1){notice[0].click();return false}const e=document.querySelector("[contenteditable=true]");if(e&&e.getBoundingClientRect().height>0)return true;for(const label of ["LR installed synthetic preservation","LUCKYRAY_DSH_NATIVE_PROBE"]){const matches=[...document.querySelectorAll("button,[role=button],[role=treeitem],span,div")].filter(x=>x.childElementCount===0&&x.textContent.trim()===label);if(matches.length){const x=matches[0];(x.closest("button,[role=button],[role=treeitem],a")||x).click();break}}return false})()' -Lsh
  if($editable){break};Start-Sleep -Milliseconds 400
 }
 Check 'synthetic-session-editor-visible' ([bool]$editable)
 if($Write){
  $inserted=Evaluate '(()=>{const e=document.querySelector("[contenteditable=true]");if(!e)return false;e.focus();document.execCommand("selectAll",false);document.execCommand("insertText",false,"LR 合成未发送草稿 — installed recovery");return e.textContent.includes("LR 合成未发送草稿")})()' -Lsh
  Check 'real-editor-draft-input' ([bool]$inserted)
 }
 $keyJs=ConvertTo-Json -InputObject $key -Compress
 $deadline=[DateTime]::UtcNow.AddSeconds(15);$persisted=$false
 while([DateTime]::UtcNow -lt $deadline){
  $persisted=Evaluate ('(()=>{const key='+$keyJs+';const v=JSON.parse(localStorage.getItem(key)||"{}");const text=typeof v.draft==="string"?v.draft:v.draft?.text;return typeof text==="string"&&text.includes("LR 合成未发送草稿")&&document.querySelector("[contenteditable=true]")?.textContent.includes("LR 合成未发送草稿")})()') -Lsh
  if($persisted){break};Start-Sleep -Milliseconds 400
 }
 Check $(if($Write){'draft-persisted'}else{'draft-restored-after-reopen'}) ([bool]$persisted)
 $script:record.newDraft='PASS_ACTUAL_WEBVIEW_UNSENT_DRAFT'
}
function Gateway-Product-Check {
 $script:record.gatewayProductRecovery='NOT_RUN'
 Start-Product
 $interfaces=@(Evaluate 'window.__TAURI_INTERNALS__.invoke("companion_gateway_list_interfaces")')
 if($interfaces.Count -eq 0){$script:record.gatewayNotRunReason='runner-has-no-eligible-lan-interface';Stop-Product;return}
 $address=[string]$interfaces[0].address;$addressJs=ConvertTo-Json -InputObject $address -Compress
 $initial=Evaluate ('window.__TAURI_INTERNALS__.invoke("companion_gateway_start",{bindAddress:'+$addressJs+'})')
 Check 'gateway-initial-actual-listener' ($initial.state -ceq 'running' -and $initial.bindAddress -ceq $address -and $initial.port -gt 0)
 $port=[int]$initial.port;Stop-Product
 $blocker=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Parse($address),$port)
 $blocker.ExclusiveAddressUse=$true;$blocker.Start()
 try{
  Start-Product
  $failed=Evaluate 'window.__TAURI_INTERNALS__.invoke("companion_gateway_status")'
  Check 'gateway-occupied-resume-failure' ($failed.state -ceq 'resume-failed' -and $failed.bindFailure.kind -ceq 'address-in-use' -and $failed.port -eq $port)
  $script:record.gatewayBindFailure=@{stage=$failed.bindFailure.stage;kind=$failed.bindFailure.kind;osCode=$failed.bindFailure.osCode;attempts=$failed.bindFailure.attempts}
  $args='{expectedAddress:'+$addressJs+',expectedPort:'+$port+',confirmed:'
  $cancel=Evaluate ('window.__TAURI_INTERNALS__.invoke("companion_gateway_recover_endpoint",'+$args+'false}).then(()=>"unexpected",e=>e.code)')
  Check 'gateway-cancel-does-not-recover' ($cancel -ceq 'gateway-recovery-confirmation-required')
  $running=Evaluate ('window.__TAURI_INTERNALS__.invoke("companion_gateway_recover_endpoint",'+$args+'true})')
  Check 'gateway-confirmed-same-interface-new-port' ($running.state -ceq 'running' -and $running.bindAddress -ceq $address -and $running.port -gt 0 -and $running.port -ne $port)
  $listening=@(Get-NetTCPConnection -State Listen -LocalAddress $address -LocalPort $running.port -ErrorAction SilentlyContinue)
  Check 'gateway-os-listener-owned-by-actual-product' (@($listening | Where-Object {$_.OwningProcess -eq $script:app.Id}).Count -eq 1)
  $oldListening=@(Get-NetTCPConnection -State Listen -LocalAddress $address -LocalPort $port -ErrorAction SilentlyContinue)
  Check 'gateway-does-not-steal-occupied-port' (@($oldListening | Where-Object {$_.OwningProcess -eq $PID}).Count -eq 1)
  Check 'gateway-original-identity-and-pin-preserved' ($running.desktopInstanceId -ceq $initial.desktopInstanceId -and $running.certificateFingerprint -ceq $initial.certificateFingerprint)
  $presentation=Evaluate 'window.__TAURI_INTERNALS__.invoke("companion_gateway_endpoint_recovery_presentation")'
  Check 'gateway-recovery-envelope-exact-fields' ((@($presentation.envelope.PSObject.Properties.Name | Sort-Object) -join ',') -ceq 'baseUrl,certificateFingerprint,desktopInstanceId,kind,schema')
  Check 'gateway-recovery-envelope-live-endpoint' ($presentation.envelope.baseUrl -ceq ('https://'+$address+':'+$running.port) -and $presentation.envelope.schema -eq 1 -and $presentation.envelope.kind -ceq 'luckyray.endpoint-recovery' -and $presentation.envelope.desktopInstanceId -ceq $initial.desktopInstanceId -and $presentation.envelope.certificateFingerprint -ceq $initial.certificateFingerprint -and $presentation.qrSize -gt 0)
  Stop-Product;Start-Product
  $reopened=Evaluate 'window.__TAURI_INTERNALS__.invoke("companion_gateway_status")'
  Check 'gateway-actual-port-persists-after-reopen' ($reopened.state -ceq 'running' -and $reopened.port -eq $running.port -and $reopened.bindAddress -ceq $address -and $reopened.desktopInstanceId -ceq $initial.desktopInstanceId -and $reopened.certificateFingerprint -ceq $initial.certificateFingerprint)
  Stop-Product
  $script:record.gatewayProductRecovery='PASS_ACTUAL_EXE_BIND_RECOVERY_AND_REOPEN_NOT_ANDROID'
 }finally{$blocker.Stop()}
}
try{
 if($Case -ne 'fresh'){
  $record.stage='old-install'
  if($Case -eq 'old020'){Install 'old-setup.exe' $spec.oldPublic.sha256}else{Install 'old021-setup.exe' $spec.old021.sha256}
  $record.oldProductVersion=(Get-Item -LiteralPath $exe).VersionInfo.ProductVersion
  $runtime=Join-Path $installRoot 'deepseek-harness';$host=Join-Path $installRoot 'dsh-host'
  $record.oldEngineVersion=(Get-Content -LiteralPath (Join-Path $runtime 'host\node_modules\@deepseek-ai\dsh\package.json') -Raw | ConvertFrom-Json).version
  $expected=if($Case -eq 'old020'){'0.1.7-rc.2'}else{'0.2.1-rc.2'}
  Check 'old-installed-engine-version' ($record.oldEngineVersion -ceq $expected)
  if($Case -eq 'old020'){$runtime=Prepare-Qualified020;$record.syntheticSignedSelectedVersion='0.2.0-rc.2'}
  Synthetic-Check 'seed' $runtime $host
  $record.stage='actual-old-product';Start-Product -Legacy;Stop-Product
  # A deliberate, synthetic legacy file stays outside the new owned namespace.
  [IO.File]::WriteAllText((Join-Path $installRoot 'deepseek-harness\synthetic-legacy-leftover.txt'),'preserve-synthetic-legacy')
  if($Case -eq 'old020'){
   $legacyActiveHash=Hash (Join-Path $profile 'dsh-engine-updates\active.json')
   $legacyJournalHash=Hash (Join-Path $profile 'dsh-engine-updates\transaction.json')
  }
 }
 $record.stage='candidate-install';Install 'candidate-setup.exe' $spec.candidate.sha256
 Check 'installed-exe-identity' ((Hash $exe) -ceq $spec.exeSha256)
 $check=Start-Process -FilePath $exe -ArgumentList '--verify-installed-lsh' -WindowStyle Hidden -PassThru
 Check 'actual-exe-resource-verifier' ($check.WaitForExit(120000) -and $check.ExitCode -eq 0)
 Check 'owned-runtime-file-count' (@(Get-ChildItem -LiteralPath (Join-Path $slot 'deepseek-harness') -File -Recurse -Force).Count -eq 35192)
 if($Case -ne 'fresh'){Check 'legacy-leftover-retained' ((Get-Content -LiteralPath (Join-Path $installRoot 'deepseek-harness\synthetic-legacy-leftover.txt') -Raw) -ceq 'preserve-synthetic-legacy')}
 $record.stage='actual-normal';Start-Product;Surface-Check 'normal'
 if($Case -eq 'old020'){
  $history=Join-Path $profile 'dsh-engine-updates\desktop-install-history'
  Check 'original-signed-active-archived-exact' ((Hash (Join-Path $history ($legacyActiveHash+'.json'))) -ceq $legacyActiveHash)
  Check 'original-signed-journal-archived-exact' ((Hash (Join-Path $history ($legacyJournalHash+'.json'))) -ceq $legacyJournalHash)
  Check 'original-signed-journal-kept-exact' ((Hash (Join-Path $profile 'dsh-engine-updates\transaction.json')) -ceq $legacyJournalHash)
  $record.legacySignedActive='PASS_ACTUAL_EXE_ADOPTED_QUALIFIED_SYNTHETIC_020'
 }
 if($Case -ne 'fresh'){Draft-Check -Write}
 $compat=Evaluate '(async()=>{try{const s=await window.__TAURI_INTERNALS__.invoke("dsh_plugin_compat_apply",{action:{kind:"compatible"}});return {ok:s?.applied===true&&s.failed!==true&&Array.isArray(s.quarantineSet)&&Array.isArray(s.unquarantinable)&&s.unquarantinable.length===0&&Array.isArray(s.skippedEntryIds)&&s.skippedEntryIds.length===0,quarantineSet:s.quarantineSet,guardActive:s.guardActive,code:"structured-action-result"}}catch(e){return {ok:false,code:typeof e==="string"&&/^[a-z][a-z0-9-]{2,100}$/.test(e)?e:"unknown"}}})()'
 if(-not $compat.ok){$record.lastCompatibleCode=$compat.code};Check 'compatible-start-accepted' $compat.ok
 Stop-Product;Start-Product
 Surface-Check 'compatible'
 $compatStatus=Evaluate 'window.__TAURI_INTERNALS__.invoke("dsh_plugin_compat_status").then(s=>({compatMode:s.compatMode,quarantineSet:s.quarantineSet}))'
 Confirm-CompatStatus $compat $compatStatus
 Stop-Product
 if($Case -ne 'fresh'){Synthetic-Check 'read' (Join-Path $slot 'deepseek-harness') (Join-Path $slot 'dsh-host')}
 $record.stage='actual-reopen';Start-Product;Surface-Check 'reopen';if($Case -ne 'fresh'){Draft-Check};Stop-Product
 # Deliberately incomplete synthetic extraction; reinstall must retain it,
 # restore exact bytes and not admit the contaminated slot before repair.
 $record.stage='repeat-interrupted-repair'
 $priorNodeHash=Hash (Join-Path $slot 'deepseek-harness\node\node.exe')
 [IO.File]::WriteAllText((Join-Path $slot 'deepseek-harness\synthetic-partial.txt'),'retained-partial')
 [IO.File]::WriteAllText((Join-Path $installRoot 'luckyray-install-in-progress.txt'),'synthetic-interrupted-extraction')
 $check=Start-Process -FilePath $exe -ArgumentList '--verify-installed-lsh' -WindowStyle Hidden -PassThru
 Check 'tampered-slot-rejected' ($check.WaitForExit(120000) -and $check.ExitCode -ne 0)
 Install 'candidate-setup.exe' $spec.candidate.sha256
 Check 'previous-partial-slot-retained' ((Get-Content -LiteralPath (Join-Path $installRoot 'lr-lsh\199-1.saved-1\deepseek-harness\synthetic-partial.txt') -Raw) -ceq 'retained-partial')
 Check 'complete-previous-runtime-retained' (@(Get-ChildItem -LiteralPath (Join-Path $installRoot 'lr-lsh\199-1.saved-1\deepseek-harness') -File -Recurse -Force).Count -eq 35193 -and (Hash (Join-Path $installRoot 'lr-lsh\199-1.saved-1\deepseek-harness\node\node.exe')) -ceq $priorNodeHash)
 Check 'complete-previous-host-retained' (@(Get-ChildItem -LiteralPath (Join-Path $installRoot 'lr-lsh\199-1.saved-1\dsh-host') -File -Recurse -Force).Count -eq 18)
 Check 'installation-complete-marker' ((Test-Path -LiteralPath (Join-Path $installRoot 'luckyray-install-complete.txt')) -and -not (Test-Path -LiteralPath (Join-Path $installRoot 'luckyray-install-in-progress.txt')))
 Start-Product;Surface-Check 'repaired';Stop-Product
 if($Case -ne 'fresh'){Synthetic-Check 'read' (Join-Path $slot 'deepseek-harness') (Join-Path $slot 'dsh-host')}
 if($Case -eq 'fresh'){$record.stage='gateway-product-recovery';Gateway-Product-Check}
 $record.stage='completed';$record.status='PASS_ACTUAL_PRODUCT_INSTALLED_PATHS'
 if(-not $record.Contains('newDraft')){$record.newDraft='NOT_RUN'};if(-not $record.Contains('gatewayProductRecovery')){$record.gatewayProductRecovery='NOT_RUN'};if(-not $record.Contains('legacySignedActive')){$record.legacySignedActive='NOT_RUN'};$record.androidRecovery='NOT_RUN'
}catch{
 $message=$_.Exception.Message
 $record.failure=if($message -cmatch '^[a-z][a-z0-9-]{2,110}$'){$message}else{'unexpected-details-withheld'}
 $record.errorType=$_.Exception.GetType().Name
 $record.harnessLine=$_.InvocationInfo.ScriptLineNumber
 if($_.FullyQualifiedErrorId -cmatch '^[A-Za-z0-9_.-]{1,100}$'){$record.harnessErrorId=$_.FullyQualifiedErrorId}
 if($record.errorType -ceq 'PropertyNotFoundException' -and $message -cmatch "property '([A-Za-z][A-Za-z0-9]{0,60})'"){$record.missingProperty=$Matches[1]}
}finally{
 $errorFile=Join-Path $profile 'dsh-engine-updates\last-switch-error.json'
 if(Test-Path -LiteralPath $errorFile){
  try{
   $admission=Get-Content -LiteralPath $errorFile -Raw | ConvertFrom-Json
   if($admission.stage -cmatch '^[a-z][a-z0-9-]{1,99}$'){$record.admissionErrorStage=$admission.stage}
   if($admission.errorCategory -cmatch '^[a-z][a-z0-9-]{1,79}$'){$record.admissionErrorCategory=$admission.errorCategory}
  }catch{$record.admissionDiagnostic='unknown'}
 }
 $record | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath (Join-Path $EvidenceRoot 'green-result.json') -Encoding utf8
 $record | ConvertTo-Json -Depth 7
}
if($record.status -cne 'PASS_ACTUAL_PRODUCT_INSTALLED_PATHS'){exit 1}
