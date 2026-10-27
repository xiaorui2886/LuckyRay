// Real production components + theme/shell/material CSS. IPC/data are synthetic;
// this does NOT prove native WebView hiding, real pairing or phone authorization.
const assert = require('node:assert/strict'), fs = require('node:fs'), http = require('node:http'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const esbuild = require(require.resolve('esbuild', { paths: [fs.realpathSync(path.join(root, 'node_modules', 'vite'))] }));
const { chromium } = require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE || 'playwright');
const saveOnly = process.env.LUCKYRAY_PHONE_SAVE_ONLY === '1';
const renewalOnly = process.env.LUCKYRAY_PHONE_RENEWAL_ONLY === '1';
const output = path.join(root, 'output', 'playwright', renewalOnly ? 'issue191-qr-switch-interaction' : saveOnly ? 'issue191-phone-save-feedback' : 'issue191-phone-refinement');
const entry = String.raw`
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {I18nProvider} from './src/core/i18n/index';
import {ApplicationModalIsolationProvider, createApplicationModalIsolationStore, useApplicationModalIsolationSnapshot} from './src/app/applicationModalIsolation';
import {AppSidebar, AppTitlebar} from './src/app/AppSidebar';
import {ExperienceOverlayProvider, ExperienceNotices, useExperienceNotices} from './src/components/ExperienceOverlay';
import PhoneConnectionDialog from './src/features/settings/PhoneConnectionDialog';
import CompanionGatewayPanel from './src/features/settings/CompanionGatewayPanel';
import {CompanionPresentationTestProvider} from './src/features/settings/CompanionPresentation';
import {createCompanionPresentationStore} from './src/core/services/companionPresentationStore';
import {createCompanionGatewayClient} from './src/core/services/companionGateway';
import MaterialsPage from './src/features/materials/MaterialsPage';
import {MaterialExportUI} from './src/features/materials/MaterialExportUI';
import './src/core/theme/themeTokens.css';
import './src/app/appShell.css';
import './src/components/experienceLayer.css';
import './src/features/materials/materials.css';
import './src/features/settings/settings.css';
const params = new URLSearchParams(location.search);
const locale = params.get('locale') || 'zh-CN';
const a={id:'a',name:'当前分类 A',parentId:null,open:true,children:[]};
const b={id:'b',name:'右键目标 B — '+ '很长分类名'.repeat(5),parentId:null,open:true,children:[{id:'child',name:'子分类',parentId:'b',open:true,children:[]}]};
const data={calls:[],folders:[a,b], devices:[{deviceId:'phone-a',label:'Studio phone — '+ '很长设备名称'.repeat(6),connected:true,revokedAt:null},{deviceId:'phone-b',label:'Offline test phone',connected:false,revokedAt:null}],
  services:{'phone-a':{permissionRevision:1,currentVault:{vaultId:'vault-a',label:'设计资料库 A'},grants:[]},'phone-b':{permissionRevision:1,currentVault:{vaultId:'vault-b',label:'另一知识库 B'},grants:[]}},
  lsh:{'phone-a':{granted:false,runtimeAvailable:false},'phone-b':{granted:true,runtimeAvailable:true}}, fail:false, failGrant:false, holdGrant:null, grantResolvers:[], pairCounter:0,
  gatewayState:'running', failPair:false, holdPair:false, pairResolvers:[], holdWrite:false, writeResolvers:[]};
const invoke=async(command,args)=>{
 data.calls.push({command,args});
 if(command==='companion_gateway_status'){if(data.fail)throw {code:'fixture-offline'};return {state:data.gatewayState,generation:1,bindAddress:'192.168.10.5',port:48180,desktopInstanceId:'fixture',certificateFingerprint:'a'.repeat(64)};}
 if(command==='companion_gateway_list_devices')return data.devices;
 if(command==='companion_gateway_list_interfaces')return [{interfaceId:'fixture',name:'Synthetic LAN',address:'192.168.10.5',prefixLength:24}];
 if(command==='companion_gateway_list_audit')return [];
 if(command==='companion_gateway_service_grants'){if(data.holdGrant===args.deviceId)return new Promise(r=>data.grantResolvers.push(r));return structuredClone(data.services[args.deviceId]);}
 if(command==='companion_gateway_lsh_remote_state')return structuredClone(data.lsh[args.deviceId]);
 if(command==='companion_gateway_service_set_grant'){if(data.holdWrite)await new Promise(r=>data.writeResolvers.push(r));if(data.failGrant)throw {code:'fixture-denied'};const s=data.services[args.deviceId]; s.grants=s.grants.filter(g=>g.grantClass!==args.grantClass||g.scopeKind!==args.scopeKind||g.scopeId!==args.scopeId);if(args.enabled)s.grants.push({grantClass:args.grantClass,scopeKind:args.scopeKind,scopeId:args.scopeId});s.permissionRevision++;return;}
 if(command==='companion_gateway_lsh_remote_set_grant'){data.lsh[args.deviceId].granted=args.granted;return;}
 if(command==='companion_gateway_issue_pairing'){
  if(data.failPair)throw {code:'pairing-rate-limited'};
  const value={pairingId:'fixture-'+(++data.pairCounter),v:1,name:'Synthetic',instance:'fixture',ip:'192.168.10.5',port:48180,secret:'synthetic-never-logged',fp:'a'.repeat(64),expiresAt:new Date(Date.now()+60000).toISOString(),qrSize:21,qrPath:'M0 0h7v7H0zM14 0h7v7h-7zM0 14h7v7H0z'};
  return data.holdPair?new Promise(r=>data.pairResolvers.push(()=>r(value))):value;
 }
 if(command==='companion_gateway_cancel_pairing')return true;
 if(command==='companion_gateway_revoke_device'){data.devices=data.devices.map(d=>d.deviceId===args.deviceId?{...d,revokedAt:'now',connected:false}:d);return {};}
 if(command==='material_csv_export_plan'){if(!data.folders.some(f=>f.id===args.request.folderId))throw new Error('folder-missing');return {planId:'csv-'+args.request.folderId,total:args.request.folderId==='b'?2:0,scopeLabel:args.request.folderId,includesDescendants:true};}
 if(command==='material_catalog_list_note_attachments'||command==='list_favorite_items')return [];
 if(command==='favorite_item_counts')return {material:0,note:0};
 if(command==='get_local_transport_client_config')return {baseUrl:'http://127.0.0.1:1',credential:''};
 return [];
};
window.__TAURI_INTERNALS__={invoke};
const asset={id:'fixture-asset',name:'image.png',kind:'image',mimeType:'image/png',sizeBytes:10,thumbnailUrl:'',previewUrl:'',folderId:'a',storageMode:'linked',importedAt:'',updatedAt:''};
const bridge={listAssets:async()=>[asset],listAssetsFiltered:async()=>[asset],listFolders:async()=>data.folders,getAssetsByIds:async()=>[asset],
 getMaterialChangeState:async()=>null,listFavoriteItems:async()=>[],getFavoriteItemCounts:async()=>({material:0,note:0}),getCollectionServerBaseUrl:async()=>null};
Object.defineProperty(window,'__LUCKYRAY__',{get:()=>bridge,set:()=>{},configurable:true});
window.fetch=async()=>new Response(JSON.stringify({capabilities:[]}),{headers:{'Content-Type':'application/json'}});
localStorage.setItem('luckyray-settings-v1',JSON.stringify({'materials.importModePromptSeen':true}));
const store=createCompanionPresentationStore(createCompanionGatewayClient(invoke)), modalStore=createApplicationModalIsolationStore();
window.__ux={data,store};
function Fixture(){
 const [open,setOpen]=useState(false),[advanced,setAdvanced]=useState(false),[route,setRoute]=useState('materials'),[notices,setNotices]=useState([]);
 const modal=useApplicationModalIsolationSnapshot(modalStore), toast=useExperienceNotices();
 Object.assign(window.__ux,{notify:toast.notify,setNotices,setRoute,setAdvanced,modal:()=>modalStore.getSnapshot()});
 return <div className="react-nav-shell" data-route={route}><ExperienceOverlayProvider>
  <AppSidebar route={route} onNavigate={setRoute} onOpenPhone={()=>setOpen(true)} applicationModalIsolated={modal}/>
  <div className="main" inert={open||undefined} aria-hidden={open||undefined}>
   <AppTitlebar route={route} hashPath={route} onOpenSearch={()=>{}}/>
   <div className="content-wrap"><div className="content materials-mode" style={{overflow:'hidden',transform:'translateZ(0)'}}>
    <textarea aria-label="Retained draft" defaultValue="Synthetic unsent draft"/>
    {advanced?<CompanionGatewayPanel/>:<MaterialsPage/>}
    <ExperienceNotices notices={toast.notices} dismiss={toast.dismiss} maxVisible={Math.max(0,2-notices.length)}/>
    <MaterialExportUI notices={notices} onDismissNotice={id=>setNotices(n=>n.filter(x=>x.id!==id))}
      onOpenPanel={()=>{}} onOpenDestination={()=>{}} tasks={[]} csvTasks={[]} labels={{}} taskProblems={{}} actionErrors={{}}
      retryState={{}} retryChildren={{}} retryErrors={{}} csvRetrying={{}} plan={null} planning={false} panelOpen={false} submissionPhase="idle"/>
   </div></div>
  </div>
  <React.StrictMode>{open&&<PhoneConnectionDialog onClose={()=>setOpen(false)} onMore={()=>{setOpen(false);setAdvanced(true);setRoute('settings');}}/>}</React.StrictMode>
 </ExperienceOverlayProvider></div>;
}
createRoot(document.getElementById('root')).render(<I18nProvider locale={locale}><ApplicationModalIsolationProvider store={modalStore}>
 <CompanionPresentationTestProvider store={store}><Fixture/></CompanionPresentationTestProvider>
</ApplicationModalIsolationProvider></I18nProvider>);
void store.refresh();
setTimeout(()=>window.dispatchEvent(new CustomEvent('luckyray:bridge-ready')),100);
`;

async function run(){
 const built=await esbuild.build({stdin:{contents:entry,resolveDir:root,loader:'tsx'},bundle:true,write:false,outdir:'out',format:'iife',jsx:'automatic',
   loader:{'.svg':'file','.css':'css'},assetNames:'assets/[name]-[hash]',publicPath:'/',define:{'process.env.NODE_ENV':'"test"'},logLevel:'error'});
 const js=built.outputFiles.find(f=>f.path.endsWith('.js')).text, css=built.outputFiles.find(f=>f.path.endsWith('.css')).text;
 assert.ok(css.includes('.phone-connection-body')&&css.includes('.experience-overlay-root')&&css.includes('.react-nav-shell'));
 const server=http.createServer((req,res)=>{
  const asset=built.outputFiles.find(f=>f.path.replaceAll('\\','/').endsWith(req.url)&&req.url.startsWith('/assets/'));
  if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end(js);}
  else if(req.url==='/app.css'){res.setHeader('Content-Type','text/css');res.end(css);}
  else if(req.url==='/luckyray-logo.png'){res.setHeader('Content-Type','image/png');res.end(fs.readFileSync(path.join(root,'public','luckyray-logo.png')));}
  else if(asset){res.setHeader('Content-Type','image/svg+xml');res.end(asset.contents);}
  else {res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body style="margin:0"><div id="root"></div><script src="/app.js"></script></body></html>');}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r)); fs.mkdirSync(output,{recursive:true});
 let browser; const results=[];
 try{
  browser=await chromium.launch({channel:'msedge',headless:true});
  for(const spec of [{w:1536,h:960,scale:1,locale:'zh-CN',theme:'dark'},{w:1536,h:960,scale:1,locale:'en-US',theme:'light'},
    {w:1024,h:720,scale:1,locale:'zh-CN',theme:'light'},{w:1180,h:720,scale:1,locale:'zh-CN',theme:'dark'},
    {w:1180,h:720,scale:1.25,locale:'en-US',theme:'dark'},{w:1180,h:720,scale:1.5,locale:'zh-CN',theme:'light'}]){
   // Logical viewport contraction + DPR models Windows scaling; not just a larger raster.
   const context=await browser.newContext({viewport:{width:Math.floor(spec.w/spec.scale),height:Math.floor(spec.h/spec.scale)},deviceScaleFactor:spec.scale});
   const page=await context.newPage(), errors=[]; page.on('pageerror',e=>{errors.push(e.message);console.error('FIXTURE-PAGE-ERROR',e.message);});
   page.on('console',m=>{if(m.type()==='error')console.error('FIXTURE-CONSOLE',m.text());});
   await page.goto('http://127.0.0.1:'+server.address().port+'/?locale='+spec.locale);await page.waitForLoadState('networkidle');
   await page.waitForFunction(()=>window.__ux&&document.querySelector('[data-folder-id="b"]'),null,{timeout:5000}).catch(async e=>{
     console.error('FIXTURE-STARTUP',await page.locator('body').innerText(),errors);throw e;
   });
   await page.waitForFunction(()=>document.querySelector('.logo-mark img')?.naturalWidth>0&&getComputedStyle(document.querySelector('.sidebar-masked-icon')).maskImage!=='none');
   await page.evaluate(theme=>document.documentElement.dataset.theme=theme,spec.theme);
   const entryButton=page.locator('.phone-connection-entry');
   assert.equal(await entryButton.getAttribute('data-connected'),'true');
   assert.equal(await entryButton.locator('.nav-label').textContent(),spec.locale==='zh-CN'?'手机':'Phone');
   assert.equal(await entryButton.locator('.phone-entry-state').count(),0,'no numeric badge, including unknown status');
   assert.doesNotMatch(await entryButton.getAttribute('title'),/\d/,'navigation tooltip has no device count either');
   await page.getByRole('textbox',{name:'Retained draft'}).fill('Keep synthetic draft');
   await entryButton.click(); const dialog=page.locator('.phone-connection-dialog');await dialog.waitFor();
   await page.waitForFunction(()=>document.querySelectorAll('.phone-permission-switch').length===9);
   await dialog.locator('.phone-qr-frame').waitFor();
   assert.equal(await page.evaluate(()=>window.__ux.data.pairCounter),1,'opening prepares exactly one QR, including StrictMode replay');
   if(renewalOnly){
    const saves=await stableSaving(page,dialog);
    await stableRefresh(page,dialog);
    const name='phone-'+spec.w+'x'+spec.h+'-'+spec.scale+'-'+spec.locale+'-'+spec.theme;
    const hover=await switchInteraction(page,dialog);
    await page.screenshot({path:path.join(output,name+'-hover.png'),animations:'disabled'});
    const renewal=await expiryRenewal(page,dialog,output,name);
    await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
    if(spec.w===1536&&spec.theme==='dark')await pairingBoundaries(page,output);
    results.push({spec,saves,hover,renewal});
    assert.deepEqual(errors,[]);await context.close();continue;
   }
   if(saveOnly){
    results.push({spec,saves:await stableSaving(page,dialog)});
    assert.deepEqual(errors,[]);await context.close();continue;
   }
   await stableRefresh(page,dialog);
   const geometry=await dialog.evaluate(el=>{
     const r=el.getBoundingClientRect(), close=el.querySelector('.phone-close').getBoundingClientRect();
     return {viewport:[innerWidth,innerHeight],rect:r.toJSON(),close:close.toJSON(),inView:r.left>=23&&r.top>=23&&r.right<=innerWidth-23&&r.bottom<=innerHeight-23,
       noHorizontalScroll:el.scrollWidth<=el.clientWidth+1,bodyNoHorizontalScroll:el.querySelector('.phone-connection-body').scrollWidth<=el.querySelector('.phone-connection-body').clientWidth+1,
       background:getComputedStyle(el).backgroundColor,grid:getComputedStyle(el.querySelector('.phone-connection-body')).gridTemplateColumns};
   });
   assert.ok(geometry.inView&&geometry.noHorizontalScroll&&geometry.bodyNoHorizontalScroll,JSON.stringify(geometry));
   assert.notEqual(geometry.background,'rgba(0, 0, 0, 0)');
   if(Math.floor(spec.w/spec.scale)>760){
    const columns=geometry.grid.split(' ').map(parseFloat);assert.ok(columns[0]>columns[1]*1.45,'QR pane uses 60%, access uses 40%');
   }
   assert.equal(await dialog.locator('header, footer, h2, #phone-connection-title').count(),0,'no visible replacement header or thick footer');
   assert.equal(await dialog.evaluate(el=>getComputedStyle(el.querySelector('.phone-connection-right')).backgroundColor),'rgba(0, 0, 0, 0)','one shared surface, not a dark right slab');
   assert.equal(await dialog.evaluate(el=>getComputedStyle(el.querySelector('.phone-pairing-area')).borderTopWidth),'0px','pairing is not a card inside the dialog');
   const closeHit=await dialog.evaluate(el=>{const c=el.querySelector('.phone-close'),r=c.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return hit===c||c.contains(hit);});
   assert.equal(closeHit,true,'independent close remains reachable');
   assert.equal(await page.evaluate(()=>document.activeElement.classList.contains('phone-close')),true);
   assert.equal(await page.evaluate(()=>window.__ux.data.calls.some(c=>/set_grant|_start|_stop|revoke/.test(c.command))),false,'QR preparation never starts, pairs or grants access');
   const name='phone-'+spec.w+'x'+spec.h+'-'+spec.scale+'-'+spec.locale+'-'+spec.theme;
   await page.screenshot({path:path.join(output,name+'.png'),animations:'disabled'});results.push({name,geometry});
   await page.keyboard.press('Shift+Tab');assert.equal(await dialog.evaluate(el=>el.contains(document.activeElement)),true);
   await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
   await page.waitForFunction(()=>document.activeElement?.classList.contains('phone-connection-entry'));
   assert.equal(await page.getByRole('textbox',{name:'Retained draft'}).inputValue(),'Keep synthetic draft');
   // Empty devices do not render inactive switches or reserve a second pane.
   const savedDevices=await page.evaluate(()=>structuredClone(window.__ux.data.devices));
   await page.evaluate(()=>{window.__ux.data.devices=[];return window.__ux.store.refresh();});
   await entryButton.click();await dialog.waitFor();
   await dialog.locator('.phone-qr-frame').waitFor();
   assert.equal(await dialog.locator('.phone-connection-right,[role="switch"]').count(),0);
   const compact=await dialog.evaluate(el=>{const r=el.getBoundingClientRect();return {width:r.width,height:r.height,columns:getComputedStyle(el.querySelector('.phone-connection-body')).gridTemplateColumns};});
   assert.ok(compact.width<=420.1&&compact.height<=Math.floor(spec.h/spec.scale)-48,JSON.stringify(compact));
   assert.equal(await page.evaluate(()=>window.__ux.data.calls.some(c=>/set_grant|_start|_stop|revoke/.test(c.command))),false);
   await page.screenshot({path:path.join(output,name+'-empty.png'),animations:'disabled'});
   results.at(-1).empty=compact;
   // Automatic synthetic QR; scrolling must not move or cover the independent close.
   const qrWidth=await dialog.locator('.phone-qr-frame').evaluate(el=>el.getBoundingClientRect().width);
   assert.ok(qrWidth>=220&&qrWidth<=240.1);
   await dialog.locator('.phone-connection-body').evaluate(el=>el.scrollTop=el.scrollHeight);
   assert.equal(await dialog.evaluate(el=>{const c=el.querySelector('.phone-close'),r=c.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===c;}),true);
   await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
   await page.waitForFunction(()=>window.__ux.store.getSnapshot().pairing===null);
   await page.evaluate(devices=>{window.__ux.data.devices=devices;return window.__ux.store.refresh();},savedDevices);
   await page.evaluate(()=>{window.__ux.data.gatewayState='disabled';return window.__ux.store.refresh();});
   const pairCount=await page.evaluate(()=>window.__ux.data.pairCounter);
   await entryButton.click();await dialog.waitFor();assert.equal(await dialog.locator('.phone-qr-frame').count(),0);
   await page.waitForTimeout(150);assert.equal(await page.evaluate(()=>window.__ux.data.pairCounter),pairCount,'disabled gateway remains explicit, no automatic lifecycle');
   await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
   await page.evaluate(()=>{window.__ux.data.gatewayState='running';return window.__ux.store.refresh();});
   await page.emulateMedia({reducedMotion:'reduce'});
   await page.evaluate(()=>window.__ux.notify('Status / '+ '长路径文字 long-path '.repeat(12)));
   const themedToast=page.locator('.experience-ordinary-notice:visible').last();await themedToast.waitFor();
   const themedBounds=await themedToast.evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,width:r.width,background:getComputedStyle(el).backgroundColor}});
   assert.ok(themedBounds.left>=19&&themedBounds.right<=Math.floor(spec.w/spec.scale)-19&&themedBounds.top>=76&&themedBounds.width<=400.1);
   assert.notEqual(themedBounds.background,'rgba(0, 0, 0, 0)');
   if(spec.w===1536&&spec.theme==='light')await page.screenshot({path:path.join(output,'toast-long-light.png'),animations:'disabled'});
   await page.evaluate(()=>window.__ux.notify(''));
   await page.emulateMedia({reducedMotion:'no-preference'});
   if(spec.scale===1&&spec.locale==='zh-CN'&&spec.theme==='dark'&&spec.w===1536){
    await interactions(page,output);
    await pairingBoundaries(page,output);
   }
   assert.deepEqual(errors,[]);await context.close();
  }
  fs.writeFileSync(path.join(output,'geometry.json'),JSON.stringify(results,null,2));
  console.log(renewalOnly?'PHONE-QR-SWITCH-INTERACTION-OK':saveOnly?'PHONE-SAVE-LAYOUT-STABLE-OK':'DESKTOP-UX191-PRODUCTION-CSS-OK',results.length,'layouts; native-WebView=NOT-CLAIMED');
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
}

async function switchInteraction(page,dialog){
 const states=[];
 for(const index of [0,1,8]){
  const control=dialog.locator('.phone-permission-switch').nth(index);
  const style=()=>control.evaluate(el=>({checked:el.getAttribute('aria-checked'),track:getComputedStyle(el).backgroundColor,
    knob:getComputedStyle(el.querySelector('i')).backgroundColor,position:getComputedStyle(el.querySelector('i')).transform,
    rect:el.getBoundingClientRect().toJSON(),title:el.title}));
  await page.mouse.move(3,3);await control.scrollIntoViewIfNeeded();const before=await style();
  await control.hover();const hovered=await style();
  assert.equal(hovered.checked,before.checked);assert.equal(hovered.track,before.track,'hover must keep the confirmed on/off track');
  assert.equal(hovered.position,before.position,'hover does not preview a changed permission');
  assert.deepEqual(hovered.rect,before.rect);assert.match(hovered.title,before.checked==='true'?/已开启|^On/:/已关闭|^Off/);
  await control.focus();await page.keyboard.press('Shift+Tab');await page.keyboard.press('Tab');
  assert.equal(await control.evaluate(el=>el===document.activeElement&&getComputedStyle(el).outlineStyle==='solid'),true,'keyboard focus remains visible');
  await page.mouse.down();const pressed=await style();assert.equal(pressed.checked,before.checked);assert.equal(pressed.position,before.position);
  // Release outside so this visual check never writes a permission.
  await page.mouse.move(3,3);await page.mouse.up();states.push({index,before,hovered});
 }
 assert.notEqual(states[0].hovered.track,states[1].hovered.track,'on and off remain visibly distinct');
 const on=dialog.locator('.phone-permission-switch').first();await on.hover();
 return states;
}

async function expiryRenewal(page,dialog,output,name){
 const geometry=()=>dialog.evaluate(el=>({height:el.getBoundingClientRect().height,scrollHeight:el.querySelector('.phone-connection-body').scrollHeight,
  qr:el.querySelector('.phone-qr-frame').getBoundingClientRect().toJSON(),rows:[...el.querySelectorAll('.phone-permission')].map(r=>[r.offsetTop,r.offsetHeight,r.offsetWidth])}));
 const before=await geometry(), start=await page.evaluate(()=>window.__ux.data.pairCounter);
 for(let i=1;i<=2;i++){
  const old=await page.evaluate(()=>window.__ux.store.getSnapshot().pairing.pairingId);
  await page.evaluate(()=>{window.__ux.data.holdPair=true;window.__ux.store.getSnapshot().pairing.expiresAt=new Date(Date.now()-1000).toISOString();window.__ux.store.tick();});
  await page.waitForFunction(()=>window.__ux.data.pairResolvers.length===1);
  assert.equal(await dialog.locator('.phone-qr-frame svg').count(),0,'expired QR is removed, not shown as scannable while renewing');
  assert.equal(await dialog.locator('.phone-qr-frame').getAttribute('aria-busy'),'true');
  assert.deepEqual(await geometry(),before,'renewal retains QR footprint, rows and scroll geometry');
  assert.equal(await page.evaluate(()=>window.__ux.data.calls.filter(c=>c.command==='companion_gateway_cancel_pairing').at(-1).args.pairingId),old);
  if(i===1)await page.screenshot({path:path.join(output,name+'-renewing.png'),animations:'disabled'});
  for(let poll=0;poll<3;poll++)await page.evaluate(()=>{window.__ux.store.tick();return window.__ux.store.refresh();});
  assert.equal(await page.evaluate(()=>window.__ux.data.pairCounter),start+i,'one renewal per actual expiry, not per tick or poll');
  await page.evaluate(()=>{window.__ux.data.holdPair=false;window.__ux.data.pairResolvers.splice(0).forEach(r=>r());});
  await dialog.locator('.phone-qr-frame svg').waitFor();
  assert.notEqual(await page.evaluate(()=>window.__ux.store.getSnapshot().pairing.pairingId),old);
  assert.deepEqual(await geometry(),before);
 }
 assert.equal(await page.evaluate(()=>window.__ux.data.calls.some(c=>/_start|_stop|_restart|revoke/.test(c.command))),false);
 return {consecutiveExpiries:2,exactlyOneIssueEach:true,oldTicketRetired:true,geometryUnchanged:true};
}

async function stableSaving(page,dialog){
 const saves=[];
 for(const index of [0,4]){
  const control=dialog.locator('.phone-permission-switch').nth(index);
  const before=await dialog.evaluate(el=>({height:el.getBoundingClientRect().height,scrollHeight:el.querySelector('.phone-connection-body').scrollHeight,
    rows:[...el.querySelectorAll('.phone-permission')].map(row=>[row.offsetTop,row.offsetHeight,row.offsetWidth])}));
  const label=await control.getAttribute('aria-label'), checked=await control.getAttribute('aria-checked');
  const count=await page.evaluate(()=>window.__ux.data.calls.filter(c=>c.command==='companion_gateway_service_set_grant').length);
  await page.evaluate(()=>window.__ux.data.holdWrite=true);await control.click();
  await page.waitForFunction(()=>window.__ux.data.writeResolvers.length===1);
  assert.equal(await control.isDisabled(),true,'pending write remains single-flight');
  assert.equal(await control.getAttribute('aria-busy'),'true','saving remains accessible without an inserted status row');
  assert.equal(await control.getAttribute('aria-checked'),checked,'no optimistic grant before backend/readback');
  assert.equal(await dialog.locator('.phone-permission small[role="status"]').count(),0,'saving inserts no little status label');
  const pending=await dialog.evaluate(el=>({height:el.getBoundingClientRect().height,scrollHeight:el.querySelector('.phone-connection-body').scrollHeight,
    rows:[...el.querySelectorAll('.phone-permission')].map(row=>[row.offsetTop,row.offsetHeight,row.offsetWidth])}));
  assert.deepEqual(pending,before,'saving cannot change row geometry or pane height');
  await page.evaluate(()=>{window.__ux.data.holdWrite=false;window.__ux.data.writeResolvers.splice(0).forEach(r=>r());});
  await page.waitForFunction(label=>{
    const control=[...document.querySelectorAll('.phone-permission-switch')].find(el=>el.getAttribute('aria-label')===label);
    return control?.getAttribute('aria-checked')==='true'&&!control.disabled&&control.getAttribute('aria-busy')==='false';
  },label);
  assert.equal(await page.evaluate(()=>window.__ux.data.calls.filter(c=>c.command==='companion_gateway_service_set_grant').length),count+1,'exactly one saved grant');
  saves.push({label,geometryUnchanged:true,disabledWhileSaving:true,confirmedReadback:true});
 }
 return saves;
}

async function stableRefresh(page,dialog){
 const controls=await dialog.locator('.phone-permission-switch').elementHandles();
 const qr=await dialog.locator('.phone-qr-frame svg').elementHandle();
 const initial=await dialog.boundingBox();
 const pairCount=await page.evaluate(()=>window.__ux.data.pairCounter);
 const opacities=await Promise.all(controls.map(el=>el.evaluate(el=>getComputedStyle(el).opacity)));
 for(let i=0;i<3;i++){
  await page.evaluate(()=>{window.__ux.data.holdGrant='phone-a';void window.__ux.store.refresh();});
  await page.waitForFunction(()=>window.__ux.data.grantResolvers.length===1);
  assert.equal(await dialog.locator('.phone-permission-switch').count(),9,'background poll must not replace confirmed permissions with a loading page');
  assert.ok((await Promise.all(controls.map(el=>el.evaluate(el=>el.isConnected)))).every(Boolean));
  assert.equal(await qr.evaluate(el=>el.isConnected),true,'poll never recreates QR');
  assert.deepEqual(await Promise.all(controls.map(el=>el.evaluate(el=>getComputedStyle(el).opacity))),opacities,'poll never blinks confirmed switches');
  assert.deepEqual(await dialog.boundingBox(),initial,'dialog does not jump while polling');
  await page.evaluate(()=>{const {data}=window.__ux;data.holdGrant=null;data.grantResolvers.splice(0).forEach(r=>r(structuredClone(data.services['phone-a'])));});
  await page.waitForFunction(()=>!window.__ux.store.getSnapshot().grantLoading['phone-a']);
 }
 assert.equal(await page.evaluate(()=>window.__ux.data.pairCounter),pairCount,'poll never reissues QR');
}

async function pairingBoundaries(page,output){
 const entry=page.locator('.phone-connection-entry'),dialog=page.locator('.phone-connection-dialog');
 await page.evaluate(()=>{
  window.__ux.setAdvanced(false);
  window.__ux.data.devices=window.__ux.data.devices.map(d=>({...d,label:'LuckyRay Mobile',connected:d.deviceId==='phone-a'}));
  return window.__ux.store.refresh();
 });
 await entry.click();await dialog.locator('.phone-qr-frame').waitFor();
 const labels=await dialog.locator('.phone-device b').allTextContents();
 assert.equal(new Set(labels).size,2,'same mobile name is distinguishable');
 assert.equal(await dialog.locator('.phone-device-heading h3').textContent(),await dialog.locator('.phone-device[aria-pressed="true"] b').textContent(),'selected access pane uses the same identity as device list');
 await page.screenshot({path:path.join(output,'phone-duplicate-identity-dark.png'),animations:'disabled'});
 const issued=await page.evaluate(()=>window.__ux.data.pairCounter);
 await dialog.getByRole('button',{name:'关闭配对码',exact:true}).click();
 await dialog.locator('.phone-qr-frame').waitFor({state:'hidden'});
 for(let i=0;i<3;i++)await page.evaluate(()=>window.__ux.store.refresh());
 assert.equal(await page.evaluate(()=>window.__ux.data.pairCounter),issued,'explicit QR close remains closed while polling');
 await dialog.getByRole('button',{name:'连接新手机',exact:true}).click();await dialog.locator('.phone-qr-frame').waitFor();
 const beforeExpire=await page.evaluate(()=>window.__ux.data.pairCounter);
 await page.evaluate(()=>{window.__ux.store.getSnapshot().pairing.expiresAt=new Date(Date.now()-1000).toISOString();window.__ux.store.tick();});
 await page.waitForFunction(count=>window.__ux.data.pairCounter===count+1&&window.__ux.store.getSnapshot().pairing,beforeExpire);
 await page.evaluate(()=>window.__ux.store.refresh());
 assert.equal(await page.evaluate(()=>window.__ux.data.pairCounter),beforeExpire+1,'expiry renews once, polling does not issue again');
 await page.evaluate(()=>{window.__ux.data.failPair=true;window.__ux.store.getSnapshot().pairing.expiresAt=new Date(Date.now()-1000).toISOString();window.__ux.store.tick();});
 await dialog.locator('.phone-error').waitFor();
 const failedRenewal=await page.evaluate(()=>window.__ux.data.calls.filter(c=>c.command==='companion_gateway_issue_pairing').length);
 for(let i=0;i<3;i++)await page.evaluate(()=>{window.__ux.store.tick();return window.__ux.store.refresh();});
 assert.equal(await page.evaluate(()=>window.__ux.data.calls.filter(c=>c.command==='companion_gateway_issue_pairing').length),failedRenewal,'failed automatic renewal never loops');
 assert.match(await dialog.locator('.phone-error').textContent(),/过于频繁/);
 await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
 await page.evaluate(()=>window.__ux.data.failPair=true);
 const attempts=await page.evaluate(()=>window.__ux.data.calls.filter(c=>c.command==='companion_gateway_issue_pairing').length);
 await entry.click();await dialog.locator('.phone-error').waitFor();
 assert.equal(await dialog.locator('.phone-qr-frame').count(),0);
 for(let i=0;i<3;i++)await page.evaluate(()=>window.__ux.store.refresh());
 assert.equal(await page.evaluate(()=>window.__ux.data.calls.filter(c=>c.command==='companion_gateway_issue_pairing').length),attempts+1,'failed preparation is one-shot, no retry loop');
 assert.match(await dialog.locator('.phone-error').textContent(),/过于频繁/,'status poll cannot erase pairing failure feedback');
 await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
 await page.evaluate(()=>{window.__ux.data.failPair=false;window.__ux.data.holdPair=true;});
 await entry.click();await page.waitForFunction(()=>window.__ux.data.pairResolvers.length===1);
 const lateId=await page.evaluate(()=>'fixture-'+window.__ux.data.pairCounter);
 await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
 await page.evaluate(()=>{window.__ux.data.holdPair=false;window.__ux.data.pairResolvers.splice(0).forEach(r=>r());});
 await page.waitForFunction(id=>window.__ux.data.calls.some(c=>c.command==='companion_gateway_cancel_pairing'&&c.args.pairingId===id),lateId);
 assert.equal(await page.evaluate(()=>window.__ux.store.getSnapshot().pairing),null,'late code never opens hidden dialog');
 // A second expiry is deferred while hidden or unconfirmed; visibility does not
 // bypass gateway authority. Manual close and a failed renewal remain one-shot.
 await entry.click();await dialog.locator('.phone-qr-frame svg').waitFor();
 const visibleCount=await page.evaluate(()=>window.__ux.data.pairCounter);
 await page.evaluate(()=>{
  Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});
  window.__ux.store.getSnapshot().pairing.expiresAt=new Date(Date.now()-1000).toISOString();window.__ux.store.tick();
 });
 await page.waitForFunction(()=>window.__ux.store.getSnapshot().pairingExpiry?.ready);
 await page.evaluate(()=>window.__ux.store.refresh());
 assert.equal(await page.evaluate(()=>window.__ux.data.pairCounter),visibleCount,'hidden dialog cannot renew');
 await page.evaluate(()=>{
  window.__ux.data.gatewayState='disabled';delete document.visibilityState;
  document.dispatchEvent(new Event('visibilitychange'));return window.__ux.store.refresh();
 });
 assert.equal(await page.evaluate(()=>window.__ux.data.pairCounter),visibleCount,'stopped gateway is not restarted to renew');
 await page.evaluate(()=>{window.__ux.data.gatewayState='running';return window.__ux.store.refresh();});
 await page.waitForFunction(count=>window.__ux.data.pairCounter===count+1&&window.__ux.store.getSnapshot().pairing,visibleCount);
 await page.evaluate(()=>{window.__ux.data.holdPair=true;window.__ux.store.getSnapshot().pairing.expiresAt=new Date(Date.now()-1000).toISOString();window.__ux.store.tick();});
 await page.waitForFunction(()=>window.__ux.data.pairResolvers.length===1);
 const renewingId=await page.evaluate(()=>'fixture-'+window.__ux.data.pairCounter);
 await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
 await page.evaluate(()=>{window.__ux.data.holdPair=false;window.__ux.data.pairResolvers.splice(0).forEach(r=>r());});
 await page.waitForFunction(id=>window.__ux.data.calls.some(c=>c.command==='companion_gateway_cancel_pairing'&&c.args.pairingId===id),renewingId);
 assert.equal(await page.evaluate(()=>window.__ux.store.getSnapshot().pairing),null,'late renewal is cancelled after closing');
 // The quick dialog neither steals nor renews the advanced view's owned ticket.
 await page.evaluate(async()=>{
  window.__ux.otherOwner=Symbol('advanced-fixture');window.__ux.closeOther=window.__ux.store.open(window.__ux.otherOwner,true);
  await window.__ux.store.refresh();await window.__ux.store.issuePairing(window.__ux.otherOwner);
 });
 const otherCount=await page.evaluate(()=>window.__ux.data.pairCounter);
 await entry.click();await dialog.waitFor();
 await page.evaluate(()=>{window.__ux.store.getSnapshot().pairing.expiresAt=new Date(Date.now()-1000).toISOString();window.__ux.store.tick();});
 await page.waitForFunction(()=>window.__ux.store.getSnapshot().pairingExpiry?.ready);
 for(let i=0;i<3;i++)await page.evaluate(()=>window.__ux.store.refresh());
 assert.equal(await page.evaluate(()=>window.__ux.data.pairCounter),otherCount,'another view expiry is not a renewal request');
 await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
 await page.evaluate(()=>window.__ux.closeOther());
 assert.equal(await page.evaluate(()=>window.__ux.data.calls.some(c=>/_start|_stop|revoke/.test(c.command))),false,'only pairing ticket lifetime is touched');
 console.log('PHONE-REFINEMENT-BOUNDARIES-OK: same names, close, expiry renewal, failures, hidden/stopped, other owner, late cancellation, StrictMode');
}

async function interactions(page,output){
 const entry=page.locator('.phone-connection-entry'), dialog=page.locator('.phone-connection-dialog');
 const csv=page.getByRole('menuitem',{name:'导出此分类清单（CSV）'});
 await page.locator('.sidebar [data-folder-id="b"]').first().evaluate(el=>el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:innerWidth-2,clientY:innerHeight-2})));
 await csv.waitFor();
 const fenced=await csv.evaluate(el=>{const r=el.closest('[role="menu"]').getBoundingClientRect();return r.left>=8&&r.top>=8&&r.right<=innerWidth-8&&r.bottom<=innerHeight-8});assert.equal(fenced,true);
 await page.keyboard.press('End');assert.equal(await csv.evaluate(el=>el.closest('[role="menu"]').contains(document.activeElement)),true);
 await page.keyboard.press('Home');await page.keyboard.press('ArrowDown');await page.keyboard.press('Escape');await csv.waitFor({state:'hidden'});
 await page.locator('.sidebar [data-folder-id="a"]').first().click();
 await page.locator('.sidebar [data-folder-id="b"]').first().click({button:'right'});await csv.waitFor();
 await page.screenshot({path:path.join(output,'csv-right-target-dark.png'),animations:'disabled'});await csv.click();
 const csvDialog=page.getByRole('dialog',{name:'导出素材清单（CSV）'});await csvDialog.waitFor();
 const plans=await page.evaluate(()=>window.__ux.data.calls.filter(c=>c.command==='material_csv_export_plan'));
 assert.equal(plans.at(-1).args.request.folderId,'b');assert.match(await csvDialog.textContent(),/2 条素材记录/);
 assert.equal(await page.locator('.material-csv-folder-entry').count(),0);
 await page.keyboard.press('Escape');await csvDialog.waitFor({state:'hidden'});
 // Keyboard context opening uses the same stable target, without changing page selection.
 const b=page.locator('.sidebar [data-folder-id="b"]').first();await b.focus();await page.keyboard.press('Shift+F10');await csv.waitFor();
 await page.evaluate(()=>{window.__ux.data.folders[1].name='Renamed B';window.dispatchEvent(new CustomEvent('luckyray:folders-changed',{detail:{scope:'materials'}}));});
 await csv.click();await csvDialog.waitFor();await page.keyboard.press('Escape');await csvDialog.waitFor({state:'hidden'});
 await b.click({button:'right'});await csv.waitFor();
 await page.evaluate(()=>{window.__ux.data.folders=window.__ux.data.folders.filter(f=>f.id!=='b');window.dispatchEvent(new CustomEvent('luckyray:folders-changed',{detail:{scope:'materials'}}));});
 await csv.waitFor({state:'hidden'});
 const before=await page.evaluate(()=>window.__ux.data.calls.filter(c=>c.command==='material_csv_export_plan').length);
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('luckyray:materials-export-folder-csv',{detail:{folderId:'b'}})));
 await page.waitForTimeout(100);
 const latePlans=await page.evaluate(()=>window.__ux.data.calls.filter(c=>c.command==='material_csv_export_plan'));
 assert.ok(latePlans.length===before||latePlans.length===before+1);
 assert.ok(latePlans.slice(before).every(c=>c.args.request.folderId==='b'),'stale target never becomes whole catalog');
 assert.equal(await csvDialog.count(),0,'stale target cannot produce a writable plan');
 await page.waitForFunction(()=>[...document.querySelectorAll('.experience-ordinary-notice,.material-export-notice')].every(el=>!el.getClientRects().length),null,{timeout:6500});
 await page.evaluate(()=>{window.__ux.notify('Floating success with a long path '+ '中文 / text '.repeat(25));});
 const toast=page.locator('.experience-ordinary-notice:visible').last();await toast.waitFor();await page.waitForTimeout(250);
 const toastGeometry=await toast.evaluate(el=>{const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {r:r.toJSON(),inside:r.top>=76&&r.right<=innerWidth-19&&r.left>=19&&r.bottom<=innerHeight,
   portal:!!el.closest('[data-experience-overlay]'),unclipped:hit===el||el.contains(hit),width:r.width,background:getComputedStyle(el).backgroundColor};});
 assert.ok(toastGeometry.inside&&toastGeometry.portal&&toastGeometry.unclipped&&toastGeometry.width<=400.1,JSON.stringify(toastGeometry));
 await toast.hover();await page.waitForTimeout(5300);assert.equal(await toast.count(),1,'hover pauses long 5s notice past its full lifetime');
 await page.mouse.move(4,400);await toast.waitFor({state:'hidden',timeout:6000});
 await page.evaluate(()=>window.__ux.notify('Duplicate'));await page.waitForTimeout(2000);
 await page.evaluate(()=>window.__ux.notify('Duplicate'));await page.waitForTimeout(1500);
 assert.equal(await page.getByText('Duplicate',{exact:true}).count(),1,'repeat rearmed');
 await page.evaluate(()=>{window.__ux.notify('One');window.__ux.notify('Two');window.__ux.notify('Three');window.__ux.setNotices([{id:'export',taskId:null,message:'Export notice still uses accepted 4s lifetime',tone:'success',action:'view'}]);});
 await page.waitForFunction(()=>document.querySelectorAll('.experience-ordinary-notice:not([hidden])').length===1);
 assert.equal(await page.locator('.experience-ordinary-notice:visible').count()+await page.locator('.material-export-notice:visible').count(),2);
 const noOverlap=await page.evaluate(()=>{const a=document.querySelector('.experience-ordinary-notice:not([hidden])').getBoundingClientRect(),b=document.querySelector('.material-export-notice').getBoundingClientRect();return a.bottom+8<=b.top||b.bottom+8<=a.top;});assert.equal(noOverlap,true);
 await page.screenshot({path:path.join(output,'toast-export-coexist-dark.png'),animations:'disabled'});
 await entry.click();await dialog.waitFor();
 await page.getByRole('img',{name:'一次性手机配对二维码'}).waitFor();
 const first=await page.evaluate(()=>window.__ux.store.getSnapshot().pairing.pairingId);
 await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
 await page.waitForFunction(id=>window.__ux.data.calls.some(c=>c.command==='companion_gateway_cancel_pairing'&&c.args.pairingId===id),first);
 await entry.click();await dialog.waitFor();await dialog.locator('.phone-qr-frame').waitFor();
 assert.notEqual(await page.evaluate(()=>window.__ux.store.getSnapshot().pairing.pairingId),first,'reopening owns a new code, not the cancelled one');
 await page.getByRole('button',{name:'Offline test phone'}).click();
 await page.waitForFunction(()=>document.querySelector('.phone-connection-right h3')?.textContent==='Offline test phone'&&!document.querySelector('.phone-connection-right [role="status"]'));
 assert.match(await page.locator('.phone-connection-right').textContent(),/另一知识库 B/);
 await page.evaluate(()=>window.__ux.data.failGrant=true);
 const read=page.getByRole('switch',{name:'读取素材库',exact:true});await read.click();await page.locator('.phone-permission .phone-error').waitFor();
 assert.equal(await read.getAttribute('aria-checked'),'false','failed write is not optimistic');
 await page.evaluate(()=>window.__ux.data.failGrant=false);await read.click();
 await page.waitForFunction(()=>document.querySelector('.phone-permission-switch[aria-label="读取素材库"]').getAttribute('aria-checked')==='true');
 await page.getByRole('button',{name:'撤销设备',exact:true}).click();
 const revoke=page.locator('.phone-revoke-dialog');await revoke.waitFor();await page.keyboard.press('Escape');
 await revoke.waitFor({state:'hidden'});assert.equal(await dialog.count(),1,'Esc closes only topmost');
 await page.getByRole('button',{name:'更多连接设置'}).click();await dialog.waitFor({state:'hidden'});
 await page.locator('.companion-panel').waitFor();assert.match(await page.locator('.companion-panel').textContent(),/Offline test phone/);
 await page.evaluate(()=>{window.__ux.data.fail=true;return window.__ux.store.refresh();});
 assert.equal(await entry.getAttribute('data-connected'),'false');assert.match(await entry.getAttribute('aria-label'),/未确认/);
 await page.evaluate(()=>{window.__ux.data.fail=false;window.__ux.data.devices=window.__ux.data.devices.map(d=>({...d,connected:false}));return window.__ux.store.refresh();});
 assert.match(await entry.getAttribute('aria-label'),/未连接/);
 await page.locator('.sidebar-toggle').click();assert.equal(await entry.isVisible(),true);
 console.log('DESKTOP-UX191-INTERACTION-OK',JSON.stringify(toastGeometry));
}
run().catch(error=>{console.error(error);process.exitCode=1;});
