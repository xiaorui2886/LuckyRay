// Exercise production TS adapters against the actual Rust package store and
// production Knowledge browser fixture writer. No user profile/DB or desktop.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const readline=require('node:readline');
const root=path.resolve(__dirname,'..');
const esbuild=require(require.resolve('esbuild',{paths:[fs.realpathSync(root+'/node_modules/vite')]}));
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'luckyray-ext-c0-'));
const executable=process.env.LUCKYRAY_PACKAGE_FIXTURE;
if(!executable) throw Error('Set LUCKYRAY_PACKAGE_FIXTURE to the built extension-packages-native-fixture executable.');
const values=new Map();
global.localStorage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
global.window=new EventTarget();window.localStorage=global.localStorage;
const target=()=>{const styles=new Map();return {dataset:{},style:{setProperty:(k,v)=>styles.set(k,v),removeProperty:k=>styles.delete(k),getPropertyValue:k=>styles.get(k)||''},styles};};
global.document={documentElement:target()};
let child;
(async()=>{
 const out=path.join(fixture,'adapters.cjs');
 await esbuild.build({stdin:{contents:`export * from './src/core/extensions/packages'; export * from './src/core/extensions/templates'; export * from './src/core/extensions/theme'; export {readSavedSettings,writeSavedSettingsPatch,applyGlobalSettings} from './src/features/settings/useSettings'; export * as knowledge from './src/core/services/knowledge'; export * as source from './src/core/services/knowledgeSource'; export * as drafts from './src/core/services/vaultAttachmentSessions';`,resolveDir:root,loader:'ts'},bundle:true,platform:'node',format:'cjs',outfile:out});
 const api=require(out);
 child=spawn(executable,[fixture],{stdio:['pipe','pipe','inherit'],windowsHide:true});
 const pending=[];readline.createInterface({input:child.stdout}).on('line',line=>{const waiter=pending.shift();if(!waiter)throw Error('unexpected native response');const value=JSON.parse(line);value.error?waiter.reject(new Error(value.error)):waiter.resolve(value.ok);});
 const transport=request=>new Promise((resolve,reject)=>{pending.push({resolve,reject});child.stdin.write(JSON.stringify(request)+'\n');});
 const packages=api.createExtensionPackageService(transport);
 const theme=fs.readFileSync(root+'/examples/extensions/paper-sage.lrpack.json','utf8');
 const template=fs.readFileSync(root+'/examples/extensions/research-note.lrpack.json','utf8');
 const themeId=JSON.parse(theme).manifest.id,templateId=JSON.parse(template).manifest.id;
 let state=await packages.refresh();assert.equal(state.revision,0);
 state=await packages.install(theme,state.revision);assert.equal(state.packages.length,1);assert.equal(state.packages[0].enabled,false);
 assert.equal((await packages.install(theme,state.revision)).revision,state.revision,'identical install idempotent');
 state=await packages.install(template,state.revision);assert.equal(state.packages.length,2);
 assert.deepEqual(api.packageCompatibility(JSON.parse(template),state.hostVersion),{compatible:true,unavailableOptional:['assets']});
 for(const mutate of [p=>p.manifest.type='script',p=>p.manifest.entry='../theme.json',p=>p.manifest.requiredModules=['network'],p=>p.resource.tokens['--theme-app-bg']='url(https://example.invalid/a)',p=>p.manifest.minHostVersion='9.0.0',p=>p.manifest.apiVersion=1]){
  const bad=JSON.parse(theme);mutate(bad);await assert.rejects(()=>packages.update(JSON.stringify(bad),state.revision),/extension-/);
  assert.deepEqual(await packages.refresh(),state,'rejected package must not change old version or registry');
 }
 await assert.rejects(()=>packages.enable(themeId,state.revision-1),/revision-conflict/);
 const badTemplate=JSON.parse(template);badTemplate.resource.markdown='![remote](https://example.invalid/x)';await assert.rejects(()=>packages.update(JSON.stringify(badTemplate),state.revision),/unsafe-template/);
 await assert.rejects(()=>packages.install('x'.repeat(131073),state.revision),/too-large/);
 console.log('PASS native install, idempotence, module compatibility, bad paths/resources/types, stale revisions');
 const saved=api.writeSavedSettingsPatch({'general.theme':'rose-tea','appearance.accentColor':'#123456','appearance.fontSize':'lg'});
 // The shared singleton is the same instance read by applyGlobalSettings.
 // Injecting the transport is unnecessary for palette testing: compose the two
 // actual production functions as AppShell/useSettings do, using our native state.
 const apply=()=>{api.applyGlobalSettings(api.readSavedSettings(),document.documentElement);api.applyPackageTheme(packages.activeTheme(),document.documentElement);};
 apply();const before=Object.fromEntries(document.documentElement.styles),beforeData={...document.documentElement.dataset};
 const dispose=packages.previewTheme(themeId);apply();assert.equal(document.documentElement.dataset.theme,'light');assert.equal(document.documentElement.style.getPropertyValue('--theme-app-bg'),'#edf1e8');assert.equal(document.documentElement.style.getPropertyValue('--accent'),'#123456');
 dispose();apply();assert.deepEqual(Object.fromEntries(document.documentElement.styles),before);assert.deepEqual(document.documentElement.dataset,beforeData);assert.deepEqual(api.readSavedSettings(),saved);
 packages.previewTheme(themeId);state=await packages.confirmPreview(state.revision);apply();assert.equal(document.documentElement.dataset.theme,'light');
 const reloaded=api.createExtensionPackageService(transport);await reloaded.refresh();assert.deepEqual(reloaded.activeTheme(),packages.activeTheme());
 state=await packages.disable(themeId,state.revision);apply();assert.equal(document.documentElement.dataset.theme,'rose-tea');assert.deepEqual(Object.fromEntries(document.documentElement.styles),before);
 packages.previewTheme(themeId);state=await packages.uninstall(themeId,state.revision);assert.equal(packages.activeTheme(),null);apply();assert.deepEqual(Object.fromEntries(document.documentElement.styles),before);
 state=await packages.install(theme,state.revision);state=await packages.enable(themeId,state.revision);
 const nextTheme=JSON.parse(theme);nextTheme.manifest.version='1.0.1';nextTheme.resource.tokens['--theme-app-bg']='#e0eadd';state=await packages.update(JSON.stringify(nextTheme),state.revision);assert.equal(packages.activeTheme().tokens['--theme-app-bg'],'#e0eadd');assert.equal(state.packages.find(p=>p.package.manifest.id===themeId).enabled,true);
 console.log('PASS preview full restore, persistent enabled theme, disable/uninstall restore, atomic version update');
 state=await packages.enable(templateId,state.revision);
 api.source.activateKnowledgeWritesForVault({mode:'real-vault',vaultId:'browser-preview'});
 const actions=api.createExtensionTemplateActions(packages);
 const prepared=await actions.prepare(templateId,{topic:'Evidence study',question:'What changes?'},'create');
 const note=await prepared.execute('C0 dedicated fixture');assert.match(note.content,/# Evidence study/);assert.equal(note.documentRef.vaultId,'browser-preview');
 assert.equal((await api.knowledge.readKnowledgeDocument(note.documentRef)).content,note.content);
 await assert.rejects(()=>prepared.execute('must not duplicate'),/operation-consumed/);
 const active=await api.knowledge.ensureActiveKnowledgeUiSource();
 const session=await api.knowledge.beginCurrentKnowledgeContextSession('c0-fixture',active.sourceEpoch);
 await api.knowledge.setCurrentKnowledgeContext({...session,sourceEpoch:active.sourceEpoch,generation:1,documentRef:note.documentRef,expectedRevision:note.revision,cursorOffset:note.content.length});
 const noEditor=await actions.prepare(templateId,{},'insert');await assert.rejects(()=>noEditor.execute('no session'),/笔记页/);
 let dirty=true; let refreshCount=0;
 const disposeDraft=api.drafts.registerAttachmentDraftSession({vaultId:'browser-preview',source:api.source.readActiveKnowledgeWriteSource(),save:async()=>{},dirty:()=>dirty,refresh:async()=>{refreshCount++;}});
 const blocked=await actions.prepare(templateId,{},'insert');await assert.rejects(()=>blocked.execute('dirty'),/editor-dirty/);assert.equal((await api.knowledge.readKnowledgeDocument(note.documentRef)).content,note.content);dirty=false;
 const insert=await actions.prepare(templateId,{topic:'Append study'},'insert');const inserted=await insert.execute('ignored');assert.match(inserted.document.content,/# Append study/);assert.equal(refreshCount,1);disposeDraft();
 const stale=await actions.prepare(templateId,{},'create');api.source.activateKnowledgeWritesForVault({mode:'real-vault',vaultId:'other-vault'});await assert.rejects(()=>stale.execute('wrong vault'),/target-stale/);
 api.source.activateKnowledgeWritesForVault({mode:'real-vault',vaultId:'browser-preview'});
 const revoked=await actions.prepare(templateId,{},'create');state=await packages.disable(templateId,state.revision);await assert.rejects(()=>revoked.execute('disabled'),/template-changed/);
 state=await packages.uninstall(templateId,state.revision);assert.equal((await api.knowledge.readKnowledgeDocument(note.documentRef)).content,inserted.document.content,'uninstall never touches generated note');
 console.log('PASS production Knowledge preview create/insert, epoch target refusal, disabled package refusal, generated note survives uninstall');
 // New process uses the same production SQLite reader, proving durable reload.
 const output=execFileSync(executable,[fixture],{input:'{"op":"list"}\n',encoding:'utf8'});assert.equal(JSON.parse(output).ok.revision,state.revision);
 // Package-controlled resource names never become filesystem paths. Also fail
 // closed on an OS-created storage junction before opening a database.
 const linkFixture=path.join(fixture,'link-fixture'),outside=path.join(fixture,'outside');fs.mkdirSync(linkFixture);fs.mkdirSync(outside);fs.symlinkSync(outside,path.join(linkFixture,'extension-packages-v0'),process.platform==='win32'?'junction':'dir');
 const rejected=JSON.parse(execFileSync(executable,[linkFixture],{input:'{"op":"list"}\n',encoding:'utf8'}));assert.match(rejected.error,/unsafe-storage-path/);assert.deepEqual(fs.readdirSync(outside),[]);
 const replies=[];const ordered=api.createExtensionPackageService(()=>new Promise(resolve=>replies.push(resolve)));
 const oldRead=ordered.refresh(),newRead=ordered.refresh();replies[1]({...state,revision:20});await newRead;replies[0]({...state,revision:19});assert.equal((await oldRead).revision,20);assert.equal(ordered.snapshot().revision,20);
 console.log('PASS durable restart and storage symlink/junction rejection');
 console.log('Fixture:',fixture);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{if(child)child.stdin.end();});
