// DSH-only: frozen B is already directly installed on this fresh runner.
// Preparation is not evidence of desktop A-to-B or an updater-owned reopen.
import assert from 'node:assert/strict';
import {readFile,writeFile,appendFile,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {preservationPolicy} from './preservation-policy.mjs';
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
assert.equal(hash(await readFile(join(paths.install,'luckyray-app.exe'))),spec.b.installedExeSha256);
assert.equal(spec.b.version,'1.9.9');assert.equal(spec.engine.fromVersion,'0.1.7-rc.2');
const policy=preservationPolicy({evidenceMode:'dsh-only',paths});await policy.verify();
const oldFixture=await seedOldInstalledSession({root,paths,spec,event});
const {chromium}=await import(pathToFileURL(join(process.env.UI_TOOLS,'node_modules/playwright-core/index.mjs')));
const B=spawn(join(paths.install,'luckyray-app.exe'),[],{cwd:paths.install,windowsHide:false,env:installedEnvironment});
B.stdout.resume();B.stderr.resume();
let BExit,browser,page,stage='old_startup_without_proxy';
B.on('exit',(code,signal)=>{BExit={atUtc:new Date().toISOString(),code,signal};void event('fixture_B_normal_exit',BExit);});
const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI__.core.invoke(command,args),{command,args});
const snapshot=async name=>{await page.screenshot({path:join(evidence,name+'.png'),fullPage:true});await writeFile(join(evidence,name+'.dom.txt'),await page.locator('body').innerText());};
try{
  await wait('original B CDP',async()=>{try{return(await fetch('http://127.0.0.1:9391/json/version')).ok;}catch{return false;}});
  browser=await chromium.connectOverCDP('http://127.0.0.1:9391');
  page=await wait('original installed WebView',()=>browser.contexts().flatMap(c=>c.pages()).find(p=>/tauri\.localhost|^tauri:\/\//.test(p.url())));
  await page.waitForFunction(()=>Boolean(window.__TAURI__?.core?.invoke));
  const ownerScript="$owners=@(Get-NetTCPConnection -LocalPort 9391 -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique); if($owners.Count -ne 1){throw 'cdp-owner-not-unique'}; $chain=@(); $lrProbePid=$owners[0]; for($i=0;$i -lt 8 -and $lrProbePid -gt 0;$i++){ $p=Get-CimInstance Win32_Process -Filter \"ProcessId=$lrProbePid\"; if(-not $p){break};$chain+=[int]$p.ProcessId;$lrProbePid=[int]$p.ParentProcessId }; @{listenerPid=$owners[0];parentChain=$chain}|ConvertTo-Json -Compress";
  const owner=JSON.parse((await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',ownerScript],{env:installedApplicationEnvironment(process.env,null),windowsHide:true,encoding:'utf8',timeout:15000})).stdout);
  assert.ok(owner.parentChain.includes(B.pid));assert.equal(await page.evaluate(()=>window.__TAURI__.app.getVersion()),spec.b.version);
  await event('fixture_direct_B_identity',{pid:B.pid,version:spec.b.version,exeSha256:spec.b.installedExeSha256,profile:paths.profile,proxyConfigured:false,certificateConfigured:false,...owner});
  await snapshot('FIXTURE-B-original');
  await wait('original background preload fully ready before synthetic data',async()=>{
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
  // Frozen B's AI tab hydrates bridge defaults (/v1, 2048) over the initial
  // General-page placeholders. Complete that ordinary UI initialization before
  // freezing the full preservation baseline, while the old engine still runs.
  const settingsBeforeAi=await page.evaluate(()=>JSON.parse(localStorage.getItem('luckyray-settings-v1')));
  assert.equal(settingsBeforeAi['ai.baseUrl'],'https://api.deepseek.com');
  assert.equal(settingsBeforeAi['ai.maxTokens'],2000);
  await page.locator('#settings-nav').getByRole('button',{name:'AI',exact:true}).click();
  await wait('frozen host AI bridge settings initialized',()=>page.evaluate(()=>{
    const saved=JSON.parse(localStorage.getItem('luckyray-settings-v1'));
    return saved?.['ai.baseUrl']==='https://api.deepseek.com/v1'&&saved?.['ai.maxTokens']===2048;
  }));
  const settingsBefore=await page.evaluate(()=>JSON.parse(localStorage.getItem('luckyray-settings-v1')));
  assert.deepEqual(settingsBefore,{...settingsBeforeAi,'ai.baseUrl':'https://api.deepseek.com/v1','ai.maxTokens':2048},'only frozen host default hydration may precede baseline capture');
  await event('fixture_settings_initialized_before_baseline',{initialization:'ordinary AI tab bridge hydration',engineVersion:spec.engine.fromVersion,fullSettingsSha256:hash(Buffer.from(JSON.stringify(settingsBefore)))});
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
  const installerLanguage=(await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',languageScript],{env:installedApplicationEnvironment(process.env,null),windowsHide:true,encoding:'utf8',timeout:15000})).stdout.trim();
  assert.ok(['1033','2052'].includes(installerLanguage));
  await policy.verify();
  await verifyInstalledMaterial(invoke,materialFixture);await snapshot('FIXTURE-B-DSH-only-no-proxy');
  if(process.env.DSH_OBSERVE_ONLY==='true'){
    stage='observe_actual_LSH_without_CA';
    await page.evaluate(()=>{location.hash='#ai';});
    const surface=await wait('actual LSH surface for observation only',async()=>{
      for(const candidate of browser.contexts().flatMap(c=>c.pages())){
        let url;try{url=new URL(candidate.url());}catch{continue;}
        if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')continue;
        if(await candidate.locator('[contenteditable="true"]:visible,[role="dialog"]:visible').count())return candidate;
      }
      return false;
    });
    await surface.screenshot({path:join(evidence,'OBSERVE-LSH-before-session-click.png'),fullPage:true});
    await writeFile(join(evidence,'OBSERVE-LSH-before-session-click.dom.txt'),await surface.locator('body').innerText());
    const dialogs=await surface.locator('[role="dialog"]:visible').evaluateAll(nodes=>nodes.map(node=>({title:node.getAttribute('aria-label'),text:node.innerText})));
    await event('actual_LSH_observation_only',{visibleDialogs:dialogs,sessionClicked:false,modalDismissed:false,certificateActionsPerformed:false,engineUpgrade:'NOT_RUN'});
    await snapshot('OBSERVE-host-before-normal-quit');
  }
  stage='normal_preparation_quit';
  await invoke('close_window');
  await wait('original B normal fixture-preparation quit',()=>BExit);assert.equal(BExit.code,0);assert.equal(BExit.signal,null);
  await wait('old CDP listener released before update preparation',async()=>{try{await fetch('http://127.0.0.1:9391/json/version');return false;}catch{return true;}},45000);
  assert.equal(await readFile(notePath,'utf8'),base);
  await policy.verify();
  const fixture={schema:1,preparedWithVersion:spec.b.version,preparedExeSha256:spec.b.installedExeSha256,profile:paths.profile,install:paths.install,oldFixture,materialFixture,base,reference,notePath,settingsBefore,installerLanguage,evidenceMode:'dsh-only',preparationExit:BExit};
  await writeFile(join(root,'private/dsh-only-fixture.json'),JSON.stringify(fixture,null,2)+'\n',{flag:'wx'});
  if(process.env.DSH_OBSERVE_ONLY==='true')await writeFile(join(evidence,'OBSERVATION-RESULT.json'),JSON.stringify({status:'PASS_DSH_ONLY_SURFACE_OBSERVED_WITHOUT_CA',normalExit:BExit,modalDismissed:false,sessionClicked:false,engineUpgrade:'NOT_RUN',certificateActionsPerformed:false,proxyConfigured:false},null,2)+'\n');
  await writeFile(join(evidence,'FIXTURE-RESULT.json'),JSON.stringify({status:'PASS_DSH_ONLY_OLD_ENGINE_FIXTURE_PREPARED_WITHOUT_PROXY',version:spec.b.version,pid:B.pid,normalExit:BExit,profile:paths.profile,communityMcpAuthorization:'NOT_APPLICABLE_TO_DSH_ONLY',certificateActionsPerformed:false,automaticUpdateClaimed:false},null,2)+'\n');
}catch(error){
  await event('fixture_stopped',{stage,error:error.message});
  try{if(page&&!page.isClosed())await snapshot('FIXTURE-STOP-'+stage);}catch{}
  await writeFile(join(evidence,'FIXTURE-RESULT.json'),JSON.stringify({status:'FAIL_FIXTURE_BEFORE_CA_AND_UPDATES',stage,error:error.message,certificateActionsPerformed:false,desktopUpgrade:'NOT_RUN',engineUpgrade:'NOT_RUN',noForcedTermination:true},null,2)+'\n');
  process.exitCode=1;
}finally{
  if(browser)await browser.close().catch(()=>{});
  B.stdout.unref?.();B.stderr.unref?.();B.unref();
}

