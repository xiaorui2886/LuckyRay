const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');const{createRequire}=require('node:module');const esbuild=createRequire(require.resolve('vite/package.json'))('esbuild');const{JSDOM}=require(process.env.LUCKYRAY_TEST_DOM_MODULE||'jsdom');
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://fixture.invalid/',pretendToBeVisual:true});for(const key of ['window','document','navigator','HTMLElement','Element','Node','Event','CustomEvent','DOMException'])Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});globalThis.location=dom.window.location;globalThis.getComputedStyle=dom.window.getComputedStyle.bind(dom.window);
const names={knowledge:['listKnowledgeDocuments','searchKnowledgeDocuments','readKnowledgeDocument','createKnowledgeDocument','appendKnowledgeDocument','insertKnowledgeDocument','replaceKnowledgeDocument','moveKnowledgeDocument','deleteKnowledgeDocument','getCurrentKnowledgeContext','readKnowledgeIndexSnapshot','readKnowledgeBacklinks','readKnowledgeTagSummary'],materials:['listMaterialAssets','getMaterialAssetsByIds','listFilteredMaterialAssets','importMaterialAssets','importMaterialFolder','updateMaterialAsset','renameMaterialAsset','deleteMaterialAsset','listMaterialTags','setMaterialAssetTags','moveMaterialAssetsToFolder']};
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lr-desktop-host-'));
const ready=(async()=>{const r=await esbuild.build({stdin:{contents:`export * from './src/core/extensions/desktop/runtime';export * from './src/core/extensions/desktop/contributions';export {extensionPackages} from './src/core/extensions/packages';`,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false,plugins:[{name:'host-seams',setup(b){
 b.onResolve({filter:/^@tauri-apps\//},()=>({path:'tauri',namespace:'fixture'}));
 b.onResolve({filter:/services\/(knowledge|materials)$/},args=>({path:args.path.endsWith('/knowledge')?'knowledge':'materials',namespace:'fixture'}));
 b.onResolve({filter:/services\/materialLibraryContext$/},()=>({path:'library',namespace:'fixture'}));
 b.onResolve({filter:/services\/materialLibraryAdapter$/},()=>({path:'adapter',namespace:'fixture'}));
 b.onResolve({filter:/bridge\/luckyRayBridge$/},()=>({path:'bridge',namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'js',contents:args.path==='tauri'?`export const invoke=(command,args)=>globalThis.__hostInvoke(command,args);export const listen=async(name,handler)=>globalThis.__fixtureListen?globalThis.__fixtureListen(name,handler):()=>{};`:args.path==='library'?`export const materialLibrarySession={getSnapshot:()=>globalThis.__fixtureLibraries??({libraryId:'fixture'}),request:()=>Promise.resolve([])};`:args.path==='adapter'?`export const createMaterialLibraryAdapter=(_bridge,id,origins)=>globalThis.__fixtureMaterialAdapter?.(id,origins)??({listAssets:async()=>[]});`:args.path==='bridge'?`export const getLuckyRayBridgeSync=()=>({});export const getLuckyRayBridge=async()=>({});`:names[args.path].map(name=>`export const ${name}=(...args)=>globalThis.__fixtureServices?.${name}?.(...args)??Promise.resolve([]);`).join('\n')}));
 }}]});const file=path.join(dir,'host.cjs');fs.writeFileSync(file,r.outputFiles[0].text);return require(file);})();
const wait=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,2));}throw Error('fixture timeout');};
test('stop during async activation rejects and immediately cleans late standard registrations',async()=>{
 const api=await ready;const calls=[];const state={revision:1,hostVersion:'1.9.8',packages:[{enabled:true,digest:'fixture-digest',epoch:1,grants:['desktop.fullTrust'],package:{manifest:{schemaVersion:2,apiVersion:2,type:'desktop',id:'test.desktop',name:'Synthetic',version:'1.0.0',minHostVersion:'1.9.8',requiredModules:[],optionalModules:[]},resource:{code:'synthetic import seam',dataVersion:1,contributions:[],assets:{}}}}]};
 globalThis.__hostInvoke=async(command,args)=>{const request=JSON.parse(args.request);calls.push(request.op);if(command==='manage_extension_packages')return structuredClone(state);if(request.op==='open')return 'fixture-lease';return null;};
 let captured,release,finished=false;const gate=new Promise(r=>{release=r;});let lateRoutes=0,intervals=0;
 const set=window.setInterval.bind(window),clear=window.clearInterval.bind(window);window.setInterval=(fn,ms)=>{intervals++;return set(fn,ms);};window.clearInterval=id=>{intervals--;clear(id);};
 const stop=await api.startDesktopExtensionHost({importModule:async()=>({activate:async host=>{captured=host;host.commands.register({id:'one',name:'one',run:()=>{}});await gate;assert.throws(()=>host.lifecycle.setInterval(()=>{},1000),/retired/);assert.throws(()=>host.workspace.onRouteChange(()=>lateRoutes++),/retired/);finished=true;}})});
 await wait(()=>captured);assert.equal(api.desktopCommands.size,1);stop();release();await wait(()=>finished);assert.equal(intervals,0);assert.equal(api.desktopCommands.size,0);window.dispatchEvent(new Event('hashchange'));assert.equal(lateRoutes,0);assert.ok(calls.includes('close'));window.setInterval=set;window.clearInterval=clear;
});

test('late old activation cleanup cannot remove a re-enabled generation with the same view id',async()=>{
 const api=await ready;let state={revision:10,hostVersion:'1.9.8',packages:[{enabled:true,digest:'same',epoch:10,grants:['desktop.fullTrust'],package:{manifest:{schemaVersion:2,apiVersion:2,type:'desktop',id:'test.generations',name:'Synthetic',version:'1.0.0',minHostVersion:'1.9.8',requiredModules:[],optionalModules:[]},resource:{code:'synthetic import seam',dataVersion:1,contributions:[],assets:{}}}}]};
 globalThis.__hostInvoke=async(command,args)=>{const request=JSON.parse(args.request);if(command==='manage_extension_packages')return structuredClone(state);if(request.op==='open')return 'lease-'+state.revision;return null;};
 let oldReady=false,newReady=false,release,finished=false,imports=0;const gate=new Promise(r=>{release=r;});
 const stop=await api.startDesktopExtensionHost({importModule:async()=>{const generation=++imports;return{activate:async host=>{
  const unregister=host.workspace.registerView({id:'board',title:generation===1?'old':'new',mount:()=>{}});
  if(generation===1){oldReady=true;await gate;finished=true;return()=>{unregister();unregister();};}
  newReady=true;return unregister;
 }};}});
 await wait(()=>oldReady);state={...state,revision:11,packages:[{...state.packages[0],enabled:false,epoch:11}]};await api.extensionPackages.refresh();
 state={...state,revision:12,packages:[{...state.packages[0],enabled:true,epoch:12}]};await api.extensionPackages.refresh();await wait(()=>newReady);
 release();await wait(()=>finished);await Promise.resolve();assert.equal(api.desktopViews.get('test.generations/board').title,'new');stop();assert.equal(api.desktopViews.has('test.generations/board'),false);
});
test('retired generation cannot close a newer view with the same id',async()=>{
 const api=await ready;
 let state={revision:20,hostVersion:'1.9.8',packages:[{enabled:true,digest:'same',epoch:20,grants:['desktop.fullTrust'],package:{manifest:{schemaVersion:2,apiVersion:2,type:'desktop',id:'test.late-close',name:'Synthetic',version:'1.0.0',minHostVersion:'1.9.8',requiredModules:[],optionalModules:[]},resource:{code:'synthetic import seam',dataVersion:1,contributions:[],assets:{}}}}]};
 globalThis.__hostInvoke=async(command,args)=>{const request=JSON.parse(args.request);if(command==='manage_extension_packages')return structuredClone(state);if(request.op==='open')return 'lease-'+state.revision;return null;};
 const hosts=[];
 const stop=await api.startDesktopExtensionHost({importModule:async()=>({activate:host=>{
  hosts.push(host);host.workspace.registerView({id:'board',title:'Synthetic',mount:()=>{}});
 }})});
 await wait(()=>hosts.length===1);
 state={...state,revision:21,packages:[{...state.packages[0],enabled:false,epoch:21}]};await api.extensionPackages.refresh();
 state={...state,revision:22,packages:[{...state.packages[0],enabled:true,epoch:22}]};await api.extensionPackages.refresh();await wait(()=>hosts.length===2);
 hosts[1].workspace.openView('board','right');
 assert.equal(api.panels.some(p=>p.key==='test.late-close/board'),true);
 assert.throws(()=>hosts[0].workspace.closeView('board'),/retired/);
 assert.equal(api.panels.some(p=>p.key==='test.late-close/board'),true);
 stop();
});
test('committed host events use valid Tauri names and stop delivery on retirement',async()=>{
 const api=await ready;
 const entry={enabled:true,digest:'events',epoch:25,grants:['desktop.fullTrust'],package:{manifest:{schemaVersion:2,apiVersion:2,type:'desktop',id:'test.event-roundtrip',name:'Events',version:'1.0.0',minHostVersion:'1.9.8',requiredModules:[],optionalModules:[]},resource:{code:'synthetic import seam',dataVersion:1,contributions:[],assets:{}}}};
 const store={revision:25,hostVersion:'1.9.8',packages:[entry]},listeners=new Map(),received=[];
 globalThis.__hostInvoke=async(command,args)=>{const request=JSON.parse(args.request);if(command==='manage_extension_packages')return structuredClone(store);if(request.op==='open')return 'event-lease';return null;};
 globalThis.__fixtureListen=async(name,handler)=>{if(!/^[A-Za-z0-9_:/-]+$/.test(name))throw Error('invalid Tauri event name: '+name);listeners.set(name,handler);return()=>listeners.delete(name);};
 const stop=await api.startDesktopExtensionHost({importModule:async()=>({activate:async host=>{
  await host.events.on('knowledge.saved',event=>received.push(['note',event]));
  await host.events.on('materials.imported',event=>received.push(['material',event]));
 }})});
 try{
  await wait(()=>['active','failed'].includes(api.desktopStatus('test.event-roundtrip')?.state));
  assert.equal(api.desktopStatus('test.event-roundtrip')?.state,'active',api.desktopStatus('test.event-roundtrip')?.message);
  assert.deepEqual([...listeners.keys()].sort(),['luckyray:desktop:knowledge-saved','luckyray:desktop:materials-imported']);
  listeners.get('luckyray:desktop:knowledge-saved')({payload:{documentRef:{vaultId:'synthetic',relativePath:'note.md'}}});
  listeners.get('luckyray:desktop:materials-imported')({payload:{libraryId:'synthetic',ids:['asset']}});
  assert.deepEqual(received.map(item=>item[0]),['note','material']);
  stop();assert.equal(listeners.size,0);
 }finally{stop();delete globalThis.__fixtureListen;}
});
test('host passes scoped origins through note and bound-library writes and retires the scope',async()=>{
 const api=await ready, listeners=new Map(),calls=[],seen={a:[],b:[]};let capturedScope,bound;
 const entry=id=>({enabled:true,digest:id,epoch:26,grants:['desktop.fullTrust'],package:{manifest:{schemaVersion:2,apiVersion:2,type:'desktop',id,name:id,version:'1.0.0',minHostVersion:'1.9.8',requiredModules:[],optionalModules:[]},resource:{code:id,dataVersion:1,contributions:[],assets:{}}}});
 const state={revision:26,hostVersion:'1.9.8',packages:[entry('test.guard-a'),entry('test.guard-b')]};
 globalThis.__hostInvoke=async(command,args)=>{const request=JSON.parse(args.request);if(command==='manage_extension_packages')return structuredClone(state);if(request.op==='open')return 'lease-'+request.id;return null;};
 globalThis.__fixtureListen=async(name,handler)=>{const set=listeners.get(name)??new Set();set.add(handler);listeners.set(name,set);return()=>set.delete(handler);};
 const emit=(name,payload)=>{for(const listener of [...(listeners.get(name)??[])])listener({payload});};
 const ref={vaultId:'synthetic',relativePath:'note.md'};
 globalThis.__fixtureServices={appendKnowledgeDocument:async(_ref,_content,_rev,origins)=>{calls.push(['note',origins]);emit('luckyray:desktop:knowledge-saved',{documentRef:ref,__luckyrayEventOrigins:origins});return {};}};
 globalThis.__fixtureMaterialAdapter=(id,origins)=>({importAssets:async()=>{const captured=origins();calls.push(['material',id,captured]);emit('luckyray:desktop:materials-imported',{libraryId:id,ids:['synthetic'],__luckyrayEventOrigins:captured});return {assets:[]};}});
 const stop=await api.startDesktopExtensionHost({importModule:async code=>({activate:async host=>{
  const who=code.endsWith('-a')?'a':'b';
  await host.events.on(who==='a'?'knowledge.saved':'luckyray:desktop:knowledge-saved',async (payload,scope)=>{seen[who].push(['note',payload]);if(who==='a'){capturedScope=scope;bound=scope.materials.library('synthetic-library');await scope.knowledge.append(ref,'synthetic');await bound.importAssets({paths:['synthetic']});}});
  await host.events.on('materials.imported',payload=>seen[who].push(['material',payload]));
 }})});
 try{
  await wait(()=>state.packages.every(e=>api.desktopStatus(e.package.manifest.id)?.state==='active'));
  emit('luckyray:desktop:knowledge-saved',{documentRef:ref});
  await wait(()=>calls.length===2);
  assert.deepEqual(calls,[['note',['test.guard-a']],['material','synthetic-library',['test.guard-a']]]);
  assert.deepEqual(seen.a.map(x=>x[0]),['note']);
  assert.deepEqual(seen.b.map(x=>x[0]),['note','note','material']);
  assert.ok(seen.b.every(([,payload])=>!('__luckyrayEventOrigins' in payload)));
  emit('luckyray:desktop:knowledge-saved',{documentRef:ref,__luckyrayEventOrigins:['test.guard-a','test.guard-b']});
  assert.equal(seen.a.length,1);assert.equal(seen.b.length,3);
  stop();assert.ok([...listeners.values()].every(set=>set.size===0));
  assert.throws(()=>capturedScope.knowledge.append(ref,'late'),/retired/);
  assert.throws(()=>bound.importAssets({paths:['synthetic']}),/retired/);
 }finally{stop();delete globalThis.__fixtureServices;delete globalThis.__fixtureMaterialAdapter;delete globalThis.__fixtureListen;}
});
test('an independent write receives its own event while an earlier callback is pending',async()=>{
 const api=await ready,listeners=new Map(),seen=[];let host,release;
 const entry={enabled:true,digest:'independent',epoch:27,grants:['desktop.fullTrust'],package:{manifest:{schemaVersion:2,apiVersion:2,type:'desktop',id:'test.independent',name:'Independent',version:'1.0.0',minHostVersion:'1.9.8',requiredModules:[],optionalModules:[]},resource:{code:'synthetic',dataVersion:1,contributions:[],assets:{}}}};
 const state={revision:27,hostVersion:'1.9.8',packages:[entry]},pending=new Promise(resolve=>{release=resolve;});
 globalThis.__hostInvoke=async(command,args)=>{const request=JSON.parse(args.request);if(command==='manage_extension_packages')return structuredClone(state);if(request.op==='open')return 'independent-lease';return null;};
 globalThis.__fixtureListen=async(name,handler)=>{listeners.set(name,handler);return()=>listeners.delete(name);};
 const emit=payload=>listeners.get('luckyray:desktop:knowledge-saved')?.({payload});
 globalThis.__fixtureServices={appendKnowledgeDocument:async(_ref,_text,_revision,origins)=>{emit({id:'independent',__luckyrayEventOrigins:origins});return {};}};
 const stop=await api.startDesktopExtensionHost({importModule:async()=>({activate:async h=>{host=h;await h.events.on('knowledge.saved',async payload=>{seen.push(payload.id);if(payload.id==='first')await pending;});}})});
 try{
  await wait(()=>api.desktopStatus(entry.package.manifest.id)?.state==='active');
  emit({id:'first'});
  await host.knowledge.append({vaultId:'synthetic',relativePath:'note.md'},'independent');
  assert.deepEqual(seen,['first','independent']);
  release();
 }finally{release();stop();delete globalThis.__fixtureServices;delete globalThis.__fixtureListen;}
});
test('two extensions carry distinct event scopes through detached host writes',async()=>{
 const api=await ready,listeners=new Map(),calls=[],seen={a:0,b:0},errors=[];
 const entry=id=>({enabled:true,digest:id,epoch:28,grants:['desktop.fullTrust'],package:{manifest:{schemaVersion:2,apiVersion:2,type:'desktop',id,name:id,version:'1.0.0',minHostVersion:'1.9.8',requiredModules:[],optionalModules:[]},resource:{code:id,dataVersion:1,contributions:[],assets:{}}}});
 const state={revision:28,hostVersion:'1.9.8',packages:[entry('test.detached-a'),entry('test.detached-b')]},ref={vaultId:'synthetic',relativePath:'note.md'};
 globalThis.__hostInvoke=async(command,args)=>{const request=JSON.parse(args.request);if(command==='manage_extension_packages')return structuredClone(state);if(request.op==='open')return 'lease-'+request.id;return null;};
 globalThis.__fixtureListen=async(name,handler)=>{const set=listeners.get(name)??new Set();set.add(handler);listeners.set(name,set);return()=>set.delete(handler);};
 const emit=origins=>{const payload={documentRef:ref,...(origins?{__luckyrayEventOrigins:origins}:{})};for(const listener of [...(listeners.get('luckyray:desktop:knowledge-saved')??[])])listener({payload});};
 globalThis.__fixtureServices={appendKnowledgeDocument:async(_ref,text,_rev,origins)=>{calls.push([text,origins]);emit(origins);return {};}};
 const stop=await api.startDesktopExtensionHost({importModule:async code=>({activate:async host=>{
  const who=code.endsWith('-a')?'a':'b';
  await host.events.on('knowledge.saved',(payload,scope)=>{
   assert.ok(!('__luckyrayEventOrigins' in payload));seen[who]++;
   if(seen.a+seen.b<=4)setTimeout(()=>{try{void scope.knowledge.append(ref,who).catch(error=>errors.push(String(error)));}catch(error){errors.push(String(error));}},1);
  });
 }})});
 try{
  await wait(()=>state.packages.every(e=>api.desktopStatus(e.package.manifest.id)?.state==='active'));
  emit();await wait(()=>calls.length===4);await new Promise(resolve=>setTimeout(resolve,20));
  assert.deepEqual(seen,{a:2,b:2});assert.equal(calls.length,4);assert.deepEqual(errors,[]);
  assert.equal(calls.filter(([,origins])=>origins.length===1).length,2);
  assert.equal(calls.filter(([,origins])=>origins.length===2).length,2);
 }finally{stop();delete globalThis.__fixtureServices;delete globalThis.__fixtureListen;}
});
test('SDK-generated synthetic desktop example registers, opens and cleans up its contributions',async()=>{
 const api=await ready;
 const folder=path.resolve(process.cwd(),'../docs/review-evidence/secondary-community-api2-20261103/synthetic-extension');
 const config=JSON.parse(fs.readFileSync(path.join(folder,'plugin.json'),'utf8'));
 const code=fs.readFileSync(path.join(folder,'main.js'),'utf8');
 const entry={enabled:true,digest:'synthetic-example',epoch:30,grants:['desktop.fullTrust'],package:{manifest:{schemaVersion:2,apiVersion:2,type:'desktop',entry:'main.js',id:config.id,name:config.name,version:config.version,minHostVersion:config.minHostVersion,requiredModules:config.requiredModules,optionalModules:[]},resource:{code,css:'',dataVersion:1,contributions:config.contributions,assets:{}}}};
 const state={revision:30,hostVersion:'1.9.8',packages:[entry]};
 globalThis.__hostInvoke=async(command,args)=>{const request=JSON.parse(args.request);if(command==='manage_extension_packages')return structuredClone(state);if(request.op==='open')return 'synthetic-example-lease';return null;};
 const example=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
 const stop=await api.startDesktopExtensionHost({importModule:async()=>example});
 await wait(()=>['active','failed'].includes(api.desktopStatus(config.id)?.state));
 assert.equal(api.desktopStatus(config.id)?.state,'active',api.desktopStatus(config.id)?.message);
 assert.equal(api.desktopViews.size,4);assert.equal(api.desktopMenus.size,2);
 const container=document.createElement('div');const cleanup=await api.desktopViews.get(config.id+'/board').mount(container);
 assert.match(container.textContent,/只使用合成资料/);
 [...container.querySelectorAll('button')].find(button=>button.textContent==='打开right').click();
 await wait(()=>api.panels.some(panel=>panel.key===config.id+'/right'));
 let releaseImport,started=false;const writes=[];
 globalThis.__fixtureLibraries={libraryId:'a',registry:{libraries:[{id:'a',name:'API2合成验收-A'},{id:'b',name:'API2合成验收-B'}]}};
 globalThis.__fixtureMaterialAdapter=id=>({importAssets:()=>{started=true;return new Promise(resolve=>{releaseImport=resolve;});},updateAsset:async(asset,patch)=>{writes.push({id,asset,patch});},getAssetsByIds:async()=>[{description:'Synthetic API 2 intake'}]});
 container.querySelector('input').value='API2合成验收-A';
 [...container.querySelectorAll('button')].find(button=>button.textContent==='导入并验证合成文本素材').click();
 await wait(()=>started);globalThis.__fixtureLibraries.libraryId='b';releaseImport({assets:[{id:'synthetic-asset'}]});
 await wait(()=>container.textContent.includes('合成素材导入、修改和读回通过'));
 assert.equal(writes.length,1);assert.equal(writes[0].id,'a');
 delete globalThis.__fixtureLibraries;delete globalThis.__fixtureMaterialAdapter;
 cleanup();stop();
 assert.equal(api.desktopViews.size,0);assert.equal(api.desktopMenus.size,0);assert.equal(api.panels.length,0);
});
test('followup fixture responds once to a user save, writes once, and stops after retirement',async()=>{
 const api=await ready,listeners=new Map(),folder=path.resolve(process.cwd(),'../docs/review-evidence/secondary-community-api2-followup-20261103/fixture');
 const config=JSON.parse(fs.readFileSync(path.join(folder,'plugin.json'),'utf8'));
 const code=fs.readFileSync(path.join(folder,'main.js'),'utf8');
 const entry={enabled:true,digest:'feedback-example',epoch:35,grants:['desktop.fullTrust'],package:{manifest:{schemaVersion:2,apiVersion:2,type:'desktop',entry:'main.js',id:config.id,name:config.name,version:config.version,minHostVersion:config.minHostVersion,requiredModules:config.requiredModules,optionalModules:[]},resource:{code,css:'',dataVersion:1,contributions:config.contributions,assets:{}}}};
 const state={revision:35,hostVersion:'1.9.8',packages:[entry]},ref={vaultId:'lr-vault-3a39951a',relativePath:'synthetic.md'};
 let writes=0;
 globalThis.__hostInvoke=async(command,args)=>{const request=JSON.parse(args.request);if(command==='manage_extension_packages')return structuredClone(state);if(request.op==='open')return 'feedback-lease';return null;};
 globalThis.__fixtureListen=async(name,handler)=>{const set=listeners.get(name)??new Set();set.add(handler);listeners.set(name,set);return()=>set.delete(handler);};
 const emit=(name,payload)=>{for(const listener of [...(listeners.get(name)??[])])listener({payload});};
 globalThis.__fixtureServices={
  readKnowledgeIndexSnapshot:async()=>({vaultId:ref.vaultId}),
  createKnowledgeDocument:async(_input,origins)=>{emit('luckyray:desktop:knowledge-saved',{documentRef:ref,__luckyrayEventOrigins:origins});return {documentRef:ref,revision:'one'};},
  readKnowledgeDocument:async()=>({documentRef:ref,revision:'two'}),
  appendKnowledgeDocument:async(_ref,_text,_revision,origins)=>{writes++;emit('luckyray:desktop:knowledge-saved',{documentRef:ref,__luckyrayEventOrigins:origins});return {document:{documentRef:ref,revision:'three'}};},
 };
 const example=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
 const stop=await api.startDesktopExtensionHost({importModule:async()=>example});
 try{
  await wait(()=>api.desktopStatus(config.id)?.state==='active' && (listeners.get('luckyray:desktop:knowledge-saved')?.size??0)>0);
  const container=document.createElement('div');const unmount=api.desktopViews.get(config.id+'/board').mount(container);
  const click=label=>[...container.querySelectorAll('button')].find(button=>button.textContent===label).click();
  click('创建合成笔记');await wait(()=>container.textContent.includes('已创建合成笔记'));
  click('启用回写验收');await wait(()=>container.textContent.includes('等待合成保存或导入'));
  emit('luckyray:desktop:knowledge-saved',{documentRef:ref});
  await wait(()=>container.textContent.includes('合成回写完成'));
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(writes,1);assert.match(container.textContent,/保存 1 · 导入 0 · 回写 1/);
  click('独立写入验收');await wait(()=>writes===3);await new Promise(resolve=>setTimeout(resolve,20));
  assert.match(container.textContent,/保存 2 · 导入 0 · 回写 2/);
  stop();emit('luckyray:desktop:knowledge-saved',{documentRef:ref});await new Promise(resolve=>setTimeout(resolve,10));assert.equal(writes,3);
  unmount();
 }finally{stop();delete globalThis.__fixtureServices;delete globalThis.__fixtureListen;}
});
test('scoped example detects an older API 2 host before attempting an unguarded write',async()=>{
 const folder=path.resolve(process.cwd(),'../docs/review-evidence/secondary-community-api2-followup-20261103/fixture');
 const code=fs.readFileSync(path.join(folder,'main.js'),'utf8'),example=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
 const ref={vaultId:'lr-vault-3a39951a',relativePath:'synthetic.md'},listeners=new Map();let view,writes=0;
 const oldHost={workspace:{registerView:definition=>{view=definition;}},commands:{register:()=>{}},events:{on:async(name,handler)=>{listeners.set(name,handler);}},
  knowledge:{index:async()=>({vaultId:ref.vaultId}),create:async()=>({documentRef:ref}),read:async()=>({revision:'synthetic'}),append:async()=>{writes++;}},
  materials:{libraries:()=>({registry:{libraries:[]}})}};
 example.activate(oldHost);
 const container=document.createElement('div');view.mount(container);
 const click=label=>[...container.querySelectorAll('button')].find(button=>button.textContent===label).click();
 click('创建合成笔记');await wait(()=>container.textContent.includes('已创建合成笔记'));
 click('启用回写验收');await wait(()=>container.textContent.includes('等待合成保存或导入'));
 await listeners.get('knowledge.saved')({documentRef:ref});
 assert.match(container.textContent,/需要支持事件上下文的新版宿主/);assert.equal(writes,0);
});
test.after(()=>{dom.window.close();esbuild.stop();});
