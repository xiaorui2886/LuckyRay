// Prepare only the old installed version, without CA/proxy. This normal reopen
// is fixture preparation, never evidence for an updater-owned automatic reopen.
import assert from 'node:assert/strict';
import {readFile,writeFile,appendFile,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {installedPaths} from './installed-paths.mjs';
import {installedApplicationEnvironment} from './runner-environment.mjs';
import {seedOldInstalledSession,seedInstalledMaterial,verifyInstalledMaterial} from './engine-chain.mjs';

assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.RUNNER_OS,'Windows');
assert.equal(process.env.GITHUB_REPOSITORY,'xiaorui2886/LuckyRay');
const root='D:\\lr-formal-uat',evidence=join(root,'evidence'),run=promisify(execFile);
const paths=installedPaths(JSON.parse((await readFile(join(root,'private/paths.json'),'utf8')).replace(/^\uFEFF/,'')));
assert.equal(existsSync(join(root,'private/test-certificates.json')),false,'fixture must finish before certificate actions');
assert.equal(existsSync(paths.tls),false,'fixture must not use replay TLS');
const spec=JSON.parse(await readFile(process.env.UPGRADE_SPEC,'utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const event=async(kind,value={})=>appendFile(join(evidence,'fixture-timeline.jsonl'),JSON.stringify({atUtc:new Date().toISOString(),kind,...value})+'\n');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async(label,fn,ms=120000)=>{const until=Date.now()+ms;while(Date.now()<until){const value=await fn();if(value)return value;await delay(400);}throw Error(label+' timed out');};
const installedEnvironment=installedApplicationEnvironment(process.env,null);
assert.equal(Object.keys(installedEnvironment).some(name=>/proxy/i.test(name)),false);
assert.equal(hash(await readFile(join(paths.install,'luckyray-app.exe'))),spec.a.installedExeSha256);
const oldFixture=await seedOldInstalledSession({root,paths,spec,event});
const {chromium}=await import(pathToFileURL(join(process.env.UI_TOOLS,'node_modules/playwright-core/index.mjs')));
const A=spawn(join(paths.install,'luckyray-app.exe'),[],{cwd:paths.install,windowsHide:false,env:installedEnvironment});
A.stdout.resume();A.stderr.resume();
let AExit,browser,page,stage='old_startup_without_proxy';
A.on('exit',(code,signal)=>{AExit={atUtc:new Date().toISOString(),code,signal};void event('fixture_A_normal_exit',AExit);});
const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI__.core.invoke(command,args),{command,args});
const snapshot=async name=>{await page.screenshot({path:join(evidence,name+'.png'),fullPage:true});await writeFile(join(evidence,name+'.dom.txt'),await page.locator('body').innerText());};
try{
  await wait('original A CDP',async()=>{try{return(await fetch('http://127.0.0.1:9391/json/version')).ok;}catch{return false;}});
  browser=await chromium.connectOverCDP('http://127.0.0.1:9391');
  page=await wait('original installed WebView',()=>browser.contexts().flatMap(c=>c.pages()).find(p=>/tauri\.localhost|^tauri:\/\//.test(p.url())));
  await page.waitForFunction(()=>Boolean(window.__TAURI__?.core?.invoke));
  const ownerScript="$owners=@(Get-NetTCPConnection -LocalPort 9391 -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique); if($owners.Count -ne 1){throw 'cdp-owner-not-unique'}; $chain=@(); $lrProbePid=$owners[0]; for($i=0;$i -lt 8 -and $lrProbePid -gt 0;$i++){ $p=Get-CimInstance Win32_Process -Filter \"ProcessId=$lrProbePid\"; if(-not $p){break};$chain+=[int]$p.ProcessId;$lrProbePid=[int]$p.ParentProcessId }; @{listenerPid=$owners[0];parentChain=$chain}|ConvertTo-Json -Compress";
  const owner=JSON.parse((await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',ownerScript],{windowsHide:true,encoding:'utf8',timeout:15000})).stdout);
  assert.ok(owner.parentChain.includes(A.pid));assert.equal(await page.evaluate(()=>window.__TAURI__.app.getVersion()),spec.a.version);
  await event('fixture_original_A_identity',{pid:A.pid,version:spec.a.version,exeSha256:spec.a.installedExeSha256,profile:paths.profile,proxyConfigured:false,certificateConfigured:false,...owner});
  await snapshot('FIXTURE-A-original');
  await wait('original background preload fully ready before protected storage',async()=>{
    const surface=await invoke('dsh_native_surface_status'),host=await invoke('dsh_host_status');
    return surface.ready===true&&surface.stage==='session-open'&&surface.ownedDirectProcessCount===2&&host.latestProbePassed===true;
  });
  await event('fixture_old_background_ready',{surface:await invoke('dsh_native_surface_status'),host:await invoke('dsh_host_status')});
  stage='synthetic_settings';
  await page.evaluate(()=>{location.hash='#settings';});
  await page.locator('#settings-nav').getByRole('button',{name:/^(通用|General)$/}).click();
  await page.getByRole('button',{name:/^(简体中文|Simplified Chinese)$/}).click();
  await page.getByRole('button',{name:'紧凑',exact:true}).click();
  // Use the actual supported UI setting, whose default is tray, so subsequent
  // close requests really exercise normal quit rather than hiding the window.
  await page.locator('.setting-row').filter({has:page.locator('.setting-label').filter({hasText:'关闭窗口时'})}).getByRole('combobox').selectOption('exit');
  await wait('normal-exit UI preference persisted',()=>page.evaluate(()=>JSON.parse(localStorage.getItem('luckyray-settings-v1'))?.['general.onClose']==='exit'));
  const settingsBefore=await page.evaluate(()=>JSON.parse(localStorage.getItem('luckyray-settings-v1')));
  assert.equal(settingsBefore['general.language'],'zh-CN');assert.equal(settingsBefore['general.density'],'compact');
  stage='synthetic_note_and_material';
  await mkdir(join(root,'vault'));
  await invoke('create_notes_vault',{rootPath:join(root,'vault')});
  const activation=await invoke('knowledge_activate_current_ui_source');
  const base='# FormalUpgradeSynthetic\n\nBase body 中文 😀.\n';
  const note=await invoke('knowledge_create_document',{input:{title:'FormalUpgradeSynthetic',content:base},sourceEpoch:activation.sourceEpoch});
  assert.equal(note.content,base);
  const reference=note.documentRef,notePath=join(root,'vault',reference.relativePath);
  assert.equal(await readFile(notePath,'utf8'),base);
  const materialFixture=await seedInstalledMaterial({root,invoke,event});
  const languageScript="[string](Get-ItemProperty -LiteralPath 'HKCU:\\Software\\luckyray\\LuckyRay').'Installer Language'";
  const installerLanguage=(await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',languageScript],{windowsHide:true,encoding:'utf8',timeout:15000})).stdout.trim();
  assert.ok(['1033','2052'].includes(installerLanguage));
  stage='protected_storage_initialize_and_official_component_install';
  let grantStatus=await invoke('community_mcp_status');assert.equal(grantStatus.phase,'absent');
  await event('fixture_official_component_install_started',{noProxy:true});
  await invoke('community_mcp_action',{input:{action:'install',revision:grantStatus.revision}});
  grantStatus=await invoke('community_mcp_status');
  const catalog=JSON.parse(await readFile('src-tauri/community-mcp/catalog.json','utf8'));
  assert.equal(grantStatus.version,catalog.version);
  stage='synthetic_scoped_authorization';
  assert.ok(grantStatus.vaults.length===1,'only the new synthetic vault is eligible');
  await invoke('community_mcp_action',{input:{action:'authorize',revision:grantStatus.revision,confirmed:true,libraryId:materialFixture.libraryId,vaultId:grantStatus.vaults[0].id}});
  grantStatus=await invoke('community_mcp_status');assert.equal(grantStatus.authorized,true);
  const originalGrant=grantStatus.grant,mcpRoot=join(paths.local,'com.luckyray.desktop/community-web-mcp-v1');
  const originalAuthorityBytes=Object.fromEntries(await Promise.all(['settings.json','connection.json','private/credential.dpapi'].map(async file=>[file,hash(await readFile(join(mcpRoot,file)))])));
  await event('fixture_authority_created',{grantSha256:hash(JSON.stringify(originalGrant)),files:originalAuthorityBytes,componentVersion:grantStatus.version});
  await verifyInstalledMaterial(invoke,materialFixture);await snapshot('FIXTURE-A-prepared-no-proxy');
  stage='normal_preparation_quit';
  await invoke('close_window');
  await wait('original A normal fixture-preparation quit',()=>AExit);assert.equal(AExit.code,0);assert.equal(AExit.signal,null);
  await wait('old CDP listener released before update preparation',async()=>{try{await fetch('http://127.0.0.1:9391/json/version');return false;}catch{return true;}},45000);
  assert.equal(await readFile(notePath,'utf8'),base);
  for(const [file,sha]of Object.entries(originalAuthorityBytes))assert.equal(hash(await readFile(join(mcpRoot,file))),sha);
  const fixture={schema:1,preparedWithVersion:spec.a.version,preparedExeSha256:spec.a.installedExeSha256,profile:paths.profile,install:paths.install,oldFixture,materialFixture,base,reference,notePath,settingsBefore,installerLanguage,originalGrant,originalAuthorityBytes,preparationExit:AExit};
  await writeFile(join(root,'private/fixture.json'),JSON.stringify(fixture,null,2)+'\n',{flag:'wx'});
  await writeFile(join(evidence,'FIXTURE-RESULT.json'),JSON.stringify({status:'PASS_OLD_VERSION_FIXTURE_PREPARED_WITHOUT_PROXY',version:spec.a.version,pid:A.pid,normalExit:AExit,profile:paths.profile,syntheticGrantCreated:true,certificateActionsPerformed:false,automaticUpdateClaimed:false},null,2)+'\n');
}catch(error){
  await event('fixture_stopped',{stage,error:error.message});
  try{if(page&&!page.isClosed())await snapshot('FIXTURE-STOP-'+stage);}catch{}
  await writeFile(join(evidence,'FIXTURE-RESULT.json'),JSON.stringify({status:'FAIL_FIXTURE_BEFORE_CA_AND_UPDATES',stage,error:error.message,certificateActionsPerformed:false,desktopUpgrade:'NOT_RUN',engineUpgrade:'NOT_RUN',noForcedTermination:true},null,2)+'\n');
  process.exitCode=1;
}finally{
  if(browser)await browser.close().catch(()=>{});
  A.stdout.unref?.();A.stderr.unref?.();A.unref();
}
