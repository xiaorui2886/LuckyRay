// Production MaterialsPage + appearance panel, fixture native transport, isolated headless browser.
// No main app, user profile, real libraries, phone, Collector replacement or pixel-algorithm claim.
const fs=require('node:fs');const path=require('node:path');const http=require('node:http');const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const esbuild=require(require.resolve('esbuild',{paths:[fs.realpathSync(root+'/node_modules/vite')]}));
const {chromium}=require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE||'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@playwright/mcp/node_modules/playwright');
const thumb='data:image/png;base64,'+fs.readFileSync(path.join(root,'tests/fixtures/material-appearance/oriented-expected.png')).toString('base64');
const out=process.env.LUCKYRAY_EVIDENCE_DIR||path.join(root,'.tmp-material-appearance');
const entry=`
import React,{Activity,useState,useEffect} from 'react';import {createRoot} from 'react-dom/client';
import {I18nProvider} from './src/core/i18n/index';import MaterialsPage from './src/features/materials/MaterialsPage';
import {AppTitlebar} from './src/app/AppSidebar';
import {MaterialLibraryNavigation} from './src/features/materials/MaterialLibraryNavigation';
import {setActiveMaterialExternalDrag,peekActiveMaterialExternalDrag} from './src/core/services/materials';
import {openMaterialAppearanceFromNavigation,dispatchMaterialsToolbarCommand} from './src/features/materials/materialsToolbarProtocol';
import SearchOverlay from './src/features/search/SearchOverlay';
import {writeSavedSettingsPatch,useSettings} from './src/features/settings/useSettings';
import {ApplicationModalIsolationProvider,createApplicationModalIsolationStore} from './src/app/applicationModalIsolation';
import {materialLibrarySession} from './src/core/services/materialLibraryContext';import {materialStore} from './src/core/services/materialStore';
import './src/App.css';import './src/features/materials/materials.css';
import './src/app/appShell.css';import './src/core/theme/themeTokens.css';
const image=(id,name,library)=>({id,name,originalPath:'D:/fixture/'+name,libraryPath:null,storageMode:'linked',kind:'image',mimeType:'image/png',sizeBytes:id==='red'?20:10,thumbnailUrl:${JSON.stringify(thumb)},description:'reference',rating:null,dominantColor:'#336699',folderId:null,importedAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z',contentHash:null});
let rows={A:[image('red','red.png'),image('blue','blue.png')],B:[image('B-image','B-library.png')]};
const registry={legacyId:'A',activeId:'A',libraries:['A','B'].map(id=>({id,name:id,rootPath:'D:/fixture/'+id,storageMode:'managed',state:'ready',visible:true,preferences:{},version:0}))};
const cache=new Set();const staged=new Map();const held=[];let hold=false;let fail='';
window.__appearance={calls:[],drag:setActiveMaterialExternalDrag,peek:peekActiveMaterialExternalDrag,nav:openMaterialAppearanceFromNavigation,command:dispatchMaterialsToolbarCommand,settings:writeSavedSettingsPatch,hold:value=>{hold=value},resolve:()=>{const item=held.shift();if(item)item()},refresh:()=>materialLibrarySession.refresh(),
 preferences:()=>{materialLibrarySession.writePreference('luckyray-materials-test','value','A')},select:id=>materialLibrarySession.select(id),
 one:()=>{rows.A=rows.A.slice(0,1);return materialStore.invalidate({reason:'fixture-delete',force:true})},many:()=>{rows.A=[...rows.A,...Array.from({length:100},(_,i)=>image('scroll-'+i,'scroll-'+i+'.png'))];return materialStore.invalidate({reason:'fixture-populate-scroll',force:true})},failure:value=>{fail=value}};
window.__appearance.video=()=>{rows.A=[{...image('film','film.mp4'),kind:'video',mimeType:'video/mp4'}];return materialStore.invalidate({reason:'fixture-video',force:true})};
const result=(libraryId,ids,anchor)=>({libraryId,algorithm:'pixel-appearance-v1',requested:ids.length,indexed:ids.filter(id=>id!==anchor&&cache.has(libraryId+id)).length,unindexed:ids.filter(id=>id!==anchor&&!cache.has(libraryId+id)).length,excludedAnchor:ids.includes(anchor)?1:0,failures:[],hits:ids.filter(id=>id!==anchor&&cache.has(libraryId+id)).slice(0,24).map(id=>({assetId:id,distance:{total:.1,spatial:.1,color:.1,structure:.1,proportion:.1}}))});
window.__TAURI_INTERNALS__={invoke:async(command,args={})=>{
 if(command==='material_library_command'){
  const {libraryId,action}=args.request;window.__appearance.calls.push(structuredClone(args.request));
  if(action.op==='registry')return structuredClone(registry);
  if(action.op==='select'){registry.activeId=libraryId;return null;}
  if(action.op==='preferences'){registry.libraries.find(l=>l.id===libraryId).preferences=action.value;return null;}
  if(action.op==='list')return structuredClone(rows[libraryId].filter(a=>!action.filter?.query||(a.name+' '+a.description).includes(action.filter.query)));
  if(action.op==='get')return structuredClone(rows[libraryId].filter(a=>action.ids.includes(a.id)));
  if(action.op==='videoMarks')return {sourceRevision:'fixture',marks:[]};
  if(action.op==='change')return null;if(action.op==='tasks')return {exports:[],csv:[]};
  if(action.op==='favoriteCounts')return {material:0,note:0};if(action.op==='tagMap')return {};
  if(action.op==='appearancePrepare'){
   const done=()=>{if(action.id===fail)throw Error('fixture broken image');const cached=cache.has(libraryId+action.id);const token=cached?null:libraryId+action.id;staged.set(token,libraryId+action.id);return {libraryId,assetId:action.id,algorithm:'pixel-appearance-v1',cached,token};};
   if(hold)return new Promise((resolve,reject)=>held.push(()=>{try{resolve(done())}catch(e){reject(e)}}));return done();
  }
  if(action.op==='appearanceCommit'){cache.add(staged.get(action.token));staged.delete(action.token);return null;}
  if(action.op==='appearanceDiscard'){staged.delete(action.token);return null;}
  if(action.op==='appearanceQuery')return result(libraryId,action.ids,action.query.kind==='asset'?action.query.id:null);
  return [];
 }
 if(command==='favorite_item_counts'||command==='get_favorite_item_counts')return {material:0,note:0};
 if(command==='get_local_transport_client_config')return {baseUrl:'http://127.0.0.1:1',credential:''};
 if(command==='material_catalog_attachment_details')return {referenceCount:0,references:[],ordinary:true,absolutePath:''};
 return [];
}};
window.fetch=async()=>new Response(JSON.stringify({capabilities:[]}),{headers:{'Content-Type':'application/json'}});
const bridge={listAssets:async()=>rows[registry.activeId],listAssetsFiltered:async()=>rows[registry.activeId],getAssetsByIds:async ids=>rows[registry.activeId].filter(a=>ids.includes(a.id)),listFolders:async()=>[],getMaterialChangeState:async()=>null,listFavoriteItems:async()=>[],getFavoriteItemCounts:async()=>({material:0,note:0}),listVaults:async()=>[],getCurrentNotesVault:async()=>null,listNotes:async()=>[],searchNotesForGlobal:async q=>['red','中文'].some(s=>q.includes(s))?[{id:'fixture-note',title:'red 中文知识笔记',snippet:'fixture正文',updatedAt:''}]:[]};
Object.defineProperty(window,'__LUCKYRAY__',{get:()=>bridge,set:()=>{},configurable:true});
if(!localStorage.getItem('luckyray-settings-v1'))localStorage.setItem('luckyray-settings-v1',JSON.stringify({'materials.importModePromptSeen':true}));
function ShortcutSettingsFixture(){const s=useSettings();window.__appearance.rebind=value=>s.updateShortcut('searchModeToggle',value);return null;}
function Fixture(){const [search,setSearch]=useState(false),[route,setRoute]=useState('materials');window.__appearance.route=r=>{location.hash=r;setRoute(r)};useEffect(()=>{const open=()=>setSearch(true);window.addEventListener('luckyray:search-open',open);return()=>window.removeEventListener('luckyray:search-open',open)},[]);return <div className='react-nav-shell' data-route={route}><aside className='sidebar' aria-label='Fixture sidebar'><div className='folder-item folder-all-with-accessory'><MaterialLibraryNavigation onViewAll={()=>{window.__appearance.allClicks=(window.__appearance.allClicks||0)+1}}/></div></aside><div className='main'><AppTitlebar route='materials' onOpenSearch={()=>setSearch(true)}/><div className='content-wrap'><div className='content'><Activity mode={route==='materials'?'visible':'hidden'}><MaterialsPage/></Activity></div></div></div><SearchOverlay open={search} onClose={()=>setSearch(false)}/></div>}
createRoot(document.getElementById('root')).render(<ApplicationModalIsolationProvider store={createApplicationModalIsolationStore()}><I18nProvider locale='zh-CN'><ShortcutSettingsFixture/><Fixture/></I18nProvider></ApplicationModalIsolationProvider>);
`;
(async()=>{
 fs.mkdirSync(out,{recursive:true});
 const appStub={name:'fixture-app',setup(build){build.onResolve({filter:/\.\/App$/},args=>/luckyrayBridge\.ts$/i.test(args.importer)?{path:'fixture-app',namespace:'fixture'}:null);build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export function buildLuckyRayBridge(){return window.__LUCKYRAY__}',loader:'js'}));}};
 const rawSvg={name:'raw-svg',setup(build){build.onResolve({filter:/\.svg\?raw$/},args=>({path:path.resolve(args.resolveDir,args.path.replace(/\?raw$/,'')),namespace:'raw-svg'}));build.onLoad({filter:/.*/,namespace:'raw-svg'},args=>({contents:fs.readFileSync(args.path,'utf8'),loader:'text'}))}};
 const built=await esbuild.build({stdin:{contents:entry,resolveDir:root,loader:'tsx'},bundle:true,write:false,format:'iife',outfile:'app.js',loader:{'.svg':'dataurl'},plugins:[appStub,rawSvg],define:{'process.env.NODE_ENV':'"test"'}});
 const server=http.createServer((request,response)=>{
  const file=built.outputFiles.find(f=>f.path.endsWith(request.url.slice(1)));
  if(file&&(request.url==='/app.js'||request.url==='/app.css')){response.setHeader('Content-Type',request.url.endsWith('css')?'text/css':'text/javascript');response.end(file.contents);}
  else response.end('<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script></html>');
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let browser;
 try {
  const browserPath=process.env.LUCKYRAY_TEST_BROWSER||['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p=>fs.existsSync(p));
  browser=await chromium.launch({headless:true,executablePath:browserPath});const page=await browser.newPage({viewport:{width:1200,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port);await page.getByRole('searchbox',{name:'搜索当前素材库'}).waitFor();
  await page.waitForFunction(()=>document.querySelectorAll('[data-asset-id]').length===2);
  const search=page.getByRole('searchbox',{name:'搜索当前素材库'});await search.fill('red');
  const saveRule=async()=>{if(!await page.locator('.filter-save-smart-react').isVisible())await page.locator('#materials-filter-trigger').click();await page.locator('.filter-save-smart-react').click();};
  await page.waitForFunction(()=>document.querySelectorAll('[data-asset-id]').length===1&&document.querySelector('[data-asset-id="red"]'));
  assert.ok(await page.evaluate(()=>window.__appearance.calls.some(r=>r.action.op==='list'&&r.action.filter?.query==='red')));
  await search.fill('');await page.waitForFunction(()=>document.querySelectorAll('[data-asset-id]').length===2);
  assert.equal(await page.locator('.materials-search-controls').count(),0,'no persistent duplicate search form');
  await page.locator('#materials-filter-trigger').click();
  await page.locator('.filter-panel-row-react').first().getByRole('button').nth(3).click();
  // Freeze only the debounce, then save the visible input immediately while Catalog query is still older.
  await page.evaluate(()=>{const real=window.setTimeout;window.__appearance.restoreTimers=()=>{window.setTimeout=real};window.setTimeout=(fn,ms,...args)=>real(fn,ms===180?60000:ms,...args);});
  await search.fill('最新查询词');await saveRule();
  const draft=await page.evaluate(()=>JSON.parse(new URLSearchParams(location.hash.split('?')[1]).get('draft')));
  assert.equal(draft.criteria.query,'最新查询词');assert.equal(draft.sort,'name-asc');
  await search.fill('');
  await page.evaluate(()=>window.__appearance.restoreTimers());
  await page.evaluate(()=>{location.hash=''});
  await search.fill('  ImAgE  ');
  await page.waitForFunction(()=>document.querySelectorAll('[data-asset-id]').length===0);
  await saveRule();
  assert.equal(await page.evaluate(()=>location.hash),'','kind-only query must not open a broader smart draft');
  await page.getByText('当前检索只匹配名称和描述；智能规则还匹配文件类型。为保留当前范围，请调整查询词，或在智能规则编辑器重新设置。',{exact:true}).waitFor();
  await search.fill('red');await page.waitForFunction(()=>document.querySelectorAll('[data-asset-id]').length===1);
  await saveRule();
  assert.equal(await page.evaluate(()=>JSON.parse(new URLSearchParams(location.hash.split('?')[1]).get('draft')).criteria.query),'red');
  await search.fill('');await page.waitForFunction(()=>document.querySelectorAll('[data-asset-id]').length===2);
  if(await page.locator('.filter-save-smart-react').isVisible())await page.locator('#materials-filter-trigger').click();
  // Production CSS: the batch bar stays inside its content owner, including a
  // narrower-than-native-minimum viewport. This is fixture layout evidence only.
  await page.locator('[data-asset-id="red"] .batch-checkbox-react').click();
  await page.locator('[data-asset-id="blue"] .batch-checkbox-react').click();
  const batch=page.locator('.batch-bar-react');
  assert.equal(await batch.getByRole('button',{name:'比较',exact:true}).isEnabled(),true);
  assert.equal(await batch.getByRole('button',{name:/导出/}).count(),0);
  await batch.getByRole('button',{name:'复制所选到库',exact:true}).waitFor();
  for(const width of [1180,800]) {
   await page.setViewportSize({width,height:800});
   for(const theme of ['light','dark']) {
    await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);
    await page.waitForTimeout(280);
    const bounds=await batch.evaluate(el=>{const r=el.getBoundingClientRect(),p=document.querySelector('#page-materials').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,viewportHeight:innerHeight,center:(r.left+r.right)/2,parentLeft:p.left,parentRight:p.right,parentCenter:(p.left+p.right)/2,scroll:el.scrollWidth,width:el.clientWidth};});
    assert.ok(bounds.left>=bounds.parentLeft&&bounds.right<=bounds.parentRight,JSON.stringify(bounds));
    assert.ok(Math.abs(bounds.center-bounds.parentCenter)<2,JSON.stringify(bounds));
    assert.ok(bounds.scroll<=bounds.width+1,'batch actions must wrap without horizontal clipping');
    assert.ok(bounds.top>=0&&bounds.bottom<=bounds.viewportHeight,'batch bar must be visible inside the viewport');
    await page.screenshot({path:path.join(out,`batch-${width}-${theme}-fixture.png`)});
   }
  }
  await batch.getByRole('button',{name:'清空',exact:true}).click();
  await page.setViewportSize({width:1200,height:900});
  await page.evaluate(()=>document.documentElement.dataset.theme='light');
  await page.getByRole('button',{name:'以图搜图',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__appearance.calls.filter(r=>r.action.op==='appearancePrepare').length),0,'no automatic index scan');
  await page.evaluate(()=>window.__appearance.hold(true));
  await page.locator('.material-appearance-dialog input[type=file]').setInputFiles(path.join(root,'tests/fixtures/material-appearance/oriented-expected.png'));
  await page.waitForFunction(()=>window.__appearance.calls.some(r=>r.action.op==='appearancePrepare'));
  await page.evaluate(()=>window.__appearance.refresh());
  assert.match(await page.locator('.material-appearance-dialog').innerText(),/正在准备/,'same-context registry publish keeps operation current');
  await page.evaluate(()=>window.__appearance.preferences());
  await page.waitForFunction(()=>window.__appearance.calls.some(r=>r.action.op==='preferences'&&r.action.value['luckyray-materials-test']==='value'));
  assert.match(await page.locator('.material-appearance-dialog').innerText(),/正在准备/,'unrelated preference-save ACK keeps operation current');
  assert.equal(await page.getByRole('progressbar',{name:'以图搜图进度'}).getAttribute('value'),'0');
  await page.screenshot({path:path.join(out,'r3-feedback-progress-fixture.png')});
  await page.getByRole('img',{name:/查询图片/}).waitFor();
  await page.evaluate(()=>{window.__appearance.hold(false);window.__appearance.resolve()});
  await page.getByText('找到 2 张相似图片',{exact:true}).waitFor();
  assert.equal(await page.locator('.material-appearance-dialog').count(),1,'query stays with main-grid results');
  assert.equal(await page.locator('.material-appearance-status').count(),0,'no extra results strip');
  assert.equal(await page.locator('.masonry-container [data-asset-id]').count(),2,'results use the existing main list');
  await page.screenshot({path:path.join(out,'appearance-result-fixture.png')});
  await page.evaluate(()=>window.__appearance.failure('red'));
  await page.locator('.material-appearance-dialog input[type=file]').setInputFiles(path.join(root,'tests/fixtures/material-appearance/oriented-expected.png'));
  await page.getByText('1 张图片未参与检索',{exact:true}).waitFor();
  await page.evaluate(()=>window.__appearance.failure(''));
  await page.evaluate(()=>window.__appearance.hold(true));
  await page.locator('.material-appearance-dialog input[type=file]').setInputFiles(path.join(root,'tests/fixtures/material-appearance/oriented-expected.png'));
  await page.getByRole('button',{name:'取消',exact:true}).click();assert.match(await page.locator('.material-appearance-dialog').innerText(),/已取消/);
  const commits=await page.evaluate(()=>window.__appearance.calls.filter(r=>r.action.op==='appearanceCommit').length);
  await page.evaluate(()=>{window.__appearance.hold(false);window.__appearance.resolve()});await page.waitForTimeout(80);
  assert.equal(await page.evaluate(()=>window.__appearance.calls.filter(r=>r.action.op==='appearanceCommit').length),commits);

  await page.getByRole('button',{name:'移除查询图片',exact:true}).click();
  // Retained-page navigation opens once. No modal authority or full-screen intercept.
  await page.evaluate(()=>window.__appearance.nav());await page.getByRole('dialog',{name:'以图搜图'}).waitFor();
  assert.equal(await page.evaluate(()=>location.hash),'#materials');
  assert.equal(await page.locator('[aria-modal=true]').count(),0);
  assert.equal(await page.locator('.material-appearance-backdrop').count(),0);
  await page.locator('[data-asset-id="red"] .batch-checkbox-react').click();
  assert.equal(await page.getByRole('dialog',{name:'以图搜图'}).count(),1,'background stays interactive');
  for(const theme of ['light','dark']) {
    await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);
    await page.waitForTimeout(300); // Capture settled theme transitions, not an interpolated light/dark frame.
    const bounds=await page.locator('.material-appearance-dialog').boundingBox();
    assert.ok(bounds.width<=322&&Math.abs(1200-bounds.x-bounds.width-12)<2&&bounds.y<110,JSON.stringify(bounds));
    await page.screenshot({path:path.join(out,'r2-popover-'+theme+'-fixture.png')});
  }
  await page.getByRole('button',{name:'关闭以图搜图',exact:true}).click();
  await page.getByRole('button',{name:'以图搜图',exact:true}).click();
  await page.getByRole('dialog',{name:'以图搜图'}).waitFor();
  await page.getByRole('button',{name:'以图搜图',exact:true}).click();
  assert.equal(await page.getByRole('dialog',{name:'以图搜图'}).count(),0,'same titlebar trigger toggles the popup closed');
  const trigger=page.locator('[data-material-appearance-trigger]');
  await page.evaluate(()=>window.__appearance.drag(['red']));
  const beforeHover=await page.evaluate(()=>window.__appearance.calls.filter(r=>r.action.op==='appearanceQuery').length);
  await trigger.dispatchEvent('dragover');
  assert.equal(await page.evaluate(()=>window.__appearance.calls.filter(r=>r.action.op==='appearanceQuery').length),beforeHover);
  await trigger.dispatchEvent('drop');await page.getByText('找到 1 张相似图片',{exact:true}).waitFor();
  assert.equal(await page.locator('.masonry-container [data-asset-id="blue"]').count(),1);
  assert.equal(await page.locator('.masonry-container [data-asset-id="red"]').count(),0);
  assert.equal(await page.evaluate(()=>window.__appearance.peek()),null);
  await page.getByRole('button',{name:'关闭以图搜图',exact:true}).click();
  // Same production detail entry starts the same visible query session.
  await page.locator('[data-asset-id="red"]').click();
  await page.getByRole('button',{name:'查找相似',exact:true}).click();
  await page.getByRole('img',{name:'查询图片：red.png',exact:true}).waitFor();
  await page.getByText('找到 1 张相似图片',{exact:true}).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog',{name:'以图搜图'}).count(),0);
  assert.equal(await page.locator('.masonry-container [data-asset-id]').count(),2);
  // A pending decoder/native response cannot reopen after Activity route leave.
  await page.getByRole('button',{name:'以图搜图',exact:true}).click();
  await page.evaluate(()=>window.__appearance.hold(true));
  let prepares=await page.evaluate(()=>window.__appearance.calls.filter(r=>r.action.op==='appearancePrepare').length);
  await page.locator('.material-appearance-dialog input[type=file]').setInputFiles(path.join(root,'tests/fixtures/material-appearance/oriented-expected.png'));
  await page.waitForFunction(n=>window.__appearance.calls.filter(r=>r.action.op==='appearancePrepare').length>n,prepares);
  await page.evaluate(()=>window.__appearance.route('notes'));
  await page.evaluate(()=>{window.__appearance.hold(false);window.__appearance.resolve()});
  await page.waitForTimeout(100);
  assert.equal(await page.getByRole('dialog',{name:'以图搜图'}).count(),0);
  await page.evaluate(()=>window.__appearance.route('materials'));
  await search.waitFor();await page.waitForTimeout(100);
  assert.equal(await page.getByRole('dialog',{name:'以图搜图'}).count(),0,'hidden Activity does not resume the previous query');
  assert.equal(await page.locator('.masonry-container [data-asset-id]').count(),2);
  // Replace a held query with a new asset; the late first response is discarded.
  await page.getByRole('button',{name:'以图搜图',exact:true}).click();
  await page.evaluate(()=>window.__appearance.hold(true));
  prepares=await page.evaluate(()=>window.__appearance.calls.filter(r=>r.action.op==='appearancePrepare').length);
  await page.locator('.material-appearance-dialog input[type=file]').setInputFiles(path.join(root,'tests/fixtures/material-appearance/oriented-expected.png'));
  await page.waitForFunction(n=>window.__appearance.calls.filter(r=>r.action.op==='appearancePrepare').length>n,prepares);
  await page.evaluate(()=>{window.__appearance.hold(false);window.__appearance.drag(['blue'])});
  await page.locator('[data-material-appearance-trigger]').dispatchEvent('drop');
  await page.getByRole('img',{name:'查询图片：blue.png',exact:true}).waitFor();
  await page.getByText('找到 1 张相似图片',{exact:true}).waitFor();
  await page.evaluate(()=>window.__appearance.resolve());await page.waitForTimeout(80);
  assert.equal(await page.locator('.masonry-container [data-asset-id="red"]').count(),1);
  assert.equal(await page.locator('.masonry-container [data-asset-id="blue"]').count(),0);
  for(const width of [800,480]) {
    await page.setViewportSize({width,height:720});
    const b=await page.getByRole('dialog',{name:'以图搜图'}).boundingBox();
    assert.ok(b.x>=0&&Math.abs(width-b.x-b.width-12)<2&&b.y+b.height<=720,JSON.stringify(b));
    await page.screenshot({path:path.join(out,`r3-query-${width}-fixture.png`)});
  }
  await page.setViewportSize({width:1200,height:900});
  await page.mouse.move(0,0);
  assert.equal(await page.locator('.material-appearance-image-actions').evaluate(el=>getComputedStyle(el).opacity),'0');
  const previewBounds=await page.locator('.material-appearance-query-image').boundingBox();
  assert.ok(previewBounds.height>=250,'query image uses the large preview area');
  await page.locator('.material-appearance-image-actions').hover();
  await page.waitForTimeout(200);
  assert.equal(await page.locator('.material-appearance-image-actions').evaluate(el=>getComputedStyle(el).opacity),'1');
  await page.screenshot({path:path.join(out,'r3-feedback-hover-fixture.png')});
  await page.getByRole('button',{name:'移除查询图片',exact:true}).click();
  assert.equal(await page.getByRole('dialog',{name:'以图搜图'}).count(),1,'remove returns to empty panel, not close');
  assert.equal(await page.locator('.material-appearance-query-image').count(),0);
  await page.getByRole('button',{name:'选择图片',exact:true}).waitFor();
  assert.equal(await page.locator('.masonry-container [data-asset-id]').count(),2);
  await page.screenshot({path:path.join(out,'r3-feedback-empty-fixture.png')});
  await page.getByRole('button',{name:'关闭以图搜图',exact:true}).click();
  // Single collapsed icon; pointer and keyboard both retain library management.
  await page.evaluate(()=>document.querySelector('.sidebar').classList.add('collapsed'));
  assert.equal(await page.locator('.sidebar .material-library-menu-trigger:visible').count(),0);
  const libraryRoot=page.getByRole('button',{name:'A · 全部素材',exact:true});
  await libraryRoot.click();assert.equal(await page.evaluate(()=>window.__appearance.allClicks),1);
  await libraryRoot.click({button:'right'});await page.getByRole('menuitem',{name:'管理素材库…'}).waitFor();
  await page.keyboard.press('Escape');await libraryRoot.press('Shift+F10');await page.getByRole('menuitemradio',{name:'B',exact:true}).waitFor();
  await page.keyboard.press('Escape');
  await page.evaluate(()=>document.querySelector('.sidebar').classList.remove('collapsed'));
  await search.fill('red');await search.press('Tab');
  const global=page.locator('.search-overlay input');
  const globalTrigger=page.getByRole('searchbox',{name:'全局搜索',exact:true});
  await globalTrigger.waitFor();assert.equal(await global.count(),0,'mode shortcut only changes mode');
  await globalTrigger.press('Enter');await global.waitFor();
  assert.equal(await global.inputValue(),'red');
  await page.locator('.search-overlay').getByText('red.png',{exact:true}).waitFor();
  await page.locator('.search-overlay').getByText('red 中文知识笔记',{exact:true}).waitFor();
  // The search result update may schedule focus restoration in a layout frame.
  await global.evaluate(el=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await global.press('Shift+Tab');assert.equal(await global.evaluate(el=>el===document.activeElement),false);
  await global.focus();await global.dispatchEvent('keydown',{key:'Tab',isComposing:true});assert.equal(await global.count(),1);
  await global.fill('中文');await page.locator('.search-overlay').getByText('red 中文知识笔记',{exact:true}).waitFor();
  await global.press('Escape');await globalTrigger.waitFor();
  await page.waitForFunction(()=>document.querySelector('.titlebar-material-search input')?.value==='中文');
  await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='全局搜索');
  await globalTrigger.click();await global.waitFor();await global.press('Escape');
  await page.getByRole('button',{name:'搜索模式：全局',exact:true}).click();await search.waitFor();
  assert.ok(await page.locator('.titlebar-search-mode').evaluate(el=>el.getBoundingClientRect().width<=28),'mode switch is a compact icon target');
  assert.ok(await page.locator('.titlebar-material-search').evaluate(el=>parseFloat(getComputedStyle(el).paddingLeft)<=6),'no oversized leading search padding');
  await page.getByRole('button',{name:'搜索模式：素材',exact:true}).click();await globalTrigger.waitFor();
  assert.equal(await global.count(),0,'mode button does not open overlay');
  await globalTrigger.press('Tab');await search.waitFor();
  await page.evaluate(()=>window.__appearance.settings({'search.modeShortcutEnabled':false}));
  await search.focus();await search.press('Tab');assert.equal(await global.count(),0);assert.equal(await search.evaluate(el=>el===document.activeElement),false);
  await page.evaluate(()=>{window.__appearance.settings({'search.modeShortcutEnabled':true});window.__appearance.rebind('Alt+M')});
  await search.fill('red');await search.press('Alt+m');await globalTrigger.waitFor();assert.equal(await global.count(),0);
  await globalTrigger.press('Enter');await global.waitFor();await global.press('Alt+m');await search.waitFor();assert.equal(await search.inputValue(),'red');
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('luckyray-settings-v1-shortcuts')).searchModeToggle),'Alt+M');
  await search.fill('');await page.waitForFunction(()=>document.querySelectorAll('[data-asset-id]').length===2);
  await page.getByRole('button',{name:'切换素材库：A',exact:true}).click();
  const menuBounds=await page.getByRole('menu',{name:'切换素材库',exact:true}).boundingBox();assert.ok(menuBounds.width<250&&menuBounds.width>=160,JSON.stringify(menuBounds));
  await page.keyboard.press('Escape');

  await page.evaluate(()=>window.__appearance.many());await page.waitForFunction(()=>document.querySelectorAll('.masonry-container [data-asset-id]').length>2);
  await page.locator('[data-asset-id="red"] .batch-checkbox-react').click();
  await page.waitForFunction(()=>{const el=document.querySelector('.masonry-container');return el.scrollHeight>el.clientHeight+400});
  const scrollBefore=await page.locator('.masonry-container').evaluate(el=>{el.scrollTop=200;el.dispatchEvent(new Event('scroll',{bubbles:true}));return el.scrollTop});assert.ok(scrollBefore>0);
  await page.getByRole('button',{name:'以图搜图',exact:true}).click();
  await page.locator('.material-appearance-dialog input[type=file]').setInputFiles(path.join(root,'tests/fixtures/material-appearance/oriented-expected.png'));
  await page.locator('.material-appearance-dialog').getByText('找到 24 张相似图片',{exact:true}).waitFor();
  await page.getByRole('button',{name:'关闭以图搜图',exact:true}).click();
  await page.waitForFunction(top=>Math.abs(document.querySelector('.masonry-container').scrollTop-top)<2,scrollBefore);
  assert.ok(await page.locator('.batch-bar-react').isVisible(),'pre-query selection restored');
  await page.getByRole('button',{name:'以图搜图',exact:true}).click();
  await page.evaluate(()=>window.__appearance.hold(true));
  prepares=await page.evaluate(()=>window.__appearance.calls.filter(r=>r.action.op==='appearancePrepare').length);
  await page.locator('.material-appearance-dialog input[type=file]').setInputFiles(path.join(root,'tests/fixtures/material-appearance/oriented-expected.png'));
  await page.waitForFunction(n=>window.__appearance.calls.filter(r=>r.action.op==='appearancePrepare').length>n,prepares);
  await page.evaluate(()=>window.__appearance.select('B'));await page.waitForFunction(()=>document.querySelector('[data-asset-id="B-image"]'));
  await page.evaluate(()=>{window.__appearance.hold(false);window.__appearance.resolve()});await page.waitForTimeout(80);
  assert.equal(await page.getByRole('dialog',{name:'以图搜图'}).count(),0);
  assert.equal(await page.locator('.masonry-container [data-asset-id]').count(),1);
  assert.equal(await page.locator('.material-appearance-results').count(),0,'old library results never follow UI switch');
  await page.evaluate(()=>window.__appearance.settings({'search.modeShortcutEnabled':false}));
  await page.reload();await search.waitFor();
  await search.focus();await search.press('Alt+m');assert.equal(await search.count(),1,'disabled saved chord survives reload');
  await page.evaluate(()=>window.__appearance.settings({'search.modeShortcutEnabled':true}));
  await search.focus();await search.press('Alt+m');await globalTrigger.waitFor();assert.equal(await global.count(),0);
  assert.equal(await page.getByRole('button',{name:'搜索模式：全局'}).getAttribute('title'),'Alt+M 切换 · Esc 离开输入框 · Shift+Tab 向前导航','saved custom chord survives reload');
  // Real retained page, not just the player: leaving closes both viewer modes.
  await page.locator('[data-asset-id="red"]').hover();await page.locator('[data-asset-id="red"]').focus();await page.keyboard.press('Space');await page.locator('.material-viewer-react.preview').waitFor();
  await page.locator('.qp-close-react').focus();await page.keyboard.press('Space');await page.locator('.material-viewer-react').waitFor({state:'detached'});
  await page.locator('[data-asset-id="red"]').click();await page.locator('.material-viewer-react').waitFor();
  await page.evaluate(()=>window.__appearance.route('notes'));await page.locator('.material-viewer-react').waitFor({state:'detached'});
  await page.evaluate(()=>window.__appearance.route('materials'));assert.equal(await page.locator('.material-viewer-react').count(),0);
  await page.evaluate(()=>window.__appearance.video());await page.locator('[data-asset-id="film"]').waitFor();
  await page.locator('[data-asset-id="film"]').hover();await page.locator('[data-asset-id="film"]').focus();await page.keyboard.press('Space');await page.locator('.material-viewer-react.preview').waitFor();
  await page.keyboard.press('Space');await page.locator('.material-viewer-react').waitFor({state:'detached'});
  for(let i=0;i<3 && !(await page.locator('.workview-cycle').getAttribute('aria-label')).includes('影视');i++){
    await page.locator('.workview-cycle').click();await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  }
  assert.match(await page.locator('.workview-cycle').getAttribute('aria-label'),/影视/);
  await page.locator('[data-asset-id="film"]').click();await page.locator('.material-film').waitFor();
  await page.getByRole('button',{name:'视频信息',exact:true}).click();
  await page.locator('.material-film-info .detail-panel').waitFor();
  assert.equal(await page.locator('.material-film-info').getByText('文件信息',{exact:true}).count(),1,'real inspector, not shortcut cheat sheet');
  assert.equal(await page.locator('.material-film-info').getByText('Space / K 播放、暂停',{exact:false}).count(),0);
  const infoSize=await page.locator('.material-film-info').boundingBox();assert.ok(infoSize.width<=360&&infoSize.height<=640,'compact bounded inspector');
  assert.equal(await page.locator('.material-film-info').evaluate(e=>getComputedStyle(e).borderRadius),'12px','film-only rounded panel');
  const infoButton=await page.getByRole('button',{name:'视频信息',exact:true}).boundingBox();assert.ok(Math.abs(infoSize.y-infoButton.y-infoButton.height-4)<1,'inspector close to info button');
  assert.equal(await page.locator('.material-film-info').evaluate(e=>e.scrollWidth>e.clientWidth),false,'no horizontal overflow');
  await page.locator('.material-film-info .detail-body').evaluate(e=>Promise.all(e.getAnimations().map(a=>a.finished)));
  await page.screenshot({path:path.join(out,'film-compact-inspector-fixture.png')});
  await page.evaluate(()=>window.__appearance.route('notes'));await page.locator('.material-film').waitFor({state:'detached'});
  await page.evaluate(()=>window.__appearance.route('materials'));assert.equal(await page.locator('.material-film').count(),0);
  await page.locator('[data-asset-id="film"]').click();await page.locator('.material-film').waitFor();
  console.log('MATERIALS ROUTE EXIT PASS: real Activity ordinary and cinema portals close; return retains catalog, fresh film viewer opens.');
  assert.deepEqual(errors,[]);console.log('APPEARANCE-COMPONENT-PASS R3 single collapsed icon/context/keyboard; real global overlay material+knowledge providers/Chinese/IME/rebind/return; persistent query image/main-grid/progress/no-strip; detail/drop/file; close/remove/Escape; retained Activity/rapid query/library late-response isolation; right-edge/narrow/light-dark. Fixture native data, not actual Main acceptance.');
 } finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1});
