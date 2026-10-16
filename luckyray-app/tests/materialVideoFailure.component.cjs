// Production components/CSS; synthetic media events, not a codec-support claim.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const esbuild = require(require.resolve('esbuild', { paths: [fs.realpathSync(root + '/node_modules/vite')] }));
const { chromium } = require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE || 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@playwright/mcp/node_modules/playwright');
(async () => {
  const source = fs.readFileSync(root + '/src/features/materials/MaterialsPage.tsx', 'utf8');
  const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
  const script = await esbuild.build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
    import React,{useState,useEffect,useLayoutEffect,useRef} from 'react';import{createRoot}from'react-dom/client';import{createPortal}from'react-dom';
    import {NativeVideoInline} from './src/features/materials/NativeVideoInline';
    import {matchesShortcut,isTextEntry} from './src/app/shortcuts';
    import {NativeVideoHover} from './src/features/materials/NativeVideoHover';
    import {useMaterialViewerHost} from './src/features/materials/useMaterialViewerHost';
    import {useMaterialViewScope} from './src/features/materials/MaterialViewContext';
    import {resolveMaterialViewerBounds} from './src/features/materials/materialViewerGeometry';
    import {materialLibrarySession} from './src/core/services/materialLibraryContext';
    import {nativeVideoMetadata,nativeVideoThumbnail} from './src/features/materials/nativeVideoPreview';
    import {cachedNativeVideoCover,retainNativeVideoCover} from './src/features/materials/nativeVideoCoverCache';
    import {resolveContainedMaterialMediaRect,resolveMaterialMediaDimensions,resolveMaterialVideoPlaybackPath,resolveMaterialVideoSource,shouldDismissMaterialViewerFromBlank} from './src/features/materials/materialViewerInteraction';
    const useI18n=()=>({t:key=>key}), FileIcon=()=> <span>video</span>, ImagePreview=()=>null;
    const resolvedVideoPreviewCache=new Map(), observeMaterialVideoViewport=(_,fn)=>{fn(true);return()=>{}}, resolveVideoPreviewUrl=async(asset)=>'/media-'+asset.id;
    const isVideoAsset=()=>true,isImageAsset=()=>false,getAdjacentAsset=()=>null;
    ${extract('function HoverVideoPreview(', '\nfunction AssetColorSwatch(')}
    ${extract('function MaterialViewer(', '\nfunction ImportProgressOverlay(')}
    function Fixture(){const[id,setId]=useState('one');window.changeVideo=setId;const asset={id,name:id+'.mp4',originalPath:'/fixture/'+id,mimeType:'video/mp4'};
    return <><div id="card"><HoverVideoPreview asset={asset} className="asset-video-thumb-react" preserveAspectRatio/></div><MaterialViewer asset={asset} assets={[asset]} mode="detail" onChange={()=>{}} onClose={()=>{}} onOpenOriginal={()=>{}}/></>}
    createRoot(document.getElementById('root')).render(<Fixture/>);
  ` }, bundle: true, write: false, outfile: 'app.js', format: 'iife', jsx: 'automatic' });
  const css = fs.readFileSync(root + '/src/features/materials/materials.css','utf8');
  const server = http.createServer((req,res) => {
    if(req.url.startsWith('/media-')) {res.writeHead(204);res.end();return;}
    res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript':'text/html;charset=utf-8');
    res.end(req.url==='/app.js'?script.outputFiles[0].text:`<meta charset="utf-8"><style>${css}body{background:#111;color:#ddd}#card{width:320px}.material-viewer-react{top:280px!important;height:400px!important}</style><div id="root"></div><script src="/app.js"></script>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser = await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.waitForFunction(()=>document.querySelectorAll('video').length===2);
    assert((await page.locator('#card').boundingBox()).height>=200,'missing metadata card retains useful height');
    await page.locator('video').evaluateAll(videos=>videos.forEach(v=>v.dispatchEvent(new Event('loadeddata'))));
    await page.getByText('当前播放器无法预览此视频',{exact:true}).waitFor();
    await page.locator('.material-video-unavailable').waitFor();
    assert.equal(await page.locator('#card video.ready').count(),0,'zero-dimension loadeddata never hides fallback');
    await page.evaluate(()=>window.changeVideo('two'));
    await page.waitForFunction(()=>[...document.querySelectorAll('video')].every(v=>v.src.endsWith('/media-two')));
    // Wait for the fixture's intentionally empty media response before injecting
    // a successful decoder event; a late real 204 error must not race this step.
    await page.waitForFunction(()=>[...document.querySelectorAll('video')].every(v=>v.error));
    // A valid new source must recover even after the previous source failed.
    await page.locator('video').evaluateAll(videos=>videos.forEach(v=>{Object.defineProperty(v,'videoWidth',{configurable:true,value:640});Object.defineProperty(v,'videoHeight',{configurable:true,value:360});v.dispatchEvent(new Event('loadedmetadata'));v.dispatchEvent(new Event('loadeddata'));}));
    await page.waitForFunction(()=>document.querySelector('#card video.ready')&&!document.querySelector('.material-video-unavailable'));
    assert(Math.abs((await page.locator('#card').boundingBox()).height-180)<2,'decoded dimensions restore intrinsic aspect');
    await page.locator('video').evaluateAll(videos=>videos.forEach(v=>v.dispatchEvent(new Event('error'))));
    await page.locator('.material-video-unavailable').waitFor();
    assert.equal(await page.locator('#card video.ready').count(),0);
    assert.deepEqual(errors,[]);
    console.log('PASS: production video card/quick-view zero-dimension and error feedback, stable fallback height, new source recovery; synthetic media events only');
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
