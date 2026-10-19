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
async function originalSessions(home){
  const found=[];
  async function visit(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const file=join(dir,entry.name);if(entry.isDirectory())await visit(file);else if(/^session\.v[34]\.jsonl\.zstd$/.test(entry.name))found.push({file,sha256:hash(await readFile(file))});}}
  await visit(join(home,'sessions'));return found;
}
async function assertOriginals(fixture){for(const file of fixture.originals)assert.equal(hash(await readFile(file.file)),file.sha256,'original old-engine session generation must retain its exact bytes');}

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
  const originals=await originalSessions(home);assert.equal(originals.length,1);
  const fixture={home,sessionId,workspaceTitle,originals};
  await writeFile(join(root,'evidence/OLD-ENGINE-SESSION.json'),JSON.stringify({version:pkg.version,sessionId,provider:'deterministic loopback only; no real model',originals},null,2));
  await event('old_installed_engine_fixture',{version:pkg.version,sessionId,sessionGenerations:originals.length,realModelCalled:false});
  return fixture;
}

export async function runDshInstalledUpgrade(context){
  runner();
  const {root,paths,spec,event,oldFixture,materialFixture,connect,requireCdpOwner,settingsBefore,notePath,expected,originalGrant,originalAuthorityBytes,authorityFingerprints,installedEnvironment}=context;
  const policy=preservationPolicy(context);
  let {browser,page}=context;
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
    const row=surface.locator('[data-row-key="session:'+oldFixture.sessionId+'"]');
    if(!await row.isVisible().catch(()=>false)){
      const workspace=surface.getByRole('treeitem').filter({hasText:oldFixture.workspaceTitle}).first();
      if(await workspace.isVisible().catch(()=>false))await workspace.click();
    }
    await row.waitFor({state:'visible',timeout:45000});await row.click();
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
    await assertOriginals(oldFixture);
    await verifyInstalledMaterial(invoke,materialFixture);
  }
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
  const dialog=page.waitForEvent('dialog',{timeout:10000}).then(async d=>{assert.equal(d.type(),'confirm');await d.accept();});
  await page.getByRole('button',{name:/^(重启软件并完成更新|Restart LuckyRay and finish update)$/}).click();await dialog;
  await wait('engine updater normal old process exit',async()=>!(await processes()).some(p=>p.pid===before.pid),180000);
  if(policy.mode==='dsh-only')await context.requireInitialNormalExit(before.pid);
  const auto=await wait('product-owned automatic host reopen after engine switch',async()=>(await processes()).find(p=>p.exe?.toLowerCase()===join(paths.install,'luckyray-app.exe').toLowerCase()&&p.pid!==before.pid),180000);
  await event('engine_product_reopen_observed_before_cdp',{...auto,exeSha256:hash(await readFile(auto.exe)),expectedHostVersion:spec.b.version,uiVersion:'NOT_YET_VERIFIED'});
  ({browser,page}=await connect());await requireCdpOwner(auto.pid);
  assert.equal(hash(await readFile(join(paths.install,'luckyray-app.exe'))),spec.b.installedExeSha256);
  assert.equal(await page.evaluate(()=>window.__TAURI__.app.getVersion()),spec.b.version);
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
  await wait('official draft persisted before normal quit',()=>surface.evaluate(({id,draft})=>{try{return JSON.parse(localStorage.getItem('dsh.conversation.'+id))?.draft===draft;}catch{return false;}},{id:oldFixture.sessionId,draft}));
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
  await sidebar.getByRole('tab',{name:/^(知识库|Knowledge)$/}).click();
  await sidebar.getByRole('button',{name:/^添加到输入框：FormalUpgradeSynthetic(?:\.md)?$/}).click();
  await wait('real knowledge original binary upload',async()=>uploaded.find(r=>r.sessionId===oldFixture.sessionId&&r.name===basename(notePath)&&r.status===200&&r.ok)&&await storedOriginal(Buffer.from(expected)));
  assert.equal((await editor.innerText()).trim(),draft,'original unsent text stays intact after both additions');
  assert.equal(await readFile(notePath,'utf8'),expected);
  await snap('B-original-file-sidebars',page);await snap('B-original-files-official-composer',surface);
  assert.deepEqual(forbidden,[],'no actual submit/prompt request may be made');
  await event('original_files_sidebar_pass',{uploaded,originals:[{sha256:hash(pdf),bytes:pdf.length},{sha256:hash(expected),bytes:Buffer.byteLength(expected)}],modelSubmitCalled:false,existingDraftPreserved:true});
  if(policy.mode==='dsh-only'){
    await editor.click();await editor.press('Control+A');await editor.press('Backspace');
    await wait('cleared official composer draft persisted',()=>surface.evaluate(id=>{try{return JSON.parse(localStorage.getItem('dsh.conversation.'+id))?.draft==='';}catch{return false;}},oldFixture.sessionId));
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
  const result={from:spec.engine.fromVersion,to:spec.engine.version,descriptorSha256:spec.engine.descriptorSha256,automaticReopen:true,oldSessionVisible:true,originalSessionBytesPreserved:true,...policy.result,preUpgradeMaterialIdPreserved:materialFixture.asset.id,realDraftAfterRestart:true,originalMaterialAndNoteBytes:true,profile:paths.profile,sourceClass:'production'};
  await writeFile(join(root,'evidence/ENGINE-RESULT.json'),JSON.stringify(result,null,2)+'\n');
  await browser.close();return result;
}
