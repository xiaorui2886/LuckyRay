// Reproduce the viewport -> cleared cover -> masonry reflow feedback loop.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..');
const esbuild=require(require.resolve('esbuild',{paths:[fs.realpathSync(root+'/node_modules/vite')]}));
const {chromium}=require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE||'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@playwright/mcp/node_modules/playwright');
(async()=>{
 const source=process.env.NATIVE_COVER_OLD==='1'?cp.execFileSync('git',['show','e64fcf9:luckyray-app/src/features/materials/MaterialsPage.tsx'],{cwd:root,encoding:'utf8'}):fs.readFileSync(root+'/src/features/materials/MaterialsPage.tsx','utf8');
 const component=source.slice(source.indexOf('function HoverVideoPreview('),source.indexOf('\nfunction AssetColorSwatch('));
 const card=source.slice(source.indexOf('function AssetCard('),source.indexOf('\nfunction GridAssetCard('));
 const controls=source.slice(source.indexOf('function AssetHoverControls('),source.indexOf('\nfunction AssetCard('));
 const checkbox=source.slice(source.indexOf('function BatchCheckbox('),source.indexOf('// ========== 详情面板'));
 const png=fs.readFileSync(root+'/tests/fixtures/material-appearance/oriented-expected.png').toString('base64');
 const entry=`import React,{useState,useRef,useEffect}from'react';import{createRoot}from'react-dom/client';import{NativeVideoHover}from'./src/features/materials/NativeVideoHover';import{cachedNativeVideoCover,retainNativeVideoCover}from'./src/features/materials/nativeVideoCoverCache';
 const FileIcon=()=>null,useMaterialViewScope=()=>null, resolvedVideoPreviewCache=new Map(),materialLibrarySession={getSnapshot:()=>({libraryId:'fixture'})};
 const resolveMaterialVideoPlaybackPath=a=>a.originalPath,resolveVideoPreviewUrl=async()=>'',observeMaterialVideoViewport=(_,f)=>{window.viewport=f;f(true);return()=>{}};
 window.requests=0;
 const nativeVideoMetadata=async()=>({width:1440,height:3200,duration:118,codec:'hevc',sourceRevision:'fixture'}),nativeVideoThumbnail=async()=>{window.requests++;return{src:'data:image/png;base64,${png}'}};
 const useI18n=()=>({t:k=>k}),useAssetDragGesture=()=>()=>{},isVideoAsset=()=>true,isImageAsset=()=>false,handleAssetDragStart=()=>{},AssetColorSwatch=()=>null,formatSize=()=>'',getAssetKindLabel=()=> '视频',getStorageModeShortLabel=()=> '链接',FavoriteGlyph=()=>null;
 window.calls=[];let state={time:0,duration:118,paused:true,width:1440,height:3200,ended:false,seeking:false};
 window.__TAURI_INTERNALS__={invoke:async(command,{request:r})=>{window.calls.push(r);if(r.op==='capability')return{available:true,composition:'webview-alpha-v1',cardFrames:true};if(r.op==='previewFrame'){await new Promise(r=>setTimeout(r,35));return{time:state.time,src:'data:image/png;base64,${png}'}}if(r.op==='snapshot'){if(!state.paused)state.time+=.2;return{...state}}if(r.action?.op==='seek')state.time=r.action.seconds;if(r.action?.op==='play')state.paused=false;if(r.op==='close')state.paused=true;return{ok:true}}};
 ${component}
 ${controls}
 ${checkbox}
 ${card}
 function Fixture(){const[id,set]=useState('a');window.change=set;return <div id="card" style={{width:320}}><AssetCard asset={{id,name:'phone.mp4',kind:'video',originalPath:'/synthetic/'+id}} selectedIds={new Set()} onHover={()=>{}} onClick={()=>{}}/></div>};
 createRoot(document.getElementById('root')).render(<Fixture/>);`;
 const bundle=await esbuild.build({stdin:{contents:entry,loader:'tsx',resolveDir:root},bundle:true,write:false,jsx:'automatic'});
 const css=fs.readFileSync(root+'/src/features/materials/materials.css','utf8')+(process.env.NATIVE_HOVER_OLD==='1'?'.video-card-react .card-overlay{pointer-events:auto}':'');
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/test.js'?'text/javascript':'text/html;charset=utf-8');res.end(req.url==='/test.js'?bundle.outputFiles[0].text:`<style>${css}</style><div id="root"></div><script src="/test.js"></script>`)});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1100,height:1000}});
 await page.goto('http://127.0.0.1:'+server.address().port);await page.locator('#card img').waitFor();
 const height=(await page.locator('#card').boundingBox()).height;
 for(let i=0;i<12;i++){
  await page.evaluate(()=>window.viewport(false));
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  assert.equal(await page.locator('#card img').count(),1,'leaving viewport must retain decoded cover');
  assert.equal((await page.locator('#card').boundingBox()).height,height,'leaving viewport must retain masonry height');
  await page.evaluate(()=>window.viewport(true));
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 }
 assert.equal(await page.evaluate(()=>window.requests),1,'no repeated decode caused by observer churn');
 // The entire production AssetCard matters: testing just NativeVideoHover
 // misses a sibling metadata overlay that steals pointer events from the wrap.
 const box=await page.locator('#card').boundingBox();await page.mouse.move(box.x+box.width*.3,box.y+80);
 await page.waitForFunction(()=>window.calls.some(c=>c.op==='open'),{},{timeout:4000});
 await page.waitForFunction(()=>Number.parseFloat(getComputedStyle(document.querySelector('.hover-video-progress-react')).opacity)>.95);
 await page.waitForFunction(()=>window.calls.some(c=>c.action?.op==='play'));
 assert.equal(await page.locator('.card-overlay').evaluate(e=>getComputedStyle(e).visibility),'visible','browser-composited preview uses ordinary translucent metadata');
 assert.equal(await page.locator('.batch-checkbox-react').evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0.4)','same translucent control as ordinary cards');
 assert.equal(await page.locator('.asset-favorite-fab-react').evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)');
 assert.equal(await page.locator('#card img').evaluate(e=>getComputedStyle(e).opacity),'1','canvas paints above stable cover; no native background aperture');
 assert.equal(await page.locator('canvas.native-video-hover').count(),1,'scrolling picture is a real DOM child');
 const exclusions=await page.evaluate(()=>window.calls.filter(c=>c.op==='bounds').at(-1)?.bounds||window.calls.find(c=>c.op==='open').bounds);
 assert.equal(exclusions.exclude,undefined,'no staircase cutouts');
 assert.equal(await page.evaluate(()=>window.calls.find(c=>c.op==='open').preview),true);
 await page.evaluate(()=>{const root=document.getElementById('root');root.style.height='400px';root.style.overflow='auto'});
 for(let i=0;i<25;i++){
   await page.evaluate(i=>document.getElementById('root').scrollTop=i%2?180:0,i);
   const rects=await page.evaluate(()=>{const a=document.querySelector('.hover-video-wrap-react').getBoundingClientRect(),b=document.querySelector('canvas.native-video-hover').getBoundingClientRect();return[a.top,b.top,a.height,b.height]});
   assert.equal(rects[0],rects[1]);assert.equal(rects[2],rects[3]);
 }
 assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.op==='bounds').length),0,'scroll never sends asynchronous HWND position commands');
 await page.evaluate(()=>{document.getElementById('root').style.height='';document.getElementById('root').style.overflow=''});
 const progress=await page.locator('.hover-video-progress-react span').getAttribute('style');
 await page.waitForFunction(value=>document.querySelector('.hover-video-progress-react span').getAttribute('style')!==value,progress);
 await page.mouse.move(box.x+box.width*.7,box.y+80);
 await page.waitForFunction(()=>window.calls.some(c=>c.action?.op==='seek'&&c.action.seconds>80));
 await page.mouse.move(900,950);await page.waitForFunction(()=>window.calls.some(c=>c.op==='close'));
 assert.equal(await page.locator('.native-video-hover').count(),0,'leave releases decoder and native surface');
 assert.equal(await page.locator('#card img').evaluate(e=>getComputedStyle(e).opacity),'1','cover restored after native close');
 assert.equal(await page.locator('.card-overlay').evaluate(e=>getComputedStyle(e).visibility),'visible','ordinary poster metadata restored on leave');
 await page.evaluate(()=>window.change('b'));await page.waitForFunction(()=>window.requests===2);await page.locator('#card img').waitFor();
 await page.reload();await page.locator('#card img').waitFor();
 assert.equal((await page.locator('#card').boundingBox()).height,height,'restart restores final aspect immediately');
 assert.equal(await page.evaluate(()=>window.requests),0,'restart uses persisted cover, revalidates metadata without decode/black placeholder');
 console.log('NATIVE_COVER_CARD_PASS full production card HEVC hover/play/progress/seek/release, 12 viewport cycles, stable image/height, one decode, source invalidation');
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1});
