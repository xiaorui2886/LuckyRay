const fs=require('node:fs'),http=require('node:http'),path=require('node:path'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const fixture=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'luckyray-video-frame-'));
if (!process.env.LUCKYRAY_MEDIA_SAMPLE) execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=black:s=160x90:d=0.15:r=30','-f','lavfi','-i','color=c=red:s=160x90:d=1.85:r=30','-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0[out]','-map','[out]','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',path.join(fixture,'测试 video.mp4')]);
const baseline=process.argv.includes('--baseline');
const sourceBaseline=process.argv.includes('--source-baseline');
const samplePath=process.env.LUCKYRAY_MEDIA_SAMPLE || path.join(fixture,'测试 video.mp4');
const posterPath=process.env.LUCKYRAY_MEDIA_POSTER || path.join(fixture,'poster.jpg');
if (process.env.LUCKYRAY_MEDIA_SAMPLE && !process.env.LUCKYRAY_MEDIA_POSTER) throw new Error('Read-only sample tests require an existing LUCKYRAY_MEDIA_POSTER; no poster is generated from user media.');
if (!process.env.LUCKYRAY_MEDIA_POSTER) execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-ss','0.25','-i',samplePath,'-frames:v','1',posterPath]);
const appSource=sourceBaseline ? execFileSync('git',['show','v1.9.2:luckyray-app/src/App.tsx'],{cwd:root,encoding:'utf8'}) : fs.readFileSync(root+'/src/App.tsx','utf8');
const adapter=appSource.slice(appSource.indexOf('function normalizeAsset(asset:'),appSource.indexOf('function normalizeFolder('));
const esbuild=require(require.resolve('esbuild',{paths:[fs.realpathSync(root+'/node_modules/vite')]}));
const {chromium}=require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE || 'playwright');
(async()=>{
  const entry=`import {adaptMaterialAssetMedia as adaptMedia} from './src/core/services/materialAssetAdapter.ts';
    const adaptMaterialAssetMedia=asset=>adaptMedia(asset,{native:true,fileUrl:p=>'/'+encodeURIComponent(p)});
    import {AssetEmbedWidget} from './src/features/notes/editor/assetEmbedWidgets.ts';
    import {NoteVideoPreview} from './src/features/notes/editor/NoteVideoPreview.tsx';
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {attachVideoPreview} from './src/features/notes/editor/videoPreview.ts';
    window.testFailure=()=>{const v=document.createElement('video');document.body.append(v);window.failedController=attachVideoPreview(v,{source:'/missing-video.mp4',onState:(state,message)=>{window.failure={state,message};}});};
    function createId(){return 'v'} function filenameFromPath(p){return p} function kindFromName(){return 'video'}
    function normalizeRating(v){return v} function normalizeDominantColor(v){return v} function normalizeAssetStorageMode(v){return v}
    function isTauri(){return true} function convertFileSrc(p){return '/'+encodeURIComponent(p)}
    ${adapter}
    const adapted=normalizeAsset({id:'v',name:'video.mp4',kind:'video',storageMode:'linked',libraryPath:null,originalPath:${JSON.stringify(samplePath)},thumbnailUrl:'/poster.jpg'});
    const src=adapted.previewUrl; window.adapted=adapted;
    const widget=new AssetEmbedWidget({embed:{asset:{id:'v',name:'synthetic',kind:'video',previewUrl:src,thumbnailUrl:adapted.thumbnailUrl},target:'v.mp4',display:'test',width:null,missing:false},from:0,to:1,block:true,expanded:true,selected:false});
    const card=widget.toDOM({});document.getElementById('live').append(card);window.card=card;window.widget=widget;
    window.remount=(version)=>{window.widget.destroy(window.card);window.card.remove();
      window.widget=new AssetEmbedWidget({embed:{asset:{id:'vault-v',name:'video.mp4',kind:'video',previewUrl:src+'?vault=fixture&v='+version},target:'attachments/video.mp4',display:'video',width:null,missing:false},from:0,to:1,block:true,expanded:true,selected:false});
      window.card=window.widget.toDOM({});document.getElementById('live').append(window.card);
    };
    createRoot(document.getElementById('reading')).render(React.createElement(NoteVideoPreview,{source:src,thumbnail:adapted.thumbnailUrl}));`;
  const built=await esbuild.build({stdin:{contents:entry,resolveDir:root,loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',loader:{'.css':'empty'},plugins:(baseline||sourceBaseline)?[{name:'baseline-production-widget',setup(build){build.onLoad({filter:/assetEmbedWidgets\.ts$/},()=>({contents:execFileSync('git',['show',(sourceBaseline?'v1.9.2':'4989a12')+':luckyray-app/src/features/notes/editor/assetEmbedWidgets.ts'],{cwd:root,encoding:'utf8'}),loader:'ts',resolveDir:root+'/src/features/notes/editor'}));}}]:[]});
  const data=fs.readFileSync(process.env.LUCKYRAY_MEDIA_SAMPLE || path.join(fixture,'测试 video.mp4'));const requests=[];
  const server=http.createServer((req,res)=>{
    const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if(name==='/fixture.js'){res.writeHead(200,{'Content-Type':'application/javascript'});return res.end(built.outputFiles[0].text);}
    if(name==='/style.css'){res.writeHead(200,{'Content-Type':'text/css'});return res.end(fs.readFileSync(root+'/src/features/notes/editor/liveMarkdown.css'));}
    if(name==='/'){res.writeHead(200,{'Content-Type':'text/html'});return res.end('<link rel="stylesheet" href="/style.css"><div id="live"></div><div id="reading"></div><script src="/fixture.js"></script>');}
    if(name==='/poster.jpg'){res.writeHead(200,{'Content-Type':'image/jpeg'});return res.end(fs.readFileSync(posterPath));}
    if(name!=='/'+samplePath){res.writeHead(404);return res.end();}
    const range=/bytes=(\d+)-(\d*)/.exec(req.headers.range||'');const start=range?Number(range[1]):0,end=Math.min(range&&range[2]?Number(range[2]):data.length-1,start+1000*1024-1);
    requests.push({range:req.headers.range||null,status:range?206:200,mime:'video/mp4',byteLength:end-start+1});
    res.writeHead(range?206:200,{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':end-start+1,...(range?{'Content-Range':`bytes ${start}-${end}/${data.length}`}:{})});res.end(data.subarray(start,end+1));
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try{
    browser=await chromium.launch({channel:'msedge',headless:true});
    const context=await browser.newContext();const base=`http://127.0.0.1:${server.address().port}`;
    await context.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());
    const page=await context.newPage();page.on("pageerror",error=>console.error(error));await page.goto(base);
    if(sourceBaseline){
      await page.waitForFunction(()=>document.querySelector('#live video')?.error);
      const result=await page.evaluate(()=>({previewUrl:window.adapted.previewUrl,poster:window.adapted.thumbnailUrl,requestedPath:new URL(document.querySelector('#live video').currentSrc).pathname,mediaError:document.querySelector('#live video').error.code}));
      console.log(JSON.stringify({sourceBaseline:true,...result,videoRequests:requests.length}));
      assert.equal(result.previewUrl,'');assert.equal(result.requestedPath,'/poster.jpg');assert.equal(result.mediaError,4);assert.equal(requests.length,0);return;
    }
    await page.waitForFunction(()=>[...document.querySelectorAll('video')].length===2&&[...document.querySelectorAll('video')].every(v=>v.readyState>=2&&!v.seeking),{},{timeout:10000});
    const inspect=()=>page.evaluate(()=>[...document.querySelectorAll('video')].map(v=>{const c=document.createElement('canvas');c.width=1;c.height=1;const x=c.getContext('2d');x.drawImage(v,0,0,1,1);return {time:v.currentTime,readyState:v.readyState,paused:v.paused,pixel:[...x.getImageData(0,0,1,1).data],width:v.videoWidth,display:getComputedStyle(v).display,error:v.error?.code||null};}));
    const initial=await inspect();
    const statusDisplays=await page.evaluate(()=>[...document.querySelectorAll('.lr-live-image-status')].map(el=>getComputedStyle(el).display));
    await page.evaluate(()=>window.card.dispatchEvent(new MouseEvent('mouseenter')));
    await page.waitForFunction(()=>document.querySelector('#live video').currentTime>0.4,{},{timeout:5000});
    const playing=await inspect();
    await page.evaluate(()=>window.card.dispatchEvent(new MouseEvent('mouseleave')));
    await page.waitForFunction(()=>{const v=document.querySelector('#live video');return v.paused&&!v.seeking;});
    const stopped=await inspect();
    await page.evaluate(()=>document.querySelector('#reading video').dispatchEvent(new MouseEvent('mouseover',{bubbles:true})));
    await page.waitForFunction(()=>document.querySelector('#reading video').currentTime>0.4,{},{timeout:5000});
    const readingPlaying=await inspect();
    await page.evaluate(()=>document.querySelector('#reading video').dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:document.body})));
    await page.waitForFunction(()=>{const v=document.querySelector('#reading video');return v.paused&&!v.seeking;});
    const readingStopped=await inspect();
    const revisits=[];
    for(const version of ['1','2','2']){
      await page.evaluate(version=>window.remount(version),version);
      await page.waitForFunction(()=>{const v=document.querySelector('#live video');return v.readyState>=2&&!v.seeking;});
      const states=await inspect();revisits.push(states);
      assert.equal(states[0].error,null);assert.equal(states[0].time,0.25);assert.equal(states[1].error,null);
    }
    await page.evaluate(()=>window.testFailure());
    await page.waitForFunction(()=>window.failure?.state==='error',{},{timeout:5000});
    const failure=await page.evaluate(()=>window.failure);
    const result={baseline,initial,playing,stopped,readingPlaying,readingStopped,requests,fixture,failure,statusDisplays,revisits};console.log(JSON.stringify(result));
    fs.writeFileSync(path.join(fixture,baseline?'baseline.json':'fixed.json'),JSON.stringify(result,null,2));
    if(baseline){assert.ok(initial[0].pixel[0]<10);assert.ok(stopped[0].pixel[0]<10);}
    else{for(const frame of [...initial,...stopped,...readingStopped]){if (!process.env.LUCKYRAY_MEDIA_SAMPLE) assert.ok(frame.pixel[0]>200&&frame.pixel[1]<30); else assert.ok(frame.width>0 && frame.readyState>=2);assert.notEqual(frame.display,'none');assert.equal(frame.error,null);}assert.equal(playing[0].paused,false);assert.equal(readingPlaying[1].paused,false);assert.deepEqual(statusDisplays,['none','none']);}
    await context.close();
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});

