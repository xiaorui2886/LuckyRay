// Real production components/CSS in Chromium; native IPC is synthetic, not codec UAT.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const esbuild = require(require.resolve('esbuild', {paths: [fs.realpathSync(root + '/node_modules/vite')]}));
const {chromium} = require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE || 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@playwright/mcp/node_modules/playwright');
(async () => {
  const built = await esbuild.build({stdin: {resolveDir: root, loader: 'tsx', contents: `
    import React from 'react';import{createRoot}from'react-dom/client';
    import{NativeVideoInline}from'./src/features/materials/NativeVideoInline';
    import{CanvasNativeVideoPreview}from'./src/features/canvas/CanvasNativeVideoPreview';
    import{I18nProvider}from'./src/core/i18n';
    import './src/app/appShell.css';import './src/canvas-spike-scroll.css';
    let state={time:0,duration:1,width:64,height:64,paused:true};
    window.__TAURI_INTERNALS__={invoke:async(_,args)=>{
      const r=args.request;if(r.op==='capability')return{available:true,composition:'webview-alpha-v1',cardFrames:true,comfyResults:true,comfyPreviews:true};
      if(r.op==='metadata')return{...state,sourceRevision:'synthetic-revision'};
      if(r.op==='snapshot')return{...state};
      if(r.op==='previewFrame')return{time:state.time,src:"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"};
      if(r.op==='control'){if(r.action.op==='play')state.paused=false;if(r.action.op==='pause')state.paused=true;if(r.action.op==='seek')state.time=r.action.seconds;}
      return{ok:true};
    }};
    const app=createRoot(document.getElementById('root'));
    window.draw=(kind,width,media={width:608,height:352,duration:4.5})=>{state.width=kind==='fixed'?1216:64;state.height=kind==='fixed'?704:64;state.paused=true;app.render(<I18nProvider locale="zh-CN"><div key={kind+width+media.width+media.height} style={{position:'fixed',left:20,top:20,width,height:width}}>
      {kind==='fixed'?<><div className="canvas-node-card canvas-node-video"><CanvasNativeVideoPreview resultName={'comfy-'+'b'.repeat(64)+'.mp4'} metadata={media} selected={false} visible={true} onAudioClaim={()=>{}}/></div><div id="next-video-card" style={{width:560,height:325,marginTop:18,background:'#333'}}>next video</div></>
      :kind==='asset'?<div className="canvas-node-card canvas-node-video"><CanvasNativeVideoPreview assetId="synthetic-h3" metadata={media} selected={false} visible={true} onAudioClaim={()=>{}}/></div>
      :kind==='canvas'?<CanvasNativeVideoPreview resultName={'comfy-'+'a'.repeat(64)+'.mp4'} poster="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E" metadata={{width:64,height:64,duration:1}} selected={false} visible={true} onAudioClaim={()=>{}}/>
      :<NativeVideoInline libraryId="synthetic" assetId="synthetic" style={{width,height:width}} onClaim={()=>{}} onDimensions={()=>{}}/>}
    </div></I18nProvider>);};
  `}, bundle: true, write: false, outfile: 'app.js', jsx: 'automatic', loader: {'.svg': 'dataurl'}});
  const js = built.outputFiles.find(f=>f.path.endsWith('.js')).text, css = built.outputFiles.find(f=>f.path.endsWith('.css')).text;
  const server = http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript':'text/html;charset=utf-8');res.end(req.url==='/app.js'?js:`<meta charset="utf-8"><style>${css}body{margin:0;background:#111;color:white}</style><div id="root"></div><script src="/app.js"></script>`);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
  try {
    browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1000,height:900}}),errors=[];
    page.on('pageerror',e=>{errors.push(e.message);console.error('fixture-page-error',e.message);});await page.goto('http://127.0.0.1:'+server.address().port);
    // The real catalog call site is shrink-to-fit, unlike generator/history
    // containers. A percentage-only replacement loses the video's intrinsic size.
    for(const [width,height,wantedWidth,wantedHeight]of [[608,352,430,248.95],[64,64,64,64],[1080,1920,241.875,430]]) {
      await page.evaluate(({width,height})=>window.draw('asset',800,{width,height,duration:4.5}),{width,height});
      const asset=page.locator('.canvas-node-video > .canvas-native-video');await asset.waitFor();
      await page.waitForFunction(ratio=>document.querySelector('.canvas-native-video')?.style.getPropertyValue('--canvas-video-ratio')===String(ratio),width/height);
      const assetBox=await asset.boundingBox();
      assert(Math.abs(assetBox.width-wantedWidth)<1&&Math.abs(assetBox.height-wantedHeight)<1,`catalog ${width}x${height} must retain natural size within card limits: ${JSON.stringify(assetBox)}`);
    }
    // Decoder activation must not resize a catalog card into an adjacent one.
    await page.evaluate(()=>window.draw('fixed',800));
    const fixed=page.locator('.canvas-node-video > .canvas-native-video');await fixed.waitFor();
    const before=await fixed.boundingBox(),nextBefore=await page.locator('#next-video-card').boundingBox();
    assert.equal(before.width,430);assert(Math.abs(before.width / before.height - 608 / 352) < .01, `decoder layout must use the existing video preset and actual aspect ratio, never the 300x225 loading placeholder: ${JSON.stringify(before)}`);
    await fixed.getByRole('button',{name:'播放视频',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.canvas-native-video')?.classList.contains('is-playing'));
    const after=await fixed.boundingBox(),nextAfter=await page.locator('#next-video-card').boundingBox();
    assert.deepEqual(after,before,'higher decoded dimensions must retain the original card layout');
    assert.deepEqual(nextAfter,nextBefore,'playback must not push or overlap the next card');
    const controls=await fixed.locator('.canvas-video-controls').boundingBox();
    assert(controls.y+controls.height<=after.y+after.height+.5&&controls.y+controls.height<nextAfter.y,'upper timeline remains inside its own card above the next card');
    assert.equal(await fixed.evaluate(e=>getComputedStyle(e).isolation),'isolate','timeline stacking is local to the video');
    for(const kind of ['canvas','library'])for(const width of [64,128,280,800]) {
      await page.evaluate(({kind,width})=>window.draw(kind,width),{kind,width});
      const shell=page.locator(kind==='canvas'?'.canvas-native-video':'.native-video-inline.ready');await shell.waitFor();
      const report=await shell.evaluate(el=>{const box=el.getBoundingClientRect();return [...el.querySelectorAll('button,.canvas-video-progress,input[type="range"]')].map(c=>{const r=c.getBoundingClientRect();return{label:c.getAttribute('aria-label')||c.className,width:r.width,height:r.height,left:r.left-box.left,right:r.right-box.left,top:r.top-box.top,bottom:r.bottom-box.top,shellWidth:box.width,shellHeight:box.height};});});
      assert.equal(report.length,3,`${kind} has play, seek and sound controls`);
      for(const r of report){assert(r.width>0&&r.height>0&&r.left>=-.5&&r.top>=-.5&&r.right<=r.shellWidth+.5&&r.bottom<=r.shellHeight+.5,`${kind} width=${width}: clipped ${JSON.stringify(r)}`);}
      if(kind==='library'){await page.getByRole('slider',{name:'视频预览时间线'}).press('End');await page.getByRole('button',{name:'取消静音',exact:true}).click();await page.getByRole('button',{name:'静音',exact:true}).waitFor();}
    }
    assert.deepEqual(errors,[]);console.log('PASS: catalog decoder layout retained beside next card; canvas/library play, seek and sound fit 64/128/280/800px; IPC fixture only, real codec/audio not asserted');
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
