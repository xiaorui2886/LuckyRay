// Focused original-EXE subprocess observation, not an upgrade acceptance run.
import assert from 'node:assert/strict';
import {readFile,writeFile,appendFile,mkdir,readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join,win32} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {installedApplicationEnvironment} from './runner-environment.mjs';
assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.RUNNER_OS,'Windows');
assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');assert.equal(process.env.GITHUB_REPOSITORY,'xiaorui2886/LuckyRay');
const root='D:\\lr-formal-uat',install=join(root,'安装 空格'),evidence=join(root,'evidence'),run=promisify(execFile);
const native=join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
const observer=join(root,'private/StorageProcessObserver.exe');
const hash=b=>createHash('sha256').update(b).digest('hex');
assert.equal(hash(await readFile(join(install,'luckyray-app.exe'))),'59797b20a9b74abd3beb7c4e285b667698ae6a4b05073cdf12a29b4c0bf32304');
assert.equal(existsSync(join(root,'private/test-certificates.json')),false);
const environment=installedApplicationEnvironment(process.env,null),events=[];
// Preserve the previously failing baseline even after the continuous harness
// adopts the verified native module path. This affects this diagnostic only.
delete environment.PSModulePath;
// Windows PowerShell prepends its shared path if absent. Include it explicitly
// after PSHOME so this comparison actually preserves the intended order.
const moduleEnvironment={...environment,PSModulePath:join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/Modules')+';'+join(process.env.ProgramFiles,'WindowsPowerShell/Modules')};
assert.equal(Object.keys(environment).some(k=>/proxy|token|secret/i.test(k)),false);
const event=async(kind,data={})=>{const row={atUtc:new Date().toISOString(),kind,...data};events.push(row);await appendFile(join(evidence,'storage-diagnostic-timeline.jsonl'),JSON.stringify(row)+'\n');};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(label,fn,ms=120000){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;await delay(300);}throw Error(label+' timed out');}
const {chromium}=await import(pathToFileURL(join(process.env.UI_TOOLS,'node_modules/playwright-core/index.mjs')));
const A=spawn(join(install,'luckyray-app.exe'),[],{cwd:install,env:environment,windowsHide:false});
A.stdout.resume();A.stderr.resume();let appExit,fixedA,fixedExit,browser,page,monitor,monitorExit,stage='original_A_start';
A.on('exit',(code,signal)=>{appExit={code,signal,atUtc:new Date().toISOString()};});
const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI__.core.invoke(command,args),{command,args});
try{
  await wait('original installed CDP',async()=>{try{return(await fetch('http://127.0.0.1:9391/json/version')).ok;}catch{return false;}});
  browser=await chromium.connectOverCDP('http://127.0.0.1:9391');
  page=await wait('original installed renderer',()=>browser.contexts().flatMap(c=>c.pages()).find(p=>/tauri\.localhost|^tauri:\/\//.test(p.url())));
  await page.waitForFunction(()=>Boolean(window.__TAURI__?.core?.invoke));
  assert.equal(await page.evaluate(()=>window.__TAURI__.app.getVersion()),'1.9.8');
  const ownership="$o=@(Get-NetTCPConnection -LocalPort 9391 -State Listen|Select-Object -ExpandProperty OwningProcess -Unique);if($o.Count-ne 1){throw 'cdp-owner-not-unique'};$ids=@();$lrId=$o[0];for($i=0;$i-lt 8-and $lrId-gt 0;$i++){$p=Get-CimInstance Win32_Process -Filter \"ProcessId=$lrId\";if(-not $p){break};$ids+=[int]$p.ProcessId;$lrId=[int]$p.ParentProcessId};@{cdpPid=$o[0];ancestors=$ids}|ConvertTo-Json -Compress";
  const owner=JSON.parse((await run(native,['-NoProfile','-NonInteractive','-Command',ownership],{windowsHide:true,timeout:15000,encoding:'utf8'})).stdout);
  assert.ok(owner.ancestors.includes(A.pid));
  const local=win32.normalize(await page.evaluate(()=>window.__TAURI__.path.appLocalDataDir()));
  assert.ok(local.toLowerCase().startsWith(win32.normalize(process.env.LOCALAPPDATA).toLowerCase()+win32.sep));
  const helper=join(local,'community-mcp-secret-store-v1.ps1'),directory=join(local,'community-web-mcp-v1/private');
  await event('actual_original_identity',{pid:A.pid,version:'1.9.8',install,local,...owner,appEnvironmentNames:Object.keys(environment).sort(),inheritedWorkingDirectory:install});
  await wait('original LSH preload readiness',async()=>{const s=await invoke('dsh_native_surface_status'),h=await invoke('dsh_host_status');return s.ready&&s.stage==='session-open'&&s.ownedDirectProcessCount===2&&h.latestProbePassed;});
  await event('old_preload_ready',{surface:await invoke('dsh_native_surface_status')});
  await page.evaluate(()=>{location.hash='#settings';});await page.locator('#settings-nav').getByRole('button',{name:/^(通用|General)$/}).click();
  await page.getByRole('button',{name:/^(简体中文|Simplified Chinese)$/}).click();
  await page.locator('.setting-row').filter({has:page.locator('.setting-label').filter({hasText:'关闭窗口时'})}).getByRole('combobox').selectOption('exit');
  const status=await invoke('community_mcp_status');assert.equal(status.phase,'absent');
  stage='observe_actual_initialize_child';
  const observed=join(evidence,'actual-storage-child.jsonl'),ready=join(root,'private/storage-observer.ready');
  monitor=spawn(observer,['monitor',String(A.pid),helper,directory,native,observed,ready],{cwd:root,env:environment,windowsHide:true});
  let observerErrorBytes=0;monitor.stdout.resume();monitor.stderr.on('data',b=>{observerErrorBytes+=b.length;});
  monitor.on('exit',(code,signal)=>{monitorExit={code,signal};});
  await wait('native child metadata observer ready',()=>{if(monitorExit)throw Error('metadata observer stopped before action:'+monitorExit.code);return existsSync(ready);},15000);
  const actionStart=Date.now();let installError=null;
  try{await invoke('community_mcp_action',{input:{action:'install',revision:status.revision}});}catch(error){installError=error.message;}
  await event('actual_install_action_result',{durationMs:Date.now()-actionStart,error:installError,successful:installError===null});
  await wait('metadata observer exit',()=>monitorExit,45000);
  assert.equal(monitorExit.code,0,'read-only observer must actually capture the child, not silently pass');
  const helperBytes=await readFile(helper);assert.equal(hash(helperBytes),'c67d7bfc77ec9386b74790b49deae564a577a416ffc72c86626fb68927231099');
  const rows=(await readFile(observed,'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  const sample=rows.find(r=>r.kind==='actual_child_sample'&&r.data.snapshot.metadataAvailable);
  assert.ok(sample,'actual x64 child cwd/pipe metadata required');
  const cwd=sample.data.snapshot.workingDirectory;
  await event('exact_actual_helper_checked',{sha256:hash(helperBytes),bytes:helperBytes.length,actualWorkingDirectory:cwd,directoryExists:existsSync(directory),credentialFiles:existsSync(directory)?(await readdir(directory)).filter(f=>f.endsWith('.dpapi')).length:0});
  stage='same_bytes_same_cwd_control';
  for(const mode of ['closed']){
    const target=join(root,'private','direct-'+mode);
    await run(observer,['control',native,helper,target,cwd,mode,join(evidence,'direct-storage-controls.jsonl')],{cwd:root,env:environment,windowsHide:true,timeout:30000,maxBuffer:65536});
  }
  await run(observer,['control',native,helper,join(root,'private/direct-native-modules'),cwd,'closed',join(evidence,'direct-native-module-control.jsonl')],{cwd:root,env:moduleEnvironment,windowsHide:true,timeout:30000,maxBuffer:65536});
  // Instrument a separate initialize-only diagnostic copy, never the installed
  // helper or signed package. Its stages are supplementary, not same-byte proof.
  stage='separate_stage_control';
  let instrumented=helperBytes.toString('utf8');
  const insert=(text,needle,addition)=>{assert.equal(text.split(needle).length,2);return text.replace(needle,needle+addition);};
  instrumented=insert(instrumented,"$ErrorActionPreference='Stop'", "\r\n$lrClock=[Diagnostics.Stopwatch]::StartNew()\r\nfunction LRStage([string]$name){[Console]::Error.WriteLine('LR_STAGE:'+$name+':'+$lrClock.ElapsedMilliseconds)}\r\nLRStage 'script_entry'");
  instrumented=instrumented.replace('[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)',
    "LRStage 'before_utf8_new_object'\r\n  $lrUtf8=New-Object Text.UTF8Encoding($false)\r\n  LRStage 'after_utf8_new_object'\r\n  [Console]::InputEncoding=$lrUtf8\r\n  LRStage 'input_encoding'");
  instrumented=instrumented.replace("LRStage 'script_entry'", "LRStage 'script_entry'\r\n[IO.File]::WriteAllText('"+join(evidence,'control-calculated-module-path.txt')+"',$env:PSModulePath)");
  for(const [needle,name]of [
    ['[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)','output_encoding'],
    ["Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop",'security_module'],
    ['$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User','current_sid'],
    ['$acl=New-Object Security.AccessControl.DirectorySecurity','new_acl'],
    ["if(-not (Test-Path -LiteralPath $Directory)){[void][IO.Directory]::CreateDirectory($Directory,$acl)}",'directory_created'],
  ])instrumented=insert(instrumented,needle,"\r\n  LRStage '"+name+"'");
  instrumented=instrumented.replace("if($Action -eq 'initialize'){exit 0}","if($Action -eq 'initialize'){LRStage 'acl_verified';exit 0}");
  const stageFile=join(root,'private/initialize-stages.ps1');await writeFile(stageFile,instrumented,{flag:'wx'});
  await run(observer,['control',native,stageFile,join(root,'private/direct-stages'),cwd,'stages',join(evidence,'stage-storage-control.jsonl')],{cwd:root,env:environment,windowsHide:true,timeout:30000,maxBuffer:65536});
  // Keep separate calculated-path receipts for the isolated diagnostic copies.
  const defaultPath=await readFile(join(evidence,'control-calculated-module-path.txt'),'utf8');
  await run(observer,['control',native,stageFile,join(root,'private/direct-stages-native'),cwd,'stages',join(evidence,'stage-native-module-control.jsonl')],{cwd:root,env:moduleEnvironment,windowsHide:true,timeout:30000,maxBuffer:65536});
  const nativePath=await readFile(join(evidence,'control-calculated-module-path.txt'),'utf8');
  await writeFile(join(evidence,'control-calculated-module-path-default.txt'),defaultPath,{flag:'wx'});
  await event('module_path_control_difference',{changedEnvironmentKeys:['PSModulePath'],configuredNativeModulePath:moduleEnvironment.PSModulePath,defaultCalculatedPath:defaultPath,nativeCalculatedPath:nativePath,noExecutionPolicyOrTrustChange:true});
  await event('instrumented_control_identity',{originalUnchanged:hash(await readFile(helper))===hash(helperBytes),separateScriptSha256:hash(instrumented),notAcceptanceHelper:true});
  const explicit=insert(instrumented,'try {',"\r\n LRStage 'before_explicit_utility'\r\n Import-Module ([IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop\r\n LRStage 'explicit_utility_imported'\r\n Import-Module ([IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell.Management/Microsoft.PowerShell.Management.psd1')) -ErrorAction Stop\r\n LRStage 'explicit_management_imported'");
  const explicitFile=join(root,'private/initialize-explicit-module-control.ps1');await writeFile(explicitFile,explicit,{flag:'wx'});
  await run(observer,['control',native,explicitFile,join(root,'private/direct-explicit-modules'),cwd,'stages',join(evidence,'explicit-native-module-control.jsonl')],{cwd:root,env:moduleEnvironment,windowsHide:true,timeout:30000,maxBuffer:65536});
  await event('separate_explicit_module_control',{notInstalledHelper:true,scriptSha256:hash(explicit),nativeModuleWarmupAttempted:true,noGlobalEnvironmentOrPolicyChange:true});
  stage='normal_baseline_exit';await invoke('close_window');
  await wait('normal original app exit',()=>appExit,120000);assert.equal(appExit.code,0);assert.equal(appExit.signal,null);
  await browser.close();await wait('baseline CDP released',async()=>{try{await fetch('http://127.0.0.1:9391/json/version');return false;}catch{return true;}},45000);
  stage='same_original_A_native_module_environment';
  fixedA=spawn(join(install,'luckyray-app.exe'),[],{cwd:install,env:moduleEnvironment,windowsHide:false});fixedA.stdout.resume();fixedA.stderr.resume();fixedA.on('exit',(code,signal)=>{fixedExit={code,signal,atUtc:new Date().toISOString()};});
  await wait('same original A CDP reopened',async()=>{try{return(await fetch('http://127.0.0.1:9391/json/version')).ok;}catch{return false;}});
  browser=await chromium.connectOverCDP('http://127.0.0.1:9391');page=await wait('same original A renderer',()=>browser.contexts().flatMap(c=>c.pages()).find(p=>/tauri\.localhost|^tauri:\/\//.test(p.url())));await page.waitForFunction(()=>Boolean(window.__TAURI__?.core?.invoke));
  const fixedOwner=JSON.parse((await run(native,['-NoProfile','-NonInteractive','-Command',ownership],{windowsHide:true,timeout:15000,encoding:'utf8'})).stdout);assert.ok(fixedOwner.ancestors.includes(fixedA.pid));assert.equal(await page.evaluate(()=>window.__TAURI__.app.getVersion()),'1.9.8');
  assert.equal(win32.normalize(await page.evaluate(()=>window.__TAURI__.path.appLocalDataDir())),local);
  await wait('old preload ready with test module path',async()=>{const s=await invoke('dsh_native_surface_status');return s.ready&&s.stage==='session-open';});
  const fixedReady=join(root,'private/storage-observer-fixed.ready');monitorExit=undefined;
  monitor=spawn(observer,['monitor',String(fixedA.pid),helper,directory,native,join(evidence,'actual-storage-child-native-modules.jsonl'),fixedReady],{cwd:root,env:moduleEnvironment,windowsHide:true});monitor.stdout.resume();monitor.stderr.on('data',b=>{observerErrorBytes+=b.length;});monitor.on('exit',(code,signal)=>{monitorExit={code,signal};});
  await wait('fixed actual child observer ready',()=>{if(monitorExit)throw Error('fixed observer stopped before action');return existsSync(fixedReady);},15000);
  const fixedStatus=await invoke('community_mcp_status');assert.equal(fixedStatus.authorized,false);const fixedStart=Date.now();let fixedInstallError=null;
  try{await invoke('community_mcp_action',{input:{action:'install',revision:fixedStatus.revision}});}catch(error){fixedInstallError=error.message;}
  await event('same_original_A_native_modules_result',{pid:fixedA.pid,durationMs:Date.now()-fixedStart,error:fixedInstallError,successful:fixedInstallError===null,changedEnvironmentKeys:['PSModulePath'],separateNativeModuleWarmupAttempted:true,sameProfile:true,...fixedOwner});
  await wait('fixed actual child observer exit',()=>monitorExit,45000);assert.equal(monitorExit.code,0);
  assert.equal(hash(await readFile(helper)),hash(helperBytes));assert.equal(hash(await readFile(join(install,'luckyray-app.exe'))),'59797b20a9b74abd3beb7c4e285b667698ae6a4b05073cdf12a29b4c0bf32304');
  await page.screenshot({path:join(evidence,'same-original-A-native-modules.png'),fullPage:true});
  stage='normal_fixed_diagnostic_exit';await invoke('close_window');await wait('normal fixed original exit',()=>fixedExit,120000);assert.equal(fixedExit.code,0);assert.equal(fixedExit.signal,null);
  await writeFile(join(evidence,'STORAGE-DIAGNOSTIC-RESULT.json'),JSON.stringify({status:'MODULE_PATH_DIFFERENTIAL_CAPTURE_NOT_UPGRADE_ACCEPTANCE',runId:process.env.GITHUB_RUN_ID,source:process.env.GITHUB_SHA,originalVersion:'1.9.8',appPid:A.pid,appExit,fixedAppPid:fixedA.pid,fixedExit,installActionError:installError,fixedInstallError,observerExit:monitorExit,observerErrorBytes,actualWorkingDirectory:cwd,helperSha256:hash(helperBytes),testCaCreated:false,proxyConfigured:false,authorizationIssued:false,installedExeChanged:false,desktopUpgrade:'NOT_RUN',engineUpgrade:'NOT_RUN'},null,2)+'\n');
}catch(error){
  await event('diagnostic_stopped',{stage,error:error.message});
  await writeFile(join(evidence,'STORAGE-DIAGNOSTIC-RESULT.json'),JSON.stringify({status:'FAIL_DIAGNOSTIC_CAPTURE',stage,error:error.message,noForcedAppTermination:true,testCaCreated:false,desktopUpgrade:'NOT_RUN',engineUpgrade:'NOT_RUN'},null,2)+'\n');process.exitCode=1;
}finally{
  if(browser)await browser.close().catch(()=>{});
  A.stdout.unref?.();A.stderr.unref?.();A.unref();
  if(fixedA){fixedA.stdout.unref?.();fixedA.stderr.unref?.();fixedA.unref();}
  if(monitor){monitor.stdout.unref?.();monitor.stderr.unref?.();monitor.unref();}
}
