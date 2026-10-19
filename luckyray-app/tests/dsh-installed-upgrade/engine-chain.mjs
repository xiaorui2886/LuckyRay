// One disposable, real installed desktop -> engine chain. No activation IPC,
// storage edit, replacement renderer or manual launch substitutes for the UI.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir,stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,resolve,basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';

import {installedApplicationEnvironment} from './runner-environment.mjs';
import {preservationPolicy} from './preservation-policy.mjs';

const run=promisify(execFile),hash=b=>createHash('sha256').update(b).digest('hex');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(label,fn,ms=120000){const until=Date.now()+ms;while(Date.now()<until){const value=await fn();if(value)return value;await delay(400);}throw Error(label+' timed out');}
function runner(){assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.RUNNER_OS,'Windows');assert.equal(process.env.GITHUB_REPOSITORY,'xiaorui2886/LuckyRay');}
async function processes(){
  const script='[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); @(Get-CimInstance Win32_Process | Where-Object {$_.Name -in @("luckyray-app.exe","node.exe")} | ForEach-Object {[pscustomobject]@{pid=$_.ProcessId;ppid=$_.ParentProcessId;exe=$_.ExecutablePath}})|ConvertTo-Json -Compress';
  const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,encoding:'utf8',timeout:15000,env:installedApplicationEnvironment(process.env,null)});
  const rows=JSON.parse(stdout||'[]');return Array.isArray(rows)?rows:[rows];
}
const MAX_SYNTHETIC_SESSION_BYTES=8*1024*1024;
export async function originalSessions(home,sessionId){
  assert.match(sessionId,/^session-[a-z0-9-]+$/);
  const found=[];
  async function visit(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const file=join(dir,entry.name);if(entry.isDirectory())await visit(file);else if(basename(dir)===sessionId&&/^session(?:\.v[0-9]+)?\.jsonl(?:\.zstd)?$/.test(entry.name)){const bytes=await readFile(file);assert.ok(bytes.length<=MAX_SYNTHETIC_SESSION_BYTES);found.push({file,sha256:hash(bytes),bytes:bytes.length});assert.ok(found.length<=8,'bounded synthetic session generations');}}}
  await visit(join(home,'sessions'));return found;
}
export async function readOfficialSession(runtime,home,id){
  const load=name=>import(pathToFileURL(join(runtime,'host/node_modules',name,'lib/index.js')));
  const {Context}=await load('@deepseek-ai/cordis');
  const persistence=await load('@deepseek-ai/dsh-session-persistence-jsonl');
  const ctx=new Context();
  try{
    await ctx.plugin(persistence.default??persistence,{root:join(home,'sessions')});
    const handle=await ctx.sessionPersistence.open(id,'read');
    try{const {events}=await handle.read();const value={header:handle.header,events};assert.ok(Buffer.byteLength(JSON.stringify(value))<=MAX_SYNTHETIC_SESSION_BYTES);return JSON.parse(JSON.stringify(value));}
    finally{await handle.close();}
  }finally{await ctx.fiber.dispose();}
}
export function assertSessionPrefixes(originalBytes,currentBytes,original,current){
  assert.ok(currentBytes.length>=originalBytes.length,'original session cannot be truncated');
  assert.deepEqual(currentBytes.subarray(0,originalBytes.length),originalBytes,'exact original compressed session bytes must remain a prefix');
  assert.deepEqual(current.header,original.header,'original session identity/header must remain unchanged');
  assert.ok(current.events.length>=original.events.length,'original event history cannot be truncated');
  assert.deepEqual(current.events.slice(0,original.events.length),original.events,'every original official decoded event must remain an exact prefix');
}
// Official 0.2.1 persists semantic draft snapshots; earlier versions used strings.
// This fixture types plain text only, so references and slash-command must be absent.
export function plainDraftMatches(value,text){
  if(typeof value==='string')return value===text;
  return value!==null&&typeof value==='object'&&value.text===text&&Array.isArray(value.references)&&value.references.length===0&&value.command===undefined;
}
export function assertSessionGenerations(originals,current){
  assert.deepEqual(current.map(row=>row.file).sort(),originals.map(row=>row.file).sort(),'unexpected or ambiguous session generation');
}
async function assertOriginals(fixture,{runtime,root,index,event}){
  const currentFiles=await originalSessions(fixture.home,fixture.sessionId);
  // Capture bounded synthetic bytes and decoded history BEFORE preservation assertions.
  for(let i=0;i<currentFiles.length;i++)await writeFile(join(root,'evidence',`SESSION-after-${index}-${i}.zstd`),await readFile(currentFiles[i].file));
  const current=await readOfficialSession(runtime,fixture.home,fixture.sessionId);
  await writeFile(join(root,'evidence',`SESSION-after-${index}.json`),JSON.stringify(current,null,2));
  assertSessionGenerations(fixture.originals,currentFiles);
  const original=JSON.parse(await readFile(fixture.sessionSnapshot,'utf8'));
  for(const file of fixture.originals){
    const before=await readFile(file.snapshot),after=await readFile(file.file);
    assert.equal(hash(before),file.sha256,'captured baseline identity');
    if(basename(file.file)==='session.v4.jsonl.zstd')assertSessionPrefixes(before,after,original,current);
    else assert.equal(hash(after),file.sha256,'historical session generation must retain its exact bytes');
  }
  await event('original_session_prefix_preserved',{sessionId:fixture.sessionId,originalEvents:original.events.length,currentEvents:current.events.length,appended:current.events.slice(original.events.length).map(({type,seq})=>({type,seq})),files:currentFiles});
}

// Exact official 0.1.7 / 0.2.1 informational notices; old notice also captured live.
// Never reuse this action for auth, legal agreements, or unknown modal content.
const testingNotices=[
{"title": "Preview Notice", "body": "DeepSeek Harness 0.2 is still in preview, and many areas need continued improvement and refinement. We welcome feedback and suggestions from all developers and users. The new desktop app now targets a broad range of users, while developer-related advanced features can be enabled in the settings. DeepSeek Harness’s product features and plugin APIs are expected to continue rapid iteration and evolution, and will gradually stabilize over time.\n\nWe look forward to exploring the limits of intelligence together with users and developers around the world, building on open-source, reusable, and composable infrastructure. We welcome everyone to bring their ideas to life with DeepSeek Harness and participate in the community to enrich the plugin ecosystem.", "button": "Continue"},{"title": "预览版说明", "body": "DeepSeek Harness 目前的 0.2 版本仍处于预览阶段，还有许多地方需要持续改进和打磨，希望听取广大开发者和用户的反馈建议。现在，新的桌面端面向广泛用户，开发者相关的进阶功能可在配置中开启使用。预计 DeepSeek Harness 的产品功能以及插件 API 都会继续快速迭代、持续演化，并逐渐趋于稳定。\n\n我们期待与全球用户和开发者一起，在开源、可复用、可组合的基础设施之上，共同探索智能上限。欢迎大家用 DeepSeek Harness 将想法变成现实，与社区一起丰富插件生态。", "button": "继续"},
  {
    "title": "Internal Testing Notice",
    "body": "DeepSeek Harness 0.1 remains in testing for Harness developers. Many areas need further improvement, and we welcome feedback from the developer community. DeepSeek Harness's core plugins and foundational APIs will continue to evolve rapidly over the coming months.\n\nWe look forward to exploring the limits of intelligence with developers around the world, building on open-source, open, reusable, and composable infrastructure. We welcome Harness developers everywhere to join the DSH plugin ecosystem.",
    "button": "Continue"
  },
  {
    "title": "内测声明",
    "body": "DeepSeek Harness 目前的 0.1 版本仍处在面向 Harness 开发者进行测试的阶段，还有许多地方需要持续改进和打磨，希望听取广大开发者的反馈建议。预计 DeepSeek Harness 的核心插件以及基础 API 都会在接下来的一段时间内快速迭代、持续演化。\n\n我们期待与全球开发者一起，在开源、开放、可复用、可组合的基础设施之上，共同探索智能上限。欢迎全球 Harness 开发者加入 DSH 插件生态。",
    "button": "继续"
  }
];
const normalizedNotice=text=>text.replace(/\s+/g,' ').trim();
export async function continueKnownTestingNotice(surface,{snap,event}){
  for(const notice of testingNotices){
    const dialog=surface.getByRole('dialog',{name:notice.title,exact:true});
    if(!await dialog.isVisible())continue;
    await snap('testing-notice-before',surface);
    assert.equal(normalizedNotice(await dialog.innerText()),normalizedNotice(notice.title+' '+notice.body+' '+notice.button),'known notice content must match exactly');
    assert.equal(await dialog.locator('input,select,textarea,a,[role="checkbox"]').count(),0,'notice must not request credentials, agreement, or navigation');
    assert.equal(await dialog.getByRole('button').count(),1,'known notice has exactly one action');
    const proceed=dialog.getByRole('button',{name:notice.button,exact:true});
    await proceed.click();
    await dialog.waitFor({state:'hidden',timeout:15000});
    await snap('testing-notice-after',surface);
    await event('known_testing_notice_continued',{title:notice.title,ordinaryUiClick:true});
    return true;
  }
  return false;
}

// Source-backed first-start actions only. Never enter credentials or start sign-in.
const apiPrompts=[
  {title:'Add an API key to get started',body:'Configure the official DeepSeek provider to start building.',key:'API key',later:'Configure later',save:'Save and continue'},
  {title:'添加一个 API Key 开始使用',body:'配置 DeepSeek 官方模型，即可开始使用。',key:'API 密钥',later:'稍后配置',save:'保存并继续'}
];
const accountPrompts=[
  {title:'Get started',body:'Sign in to your DeepSeek account or add an API Key to get started. Your projects and files are stored locally.',key:'Add API Key',signIn:'Sign in',close:'Close'},
  {title:'开始使用',body:'登录 DeepSeek 账号，或添加 API Key，即可开始使用。你的项目和文件保存在本地。',key:'添加 API Key',signIn:'登录',close:'关闭'}
];
export async function deferKnownCredentialPrompt(surface,{snap,event}){
  for(const prompt of apiPrompts){
    const dialog=surface.getByRole('dialog',{name:prompt.title,exact:true});
    if(!await dialog.isVisible())continue;
    await snap('api-setup-before',surface);
    assert.equal(normalizedNotice(await dialog.innerText()),normalizedNotice([prompt.title,prompt.body,prompt.key,prompt.later,prompt.save].join(' ')));
    assert.equal(await dialog.locator('input').count(),1);
    const key=dialog.locator('input[type="password"]');
    assert.equal(await key.count(),1);assert.equal(await key.inputValue(),'');
    assert.equal(await key.getAttribute('aria-label'),prompt.key);
    assert.equal(await dialog.locator('select,textarea,a,[role="checkbox"]').count(),0);
    assert.equal(await dialog.getByRole('button').count(),2);
    assert.equal(await dialog.getByRole('button',{name:prompt.save,exact:true}).isDisabled(),true);
    await dialog.getByRole('button',{name:prompt.later,exact:true}).click();
    await dialog.waitFor({state:'hidden',timeout:15000});
    await snap('api-setup-after',surface);
    await event('known_api_setup_deferred',{title:prompt.title,credentialEntered:false});return true;
  }
  // 0.2.1 web-app enables settings-account. Only the idle choice is closable here.
  for(const prompt of accountPrompts){
    const dialog=surface.getByRole('dialog',{name:prompt.title,exact:true});
    if(!await dialog.isVisible())continue;
    await snap('account-choice-before',surface);
    assert.equal(normalizedNotice(await dialog.innerText()),normalizedNotice([prompt.title,prompt.body,prompt.key,prompt.signIn].join(' ')));
    assert.equal(await dialog.locator('input,select,textarea,a,[role="checkbox"]').count(),0);
    assert.equal(await dialog.getByRole('button').count(),3);
    assert.equal(await dialog.getByRole('button',{name:prompt.signIn,exact:true}).count(),1);
    assert.equal(await dialog.getByRole('button',{name:prompt.key,exact:true}).count(),1);
    await dialog.getByRole('button',{name:prompt.close,exact:true}).click();
    await dialog.waitFor({state:'hidden',timeout:15000});
    await snap('account-choice-after',surface);
    await event('known_idle_account_choice_closed',{title:prompt.title,authenticationStarted:false});return true;
  }
  return false;
}
export async function revealOldSession(surface,fixture,hooks){
  // Each completed step can mount the next asynchronously; poll until the real row is usable.
  return wait('known onboarding and old session navigation',async()=>{
    if(await continueKnownTestingNotice(surface,hooks))return false;
    if(await deferKnownCredentialPrompt(surface,hooks))return false;
    if(await surface.locator('[role="dialog"]:visible').count()){
      await hooks.snap('unrecognized-onboarding',surface);
      throw Error('Unrecognized dialog; no automatic action permitted');
    }
    for(const name of ['Open sidebar','打开侧边栏']){
      const open=surface.getByRole('button',{name,exact:true});
      if(await open.isVisible()){await open.click();return false;}
    }
    const workspace=surface.locator('[role="treeitem"][data-row-key="workspace:installed-upgrade"]');
    if(!await workspace.isVisible())return false;
    assert.ok((await workspace.innerText()).includes(fixture.workspaceTitle));
    const expanded=await workspace.getAttribute('aria-expanded');
    if(expanded==='false'){await workspace.click();return false;}
    assert.equal(expanded,'true','only the known expanded fixture workspace is accepted');
    const row=surface.locator('[role="treeitem"][data-row-key="session:'+fixture.sessionId+'"]');
    return await row.isVisible()?row:false;
  },45000);
}

// Frozen B uses the Tauri dialog init script's async window.confirm override.
// Observe real dialogs if emitted, but normal product exit is the required signal.
export async function clickEngineRestart(page,{canRestart,event,observeExit}){
  const messages=canRestart?[
    '将正常退出 LuckyRay 并自动重新打开以完成引擎切换。请先保存其他页面的更改。现在重启？',
    'LuckyRay will quit normally and reopen automatically to finish the engine switch. Save changes on other pages first. Restart now?'
  ]:[
    '将先完成切换准备，再正常退出并自动重新打开。请先结束 LightSeek 会话和远程任务、保存其他页面更改；未发送的草稿请先自行保存，退出过程不会自动发送。现在重启？',
    'The switch is prepared first, then LuckyRay quits normally and reopens automatically. Finish LightSeek sessions and remote tasks, save changes elsewhere, and save any unsent draft yourself (quitting never sends it). Restart now?'
  ];
  let dialogError,dialogCount=0;const pending=[];
  const listener=dialog=>{pending.push((async()=>{
    assert.equal(dialog.type(),'confirm');assert.ok(messages.includes(dialog.message()),'only the exact engine restart confirmation is permitted');
    dialogCount++;assert.equal(dialogCount,1);await dialog.accept();
  })().catch(error=>{dialogError=error;}));};
  page.on('dialog',listener);
  try{
    await page.getByRole('button',{name:/^(重启软件并完成更新|Restart LuckyRay and finish update)$/}).click();
    if(dialogError)throw dialogError;
    await observeExit();
    await Promise.all(pending);if(dialogError)throw dialogError;
    await event('engine_restart_ui_observed',{browserConfirmationCount:dialogCount,normalExitVerified:true});
  }finally{page.off('dialog',listener);}
}

export async function seedInstalledMaterial({root,invoke,event}){
  runner();
  const pdf=Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  const file=join(root,'Installed-upgrade-original.pdf');await writeFile(file,pdf,{flag:'wx'});
  const registry=await invoke('material_library_command',{request:{libraryId:null,action:{op:'registry',include_hidden:false}}});
  const imported=await invoke('material_library_command',{request:{libraryId:registry.activeId,action:{op:'importPaths',paths:[file],options:{folderId:null,storageMode:'linked',managedLibraryDir:null}}}});
  assert.equal(imported.failedCount,0);assert.equal(imported.assets.length,1);
  const row=imported.assets[0];
  const asset=Object.fromEntries(['id','name','originalPath','libraryPath','storageMode','sizeBytes','contentHash'].map(key=>[key,row[key]]));
  assert.equal(asset.storageMode,'linked');assert.equal(asset.name,'Installed-upgrade-original.pdf');
  const fixture={libraryId:registry.activeId,asset,file,sha256:hash(pdf),bytes:pdf.length};
  await event('A_existing_material_created',{libraryId:fixture.libraryId,assetId:asset.id,name:asset.name,sha256:fixture.sha256,bytes:fixture.bytes});
  return fixture;
}
export async function verifyInstalledMaterial(invoke,fixture){
  const rows=await invoke('material_library_command',{request:{libraryId:fixture.libraryId,action:{op:'get',ids:[fixture.asset.id]}}});
  assert.equal(rows.length,1,'the pre-upgrade material record must remain in its original library');
  for(const [key,value]of Object.entries(fixture.asset))assert.deepEqual(rows[0][key],value,'original material field: '+key);
  const bytes=await readFile(fixture.file);assert.equal(bytes.length,fixture.bytes);assert.equal(hash(bytes),fixture.sha256);
}

export async function seedOldInstalledSession({root,paths,spec,event}){
  runner();
  const runtime=join(paths.install,'deepseek-harness');
  const pkg=JSON.parse(await readFile(join(runtime,'host/node_modules/@deepseek-ai/dsh/package.json'),'utf8'));
  assert.equal(pkg.version,spec.engine.fromVersion);
  const home=join(paths.profile,'deepseek-harness/native-state/rc8-native-surface-v1');
  assert.equal(existsSync(home),false,'a fresh runner profile is required; never repurpose a newer engine profile');
  const {runNativeDshProbe}=await import(pathToFileURL(join(paths.install,'dsh-host/luckyray-dsh-host.mjs')));
  let sessionId;
  const probe=await runNativeDshProbe({runtimeRoot:runtime,stateRoot:home,observeEvents:events=>{sessionId=events.find(e=>e.type==='session')?.id;}});
  assert.equal(probe.probeCompleted,true);assert.match(sessionId,/^session-[a-z0-9-]+$/);
  const workspaceTitle='Installed upgrade synthetic';
  await mkdir(join(home,'storages'),{recursive:true});
  const workspace={unit:{name:'workspace',version:2},global:{initialized:true,workspaceIds:['installed-upgrade'],archivedSessionIds:[]},tables:{workspaces:{'installed-upgrade':{path:join(home,'workspace'),title:workspaceTitle,sessionIds:[sessionId],createdAt:new Date(0).toISOString(),updatedAt:new Date(0).toISOString()}}}};
  await writeFile(join(home,'storages/workspace.json'),JSON.stringify(workspace));
  const originals=await originalSessions(home,sessionId);assert.equal(originals.length,1);
  for(let i=0;i<originals.length;i++){originals[i].snapshot=join(root,'evidence',`SESSION-before-${i}.zstd`);await writeFile(originals[i].snapshot,await readFile(originals[i].file));}
  assert.equal(basename(originals[0].file),'session.v4.jsonl.zstd','both frozen official engines use V4; no custom migration permitted');
  const sessionSnapshot=join(root,'evidence','SESSION-before.json');
  await writeFile(sessionSnapshot,JSON.stringify(await readOfficialSession(runtime,home,sessionId),null,2));
  const fixture={home,sessionId,workspaceTitle,originals,sessionSnapshot};
  await writeFile(join(root,'evidence/OLD-ENGINE-SESSION.json'),JSON.stringify({version:pkg.version,sessionId,provider:'deterministic loopback only; no real model',originals},null,2));
  await event('old_installed_engine_fixture',{version:pkg.version,sessionId,sessionGenerations:originals.length,realModelCalled:false});
  return fixture;
}

export async function runDshInstalledUpgrade(context){
  runner();
  const {root,paths,spec,event,oldFixture,materialFixture,connect,requireCdpOwner,settingsBefore,notePath,expected,originalGrant,originalAuthorityBytes,authorityFingerprints,installedEnvironment}=context;
  const policy=preservationPolicy(context);
  let {browser,page}=context;
  let selectedRuntime,preservationIndex=0;
  const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI__.core.invoke(command,args),{command,args});
  const snap=async(name,surface=page)=>{await surface.screenshot({path:join(root,'evidence',name+'.png'),fullPage:true});await writeFile(join(root,'evidence',name+'.dom.txt'),await surface.locator('body').innerText());};
  const actualApp=async()=>{const apps=(await processes()).filter(p=>p.exe?.toLowerCase()===join(paths.install,'luckyray-app.exe').toLowerCase());assert.equal(apps.length,1);return apps[0];};
  async function identity(expectedVersion){
    const app=await actualApp(),rows=await processes();
    const owned=rows.filter(p=>p.exe?.toLowerCase().endsWith('node.exe')&&rows.some(parent=>parent.pid===p.ppid&&parent.ppid===app.pid)||p.exe?.toLowerCase().endsWith('node.exe')&&p.ppid===app.pid);
    const actual=[];
    for(const child of owned){const runtime=resolve(child.exe,'../..');const file=join(runtime,'host/node_modules/@deepseek-ai/dsh/package.json');if(existsSync(file)){const pkg=JSON.parse(await readFile(file,'utf8'));actual.push({...child,runtime,version:pkg.version,nodeSha256:hash(await readFile(child.exe))});}}
    assert.ok(actual.length>0,'owned running Node image must identify the actual selected engine');
    assert.ok(actual.every(p=>p.version===expectedVersion));
    selectedRuntime=actual[0].runtime;
    const status=await invoke('dsh_engine_update_status');assert.equal(status.currentVersion,expectedVersion);assert.equal(status.sourceClass,'production');
    await event('actual_selected_engine',{appPid:app.pid,hostVersion:await page.evaluate(()=>window.__TAURI__.app.getVersion()),status,runtimes:actual});
    return {app,status,runtimes:actual};
  }
  async function lshPage(){
    await page.evaluate(()=>{location.hash='#ai';});
    return wait('real authenticated LSH editor',async()=>{
      for(const candidate of browser.contexts().flatMap(c=>c.pages())){
        let url;try{url=new URL(candidate.url());}catch{continue;}
        if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')continue;
        if(await candidate.locator('[contenteditable="true"]:visible').count())return candidate;
      }
      return false;
    });
  }
  async function oldSession(surface){
    const row=await revealOldSession(surface,oldFixture,{snap,event});
    if(policy.mode==='dsh-only'){
      // The old engine's mask is a shared Modal primitive, not proof of onboarding.
      // Observe the actual dialog; never dismiss, confirm, or force through it.
      await snap('DSH-only-before-session-click',surface);
      const dialogs=await surface.locator('[role="dialog"]:visible').evaluateAll(nodes=>nodes.map(node=>({title:node.getAttribute('aria-label'),text:node.innerText})));
      await event('old_session_click_preflight',{sessionId:oldFixture.sessionId,visibleDialogs:dialogs});
    }
    await row.click();
    await surface.getByText('LUCKYRAY_DSH_NATIVE_PROBE',{exact:true}).first().waitFor({timeout:45000});
    await surface.getByText('DSH_NATIVE_ACCEPTED',{exact:true}).first().waitFor();
    await wait('official selected session',()=>surface.evaluate(id=>{try{return JSON.parse(localStorage.getItem('dsh.sessions.current'))?.sessionId===id;}catch{return false;}},oldFixture.sessionId));
    return surface.locator('[contenteditable="true"]:visible').first();
  }
  async function settingsAI(){await page.evaluate(()=>{location.hash='#settings';});await page.locator('#settings-nav').getByRole('button',{name:'AI',exact:true}).click();}
  async function preserved(){
    assert.equal(await readFile(notePath,'utf8'),expected);
    assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('luckyray-settings-v1'))),settingsBefore);
    await policy.verify(invoke);
    if(policy.mode==='dsh-only'){
      const note=await invoke('knowledge_read_document',{documentRef:context.documentRef});
      assert.equal(note.content,expected);assert.deepEqual(note.documentRef,context.documentRef);
    }
    await assertOriginals(oldFixture,{runtime:selectedRuntime,root,index:preservationIndex++,event});
    await verifyInstalledMaterial(invoke,materialFixture);
  }
  try{
  await wait('old engine running in upgraded host',async()=>{const s=await invoke('dsh_native_surface_status');return s.ready&&s.stage==='session-open'&&s.ownedDirectProcessCount===2;});
  await identity(spec.engine.fromVersion);await preserved();
  let surface=await lshPage();await oldSession(surface);await snap('B-old-engine-old-session',surface);
  await event('old_session_visible_before_engine_update',{sessionId:oldFixture.sessionId,oldTurnsVisible:true});

  await settingsAI();await snap('B-engine-update-start');
  await page.getByRole('button',{name:/^(检查更新|Check for updates)$/}).click();
  await wait('signed engine candidate discovery',async()=>{const s=await invoke('dsh_engine_update_status');if(['check_failed','untrusted','requires_host','prepare_failed','upstream_identity'].includes(s.phase))throw Error('engine candidate discovery refused: '+s.phase);return s.phase==='available'&&s.candidateVersion===spec.engine.version&&s.canInstall;});
  await snap('B-engine-candidate-discovered');
  await page.getByRole('button',{name:/^(下载并验证升级|Download and verify update)$/}).click();
  await wait('engine download assembly seal and staging',async()=>{const s=await invoke('dsh_engine_update_status');if(['prepare_failed','recovery_required','untrusted','check_failed'].includes(s.phase))throw Error('real engine prepare stopped: '+s.phase);return s.phase==='restart_required'&&(s.canRestart||s.canPrepareExit);},1200000);
  const prepared=await invoke('dsh_engine_update_status');await event('engine_download_verified_staged',{status:prepared});await snap('B-engine-verified-ready');
  const before=await actualApp();
  await clickEngineRestart(page,{canRestart:prepared.canRestart,event,observeExit:async()=>{
    await wait('engine updater normal old process exit',async()=>!(await processes()).some(p=>p.pid===before.pid),180000);
    if(policy.mode==='dsh-only')await context.requireInitialNormalExit(before.pid);
  }});
  const auto=await wait('product-owned automatic host reopen after engine switch',async()=>(await processes()).find(p=>p.exe?.toLowerCase()===join(paths.install,'luckyray-app.exe').toLowerCase()&&p.pid!==before.pid),180000);
  await event('engine_product_reopen_observed_before_cdp',{...auto,exeSha256:hash(await readFile(auto.exe)),expectedHostVersion:spec.b.version,uiVersion:'NOT_YET_VERIFIED'});
  ({browser,page}=await connect());await requireCdpOwner(auto.pid);
  assert.equal(hash(await readFile(join(paths.install,'luckyray-app.exe'))),spec.b.installedExeSha256);
  assert.equal(await page.evaluate(()=>window.__TAURI__.app.getVersion()),spec.b.version);
  // Frozen coordinator.verify_activated_health requires a real SessionOpen surface.
  surface=await lshPage();await oldSession(surface);
  await wait('new engine session open before health check',async()=>{const s=await invoke('dsh_native_surface_status');return s.ready&&s.stage==='session-open';});
  await settingsAI();
  await wait('pending engine local health check',async()=>{const s=await invoke('dsh_engine_update_status');if(s.phase==='switch_incomplete'||s.phase==='verification_failed')throw Error('engine switch health refused: '+s.phase);return s.canVerify||s.phase==='healthy';},180000);
  if((await invoke('dsh_engine_update_status')).canVerify){await page.getByRole('button',{name:/^(完成本机健康检查|Verify local engine health)$/}).click();}
  await wait('new engine healthy',async()=>{const s=await invoke('dsh_engine_update_status');if(['verification_failed','switch_incomplete','recovery_required'].includes(s.phase))throw Error('new engine health failed: '+s.phase);return s.phase==='healthy'&&s.currentVersion===spec.engine.version;},180000);
  await snap('B-engine-upgraded-healthy');
  surface=await lshPage();let editor=await oldSession(surface);await snap('B-new-engine-old-session',surface);
  const after=await identity(spec.engine.version);assert.ok(after.runtimes.every(p=>p.runtime.toLowerCase().startsWith(join(paths.profile,'dsh-engine-updates/versions',spec.engine.descriptorSha256).toLowerCase())));
  await preserved();

  assert.equal((await editor.innerText()).trim(),'','only a dedicated empty synthetic composer may be edited');
  const draft='DSH-INSTALLED-UPGRADE-DRAFT-20261018 中文 text only';
  await editor.click();await surface.keyboard.insertText(draft);
  assert.equal((await editor.innerText()).trim(),draft);await snap('B-real-unsent-draft',surface);
  await wait('official draft persisted before normal quit',async()=>plainDraftMatches(await surface.evaluate(id=>{try{return JSON.parse(localStorage.getItem('dsh.conversation.'+id))?.draft;}catch{return null;}},oldFixture.sessionId),draft));
  const normal=await actualApp();await invoke('close_window');
  await wait('normal host close for draft restart',async()=>!(await processes()).some(p=>p.pid===normal.pid),180000);
  await wait('previous draft-test CDP listener released',async()=>{try{await fetch('http://127.0.0.1:9391/json/version');return false;}catch{return true;}},45000);
  // The updater's automatic reopen has already been proved above. This is a
  // separately labelled ordinary user reopen to verify an unsent text draft.
  const reopened=spawn(join(paths.install,'luckyray-app.exe'),[],{cwd:paths.install,windowsHide:false,env:installedEnvironment});
  let reopenedExit;reopened.on('exit',(code,signal)=>{reopenedExit={code,signal};});
  reopened.stdout.resume();reopened.stderr.resume();reopened.stdout.unref?.();reopened.stderr.unref?.();reopened.unref();
  ({browser,page}=await connect());await requireCdpOwner(reopened.pid);
  surface=await lshPage();editor=await oldSession(surface);
  await wait('real composer draft restored after ordinary reopen',async()=>(await editor.innerText()).trim()===draft);
  await snap('B-draft-restored-real-composer',surface);await preserved();await identity(spec.engine.version);
  await event('engine_upgrade_and_text_restart_pass',{from:spec.engine.fromVersion,to:spec.engine.version,automaticallyReopenedPid:auto.pid,manualEngineUpdateLaunch:false,ordinaryDraftReopenPid:reopened.pid,sessionId:oldFixture.sessionId,draftSha256:hash(draft)});

  // Necessary original-file smoke: material PDF and canonical Markdown note.
  // Setup uses the ordinary catalog API; the additions themselves are real
  // sidebar clicks and official binary-upload requests. Nothing is submitted.
  await verifyInstalledMaterial(invoke,materialFixture);
  const pdf=await readFile(materialFixture.file);
  const uploaded=[],forbidden=[];
  surface.on('request',req=>{try{const url=new URL(req.url());if(req.method()==='POST'&&/^\/api\/session\//.test(url.pathname)&&/(prompt|submit|steer|reply)/i.test(url.pathname))forbidden.push(url.pathname);}catch{}});
  surface.on('response',async response=>{try{const request=response.request(),url=new URL(request.url());if(request.method()==='POST'&&url.pathname==='/api/session/uploadFileBinary'){const body=await response.json();uploaded.push({sessionId:url.searchParams.get('sessionId'),name:url.searchParams.get('name'),status:response.status(),ok:body.ok===true});}}catch{}});
  async function storedOriginal(expectedBytes){
    const matches=[];
    async function visit(dir){if(!existsSync(dir))return;for(const entry of await readdir(dir,{withFileTypes:true})){const file=join(dir,entry.name);if(entry.isDirectory())await visit(file);else if(entry.isFile()&&(await stat(file)).size===expectedBytes.length&&hash(await readFile(file))===hash(expectedBytes))matches.push({sha256:hash(expectedBytes),bytes:expectedBytes.length});}}
    await visit(join(oldFixture.home,'attachments'));return matches.length>0;
  }
  await page.getByRole('button',{name:/^(打开素材与知识库侧栏|Open Materials and Knowledge sidebar)$/}).click();
  const sidebar=page.getByRole('complementary',{name:/^(LightSeek 内容浏览侧栏|LightSeek content browser sidebar)$/});await sidebar.waitFor();
  await sidebar.getByRole('button',{name:'添加到输入框：'+materialFixture.asset.name,exact:true}).click();
  await wait('real material original binary upload',async()=>uploaded.find(r=>r.sessionId===oldFixture.sessionId&&r.name===materialFixture.asset.name&&r.status===200&&r.ok)&&await storedOriginal(pdf));
  await sidebar.getByRole('status').filter({hasText:/^(已放入 LightSeek 输入框|Added to the LightSeek draft)$/}).waitFor({timeout:120000});
  await sidebar.locator('.lightseek-content-browser-body[aria-busy="false"]').waitFor();
  await sidebar.getByRole('tab',{name:/^(知识库|Knowledge)$/}).click();
  await sidebar.getByRole('status').waitFor({state:'hidden'}); // Tab change clears the prior addition status.
  await sidebar.getByRole('button',{name:/^添加到输入框：FormalUpgradeSynthetic(?:\.md)?$/}).click();
  await wait('real knowledge original binary upload',async()=>uploaded.find(r=>r.sessionId===oldFixture.sessionId&&r.name===basename(notePath)&&r.status===200&&r.ok)&&await storedOriginal(Buffer.from(expected)));
  await sidebar.getByRole('status').filter({hasText:/^(已放入 LightSeek 输入框|Added to the LightSeek draft)$/}).waitFor({timeout:120000});
  await sidebar.locator('.lightseek-content-browser-body[aria-busy="false"]').waitFor();
  assert.equal((await editor.innerText()).trim(),draft,'original unsent text stays intact after both additions');
  assert.equal(await readFile(notePath,'utf8'),expected);
  await snap('B-original-file-sidebars',page);await snap('B-original-files-official-composer',surface);
  assert.deepEqual(forbidden,[],'no actual submit/prompt request may be made');
  await event('original_files_sidebar_pass',{uploaded,originals:[{sha256:hash(pdf),bytes:pdf.length},{sha256:hash(expected),bytes:Buffer.byteLength(expected)}],modelSubmitCalled:false,existingDraftPreserved:true});
  if(policy.mode==='dsh-only'){
    await editor.click();await editor.press('Control+A');await editor.press('Backspace');
    await wait('cleared official composer draft persisted',async()=>plainDraftMatches(await surface.evaluate(id=>{try{return JSON.parse(localStorage.getItem('dsh.conversation.'+id))?.draft;}catch{return null;}},oldFixture.sessionId),''));
    const clearing=await actualApp();await invoke('close_window');
    await wait('normal close after clear',async()=>!(await processes()).some(p=>p.pid===clearing.pid),180000);
    assert.equal(clearing.pid,reopened.pid);await wait('cleared draft process exit result',()=>reopenedExit);
    assert.equal(reopenedExit.code,0);assert.equal(reopenedExit.signal,null);
    await wait('clear-test CDP listener released',async()=>{try{await fetch('http://127.0.0.1:9391/json/version');return false;}catch{return true;}},45000);
    const clearedReopen=spawn(join(paths.install,'luckyray-app.exe'),[],{cwd:paths.install,windowsHide:false,env:installedEnvironment});
    clearedReopen.stdout.resume();clearedReopen.stderr.resume();clearedReopen.stdout.unref?.();clearedReopen.stderr.unref?.();clearedReopen.unref();
    ({browser,page}=await connect());await requireCdpOwner(clearedReopen.pid);
    surface=await lshPage();editor=await oldSession(surface);
    assert.equal((await editor.innerText()).trim(),'','cleared draft must not resurrect');
    await preserved();await identity(spec.engine.version);await snap('B-cleared-draft-stays-empty',surface);
    await event('cleared_draft_restart_pass',{ordinaryReopenPid:clearedReopen.pid});
  }
  const result={from:spec.engine.fromVersion,to:spec.engine.version,descriptorSha256:spec.engine.descriptorSha256,automaticReopen:true,oldSessionVisible:true,originalSessionBytePrefixPreserved:true,originalSessionEventPrefixPreserved:true,...policy.result,preUpgradeMaterialIdPreserved:materialFixture.asset.id,realDraftAfterRestart:true,originalMaterialAndNoteBytes:true,profile:paths.profile,sourceClass:'production'};
  await writeFile(join(root,'evidence/ENGINE-RESULT.json'),JSON.stringify(result,null,2)+'\n');
  await browser.close();return result;
  }catch(error){
    // Capture current reconnect surfaces before outer cleanup disconnects them.
    // These files stay in the existing encrypted-only evidence pipeline.
    let index=0;
    for(const candidate of browser.contexts().flatMap(c=>c.pages())){
      let allowed=candidate===page;
      try{const url=new URL(candidate.url());allowed ||= url.protocol==='http:'&&url.hostname==='127.0.0.1';}catch{}
      if(!allowed||candidate.isClosed())continue;
      const name='ENGINE-STOP-'+index++;const captured={name,screenshot:false,dom:false};
      try{await candidate.screenshot({path:join(root,'evidence',name+'.png'),fullPage:true,timeout:5000});captured.screenshot=true;}catch{}
      try{await writeFile(join(root,'evidence',name+'.dom.txt'),await candidate.locator('body').innerText({timeout:5000}));captured.dom=true;}catch{}
      await event('engine_failure_surface_capture',captured).catch(()=>{});
    }
    throw error;
  }
}
