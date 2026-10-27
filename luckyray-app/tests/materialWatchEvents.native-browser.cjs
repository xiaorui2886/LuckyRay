// Production MaterialsPage/watch service + real isolated Windows Catalog/notify.
// Only transport is adapted (stdio/HTTP/SSE); no user profile or UI is touched.
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const http=require('node:http');
const {spawn}=require('node:child_process');const readline=require('node:readline');
const root=path.resolve(__dirname,'..');
const {chromium}=require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE);
const esbuild=require(require.resolve('esbuild',{paths:[fs.realpathSync(path.join(root,'node_modules/vite'))]}));
const entry=String.raw`
import React from 'react';import {createRoot} from 'react-dom/client';
import MaterialsPage from './src/features/materials/MaterialsPage';
import {I18nProvider} from './src/core/i18n';
import {ApplicationModalIsolationProvider,createApplicationModalIsolationStore} from './src/app/applicationModalIsolation';
import {materialLibrarySession,writeMaterialLibraryPreference} from './src/core/services/materialLibraryContext';
import {materialStore} from './src/core/services/materialStore';
import {startMaterialWatchService,setLibraryRootWatch,stopMaterialWatchService} from './src/features/materials/materialWatch';
import './src/core/theme/themeTokens.css';import './src/features/materials/materials.css';import './src/app/appShell.css';
const callbacks=new Map();let next=0;const indexes=new Map();
window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
 transformCallback:fn=>{callbacks.set(++next,fn);return next;},unregisterCallback:id=>callbacks.delete(id),convertFileSrc:()=>'',
 invoke:async(command,args)=>{
  if(command==='material_library_command'){
   // Cross-library transfer UI is unrelated to root import; the catalog unit
   // fixture has no transfer-job migration. Do not mock import/list/save routes.
   if(args.request.action.op==='transferList')return [];
   const response=await fetch('/native',{method:'POST',body:JSON.stringify(args)});const body=await response.json();
   if(body.error)throw Error(body.error);return body.result;
  }
  if(command.startsWith('plugin:event|'))return 1;
  if(command==='get_favorite_item_counts')return {material:0,note:0};
  if(command==='get_local_transport_client_config')return {baseUrl:'http://127.0.0.1:1',credential:''};
  return [];
 }};
const stream=new EventSource('/events');stream.onmessage=e=>{
 const message=JSON.parse(e.data);if(!message.channel)return;
 const id=Number(message.channel.split(':')[1]);const index=indexes.get(id)||0;indexes.set(id,index+1);
 callbacks.get(id)?.({index,message:message.event});
};
const bridge={importFolder:async()=>{throw Error('legacy import forbidden in root test');},
 listFavoriteItems:async()=>[],getFavoriteItemCounts:async()=>({material:0,note:0}),getCollectionServerBaseUrl:async()=>null};
window.__LUCKYRAY__=bridge;
localStorage.setItem('luckyray-settings-v1',JSON.stringify({'materials.importModePromptSeen':true}));
window.transitions=[];window.appearances={};window.store=materialStore;
materialStore.subscribe(()=>window.transitions.push({at:Date.now(),status:materialStore.getSnapshot().status,count:materialStore.getSnapshot().assets.length}));
new MutationObserver(()=>{for(const node of document.querySelectorAll('[data-asset-id]')){
 const id=node.getAttribute('data-asset-id');if(!window.appearances[id])window.appearances[id]=Date.now();
}}).observe(document.documentElement,{childList:true,subtree:true});
await materialLibrarySession.initialize();
const id=materialLibrarySession.getSnapshot().libraryId;
writeMaterialLibraryPreference('luckyray-materials-view-v1','list',id);
const directory=await materialLibrarySession.request({op:'libraryWatchRoot'},id);
window.toggle=enabled=>setLibraryRootWatch(id,directory,enabled);window.stop=stopMaterialWatchService;
createRoot(document.getElementById('root')).render(<ApplicationModalIsolationProvider store={createApplicationModalIsolationStore()}><I18nProvider locale="zh-CN"><MaterialsPage/></I18nProvider></ApplicationModalIsolationProvider>);
startMaterialWatchService(bridge);window.fixtureReady=true;
`;

async function run(){
 const exe=process.env.LUCKYRAY_NATIVE_TEST_EXE;assert.ok(exe&&fs.existsSync(exe),'set LUCKYRAY_NATIVE_TEST_EXE to freshly built test executable');
 const events=[];const stages=[];const requests=[];const pending=new Map();let sequence=0;let readyResolve;
 const ready=new Promise(resolve=>readyResolve=resolve);const streams=new Set();
 const native=spawn(exe,['library_watch_events_browser_fixture','--ignored','--nocapture','--test-threads=1'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
 let nativeErrors='';native.stderr.on('data',chunk=>nativeErrors+=chunk);
 const nativeExit=new Promise(resolve=>native.on('exit',code=>resolve(code)));
 readline.createInterface({input:native.stdout}).on('line',line=>{
  const prefix=line.indexOf('WATCH_FIXTURE ');if(prefix<0)return;
  const message=JSON.parse(line.slice(prefix+14));
  if(message.ready)readyResolve(message);
  if(message.channel){events.push(message);for(const response of streams)response.write('data: '+JSON.stringify(message)+'\n\n');}
  if(message.stage)stages.push(message);
  if(message.sequence){const request=pending.get(message.sequence);if(request){pending.delete(message.sequence);request.resolve(message);}}
 });
 const call=fields=>new Promise((resolve,reject)=>{
  const id=++sequence;const timeout=setTimeout(()=>{pending.delete(id);reject(Error('native fixture timeout '+id));},30000);
  pending.set(id,{resolve:message=>{clearTimeout(timeout);resolve(message);}});
  native.stdin.write(JSON.stringify({...fields,sequence:id})+'\n');
 });
 const bundle=await esbuild.build({stdin:{contents:entry,resolveDir:root,loader:'tsx'},bundle:true,write:false,outdir:'out',format:'esm',jsx:'automatic',
  loader:{'.svg':'dataurl','.png':'dataurl','.webp':'dataurl'},plugins:[{name:'raw',setup(build){build.onResolve({filter:/\.svg\?raw$/},args=>({path:path.resolve(args.resolveDir,args.path.slice(0,-4)),namespace:'raw'}));build.onLoad({filter:/.*/,namespace:'raw'},args=>({contents:fs.readFileSync(args.path,'utf8'),loader:'text'}));}}]});
 const js=bundle.outputFiles.find(f=>f.path.endsWith('.js')).text;const css=bundle.outputFiles.find(f=>f.path.endsWith('.css'))?.text||'';
 const server=http.createServer(async(req,res)=>{
  if(req.url==='/events'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});res.write(': ready\n\n');streams.add(res);req.on('close',()=>streams.delete(res));return;}
  if(req.url==='/native'){let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body);const start=Date.now();
   try{const result=await call(input);requests.push({action:input.request.action.op,libraryId:input.request.libraryId,pathCount:input.request.action.paths?.length??null,start,end:Date.now(),result:result.result,error:result.error});res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));}catch(e){res.end(JSON.stringify({error:String(e)}));}return;}
  if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end(js);return;}
  res.setHeader('Content-Type','text/html');res.end('<!doctype html><html data-theme="dark"><style>'+css+'html,body,#root{height:100%;width:100%;margin:0}#root{display:block;min-width:0}</style><div id="root" class="react-nav-shell"></div><script type="module" src="/app.js"></script>');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{
  const info=await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('fixture not ready: '+nativeErrors)),20000))]);
  browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1100,height:650}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.fixtureReady&&window.store.getSnapshot().assets.length===50);
  await page.locator('[data-asset-id]').first().waitFor();
  await page.evaluate(()=>window.toggle(true));
  await page.waitForFunction(()=>document.body.textContent.length>0);
  const waitUntil=async(predicate,message)=>{const deadline=Date.now()+15000;while(!predicate()){if(Date.now()>deadline)throw Error(message);await new Promise(resolve=>setTimeout(resolve,50));}};
  await waitUntil(()=>requests.some(r=>r.action==='importLibraryRoot'),'initial root import');
  await new Promise(resolve=>setTimeout(resolve,1800));
  console.log('layout',await page.evaluate(()=>[...document.querySelectorAll('.materials-layout,.materials-main,.masonry-container')].map(e=>({class:e.className,width:e.clientWidth,height:e.clientHeight,scroll:e.scrollHeight,overflow:getComputedStyle(e).overflowY}))));
  if(process.env.LUCKYRAY_WATCH_EVIDENCE)await page.screenshot({path:process.env.LUCKYRAY_WATCH_EVIDENCE+'.layout.png'});
  const scroll=await page.evaluate(()=>{const candidates=[...document.querySelectorAll('*')].filter(e=>e.clientHeight>100&&e.scrollHeight>e.clientHeight+300&&['auto','scroll'].includes(getComputedStyle(e).overflowY));const el=candidates.sort((a,b)=>b.scrollHeight-a.scrollHeight)[0];if(!el)throw Error('no scrollable materials pane');window.scrollPane=el;el.scrollTop=300;return el.scrollTop;});
  assert.ok(scroll>0);await page.evaluate(()=>{window.transitions=[];window.anchor=[...document.querySelectorAll('[data-asset-id]')].find(e=>e.getBoundingClientRect().top>=window.scrollPane.getBoundingClientRect().top);window.anchorTop=window.anchor.getBoundingClientRect().top;});
  const idleImports=requests.filter(r=>r.action==='importLibraryRoot').length;
  const {execFileSync}=require('node:child_process');
  const counters=()=>JSON.parse(execFileSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-Command',`Get-CimInstance Win32_Process -Filter 'ProcessId = ${native.pid}' | Select-Object ReadTransferCount,WriteTransferCount,KernelModeTime,UserModeTime | ConvertTo-Json -Compress`],{encoding:'utf8',windowsHide:true}));
  const idleStart=counters();await new Promise(resolve=>setTimeout(resolve,30000));const idleEnd=counters();
  assert.equal(requests.filter(r=>r.action==='importLibraryRoot').length,idleImports,'idle must not poll/import each second');
  const idle={seconds:30,readBytes:Number(idleEnd.ReadTransferCount)-Number(idleStart.ReadTransferCount),writeBytes:Number(idleEnd.WriteTransferCount)-Number(idleStart.WriteTransferCount),cpuMs:(Number(idleEnd.KernelModeTime)-Number(idleStart.KernelModeTime)+Number(idleEnd.UserModeTime)-Number(idleStart.UserModeTime))/10000};
  assert.ok(idle.readBytes<1024*1024&&idle.writeBytes<1024*1024,JSON.stringify(idle));
  const timings=[];
  for(const [scenario,count,name] of [['single',51,'single.txt'],['batch',71,'batch-19.txt'],['large',72,'large.bin'],['same-name',73,'single.txt']]){
   const priorIds=await page.evaluate(()=>window.store.getSnapshot().assets.map(a=>a.id));
   const start=Date.now();const copy=call({scenario});
   if(scenario==='large'){
    await waitUntil(()=>stages.some(s=>s.scenario==='large'&&s.stage==='copy-open-paused'),'large copy open');
    await new Promise(resolve=>setTimeout(resolve,1800));
    assert.equal(await page.evaluate(()=>window.store.getSnapshot().assets.some(a=>a.name==='large.bin')),false,'copy pause must not import partial file');
   }
   const copied=await copy;assert.ok(!copied.error,copied.error);
   await page.waitForFunction(count=>window.store.getSnapshot().assets.length===count,count);
   const display=await page.evaluate(({name,priorIds})=>{const asset=window.store.getSnapshot().assets.find(a=>a.name===name&&!priorIds.includes(a.id));if(!asset)throw Error('new asset not found: '+name);const node=document.querySelector('[data-asset-id="'+asset.id+'"]');return {at:window.appearances[asset.id],exists:!!node,scroll:window.scrollPane.scrollTop,anchorConnected:window.anchor.isConnected,anchorDelta:window.anchor.getBoundingClientRect().top-window.anchorTop,statuses:window.transitions.map(t=>t.status)};},{name,priorIds});
   // Virtualized rows may not be mounted while scrolled away. Scroll deliberately
   // only after measuring unchanged scroll; page-level metadata visibility is separate.
   assert.ok(Math.abs(display.anchorDelta)<=1,JSON.stringify(display));assert.ok(display.anchorConnected);assert.ok(display.exists&&display.at,'new asset row must actually be rendered');assert.ok(display.statuses.every(s=>s==='ready'),display.statuses.join(','));
   const imports=requests.filter(r=>r.action==='importLibraryRoot'&&r.end>=copied.result.finishedAt&&r.result?.importedCount>0);
   const detected=events.find(e=>e.at>=start&&e.event.paths?.some(p=>p.endsWith(name)));
   const receipt=imports.at(-1)?.end;assert.ok(receipt&&detected,'real notification and commit receipt required');
   timings.push({scenario,copyComplete:copied.result.finishedAt,firstDetected:detected.at,commitReceipt:receipt,listObserved:Date.now(),domFirstSeen:display.at,
    copyCompleteToCommitMs:receipt-copied.result.finishedAt,commitToDomMs:display.at-receipt,copyCompleteToDomMs:display.at-copied.result.finishedAt,
    viewportAnchorDelta:display.anchorDelta,scrollPreserved:true});
  }
  await call({scenario:'duplicate'});await new Promise(resolve=>setTimeout(resolve,3000));
  assert.equal(await page.evaluate(()=>window.store.getSnapshot().assets.length),73);
  assert.ok(requests.some(r=>r.action==='importLibraryRoot'&&r.result?.skippedDuplicateCount>0));
  await page.evaluate(()=>window.toggle(false));await waitUntil(()=>requests.some(r=>r.action==='unwatchLibraryRoot'),'watcher disposal');
  const before=requests.filter(r=>r.action==='importLibraryRoot').length;await call({scenario:'off'});await new Promise(resolve=>setTimeout(resolve,3500));
  assert.equal(requests.filter(r=>r.action==='importLibraryRoot').length,before);assert.equal(await page.evaluate(()=>window.store.getSnapshot().assets.length),73);
  await page.evaluate(()=>window.stop());assert.deepEqual(errors,[]);
  const imports=requests.filter(r=>r.action==='importLibraryRoot');
  assert.ok(imports.every(r=>!r.error&&r.result.failedCount===0),'imports must have no hidden failure');
  const output={kind:'production-component + real isolated native notify/Catalog; adapted IPC, NOT Main EXE UAT',timings,idle,assetCountAfterDuplicate:73,expectedFinalAssetCount:73,toggleOffNoImports:true,errors,nativeErrors,
   stages,notifications:events.map(e=>({at:e.at,detectedAt:e.event.detectedAt,rescan:!!e.event.rescan,files:e.event.paths.map(p=>path.basename(p))})),
   imports:imports.map(r=>({libraryId:r.libraryId,start:r.start,end:r.end,pathCount:r.pathCount,imported:r.result.importedCount,duplicates:r.result.skippedDuplicateCount,failed:r.result.failedCount,deferred:r.result.deferredPaths.length,elapsedMs:r.result.elapsedMs}))};
  console.log(JSON.stringify(output,null,2));
  if(process.env.LUCKYRAY_WATCH_EVIDENCE){fs.writeFileSync(process.env.LUCKYRAY_WATCH_EVIDENCE,JSON.stringify(output,null,2));await page.screenshot({path:process.env.LUCKYRAY_WATCH_EVIDENCE+'.png'});}
 }finally{await browser?.close();for(const res of streams)res.end();await new Promise(resolve=>server.close(resolve));native.stdin.write('{"command":"stop"}\n');native.stdin.end();await nativeExit;}
}
run().catch(error=>{console.error(error);process.exitCode=1;});
