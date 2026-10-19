import assert from 'node:assert/strict';
import {readFile,writeFile,appendFile,stat,mkdir} from 'node:fs/promises';
import {createReadStream,existsSync} from 'node:fs';
import {createServer as httpServer} from 'node:http';
import {createServer as httpsServer} from 'node:https';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {Transform} from 'node:stream';
import {runDshInstalledUpgrade, seedOldInstalledSession, seedInstalledMaterial, verifyInstalledMaterial} from './engine-chain.mjs';
import {installedApplicationEnvironment} from './runner-environment.mjs';
import {installedPaths} from './installed-paths.mjs';

if(process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.GITHUB_REPOSITORY!=='xiaorui2886/LuckyRay')throw Error('disposable-public-runner-only');
const run=promisify(execFile), root='D:\\lr-formal-uat';
const paths=installedPaths(JSON.parse((await readFile(join(root,'private/paths.json'),'utf8')).replace(/^\uFEFF/,'')));
const tls=JSON.parse((await readFile(paths.tls,'utf8')).replace(/^\uFEFF/,''));
const spec=JSON.parse(await readFile(process.env.UPGRADE_SPEC,'utf8'));
assert.equal(spec.a.version,'1.9.8');assert.equal(spec.b.version,'1.9.9');
assert.equal(spec.reviewedPrivateTransfer,true,'reviewed immutable private test inputs required');
const updateMode=process.env.UPGRADE_MODE||'immediate';
assert.ok(['immediate','scheduled'].includes(updateMode));
const evidence=join(root,'evidence'), trace=[];
const hash=b=>createHash('sha256').update(b).digest('hex');
const event=async(kind,value={})=>{const row={atUtc:new Date().toISOString(),kind,...value};trace.push(row);await appendFile(join(evidence,'timeline.jsonl'),JSON.stringify(row)+'\n');};
const requireCdpOwner=async expectedPid=>{
  assert.ok(Number.isSafeInteger(expectedPid));
  const script="$owners=@(Get-NetTCPConnection -LocalPort 9391 -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique); if($owners.Count -ne 1){throw 'cdp-owner-not-unique'}; $chain=@(); $lrProbePid=$owners[0]; for($i=0;$i -lt 8 -and $lrProbePid -gt 0;$i++){ $p=Get-CimInstance Win32_Process -Filter \"ProcessId=$lrProbePid\"; if(-not $p){break};$chain+=[int]$p.ProcessId;$lrProbePid=[int]$p.ParentProcessId }; @{listenerPid=$owners[0];parentChain=$chain}|ConvertTo-Json -Compress";
  const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,encoding:'utf8',timeout:15000,maxBuffer:32768});
  const owner=JSON.parse(stdout);assert.ok(owner.parentChain.includes(expectedPid),'CDP must belong to this actual installed process');
  await event('actual_cdp_owner',{expectedAppPid:expectedPid,...owner});
};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async(label,fn,ms=90000)=>{const end=Date.now()+ms;while(Date.now()<end){const result=await fn();if(result)return result;await delay(300);}throw Error(label+' timed out');};
const B=resolve(process.env.B_INSTALLER);
assert.equal(hash(await readFile(B)),spec.b.sha256);
const mcpCatalog=JSON.parse(await readFile('src-tauri/community-mcp/catalog.json','utf8'));
const mcpZip=resolve(process.env.MCP_INSTALLER);
assert.equal(hash(await readFile(mcpZip)),mcpCatalog.artifactSha256);
const mcpPath=new URL(mcpCatalog.artifactUrl).pathname;
let servedManifest=spec.b.manifest;
assert.equal(spec.b.manifest.version,spec.b.version);
const BPath=new URL(spec.b.manifest.platforms['windows-x86_64-nsis'].url).pathname;
const dshPaths=new Map();
for(const input of spec.engine.replayFiles){
  const url=new URL(input.url);
  assert.ok(['raw.githubusercontent.com','registry.npmjs.org','nodejs.org'].includes(url.hostname));
  assert.equal(url.protocol,'https:');assert.equal(url.search,'');
  const file=join(root,'private/input',input.file);
  assert.equal(hash(await readFile(file)),input.sha256);
  assert.equal((await stat(file)).size,input.bytes);
  assert.equal(dshPaths.has(url.href),false);dshPaths.set(url.href,{...input,file});
}
const replay=httpsServer({pfx:await readFile(tls.pfx),passphrase:tls.password},async(req,res)=>{
  // No header/cookie/token is logged. Only exact public protocol paths are served.
  if(req.method!=='GET'||req.headers.authorization||req.headers.cookie){res.writeHead(502);res.end();return;}
  const url=new URL(req.url,'https://'+req.headers.host);
  const path=url.pathname;
  const engine=dshPaths.get(url.href);
  if(engine){
    await event('approved_engine_input',{sha256:engine.sha256,bytes:engine.bytes});
    res.writeHead(200,{'content-type':'application/octet-stream','content-length':engine.bytes});createReadStream(engine.file).pipe(res);return;
  }
  if(url.hostname!=='github.com'||url.search){res.writeHead(502);res.end();return;}
  if(path==='/xiaorui2886/LuckyRay/releases/latest/download/latest.json'){
    const manifest=JSON.stringify(servedManifest);
    await event('formal_manifest_request',{path,version:servedManifest.version});
    res.writeHead(200,{'content-type':'application/json','content-length':Buffer.byteLength(manifest)});res.end(manifest);
  }else if(path===mcpPath){
    // Unchanged, previously verified optional component: install only to seed
    // this run's original synthetic grant, not a repeat full MCP acceptance.
    await event('unchanged_mcp_component_request',{sha256:mcpCatalog.artifactSha256});
    res.writeHead(200,{'content-type':'application/zip','content-length':(await stat(mcpZip)).size});createReadStream(mcpZip).pipe(res);
  }else if(path===BPath){
    await event('formal_artifact_request',{path,sha256:spec.b.sha256});
    // Controlled network pacing only, to observe real progress in the UI.
    // No app timer, save code, package bytes or trust setting is modified.
    const paced=new Transform({transform(chunk,_encoding,done){setTimeout(()=>done(null,chunk),20);}});
    res.writeHead(200,{'content-type':'application/octet-stream','content-length':(await stat(B)).size});createReadStream(B,{highWaterMark:1024*1024}).pipe(paced).pipe(res);
  }else{res.writeHead(502);res.end();}
});
const proxy=httpServer((_req,res)=>{res.writeHead(502);res.end();});
const replayTunnels=new Set();
proxy.on('connect',(req,socket,head)=>{
  if(!['github.com:443','raw.githubusercontent.com:443','registry.npmjs.org:443','nodejs.org:443'].includes(req.url)){socket.end('HTTP/1.1 502 Denied\r\n\r\n');return;}
  replayTunnels.add(socket);socket.once('close',()=>replayTunnels.delete(socket));
  socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  if(head.length)socket.unshift(head);
  replay.emit('connection',socket);
});
await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
const proxyUrl='http://127.0.0.1:'+proxy.address().port;
const {chromium}=await import(pathToFileURL(join(process.env.UI_TOOLS,'node_modules/playwright-core/index.mjs')));
const installedEnvironment=installedApplicationEnvironment(process.env,proxyUrl);
const oldFixture=await seedOldInstalledSession({root,paths,spec,event});
const A=spawn(join(paths.install,'luckyray-app.exe'),[],{cwd:paths.install,windowsHide:false,env:installedEnvironment});
let Startup=null,StartupExit=null;
A.stdout.resume(); // Drain without logging; never let an unconsumed pipe block normal exit.
const native=[];
A.stderr.setEncoding('utf8');A.stderr.on('data',chunk=>{
  for(const line of chunk.split(/\r?\n/))if(/^\[(dsh-update-exit|workspace)\]/.test(line)&&!/(token|key|credential|secret)/i.test(line))native.push({atUtc:new Date().toISOString(),line});
});
let AExit;
A.on('exit',(code,signal)=>{AExit={atUtc:new Date().toISOString(),code,signal};void event('A_process_exit',AExit);});
const connect=async()=>{
  await wait('CDP endpoint',async()=>{try{const r=await fetch('http://127.0.0.1:9391/json/version');return r.ok;}catch{return false;}});
  const browser=await chromium.connectOverCDP('http://127.0.0.1:9391');
  const page=await wait('actual installed WebView page',async()=>browser.contexts().flatMap(c=>c.pages()).find(p=>/tauri\.localhost|^tauri:\/\//.test(p.url())));
  await page.waitForFunction(()=>Boolean(window.__TAURI__?.core?.invoke));
  return {browser,page};
};
let browser,page,stage='A_start';
const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI__.core.invoke(command,args),{command,args});
const observeLsh=async step=>{
  // Supported read-only lifecycle projections, not a manufactured idle ACK.
  const host=await invoke('dsh_host_status');
  const surface=await invoke('dsh_native_surface_status');
  await event('actual_lsh_states',{step,host,surface});
  return {host,surface};
};
const snapshot=async name=>{
  await writeFile(join(evidence,name+'.dom.txt'),await page.locator('body').innerText());
  await page.screenshot({path:join(evidence,name+'.png'),fullPage:true});
};
const route=async name=>{await page.evaluate(name=>{location.hash='#'+name;},name);};
const settings=async()=>{
  await route('settings');
  // Settings uses session state; navigation can mount after the route changes.
  // Always wait for and operate the real About button, not a count() race or
  // a write to an unrelated localStorage key.
  await page.locator('#settings-nav').getByRole('button',{name:/^(关于|About)$/}).click();
  const entry=page.locator('.settings-update-entry');await entry.waitFor();
  if(await entry.getAttribute('aria-expanded')!=='true')await entry.click();
};
try{
  ({browser,page}=await connect());
  await requireCdpOwner(A.pid);
  assert.equal(hash(await readFile(join(paths.install,'luckyray-app.exe'))),spec.a.installedExeSha256);
  await event('A_actual_page',{pid:A.pid,url:page.url(),exeSha256:spec.a.installedExeSha256});
  assert.equal(await page.evaluate(()=>window.__TAURI__.app.getVersion()),spec.a.version);
  // Use the real settings controls without reloading the renderer: a fixture
  // reload could restart startup preparation and is not ordinary app startup.
  await snapshot('A-initial');
  await observeLsh('original-startup-no-renderer-reload');
  await route('settings');
  await page.locator('#settings-nav').getByRole('button',{name:/^(通用|General)$/}).click();
  await page.getByRole('button',{name:/^(简体中文|Simplified Chinese)$/}).click();
  await page.getByRole('button',{name:'紧凑',exact:true}).click();
  const initial=await invoke('desktop_application_update',{action:'status'});
  assert.notEqual(initial.phase,'disabled');
  await mkdir(join(root,'vault'));
  const vault=await invoke('create_notes_vault',{rootPath:join(root,'vault')});
  const activation=await invoke('knowledge_activate_current_ui_source');
  const base='# FormalUpgradeSynthetic\n\nBase body 中文 😀.\n';
  const note=await invoke('knowledge_create_document',{input:{title:'FormalUpgradeSynthetic',content:base},sourceEpoch:activation.sourceEpoch});
  assert.equal(note.content,base);
  const reference=note.documentRef;
  const notePath=join(root,'vault',reference.relativePath);
  assert.equal(await readFile(notePath,'utf8'),base);
  const materialFixture=await seedInstalledMaterial({root,invoke,event});
  const languageScript="[string](Get-ItemProperty -LiteralPath 'HKCU:\\Software\\luckyray\\LuckyRay').'Installer Language'";
  const installerLanguage=(await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',languageScript],{windowsHide:true,encoding:'utf8'})).stdout.trim();
  assert.ok(['1033','2052'].includes(installerLanguage),'silent first install persisted its actual NSIS language');
  await event('A_installer_language',{storedLanguage:installerLanguage});
  // A new synthetic, materials/notes-only grant through the existing explicit
  // consent API. No real grant is copied, no tunnel/Agent permission is added.
  let grantStatus=await invoke('community_mcp_status');
  assert.equal(grantStatus.phase,'absent','each continuous chain starts with its own clean synthetic profile');
  await invoke('community_mcp_action',{input:{action:'install',revision:grantStatus.revision}});
  grantStatus=await invoke('community_mcp_status');
  assert.equal(grantStatus.version,mcpCatalog.version);
  await invoke('community_mcp_action',{input:{action:'authorize',revision:grantStatus.revision,confirmed:true,
    libraryId:materialFixture.libraryId,vaultId:grantStatus.vaults[0].id}});
  grantStatus=await invoke('community_mcp_status');assert.equal(grantStatus.authorized,true);
  const originalGrant=grantStatus.grant;
  const mcpRoot=join(paths.local,'com.luckyray.desktop/community-web-mcp-v1');
  const authorityFingerprints=async()=>Object.fromEntries(await Promise.all(['settings.json','connection.json','private/credential.dpapi'].map(async file=>{
    const path=join(mcpRoot,file);return [file,existsSync(path)?hash(await readFile(path)):null];
  })));
  const originalAuthorityBytes=await authorityFingerprints();
  assert.ok(Object.values(originalAuthorityBytes).every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)),
    'settings, connection and encrypted credential must all actually exist before preservation can be claimed');
  await event('synthetic_authority_before_update',{grantSha256:hash(JSON.stringify(originalGrant)),files:originalAuthorityBytes});
  stage='A_warm_session_open';
  await wait('actual warm background preload before update',async()=>{
    const surface=await invoke('dsh_native_surface_status');
    return surface.ready===true&&surface.stage==='session-open'&&surface.ownedDirectProcessCount===2;
  });

  // Wrong-platform/corruption/cancel regressions are already frozen separately;
  // this run adds only the requested continuous installed two-leg upgrade.
  await settings();await snapshot('A-formal-update-enabled');stage='A_download';
  await page.locator('.settings-update-native').getByRole('button',{name:/^(检查更新|Check for updates)$/}).click();
  await wait('new version discovery',async()=>{const s=await invoke('desktop_application_update',{action:'status'});if(s.phase==='error')throw Error(s.errorCode);return s.phase==='available'&&s.version===spec.b.version;});
  await snapshot('A-B-discovered');
  await page.getByRole('button',{name:/^(下载更新|Download update)$/}).click();
  await wait('visible real download progress',async()=>{const s=await invoke('desktop_application_update',{action:'status'});if(s.phase==='error')throw Error(s.errorCode);if(s.phase==='downloading'&&s.downloadedBytes>0&&s.totalBytes>s.downloadedBytes){assert.ok(await page.locator('.settings-update-native').getByRole('progressbar').isVisible());await event('download_progress_visible',{downloadedBytes:s.downloadedBytes,totalBytes:s.totalBytes});await snapshot('A-download-progress');return true;}if(s.phase==='ready')throw Error('progress observation missed; cannot claim UI coverage');return false;});
  await wait('actual download and production signature verification',async()=>{const s=await invoke('desktop_application_update',{action:'status'});if(s.phase==='error')throw Error(s.errorCode);return s.phase==='ready'&&s.canInstall;},180000);
  await snapshot('A-B-verified');
  if(updateMode==='scheduled'){
    stage='A_schedule';
    await page.getByRole('button',{name:/^(下次启动时安装|Install on next launch)$/}).click();
    await page.getByRole('button',{name:/^(确认安排|Confirm schedule)$/}).click();
    await wait('actual schedule without quitting',async()=>(await invoke('desktop_application_update',{action:'status'})).phase==='scheduled');
    assert.equal(AExit,undefined);
    await event('scheduled_without_exit',{pid:A.pid});await snapshot('A-scheduled-still-usable');
  }
  // The official Tauri invoke property is non-writable. Observe its real call
  // through CDP instead of replacing it or manufacturing any acknowledgement.
  const diagnostics=await page.context().newCDPSession(page);
  await diagnostics.send('Debugger.enable');
  const target=await diagnostics.send('Runtime.evaluate',{expression:'window.__TAURI_INTERNALS__.invoke',returnByValue:false});
  assert.equal(target.result.type,'function');assert.ok(target.result.objectId);
  let ackObserverError=null;
  diagnostics.on('Debugger.paused',async paused=>{
    try{
      assert.ok(paused.callFrames?.[0]?.callFrameId);
      const row=await diagnostics.send('Debugger.evaluateOnCallFrame',{callFrameId:paused.callFrames[0].callFrameId,expression:'({id:arguments[1].request.id,saved:arguments[1].request.saved})',returnByValue:true});
      assert.equal(typeof row.result.value.id,'string');assert.equal(typeof row.result.value.saved,'boolean');
      await event('actual_frontend_quit_ack',row.result.value);
    }catch(error){ackObserverError=error.message;}finally{await diagnostics.send('Debugger.resume').catch(()=>{});}
  });
  await diagnostics.send('Debugger.setBreakpointOnFunctionCall',{objectId:target.result.objectId,condition:'arguments[0] === "workspace_window_command" && arguments[1]?.request?.op === "quitAck"'});
  stage='A_dirty_note';await route('notes');
  const title=page.getByText(/^FormalUpgradeSynthetic(?:\.md)?$/);await title.first().waitFor();await title.first().dblclick();
  const editor=page.locator('.cm-content[contenteditable="true"]:visible').first();await editor.waitFor();
  const editorText=()=>editor.evaluate(dom=>dom.cmTile?.root?.view?.state.doc.toString());
  await wait('complete editor base',async()=>await editorText()===base);
  const observeEditor=async step=>{
    const state=await editor.evaluate(dom=>{
      const state=dom.cmTile?.root?.view?.state;
      if(!state)throw Error('actual-editor-state-unavailable');
      return {text:state.doc.toString(),selection:state.selection.toJSON()};
    });
    await event('actual_editor_input_step',{step,textBytes:Buffer.byteLength(state.text),textSha256:hash(state.text),selection:state.selection});
    return state;
  };
  await observeEditor('base');await editor.click();await observeEditor('focus');
  await editor.press('Control+End');
  const atEnd=await observeEditor('Control+End');
  assert.equal(atEnd.text,base);assert.equal(atEnd.selection.ranges[0].anchor,base.length);assert.equal(atEnd.selection.ranges[0].head,base.length);
  const suffix='\nSigned update preserves pending 中文 😀.\n',expected=base+suffix;
  // Real Enter keys delimit lines. A CDP insertText call containing embedded
  // newlines is not a clipboard paste and previously failed the exact assertion;
  // its failed evidence remains retained, not relabelled a successful input.
  await editor.press('Enter');assert.equal((await observeEditor('Enter-before-body')).text,base+'\n');
  await page.keyboard.insertText(suffix.slice(1,-1));assert.equal((await observeEditor('single-line-unicode-body')).text,base+suffix.slice(0,-1));
  await editor.press('Enter');assert.equal((await observeEditor('Enter-after-body')).text,expected);
  await settings();
  const settingsBefore=await page.evaluate(()=>JSON.parse(localStorage.getItem('luckyray-settings-v1')));
  assert.equal(settingsBefore['general.language'],'zh-CN');assert.equal(settingsBefore['general.density'],'compact');
  await observeLsh('before-immediate-update');
  const beforeClick=await readFile(notePath,'utf8');
  await event('complete_draft_before_restart',{expectedBytes:Buffer.byteLength(expected),expectedSha256:hash(expected),diskSha256:hash(beforeClick),pendingAtPreclickObservation:beforeClick!==expected});
  // Never infer pending-draft coverage if ordinary autosave completed first.
  // The separate existing exit-barrier regressions remain required in that case.
  if(updateMode==='immediate'){
    await event('immediate_update_clicked',{pid:A.pid});
    await page.getByRole('button',{name:/^(立即重启并更新|Restart and update now)$/}).click();
  }else{
    await event('scheduled_normal_quit_requested',{pid:A.pid});
    await invoke('close_window'); // Existing normal quit, no process termination.
  }
  await wait('saved normal exit',async()=>{
    if(AExit)return AExit;
    const state=await invoke('desktop_application_update',{action:'status'}).catch(()=>null);
    if(state?.errorCode){
      await event('restart_refused_by_existing_safety_gate',{status:state});
      await observeLsh('restart-refused-no-retry');
      throw Error('actual immediate restart refused: '+state.errorCode);
    }
    return false;
  },120000);assert.equal(AExit.code,0);assert.equal(AExit.signal,null);
  assert.equal(ackObserverError,null);
  assert.ok(trace.some(row=>row.kind==='actual_frontend_quit_ack'&&row.saved===true&&row.atUtc<=AExit.atUtc));
  assert.ok(native.some(row=>/lsh official saved=true stopped=true .*exit=0/.test(row.line)&&row.atUtc<=AExit.atUtc),'this same A run must receive real LSH saved/disposed/exit0 confirmation before app exit');
  assert.equal(await readFile(notePath,'utf8'),expected);
  assert.ok((await stat(notePath)).mtimeMs<=Date.parse(AExit.atUtc));
  await event('disk_at_A_normal_exit',{completeTextEqual:true,bytes:Buffer.byteLength(expected),sha256:hash(expected)});

  if(updateMode==='scheduled'){
    stage='scheduled_next_normal_start';
    assert.equal(hash(await readFile(join(paths.install,'luckyray-app.exe'))),spec.a.installedExeSha256);
    // Only this separate scheduled scenario starts A again, as its UI promises.
    // B must still be reopened by the verified installer, never by the observer.
    Startup=spawn(join(paths.install,'luckyray-app.exe'),[],{cwd:paths.install,windowsHide:false,env:installedEnvironment});
    Startup.stdout.resume();Startup.stderr.resume();
    Startup.on('exit',(code,signal)=>{StartupExit={atUtc:new Date().toISOString(),code,signal};void event('scheduled_A_startup_handoff_exit',StartupExit);});
    await event('scheduled_A_next_normal_start',{pid:Startup.pid,exeSha256:spec.a.installedExeSha256});
    await wait('scheduled startup installer handoff',()=>StartupExit,120000);
    assert.equal(StartupExit.code,0);assert.equal(StartupExit.signal,null);
  }

  stage='installer_handoff';
  const getProcesses=async()=>{
    const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',"[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('LuckyRay-update.exe','luckyray-app.exe') } | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;ppid=$_.ParentProcessId;exe=$_.ExecutablePath} }) | ConvertTo-Json -Compress"],{windowsHide:true,encoding:'utf8',timeout:15000,maxBuffer:32768});
    const value=JSON.parse(stdout||'[]');return Array.isArray(value)?value:[value];
  };
  const installerParentPid=Startup?.pid??A.pid;
  const installer=await wait('actual verified installer child',async()=>(await getProcesses()).find(p=>p.ppid===installerParentPid&&p.exe?.toLowerCase().endsWith('luckyray-update.exe')));
  const allowedCache=join(paths.local,'com.luckyray.desktop/signed-desktop-update-v1');
  await event('installer_child',{...installer,sha256:hash(await readFile(installer.exe))});
  assert.equal(hash(await readFile(installer.exe)),spec.b.sha256);
  const confirmed=await run(join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(process.cwd(),'tests/formal-update/Observe-PassiveInstaller.ps1'),'-InstallerPid',String(installer.pid),'-ExpectedSha256',spec.b.sha256,'-AllowedCache',allowedCache,'-InstallRoot',paths.install,'-ExpectedLanguage',installerLanguage],{windowsHide:true,timeout:240000,maxBuffer:131072});
  const installerResult=JSON.parse(confirmed.stdout);assert.equal(installerResult.installerExitCode,0);
  await event('installer_completed',installerResult);
  const BProcess=await wait('installer-owned automatic B reopen',async()=>(await getProcesses()).find(p=>p.exe?.toLowerCase()===join(paths.install,'luckyray-app.exe').toLowerCase()&&p.pid!==A.pid),120000);
  assert.equal(BProcess.ppid,installer.pid,'no manual launch may substitute for installer-owned reopen');
  assert.equal((await readFile(join(paths.install,'luckyray-install-complete.txt'),'utf8')).trim(),'com.luckyray.desktop|'+spec.b.version);
  assert.equal(hash(await readFile(join(paths.install,'luckyray-app.exe'))),spec.b.installedExeSha256);
  assert.equal(existsSync(join(paths.install,'luckyray-install-in-progress.txt')),false);
  assert.equal(await readFile(notePath,'utf8'),expected);
  ({browser,page}=await connect());await requireCdpOwner(BProcess.pid);await snapshot('B-automatically-reopened');
  const reopened=await invoke('knowledge_read_document',{documentRef:reference});
  assert.equal(reopened.content,expected);assert.deepEqual(reopened.documentRef,reference);assert.ok(reopened.revision);
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('luckyray-settings-v1'))),settingsBefore);
  const afterGrant=await invoke('community_mcp_status');
  assert.equal(afterGrant.authorized,true);assert.deepEqual(afterGrant.grant,originalGrant);
  assert.deepEqual(await authorityFingerprints(),originalAuthorityBytes);
  await verifyInstalledMaterial(invoke,materialFixture);
  await route('materials');
  await page.getByText(/^Installed-upgrade-original(?:\.pdf)?$/).first().waitFor({state:'visible',timeout:45000});
  await snapshot('B-preserved-original-material');
  await event('B_preupgrade_material_preserved',{libraryId:materialFixture.libraryId,assetId:materialFixture.asset.id,name:materialFixture.asset.name,sha256:materialFixture.sha256,visibleInLibrary:true});
  await event('synthetic_authority_after_automatic_reopen',{sameGrant:true,sameStoredBytes:true,grantSha256:hash(JSON.stringify(afterGrant.grant))});
  await event('B_readback',{pid:BProcess.pid,exeSha256:spec.b.installedExeSha256,documentRef:reopened.documentRef,revision:reopened.revision,settingsSha256:hash(JSON.stringify(settingsBefore)),fullTextSha256:hash(expected)});
  assert.equal(await page.evaluate(()=>window.__TAURI__.app.getVersion()),spec.b.version);
  await event('desktop_chain_pass',{versions:[spec.a.version,spec.b.version],noManualBLaunch:true,fullTextEqualAfterRestart:true,settingsPreserved:true,syntheticGrantPreserved:true});
  stage='B_engine_upgrade';
  const engineResult=await runDshInstalledUpgrade({root,paths,spec,event,oldFixture,materialFixture,browser,page,connect,requireCdpOwner,settingsBefore,notePath,expected,originalGrant,originalAuthorityBytes,authorityFingerprints,installedEnvironment});
  const final={status:'PASS_INSTALLED_DESKTOP_THEN_DSH_UPGRADE',versions:[spec.a.version,spec.b.version],engineResult,updateMode,testSourceSha:process.env.GITHUB_SHA,runUrl:`https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,source:spec,APid:A.pid,AExit,installer:installerResult,BProcess,profile:paths.profile,install:paths.install,fullTextEqualAfterRestart:true,pendingDraftAtPreclick:beforeClick!==expected,settingsPreserved:true,syntheticGrantPreserved:true,noManualBLaunch:true,realLshSavedAndExitedBeforeApp:true,formalTrustUnchanged:true,productionFeedAvailability:'NOT_RUN: approved exact-URL HTTPS replay, public feeds unchanged',externalWebTunnel:'NOT_RUN',realIME:'NOT_RUN: prior real local draft evidence reused, not manufactured by CI',installerUi:'Official passive installer; stored language inherited. No test installer clicks or security bypass.'};
  await writeFile(join(evidence,'RESULT.json'),JSON.stringify(final,null,2)+'\n');
  console.log(JSON.stringify({status:final.status,fullTextEqualAfterRestart:true,noManualBLaunch:true}));
}catch(error){
  await event('stopped',{stage,error:error.message});
  try{if(page&&!page.isClosed())await observeLsh('stopped-'+stage);}catch{}
  try{if(page&&!page.isClosed())await snapshot('STOP-'+stage);}catch{}
  await writeFile(join(evidence,'RESULT.json'),JSON.stringify({status:'FAIL_OR_BLOCKED',stage,error:error.message,trace,productionDataTouched:false,noForcedTermination:true},null,2)+'\n');
  process.exitCode=1;
}finally{
  await writeFile(join(evidence,'native-quit-lines.json'),JSON.stringify(native,null,2)+'\n');
  if(browser)await browser.close().catch(()=>{}); // CDP disconnect only; do not close/kill apps.
  A.stdout.unref?.();A.stderr.unref?.();A.unref();
  if(Startup){Startup.stdout.unref?.();Startup.stderr.unref?.();Startup.unref();}
  // Only this test's exact GitHub replay tunnels; never terminate app processes
  // or any real LSH/provider stream. Cleanup must not strand the CI job/CA.
  for(const socket of replayTunnels)socket.destroy();
  proxy.closeAllConnections();proxy.close();replay.closeAllConnections();replay.close();
}
