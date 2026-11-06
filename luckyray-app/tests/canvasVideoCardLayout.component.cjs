// Production CanvasVideoPreview + both real presentation components and CSS.
// Existing synthetic media only; native decoding IPC is a fixture, not GPU UAT.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),media=process.env.CANVAS_VIDEO_LAYOUT_MEDIA_DIR;
assert(media,'Set CANVAS_VIDEO_LAYOUT_MEDIA_DIR to the existing synthetic media directory');
const vp8=fs.readFileSync(path.join(media,'Static-Blue-VP8.webm'));
const esbuild=require(require.resolve('esbuild',{paths:[fs.realpathSync(root+'/node_modules/vite')]}));
const {chromium}=require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE||'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@playwright/mcp/node_modules/playwright');
const source=fs.readFileSync(path.join(root,'src/CanvasSpike.tsx'),'utf8');
const start=source.indexOf('// Hover previews stay silent.'),end=source.indexOf('\nfunction ',source.indexOf('function CanvasVideoPreview'));
assert(start>0&&end>start);
(async()=>{
 const build=await esbuild.build({stdin:{resolveDir:root,loader:'tsx',contents:`
  import React,{useRef,useState,useCallback,useEffect,useContext,createContext}from'react';import{createRoot}from'react-dom/client';
  import{CanvasVideoFrame}from'./src/features/canvas/CanvasVideoFrame';
  import{CanvasNativeVideoPreview}from'./src/features/canvas/CanvasNativeVideoPreview';
  import{I18nProvider,useI18n}from'./src/core/i18n';import './src/app/appShell.css';import './src/canvas-spike-scroll.css';
  const resolveCanvasMediaUrl=s=>s||'',comfyVideoResultName=()=>null;
  let publish,cover;function useCanvasVideoCover(){const[v,set]=useState(cover);publish=v=>{cover=v;set(v)};return v;}
  let state={width:64,height:64,duration:1,time:0,paused:true};
  window.__TAURI_INTERNALS__={invoke:async(_,args)=>{const r=args.request;
    if(r.op==='capability')return{available:true,composition:'webview-alpha-v1',cardFrames:true,comfyResults:true,comfyPreviews:true};
    if(r.action?.op==='registry')return{legacyId:'synthetic-catalog'};
    if(r.op==='metadata')return{...state,sourceRevision:'synthetic'};
    if(r.op==='snapshot')return{...state};
    if(r.op==='previewFrame')return{time:state.time,src:cover.src};
    if(r.op==='control'){if(r.action.op==='play')state.paused=false;if(r.action.op==='pause')state.paused=true;if(r.action.op==='seek')state.time=r.action.seconds;}
    return{ok:true};}};
  ${source.slice(start,end)}
  const app=createRoot(document.getElementById('root'));
  window.draw=(kind='browser')=>{cover=undefined;state={width:64,height:64,duration:1,time:0,paused:true};app.render(<I18nProvider locale="zh-CN"><div className="canvas-editor-stage react-flow" style={{position:'fixed',inset:0,width:'100%',height:'100%'}}><div className="react-flow__viewport"><div key={kind} id="video-node" className="react-flow__node" style={{position:'absolute',left:30,top:30,zIndex:2}}><div className="canvas-node-card canvas-node-video"><CanvasVideoPreview source="/tiny.webm" assetId="synthetic-video" selected={false}/></div></div></div></div><div id="neighbour" style={{position:'fixed',left:30,top:400,width:300,height:170}}>next card</div></I18nProvider>)};
  window.installCover=()=>publish({width:64,height:64,duration:1,src:"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='420' height='420'%3E%3Crect width='420' height='420' fill='royalblue'/%3E%3C/svg%3E"});
  window.forceNative=()=>document.querySelector('video').dispatchEvent(new Event('error'));
 `},bundle:true,write:false,outfile:'app.js',jsx:'automatic',loader:{'.svg':'dataurl'}});
 const js=build.outputFiles.find(f=>f.path.endsWith('.js')).text,css=build.outputFiles.find(f=>f.path.endsWith('.css')).text;
 const server=http.createServer((req,res)=>{if(req.url==='/tiny.webm'){res.setHeader('Content-Type','video/webm');res.end(vp8);return;}res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript':'text/html;charset=utf-8');res.end(req.url==='/app.js'?js:`<meta charset="utf-8"><style>${css}body{margin:0;background:#111;color:white}</style><div id="root"></div><script src="/app.js"></script>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
  browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1000,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port);await page.evaluate(()=>window.draw());
  await page.waitForFunction(()=>document.querySelector('video')?.videoWidth===64&&document.querySelector('.canvas-video-preview')?.style.getPropertyValue('--canvas-video-width')==='64px');
  const shell=page.locator('.canvas-video-preview'),before=await shell.boundingBox(),neighbour=await page.locator('#neighbour').boundingBox();
  assert.equal(before.width,64);assert.equal(before.height,64);
  // A later large poster must not become the intrinsic size of a tiny video.
  await page.evaluate(()=>window.installCover());await page.waitForFunction(()=>document.querySelector('video')?.poster.startsWith('data:image/svg+xml,'));
  await page.waitForTimeout(80);assert.deepEqual(await shell.boundingBox(),before,'asynchronous 420px cover cannot expand a 64px video');
  const styles=()=>shell.evaluate(el=>({box:[el.clientWidth,el.clientHeight],radius:getComputedStyle(el).borderRadius,controls:[...el.querySelectorAll('.canvas-video-controls,.canvas-video-control-row,button,.canvas-video-progress,.canvas-video-time')].map(c=>({tag:c.tagName,cls:c.className,css:['backgroundImage','backgroundColor','fontSize','padding','gridTemplateColumns','borderRadius'].map(k=>getComputedStyle(c)[k])}))}));
  const browserStyles=await styles();
  await page.evaluate(()=>window.forceNative());await page.locator('.canvas-native-video').waitFor();
  assert.deepEqual(await shell.boundingBox(),before,'decoder change retains actual media geometry, not a browser loading placeholder');
  assert.deepEqual(await styles(),browserStyles,'browser and native playback must share the exact same visible controls and card styles');
  assert.deepEqual(await page.locator('#neighbour').boundingBox(),neighbour);
  assert.equal(await shell.locator('.canvas-native-video-surface').innerText(),'','a loaded cover has no extra play-video placeholder text');
  assert.equal(await shell.locator('.canvas-video-time').textContent(),'0:00 / 0:01');
  await shell.getByRole('button',{name:'播放视频',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.canvas-native-video')?.classList.contains('is-playing'));
  assert.deepEqual(await shell.boundingBox(),before,'playback activation does not expand the card');
  const picture=await shell.locator('.canvas-native-video-surface').boundingBox();assert.deepEqual(picture,before,'the picture fills the card without added letterbox bands');
  const progress=await shell.locator('.canvas-video-progress').boundingBox();
  const points=[{x:before.x+before.width/2,y:before.y+before.height/3},{x:progress.x+progress.width/2,y:progress.y+progress.height/2}];
  // Use material image/video and generated-card structures, with the actual
  // production CSS: the picture AND its controls must obey one stacking order.
  for(const kind of ['image','video','generator']){
   await page.evaluate(({kind,box})=>{
    const other=document.createElement('div');other.id='overlap';other.className='react-flow__node';
    other.style.cssText=`position:absolute;left:${box.x+6}px;top:${box.y+6}px;width:64px;height:64px;z-index:3`;
    const card=document.createElement('div');card.className=`canvas-node-card canvas-node-${kind}`;
    card.style.cssText='width:64px;height:64px';
    const media=document.createElement(kind==='video'?'video':'img');media.className='canvas-node-media';
    const poster="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'%3E%3Crect width='64' height='64' fill='tomato'/%3E%3C/svg%3E";
    if(kind==='video'){media.poster=poster;media.src='/tiny.webm';media.preload='none';media.muted=true;}else media.src=poster;
    media.style.cssText='display:block;width:64px;height:64px;object-fit:cover';
    card.append(media);other.append(card);document.querySelector('.react-flow__viewport').append(other);
   },{kind,box:before});
   await page.waitForFunction(()=>document.querySelector('.canvas-native-video-surface').dataset.nativeVideoLive==='false');
   assert.equal(await shell.locator('img').evaluate(e=>getComputedStyle(e).visibility),'visible',kind+': overlap shows the decoded DOM picture');
   for(const point of points)assert.equal(await page.evaluate(p=>document.elementFromPoint(p.x,p.y)?.closest('.react-flow__node')?.id,point),'overlap',kind+': front card covers picture and timeline together');
   await page.evaluate(()=>document.querySelector('#overlap').style.zIndex='1');await page.waitForTimeout(80);
   for(const point of points)assert.equal(await page.evaluate(p=>document.elementFromPoint(p.x,p.y)?.closest('.react-flow__node')?.id,point),'video-node',kind+': video picture and timeline both cover the lower card');
   assert.equal(await shell.locator('.canvas-native-video-surface').getAttribute('data-native-video-live'),'false',kind+': either overlap order uses one compositor');
   if(process.env.CANVAS_VIDEO_LAYOUT_EVIDENCE_DIR){fs.mkdirSync(process.env.CANVAS_VIDEO_LAYOUT_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.CANVAS_VIDEO_LAYOUT_EVIDENCE_DIR,`overlap-${kind}-dom-stacking.png`)});}
   await page.evaluate(()=>document.querySelector('#overlap').remove());
   await page.waitForFunction(()=>document.querySelector('.canvas-native-video-surface').dataset.nativeVideoLive==='true');
   assert.deepEqual(await shell.boundingBox(),before,kind+': stack changes never resize or reposition the video');
  }
  assert.deepEqual(errors,[]);console.log('PASS: real browser VP8 metadata + late oversized cover + native switch share geometry/styles; material image/video and generated-card overlap orders cover picture/timeline together; transport IPC synthetic, codec/audio UAT not claimed');
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
