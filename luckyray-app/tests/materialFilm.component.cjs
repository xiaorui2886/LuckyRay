// Real Chromium media decoding + production React/CSS; Catalog transport is a fixture.
// Actual native persistence/import are tested separately by video_tools Rust tests.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),out=path.join(root,'output/playwright/material-film');fs.mkdirSync(out,{recursive:true});
const esbuild=require(require.resolve('esbuild',{paths:[fs.realpathSync(root+'/node_modules/vite')]}));
const {chromium}=require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE||'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@playwright/mcp/node_modules/playwright');
for(const [name,size,duration] of [['landscape','640x360',8],['portrait','240x426',8],['long','160x90',120]]) {
 const file=path.join(out,name+'.mp4');if(!fs.existsSync(file))cp.execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i',`testsrc2=size=${size}:rate=10:duration=${duration}`,'-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-movflags','+faststart',file]);
}
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';
import {MaterialFilmViewer} from './src/features/materials/MaterialFilmViewer';
const calls=[],marks=new Map();let failSave=false,failFrame=false;let captured=null;
window.__TAURI_INTERNALS__={invoke:async(command,{request})=>{
 const {libraryId,action:a}=request;calls.push({libraryId,action:{...a,bytes:a.bytes?.length}});
 const key=libraryId+':'+a.id;const rows=marks.get(key)||[];
 if(a.op==='videoMarks')return{sourceRevision:'revision-'+a.id,marks:rows};
 if(a.op==='videoMarkSave'){if(failSave)throw Error('synthetic-save-failure');marks.set(key,[...rows.filter(x=>x.id!==a.mark.id),a.mark]);return null;}
 if(a.op==='videoMarkDelete'){marks.set(key,rows.filter(x=>x.id!==a.markId));return null;}
 if(a.op==='videoFrame'){captured=a;if(failFrame){failFrame=false;throw Error('synthetic-lost-result');}return {assets:[{id:'frame',name:'frame.png'}],importedCount:1,skippedDuplicateCount:0,failedItems:[]};}
 throw Error(a.op);
}};
const host=createRoot(document.getElementById('app'));
function open(id='landscape',library='A'){host.render(<MaterialFilmViewer key={library+id} asset={{id,name:id+'.mp4',mimeType:'video/mp4'}} libraryId={library} resolveSource={async()=>'/'+id+'.mp4'} onClose={()=>host.render(<button onClick={()=>open(id,library)}>重新打开</button>)} onFrame={()=>{window.viewed=true}}/>)}
window.fixture={open,calls,marks,failSave:v=>failSave=v,failFrame:()=>failFrame=true,captured:()=>captured};open();
`;
(async()=>{
 await esbuild.build({stdin:{contents:entry,resolveDir:root,loader:'tsx'},outfile:path.join(out,'bundle.js'),bundle:true,format:'iife',jsx:'automatic'});
 const server=http.createServer((req,res)=>{const name=(req.url||'/').slice(1);if(!name){res.setHeader('Content-Type','text/html');res.end('<html><head><link rel="stylesheet" href="/bundle.css"><style>body{margin:0;font:14px sans-serif;background:#17171c;color:#eee;--bg-primary:#19191f;--text-primary:#eee;--bg-hover:#30303a;--border-color:#363640}body.light{--bg-primary:#fafafa;--text-primary:#25252c;--bg-hover:#e8e8ef;--border-color:#d7d7df}</style></head><body><div id="app"></div><script src="/bundle.js"></script></body></html>');return;}
  if(!['bundle.js','bundle.css','landscape.mp4','portrait.mp4','long.mp4'].includes(name)){res.statusCode=404;res.end();return;}
  const file=path.join(out,name),size=fs.statSync(file).size;res.setHeader('Content-Type',name.endsWith('.mp4')?'video/mp4':name.endsWith('.css')?'text/css':'text/javascript');
  if(req.headers.range){const m=/bytes=(\d+)-(\d*)/.exec(req.headers.range);const start=Number(m[1]),end=m[2]?Math.min(Number(m[2]),size-1):size-1;res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${size}`,'Accept-Ranges':'bytes','Content-Length':end-start+1});fs.createReadStream(file,{start,end}).pipe(res);}else{res.setHeader('Content-Length',size);fs.createReadStream(file).pipe(res);}
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
  browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1100,height:750}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2);
  const seekTo=async value=>{await page.getByRole('button',{name:'定位到时间'}).click();await page.getByRole('textbox',{name:'定位时间'}).fill(String(value));await page.getByRole('textbox',{name:'定位时间'}).press('Enter');await page.waitForFunction(n=>!document.querySelector('video').seeking&&Math.abs(document.querySelector('video').currentTime-n)<.02,value);};
  await page.getByRole('button',{name:'播放',exact:true}).click();await page.waitForFunction(()=>document.querySelector('video').currentTime>.2);await page.getByRole('button',{name:'暂停',exact:true}).click();
  await seekTo(3);await page.waitForTimeout(100);
  assert.equal(await page.locator('.material-film-thumbs').count(),0,'opening does not start a second decoder');
  await page.getByRole('button',{name:'标记',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'标记备注'}).count(),0,'quick mark does not cover the picture with a form');
  await page.locator('.material-film-marks button').first().click();await page.getByRole('textbox',{name:'标记备注'}).fill('镜头 A');await page.waitForFunction(()=>[...window.fixture.marks.values()].flat().some(m=>m.note==='镜头 A'));
  const before=await page.locator('video').evaluate(v=>v.currentTime);await page.getByRole('textbox',{name:'标记备注'}).press('ArrowLeft');assert.equal(await page.locator('video').evaluate(v=>v.currentTime),before);
  await page.getByRole('button',{name:'关闭标记备注'}).click();
  // Same trigger closes the clip panel rather than overwriting its in point.
  await page.getByRole('button',{name:'片段',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'片段',exact:true}).getAttribute('aria-expanded'),'true');
  await page.getByRole('button',{name:'片段',exact:true}).click();assert.equal(await page.locator('.material-film-range').count(),0);
  await page.getByRole('button',{name:'片段',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'保存片段标记',exact:true}).isDisabled(),true,'no fabricated end point');
  await seekTo(4);await page.getByRole('slider',{name:'视频时间线'}).focus();await page.keyboard.press('o');
  // Draft once-only playback stops at O; looping returns to I repeatedly.
  await page.getByRole('button',{name:'播放片段',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('video').paused&&Math.abs(document.querySelector('video').currentTime-4)<.02);
  await page.evaluate(()=>{window.loopReturns=0;document.querySelector('video').addEventListener('seeking',()=>{if(Math.abs(document.querySelector('video').currentTime-3)<.05)window.loopReturns++})});
  await page.getByRole('button',{name:'循环播放',exact:true}).click();assert.equal(await page.locator('video').evaluate(v=>v.paused),true,'loop toggle changes preference without starting playback');
  await page.keyboard.press('Space');await page.waitForFunction(()=>window.loopReturns>=3);
  assert.equal(await page.getByRole('button',{name:'循环播放',exact:true}).getAttribute('aria-pressed'),'true','Space after toggle does not activate toggle again');
  await page.keyboard.press('Space');assert.equal(await page.locator('video').evaluate(v=>v.paused),true);
  await page.getByRole('textbox',{name:'片段名称'}).fill('选区');await page.getByRole('button',{name:'保存片段标记',exact:true}).click();await page.waitForFunction(()=>[...window.fixture.marks.values()].flat().some(m=>m.end===4&&m.start===3));
  assert.equal(await page.locator('.material-film-range').count(),0);
  await page.locator('.material-film-marks button.range').click();
  assert.equal(await page.getByRole('button',{name:'循环播放',exact:true}).getAttribute('aria-pressed'),'true','loop preference survives draft save and selecting a saved range');
  await page.keyboard.press('Space');await page.waitForFunction(()=>!document.querySelector('video').paused);
  await page.getByRole('button',{name:'循环播放',exact:true}).click();await page.waitForFunction(()=>document.querySelector('video').paused&&Math.abs(document.querySelector('video').currentTime-4)<.02);
  assert.equal(await page.getByRole('button',{name:'循环播放',exact:true}).getAttribute('aria-pressed'),'false');
  await page.keyboard.press('Space');await page.waitForFunction(()=>!document.querySelector('video').paused);
  await page.keyboard.press('Space');assert.equal(await page.locator('video').evaluate(v=>v.paused),true);
  await page.getByRole('button',{name:'循环播放',exact:true}).click();await page.keyboard.press('Space');await page.waitForFunction(()=>!document.querySelector('video').paused);
  await page.getByRole('button',{name:'关闭标记备注'}).click();assert.equal(await page.locator('video').evaluate(v=>v.paused),true,'closing selected clip stops scoped playback');
  // Direct list deletion preserves the list, other marks and source video.
  await seekTo(2);await page.getByRole('button',{name:'标记',exact:true}).click();await page.getByRole('button',{name:'标记列表',exact:true}).click();
  await page.getByRole('button',{name:'删除标记 00:02.000',exact:true}).click();await page.waitForFunction(()=>!window.fixture.marks.get('A:landscape').some(m=>m.start===2));
  assert.equal(await page.getByRole('complementary',{name:'标记与片段'}).count(),1);assert.equal(await page.locator('.material-film-marks button').count(),2);
  await page.screenshot({path:path.join(out,'mark-list-delete-dark.png')});await page.getByRole('button',{name:'关闭标记列表'}).click();
  // End-of-media must loop only the selected tail, not stop or loop the whole file.
  await seekTo(7.5);await page.keyboard.press('i');await seekTo(8);await page.keyboard.press('o');
  assert.equal(await page.getByRole('button',{name:'循环播放',exact:true}).getAttribute('aria-pressed'),'true');
  await page.keyboard.press('Space');await page.waitForTimeout(1300);
  assert.ok(await page.locator('video').evaluate(v=>!v.paused&&v.currentTime>=7.5&&v.currentTime<=8));
  await page.getByRole('button',{name:'片段',exact:true}).click();assert.equal(await page.locator('.material-film-range').count(),0);assert.equal(await page.locator('video').evaluate(v=>v.paused),true);
  await seekTo(3);await page.waitForTimeout(100);
  await page.getByRole('button',{name:'截帧',exact:true}).click();await page.getByText('已保存截帧',{exact:true}).waitFor();
  const capture=await page.evaluate(()=>({time:window.fixture.captured().time,bytes:window.fixture.captured().bytes}));assert.ok(capture.time>=2.8&&capture.time<=3.2);assert.deepEqual(capture.bytes.slice(0,8),[137,80,78,71,13,10,26,10]);
  fs.writeFileSync(path.join(out,'decoded-frame.png'),Buffer.from(capture.bytes));
  await page.evaluate(()=>{window.thumbCounts=[];new MutationObserver(()=>window.thumbCounts.push(document.querySelectorAll('.material-film-thumbs img').length)).observe(document.querySelector('.material-film-timeline'),{childList:true,subtree:true});});
  await page.getByRole('button',{name:'切换时间线样式'}).click();
  assert.equal(await page.locator('.material-film-timeline.filmstrip').count(),1,'style switches before decoder completes');
  await page.waitForFunction(()=>document.querySelectorAll('.material-film-thumbs img').length===13);
  assert.ok(await page.evaluate(()=>window.thumbCounts.some(n=>n>0&&n<13)),'partial thumbnails are displayed before complete batch');
  assert.equal(await page.locator('.material-film-timeline').getAttribute('aria-busy'),'false');
  await page.screenshot({path:path.join(out,'landscape-dark.png')});
  assert.ok(await page.locator('.material-film-thumbs img').evaluateAll(images=>new Set(images.map(i=>i.src)).size>8),'samples decode different moments, not repeated first frame');
  assert.ok(await page.locator('.material-film-thumbs img').evaluateAll(images=>images.every((img,i)=>!i||Math.abs(img.getBoundingClientRect().left-images[i-1].getBoundingClientRect().right)<1)),'filmstrip tiles have no gaps');
  await page.keyboard.press('Space');await page.waitForFunction(()=>!document.querySelector('video').paused);
  assert.equal(await page.getByRole('button',{name:'切换时间线样式'}).getAttribute('aria-pressed'),'true','Space after tool click plays, does not toggle the tool');await page.keyboard.press('Space');
  const actionAlignment=await page.locator('.material-film-actions').evaluate(el=>{const a=el.getBoundingClientRect(),b=document.querySelector('.material-film').getBoundingClientRect();return Math.abs(a.x+a.width/2-b.x-b.width/2)});assert.ok(actionAlignment<2,'main actions centered on the picture, not leftover toolbar width');
  assert.equal(await page.locator('.material-film-topbar').evaluate(el=>getComputedStyle(el).position),'absolute');
  assert.ok(await page.locator('.material-film-stage').evaluate(el=>Math.abs(el.getBoundingClientRect().top-document.querySelector('.material-film').getBoundingClientRect().top)<1),'top controls consume no picture height');
  await page.mouse.move(500,300);await page.waitForTimeout(200);assert.equal(await page.locator('.material-film-topbar').evaluate(el=>getComputedStyle(el).opacity),'1','toolbar remains visible as requested, including HTML fallback');
  await page.getByRole('button',{name:'视频信息',exact:true}).hover();await page.waitForTimeout(200);assert.equal(await page.locator('.material-film-topbar').evaluate(el=>getComputedStyle(el).opacity),'1');
  await page.screenshot({path:path.join(out,'header-hover-dark.png')});
  assert.equal(await page.locator('.material-film-topbar').textContent().then(t=>t.includes('landscape.mp4')),false);
  await page.getByRole('button',{name:'视频信息',exact:true}).click();await page.locator('.material-film-info').getByText('landscape.mp4',{exact:true}).waitFor();await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'切换全屏'}).click();await page.waitForFunction(()=>Boolean(document.fullscreenElement));await page.locator('.material-film').focus();await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.fullscreenElement);assert.equal(await page.locator('.material-film').count(),1,'Escape only leaves fullscreen');
  await page.getByRole('button',{name:'切换时间线样式'}).click();assert.equal(await page.locator('.material-film-thumbs').count(),0);
  await page.getByRole('button',{name:'返回素材库'}).click();await page.getByRole('button',{name:'重新打开'}).click();await page.getByRole('button',{name:'标记 00:03 镜头 A'}).waitFor();
  await page.evaluate(()=>{const create=document.createElement.bind(document);window.newVideoDecoders=0;document.createElement=function(tag,...args){if(tag==='video')window.newVideoDecoders++;return create(tag,...args)};});
  await page.getByRole('button',{name:'切换时间线样式'}).click();await page.waitForFunction(()=>document.querySelectorAll('.material-film-thumbs img').length===13);
  assert.equal(await page.evaluate(()=>window.newVideoDecoders),0,'reopening same source/revision uses bounded session cache without new decoder');
  await page.getByRole('button',{name:'切换时间线样式'}).click();
  await page.getByRole('button',{name:'标记 00:03 镜头 A'}).click();await page.evaluate(()=>window.fixture.failSave(true));await page.getByRole('textbox',{name:'标记备注'}).fill('失败恢复');await page.getByRole('button',{name:'重试保存',exact:true}).waitFor();
  assert.ok(await page.evaluate(()=>Object.keys(localStorage).some(k=>k.startsWith('luckyray-material-film-pending:'))));
  await page.evaluate(()=>window.fixture.open('portrait','B'));await page.waitForFunction(()=>document.querySelector('video')?.videoHeight===426);await page.evaluate(()=>window.fixture.open('landscape','A'));await page.getByText('已恢复未保存的标记，请重试保存',{exact:true}).waitFor();
  await page.evaluate(()=>window.fixture.failSave(false));await page.getByRole('button',{name:'重试保存',exact:true}).click();await page.waitForFunction(()=>[...window.fixture.marks.values()].flat().some(m=>m.note==='失败恢复'));await page.getByRole('button',{name:'标记 00:03 失败恢复'}).click();await page.getByRole('button',{name:'删除标记'}).click();await page.waitForFunction(()=>![...window.fixture.marks.values()].flat().some(m=>m.note==='失败恢复'));
  await page.evaluate(()=>window.fixture.failFrame());await page.getByRole('button',{name:'截帧',exact:true}).click();await page.getByRole('button',{name:'重试截帧保存'}).waitFor();const first=await page.evaluate(()=>window.fixture.captured().bytes);await page.getByRole('button',{name:'重试截帧保存'}).click();await page.getByText('已保存截帧',{exact:true}).waitFor();assert.deepEqual(await page.evaluate(()=>window.fixture.captured().bytes),first);
  await page.evaluate(()=>window.fixture.open('portrait','B'));await page.waitForFunction(()=>document.querySelector('video')?.videoHeight===426);assert.equal(await page.locator('.material-film-marks button').count(),0);
  await page.evaluate(()=>document.body.className='light');await page.setViewportSize({width:420,height:640});
  await page.getByRole('button',{name:'切换时间线样式'}).click();await page.waitForFunction(()=>document.querySelectorAll('.material-film-thumbs img').length===14);
  assert.ok(await page.locator('.material-film-thumbs img').first().evaluate(i=>i.naturalWidth<i.naturalHeight),'portrait thumbnail is not baked into a letterboxed landscape canvas');
  await page.screenshot({path:path.join(out,'portrait-narrow-light.png')});assert.ok(await page.locator('.material-film-controls').evaluate(e=>e.scrollWidth<=e.clientWidth));
  await page.getByRole('button',{name:'标记',exact:true}).click();await page.waitForFunction(()=>window.fixture.calls.some(c=>c.libraryId==='B'&&c.action.op==='videoMarkSave'));
  await page.evaluate(()=>{window.fixture.open('long','A')});await page.waitForFunction(()=>document.querySelector('video')?.duration===120);
  await page.getByRole('button',{name:'定位到时间'}).click();await page.getByRole('textbox',{name:'定位时间'}).fill('01:15.350');await page.getByRole('textbox',{name:'定位时间'}).press('Enter');await page.waitForFunction(()=>!document.querySelector('video').seeking&&Math.abs(document.querySelector('video').currentTime-75.35)<.02);
  await page.locator('.material-film').focus();await page.keyboard.press('ArrowLeft');await page.waitForFunction(()=>!document.querySelector('video').seeking);assert.ok(Math.abs(await page.locator('video').evaluate(v=>v.currentTime)-75.25)<.02);
  await page.keyboard.press('Shift+ArrowRight');await page.waitForFunction(()=>!document.querySelector('video').seeking);assert.ok(Math.abs(await page.locator('video').evaluate(v=>v.currentTime)-80.25)<.02);
  await page.keyboard.press('i');assert.equal(await page.locator('.material-film-draft-range').count(),1);
  await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>!document.querySelector('video').seeking);await page.keyboard.press('o');
  await page.getByRole('textbox',{name:'片段名称'}).fill('键盘片段');await page.getByRole('textbox',{name:'片段名称'}).press('m');assert.equal(await page.locator('.material-film-marks button').count(),0,'typing m is not a marker shortcut');
  await page.keyboard.press('Escape');assert.equal(await page.locator('.material-film-range').count(),0);assert.equal(await page.locator('.material-film').count(),1);
  await page.getByRole('button',{name:'定位到时间'}).click();await page.getByRole('textbox',{name:'定位时间'}).fill('999');await page.getByRole('textbox',{name:'定位时间'}).press('Enter');await page.getByRole('alert').waitFor();await page.keyboard.press('Escape');assert.equal(await page.getByRole('alert').count(),0);
  await page.locator('.material-film').focus();await page.keyboard.press('m');await page.getByRole('button',{name:'标记列表',exact:true}).click();await page.getByRole('complementary',{name:'标记与片段'}).waitFor();await page.getByRole('button',{name:'关闭标记列表'}).click();
  // Repeated mark and I/O after slider focus; these were swallowed as text inputs before.
  await page.setViewportSize({width:1100,height:750});
  await seekTo(20);await page.getByRole('slider',{name:'视频时间线'}).focus();await page.keyboard.press('m');
  await seekTo(30);await page.getByRole('slider',{name:'音量'}).focus();await page.keyboard.press('m');
  await page.waitForFunction(()=>window.fixture.marks.get('A:long')?.filter(m=>m.end===null).length===3);
  for(const [start,end,name] of [[10,12,'片段一'],[25,28,'片段二']]){
    await seekTo(start);await page.getByRole('slider',{name:'视频时间线'}).focus();await page.keyboard.press('i');
    assert.equal(await page.getByRole('button',{name:'保存片段标记',exact:true}).isDisabled(),true);
    await seekTo(end);await page.getByRole('slider',{name:'视频时间线'}).focus();await page.keyboard.press('o');
    await page.getByRole('textbox',{name:'片段名称'}).fill(name);await page.keyboard.press('Control+Enter');
    await page.waitForFunction(n=>window.fixture.marks.get('A:long')?.some(m=>m.note===n),name);
  }
  assert.equal(await page.locator('.material-film-marks button.range').count(),2);
  await page.locator('.material-film-marks button.range').first().click();
  await page.getByRole('button',{name:'循环播放',exact:true}).click();assert.equal(await page.locator('video').evaluate(v=>v.paused),true);
  await page.keyboard.press('Space');await page.waitForFunction(()=>!document.querySelector('video').paused&&document.querySelector('video').currentTime>=10);await page.keyboard.press('Space');
  await page.locator('.material-film-marks button.range').nth(1).click();
  assert.equal(await page.getByRole('button',{name:'循环播放',exact:true}).getAttribute('aria-pressed'),'true','preference carries to a different saved clip');
  await page.keyboard.press('Space');await page.waitForFunction(()=>!document.querySelector('video').paused&&document.querySelector('video').currentTime>=25);
  await page.getByRole('button',{name:'循环播放',exact:true}).click();await page.waitForFunction(()=>document.querySelector('video').paused&&Math.abs(document.querySelector('video').currentTime-28)<.02);
  // An outside timeline seek leaves saved-clip selection; Space must not jump back.
  const savedClipsBeforeSeek=await page.evaluate(()=>JSON.stringify(window.fixture.marks.get('A:long')));
  const clickTimeline=async seconds=>{const box=await page.getByRole('slider',{name:'视频时间线'}).boundingBox();await page.mouse.click(box.x+box.width*seconds/120,box.y+box.height/2);await page.waitForFunction(()=>!document.querySelector('video').seeking);};
  await clickTimeline(40);
  assert.equal(await page.getByRole('button',{name:'关闭标记备注'}).count(),0,'outside timeline click closes selected clip popup');
  assert.equal(await page.locator('.material-film-marks button[aria-pressed="true"]').count(),0);
  await page.keyboard.press('Space');await page.waitForFunction(()=>!document.querySelector('video').paused&&document.querySelector('video').currentTime>40.1);await page.keyboard.press('Space');
  await page.locator('.material-film-marks button.range').nth(1).click();
  await clickTimeline(26);
  assert.equal(await page.getByRole('button',{name:'关闭标记备注'}).count(),1,'within-clip seek retains selection');
  await page.keyboard.press('Space');await page.waitForFunction(()=>document.querySelector('video').paused&&Math.abs(document.querySelector('video').currentTime-28)<.02);
  await page.getByRole('button',{name:'循环播放',exact:true}).click();await page.keyboard.press('Space');
  await page.waitForFunction(()=>!document.querySelector('video').paused);
  await clickTimeline(26);await page.waitForFunction(()=>!document.querySelector('video').paused);
  await page.waitForTimeout(2300);
  assert.ok(await page.locator('video').evaluate(v=>!v.paused&&v.currentTime>=25&&v.currentTime<28),'scrubbing inside playing loop preserves its boundary');
  await clickTimeline(40);await page.waitForFunction(()=>!document.querySelector('video').paused&&document.querySelector('video').currentTime>40.1);
  assert.equal(await page.getByRole('button',{name:'关闭标记备注'}).count(),0,'playing loop exits on outside seek without stopping ordinary playback');
  await page.keyboard.press('Space');await page.keyboard.press('Space');await page.waitForFunction(()=>!document.querySelector('video').paused&&document.querySelector('video').currentTime>40.3);await page.keyboard.press('Space');
  assert.equal(await page.evaluate(()=>JSON.stringify(window.fixture.marks.get('A:long'))),savedClipsBeforeSeek,'seeking never edits saved annotations');
  await page.locator('.material-film-marks button.range').nth(1).click();
  assert.equal(await page.getByRole('button',{name:'循环播放',exact:true}).getAttribute('aria-pressed'),'true','leaving scope preserves loop preference');
  await page.getByRole('button',{name:'关闭标记备注'}).click();
  await seekTo(40);await page.keyboard.press('o');assert.equal(await page.getByRole('button',{name:'保存片段标记',exact:true}).isDisabled(),true);
  await seekTo(35);await page.keyboard.press('i');assert.equal(await page.getByRole('button',{name:'保存片段标记',exact:true}).isEnabled(),true);await page.keyboard.press('Escape');
  await page.getByRole('slider',{name:'视频时间线'}).focus();await page.keyboard.press('m');
  const marksBeforeRepeat=await page.locator('.material-film-marks button').count();
  await page.getByRole('slider',{name:'视频时间线'}).dispatchEvent('keydown',{key:'m',repeat:true});assert.equal(await page.locator('.material-film-marks button').count(),marksBeforeRepeat);
  await page.getByRole('button',{name:'切换时间线样式'}).click();await page.waitForFunction(()=>document.querySelectorAll('.material-film-thumbs img').length===13);assert.ok(await page.locator('.material-film-thumbs img').count()<=48);
  await page.setViewportSize({width:1100,height:750});await page.evaluate(()=>document.body.className='');await page.screenshot({path:path.join(out,'long-precise-dark.png')});
  await page.getByRole('button',{name:'播放',exact:true}).click();const timeline=await page.getByRole('slider',{name:'视频时间线'}).boundingBox();await page.mouse.move(timeline.x+timeline.width*.4,timeline.y+timeline.height/2);await page.mouse.down();await page.mouse.move(timeline.x+timeline.width*.6,timeline.y+timeline.height/2);await page.mouse.up();await page.waitForFunction(()=>!document.querySelector('video').paused&&!document.querySelector('video').seeking);await page.getByRole('button',{name:'暂停',exact:true}).click();
  assert.equal(await page.evaluate(()=>getSelection().toString()),'','scrub never selects timestamps/thumbnails');
  assert.ok(await page.locator('video').evaluate(v=>v.currentTime>=71.9&&v.currentTime<74),'pointer maps to timeline position, not native image drag');
  const pausedAt=await page.locator('video').evaluate(v=>v.currentTime);
  await page.getByRole('slider',{name:'视频时间线'}).click({button:'right'});assert.equal(await page.locator('video').evaluate(v=>v.currentTime),pausedAt,'secondary button is not a seek');
  await page.mouse.move(timeline.x+timeline.width*.2,timeline.y+timeline.height/2);await page.mouse.down();await page.mouse.move(timeline.x-25,timeline.y+timeline.height/2);await page.mouse.up();await page.waitForFunction(()=>!document.querySelector('video').seeking);assert.equal(await page.locator('video').evaluate(v=>v.currentTime),0);assert.equal(await page.locator('video').evaluate(v=>v.paused),true,'paused scrub stays paused and clamps beyond boundary');
  assert.equal(await page.locator('.material-film-thumbs img').first().getAttribute('draggable'),'false');
  await page.getByRole('slider',{name:'视频时间线'}).focus();await page.keyboard.press('i');await page.keyboard.press('Shift+ArrowRight');await page.keyboard.press('o');assert.equal(await page.getByRole('button',{name:'保存片段标记',exact:true}).isEnabled(),true);await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'返回素材库'}).click();await page.getByRole('button',{name:'重新打开'}).click();await page.waitForFunction(()=>document.querySelectorAll('.material-film-marks button.range').length===2);
  await page.evaluate(()=>{window.fixture.open('portrait','B');setTimeout(()=>window.fixture.open('landscape','A'),20)});await page.waitForFunction(()=>document.querySelector('video')?.videoWidth===640);await page.waitForTimeout(400);assert.ok((await page.locator('.material-film').getAttribute('aria-label')).includes('landscape'));
  await page.evaluate(()=>window.fixture.open('broken','A'));await page.getByText('当前视频格式无法播放或原文件已不可用；不会修改原文件',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'截帧',exact:true}).isDisabled(),true);
  assert.deepEqual(errors,[]);console.log('FILM COMPONENT PASS: real decode/seek/frame PNG; marks/range; loop preference and Space after tools/range selection; reopen/delete/failure/retry; frozen-frame retry; library switch; adaptive bounded time-sampled filmstrip; cancel/fast-switch; portrait/narrow/light/dark; unsupported media. Transport fixture, NOT actual Main acceptance.');
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1});
