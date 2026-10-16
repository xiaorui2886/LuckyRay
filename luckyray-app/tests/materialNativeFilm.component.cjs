// Production React/native transport; simulated native IPC, NOT real decoder UAT.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const esbuild=require(require.resolve('esbuild',{paths:[fs.realpathSync(root+'/node_modules/vite')]}));
const {chromium}=require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE||'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@playwright/mcp/node_modules/playwright');
const png=fs.readFileSync(path.join(root,'tests/fixtures/material-appearance/oriented-expected.png')).toString('base64');
const pageSource=fs.readFileSync(root+'/src/features/materials/MaterialsPage.tsx','utf8');
const viewer=pageSource.slice(pageSource.indexOf('function MaterialViewer('),pageSource.indexOf('\nfunction ImportProgressOverlay('));
const entry=`
import './src/app/appShell.css';import './src/features/materials/materials.css';
import{NativeVideoHover}from'./src/features/materials/NativeVideoHover';
import{cachedNativeVideoCover}from'./src/features/materials/nativeVideoCoverCache';
import React,{useState,useRef,useEffect,useLayoutEffect} from 'react';import{createRoot}from'react-dom/client';import{createPortal}from'react-dom';import{MaterialFilmViewer}from'./src/features/materials/MaterialFilmViewer';import{NativeVideoInline}from'./src/features/materials/NativeVideoInline';
import{matchesShortcut,isTextEntry}from'./src/app/shortcuts';
import{useMaterialViewerHost}from'./src/features/materials/useMaterialViewerHost';
import{useMaterialViewScope,MaterialViewProvider}from'./src/features/materials/MaterialViewContext';
import{resolveMaterialViewerBounds}from'./src/features/materials/materialViewerGeometry';
import{resolveContainedMaterialMediaRect,resolveMaterialMediaDimensions,resolveMaterialVideoPlaybackPath,resolveMaterialVideoSource,shouldDismissMaterialViewerFromBlank}from'./src/features/materials/materialViewerInteraction';
const useI18n=()=>({t:k=>k}),FileIcon=()=>null,ImagePreview=()=>null,isVideoAsset=()=>true,isImageAsset=()=>false,getAdjacentAsset=()=>null,resolveVideoPreviewUrl=async()=>'/must-not-mount.mp4';
${viewer}
const calls=[],marks=[];let session=null,state={time:0,duration:10,width:1920,height:1080,paused:true,seeking:false,ended:false,configured:true},range=null;
window.fixture={calls,marks,state,delay:0,rejectSnapshot:0};
window.__TAURI_INTERNALS__={invoke:async(command,{request:r})=>{
 calls.push({command,...r});
 if(command==='material_video_preview_command'){
  if(r.op==='metadata')return{width:1920,height:1080,duration:10,codec:'fixture',sourceRevision:'revision'};
  if(r.op==='thumbnail')return{time:r.seconds,src:'data:image/png;base64,${png}'};
  return{};
 }
 if(command==='material_library_command'){
  const a=r.action;if(a.op==='videoMarks')return{sourceRevision:'revision',marks:[...marks]};
  if(a.op==='videoMarkSave'){marks.push(a.mark);return null}
  if(a.op==='videoFrame')return{assets:[{id:'frame',name:'frame.png'}],failedItems:[],skippedDuplicateCount:0};
  return null;
 }
 if(r.op==='capability'){if(window.fixture.openDelay)await new Promise(r=>setTimeout(r,window.fixture.openDelay));return{available:true,composition:'webview-alpha-v1',cardFrames:true};}
 if(r.op==='previewFrame')return{time:state.time,src:'data:image/png;base64,${png}'};
 if(r.op==='open'){if(window.fixture.openDelay)await new Promise(r=>setTimeout(r,window.fixture.openDelay));session=r.session;state.time=0;state.paused=true;return{ok:true};}
 if(r.op==='close'){if(session===r.session)session=null;return{ok:true};}
 if(session!==r.session)throw Error('native-video-session-closed');
 if(r.op==='snapshot'){if(window.fixture.rejectSnapshot-->0)throw Error('native-video-busy');return{...state};}
 if(r.op==='capture'){state.paused=true;return{time:state.time,png:'${png}'};}
 if(r.op==='control'){
  if(window.fixture.delay)await new Promise(resolve=>setTimeout(resolve,window.fixture.delay));
  const a=r.action;if(a.op==='play'){range=a.range;if(range&&(state.time<range.start||state.time>=range.end))state.time=range.start;state.paused=false;}
  if(a.op==='pause')state.paused=true;if(a.op==='seek'){state.time=a.seconds;range=null;}
  if(a.op==='clearRange')range=null;if(a.op==='loop'&&range)range.looping=a.enabled;
 }return{ok:true};
}};
setInterval(()=>{if(!state.paused){state.time+=.02;if(range&&state.time>=range.end){if(range.looping)state.time=range.start;else{state.time=range.end;state.paused=true;range=null}}}},20);
const host=createRoot(document.getElementById('root'));
function open(id='a',library='A',visible=true){host.render(<React.Activity mode={visible?'visible':'hidden'}><MaterialFilmViewer key={id+library} asset={{id,name:id+'.mp4',mimeType:'video/mp4',thumbnailUrl:'data:image/png;base64,${png}'}} libraryId={library} resolveSource={async()=>''} onClose={()=>host.render(<p>closed</p>)} onFrame={()=>{}}/></React.Activity>)}
window.fixture.inline=()=>host.render(createPortal(<div className="material-viewer-react"><NativeVideoInline libraryId="ordinary-library" assetId="ordinary-video" style={{width:800,height:450}} onClaim={v=>window.fixture.claimed=v} onDimensions={(w,h)=>window.fixture.dimensions=[w,h]}/></div>,document.body));
window.fixture.close=()=>host.render(<p>closed</p>);
window.fixture.workspaceInline=(visible=true)=>host.render(<MaterialViewProvider identity={{viewId:'ordinary-pane',libraryId:'ordinary-library',visible,focused:visible}}><NativeVideoInline libraryId="ordinary-library" assetId="ordinary-video" style={{width:800,height:450}} onClaim={()=>{}} onDimensions={()=>{}}/></MaterialViewProvider>);
window.fixture.preview=()=>host.render(<MaterialViewer asset={{id:'p',name:'p.mp4',originalPath:'/fixture/p',thumbnailUrl:'data:image/png;base64,${png}'}} libraryId="P" assets={[]} mode="preview" onClose={()=>host.render(<p>closed</p>)} onChange={()=>{}} onOpenOriginal={()=>{}}/>);
window.fixture.hover=(ratio=.2,serial=0)=>host.render(<div style={{position:'relative',width:320,height:400}}><NativeVideoHover libraryId="H" assetId="hevc-phone" metadata={{width:1440,height:3200,duration:10,codec:'hevc',sourceRevision:'hover-revision'}} position={{ratio,serial}} onProgress={r=>window.fixture.progress=r}/></div>);
window.fixture.open=open;open();
`;
(async()=>{
 const bundle=await esbuild.build({stdin:{contents:entry,loader:'tsx',resolveDir:root},bundle:true,write:false,outfile:'bundle.js',jsx:'automatic',loader:{'.svg':'dataurl'}});
 const js=bundle.outputFiles.find(f=>f.path.endsWith('.js')).text,css=bundle.outputFiles.find(f=>f.path.endsWith('.css')).text;
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript':'text/html;charset=utf-8');res.end(req.url==='/bundle.js'?js:'<html><style>'+css+'body{margin:0;background:#151515;color:white;--bg-primary:#151515}</style><div id="root"></div><script src="/bundle.js"></script></html>')});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
  browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1100,height:750}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port);await page.locator('.material-film-native').waitFor();
  await page.waitForFunction(()=>window.fixture.calls.some(c=>c.op==='bounds'));
  assert.deepEqual(await page.locator('.material-film-topbar').evaluate(e=>{const s=getComputedStyle(e);return[s.opacity,s.backgroundColor,s.backgroundImage]}),['1','rgba(0, 0, 0, 0)','none'],'transparent permanent header without pointer hover');
  const nativeBounds=await page.evaluate(()=>window.fixture.calls.filter(c=>c.op==='bounds').at(-1).bounds);
  assert.equal(nativeBounds.exclude,undefined,'HTML chrome uses real alpha, not binary native cutouts');
  assert.equal(await page.locator('.material-film-topbar button').first().evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)');
  assert.equal(await page.locator('video').count(),0,'one decoder: no HTML video under native surface');
  assert.equal(await page.locator('#root').evaluate(e=>e.style.clipPath),'','native playback must never clip the app root');
  assert.ok(await page.locator('body').evaluate(e=>e.style.backgroundImage.includes('data:image/svg+xml')),'background paint alone opens the viewport');
  for(let i=0;i<8;i++){
   await page.getByRole('button',{name:'切换时间线样式'}).click();
   await page.setViewportSize({width:1100-i*10,height:750-i*5});
   assert.equal(await page.locator('#root').evaluate(e=>e.style.clipPath),'');
   const rect=await page.locator('.material-film-stage').boundingBox();
   await page.waitForFunction(r=>{const b=window.fixture.calls.filter(c=>c.op==='bounds').at(-1)?.bounds;return b&&Math.abs(b.height-r.height)<2},rect);
  }
  await page.getByRole('button',{name:'播放',exact:true}).click();await page.waitForFunction(()=>window.fixture.state.time>.1);
  await page.keyboard.press('Space');await page.waitForFunction(()=>window.fixture.state.paused);
  await page.getByRole('button',{name:'标记',exact:true}).click();await page.keyboard.press('Space');await page.waitForFunction(()=>!window.fixture.state.paused);
  await page.keyboard.press('Space');await page.waitForFunction(()=>window.fixture.state.paused);
  assert.equal(await page.evaluate(()=>window.fixture.marks.length),1,'Space did not click marker twice');
  assert.equal(await page.locator('.material-film-topbar button').first().evaluate(e=>getComputedStyle(e).pointerEvents),'auto');
  const seek=async seconds=>{await page.getByRole('button',{name:'定位到时间'}).click();await page.getByRole('textbox',{name:'定位时间'}).fill(String(seconds));await page.getByRole('textbox',{name:'定位时间'}).press('Enter');await page.waitForFunction(s=>window.fixture.state.time===s,seconds)};
  await seek(1);await page.keyboard.press('i');await seek(2);await page.keyboard.press('o');
  await page.getByRole('button',{name:'保存片段标记'}).click();await page.locator('.material-film-marks .range').click();
  await page.getByRole('button',{name:'循环播放'}).click();assert.equal(await page.evaluate(()=>window.fixture.state.paused),true);
  await page.keyboard.press('Space');await page.waitForFunction(()=>!window.fixture.state.paused);
  const slider=await page.getByRole('slider',{name:'视频时间线'}).boundingBox();await page.mouse.click(slider.x+slider.width*.7,slider.y+slider.height/2);
  assert.equal(await page.locator('.material-film-note').count(),0);await page.waitForFunction(()=>window.fixture.state.time>=7);
  await page.getByRole('button',{name:'截帧',exact:true}).click();await page.getByText('已保存截帧',{exact:true}).waitFor();
  assert.ok(await page.evaluate(()=>window.fixture.calls.some(c=>c.action?.op==='videoFrame'&&c.libraryId==='A'&&c.action.time>=7)));
  // A deliberately slow host, actual pointer-move path, not adjacent setter calls.
  await page.evaluate(()=>{window.fixture.delay=35;window.fixture.rejectSnapshot=1});
  const drag=await page.getByRole('slider',{name:'视频时间线'}).boundingBox();
  await page.mouse.move(drag.x+10,drag.y+drag.height/2);await page.mouse.down();
  await page.evaluate(()=>{const e=document.querySelector('.material-film-seek'),r=e.getBoundingClientRect();for(let i=0;i<400;i++)e.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:1,clientX:r.x+r.width*(i%2?.8:.2),clientY:r.y+2}));});
  await page.mouse.move(drag.x+drag.width*.4,drag.y+drag.height/2);await page.mouse.up();
  await page.waitForFunction(()=>Math.abs(window.fixture.state.time-4)<.05);
  await page.keyboard.press('Space');await page.waitForFunction(()=>!window.fixture.state.paused);
  await page.getByRole('button',{name:'暂停',exact:true}).waitFor();
  await page.keyboard.press('Space');await page.waitForFunction(()=>window.fixture.state.paused);
  assert.equal(await page.getByText(/command-queue-full|会话已停止|session-closed/).count(),0);
  await page.evaluate(()=>window.fixture.delay=0);
  await page.getByRole('button',{name:'切换全屏'}).click();await page.waitForFunction(()=>Boolean(document.fullscreenElement));await page.keyboard.press('Escape');
  await page.evaluate(()=>window.fixture.open('b','B'));await page.waitForFunction(()=>window.fixture.calls.filter(c=>c.op==='open').length===2);
  const tokens=await page.evaluate(()=>window.fixture.calls.filter(c=>c.op==='open').map(c=>c.session));assert.notEqual(tokens[0],tokens[1]);
  await page.getByRole('button',{name:'返回素材库'}).click();await page.getByText('closed',{exact:true}).waitFor();
  await page.waitForFunction(()=>window.fixture.calls.some(c=>c.op==='close'&&c.session===window.fixture.calls.filter(x=>x.op==='open').at(-1).session));
  assert.equal(await page.locator('#root').evaluate(e=>e.style.clipPath),'');assert.equal(await page.locator('html').evaluate(e=>e.classList.contains('native-film-active')),false);
  await page.evaluate(()=>window.fixture.inline());await page.locator('.native-video-inline.ready').waitFor();
  await page.waitForFunction(()=>!window.fixture.state.paused);
  assert.deepEqual(await page.evaluate(()=>window.fixture.dimensions),[1920,1080]);
  assert.ok(await page.evaluate(()=>window.fixture.calls.some(c=>c.op==='open'&&c.libraryId==='ordinary-library'&&c.assetId==='ordinary-video')));
  await page.getByRole('button',{name:'取消静音',exact:true}).click();await page.keyboard.press('Space');
  await page.waitForFunction(()=>window.fixture.state.paused);
  await page.getByRole('slider',{name:'视频预览时间线'}).press('End');await page.waitForFunction(()=>window.fixture.state.time===10);
  await page.evaluate(()=>window.fixture.close());await page.waitForFunction(()=>window.fixture.calls.at(-1).op==='close');
  assert.equal(await page.locator('#root').evaluate(e=>e.style.clipPath),'');
  assert.equal(await page.locator('html').evaluate(e=>e.classList.contains('native-inline-active')),false);
  const inspector=await page.evaluate(()=>{
   const measure=cls=>{const shell=document.createElement('div');shell.className=cls;shell.style.cssText='width:340px;height:400px;position:fixed;left:0;top:0';shell.innerHTML='<div class="detail-section inspector-section-react"><input class="detail-input-react" value="A long media title"><textarea class="detail-textarea-react">Description</textarea></div>';document.body.append(shell);const input=shell.querySelector('input'),s=getComputedStyle(input),result={box:s.boxSizing,bg:s.backgroundColor,border:s.borderTopWidth,font:s.fontSize,overflow:shell.scrollWidth>shell.clientWidth};shell.remove();return result};return{original:measure('react-nav-shell'),portal:measure('material-viewer-react'),film:measure('material-film-info')};
  });
  assert.deepEqual(inspector.portal,inspector.original,'portaled inspector retains original shell presentation and sizing');
  assert.deepEqual(inspector.film,{...inspector.original,font:'12px'},'compact film inspector retains reset/theme with its explicit smaller font');
  await page.evaluate(()=>window.fixture.open('retained','R'));await page.locator('.material-film-native').waitFor();
  await page.evaluate(()=>window.fixture.open('retained','R',false));
  await page.waitForFunction(()=>window.fixture.calls.at(-1)?.op==='close');
  assert.equal(await page.locator('.material-film').count(),0,'retained hidden route must detach its body portal');
  const beforeBounds=await page.evaluate(()=>window.fixture.calls.filter(c=>c.op==='bounds').length);
  await page.evaluate(()=>window.fixture.open('retained','R',true));await page.locator('.material-film-native').waitFor();
  await page.waitForFunction(n=>window.fixture.calls.filter(c=>c.op==='bounds').length>n,beforeBounds);
  await page.evaluate(()=>window.fixture.close());
  await page.evaluate(()=>window.fixture.hover());
  await page.waitForFunction(()=>window.fixture.calls.some(c=>c.op==='open'&&c.assetId==='hevc-phone'));
  await page.waitForFunction(()=>window.fixture.progress>.2);
  await page.evaluate(()=>window.fixture.hover(.8,1));
  await page.waitForFunction(()=>window.fixture.state.time>=8);
  await page.evaluate(()=>window.dispatchEvent(new Event('luckyray:material-viewer-opening')));
  await page.waitForFunction(()=>window.fixture.calls.at(-1)?.op==='close');
  await page.evaluate(()=>window.fixture.close());
  await page.evaluate(()=>window.fixture.preview());await page.locator('.native-video-inline.ready').waitFor();
  await page.getByRole('button',{name:'取消静音',exact:true}).focus();
  const playCommands=await page.evaluate(()=>window.fixture.calls.filter(c=>c.action?.op==='play').length);
  await page.keyboard.press('Space');await page.locator('.material-viewer-react').waitFor({state:'detached'});
  await page.waitForFunction(()=>window.fixture.calls.at(-1)?.op==='close');
  assert.equal(await page.evaluate(()=>window.fixture.calls.filter(c=>c.action?.op==='play').length),playCommands,'preview close wins over focused native control');
  await page.evaluate(()=>window.fixture.preview());await page.locator('.native-video-inline.ready').waitFor();
  await page.getByRole('slider',{name:'视频预览时间线'}).focus();await page.keyboard.press('Space');
  await page.locator('.material-viewer-react').waitFor({state:'detached'});
  await page.waitForFunction(()=>window.fixture.calls.at(-1)?.op==='close');
  console.log('NATIVE QUICK PREVIEW SPACE PASS: modal-level close, even with native control focus, decoder released without extra play');
  for(const kind of ['film','preview','film','preview']){
    await page.evaluate(kind=>{window.fixture.openDelay=220;kind==='film'?window.fixture.open('delayed','D'):window.fixture.preview()},kind);
    await page.waitForTimeout(120);
    assert.equal(await page.locator('video').count(),0,'no temporary HTML decoder before native capability');
    assert.equal(await page.locator(kind==='film'?'.material-film-stage>img':'.native-video-inline-picture>img').count(),1,'cover remains during opening');
    assert(!await page.locator('body').innerText().then(t=>t.includes('正在打开')),'no cover -> loading text flash');
    await page.locator(kind==='film'?'.material-film-native':'.native-video-inline.ready').waitFor();
    await page.evaluate(()=>window.fixture.close());
    await page.waitForFunction(()=>window.fixture.calls.at(-1)?.op==='close');
  }
  console.log('OPENING_TRANSITION_PASS delayed capability/open repeated4: stable poster, no temporary HTML player or loading-text flash');
  console.log('RETAINED ROUTE AND NATIVE HOVER PASS: hidden body portal detached; resumed session gets bounds; HEVC hover muted playback, pointer seek and viewer-opening release.');
  console.log('NATIVE REGRESSION PASS: 400 pointer moves with 35ms IPC, transient snapshot recovery, Space and decoder state agree, portaled inspector computed-style parity.');
  await page.evaluate(()=>{window.fixture.openDelay=0;window.fixture.workspaceInline()});
  await page.locator('.native-video-inline.ready').waitFor();
  await page.getByRole('slider',{name:'视频预览时间线'}).fill('4');
  await page.waitForFunction(()=>window.fixture.state.time>=4);
  await page.evaluate(()=>window.fixture.workspaceInline(false));
  await page.waitForFunction(()=>window.fixture.calls.at(-1)?.op==='close');
  const hiddenCalls=await page.evaluate(()=>window.fixture.calls.length);await page.waitForTimeout(300);
  assert.equal(await page.evaluate(()=>window.fixture.calls.length),hiddenCalls,'hidden workspace native player stops polling');
  await page.evaluate(()=>window.fixture.workspaceInline(true));await page.locator('.native-video-inline.ready').waitFor();
  await page.waitForFunction(()=>window.fixture.state.time>=4&&window.fixture.state.paused);
  await page.evaluate(()=>window.fixture.close());await page.waitForFunction(()=>window.fixture.calls.at(-1)?.op==='close');
  console.log('WORKSPACE HIDDEN PLAYER PASS: releases native session, stops polling, restores time paused');
  assert.deepEqual(errors,[]);console.log('NATIVE FILM COMPONENT PASS: scoped open/close, alpha background restoration, Space after controls, selected range exit, current-frame import, DOM fullscreen/cleanup, asset/library switch. Native IPC simulated; decoder proof separate.');
  console.log('NATIVE ORDINARY PREVIEW PASS: same scoped player, native dimensions, autoplay/mute/Space, seek-to-end and session cleanup; no app-root clipping. IPC fixture only.');
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1});
