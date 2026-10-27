// Production components + a generated moving H.264 clip. No Main/profile/model access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname,'..');
const requireTool = process.env.LR_TEST_TOOLS ? createRequire(path.join(process.env.LR_TEST_TOOLS,'package.json')) : require;
const { chromium } = requireTool('playwright');
const { build, stop } = require(require.resolve('esbuild',{paths:[fs.realpathSync(path.join(root,'node_modules/vite'))]}));
const dir = process.env.LR_AGENT_UI_OUT || path.join(root,'output/playwright/canvas-hover-media-20261020/final');
const checks = [], errors = [];
const record = (name,detail={}) => checks.push({name,status:'PASS',...detail});
async function playing(page, selector) {
  await page.waitForFunction(selector => {
    const v=document.querySelector(selector); return v && !v.paused && v.readyState>=2 && v.currentTime>.08 && v.videoWidth>0;
  },selector);
  const v=page.locator(selector);
  const first=await v.evaluate(v=>({time:v.currentTime,frames:v.getVideoPlaybackQuality().totalVideoFrames,muted:v.muted,loop:v.loop,inline:v.playsInline,width:v.videoWidth,height:v.videoHeight}));
  assert.equal(first.muted,true);assert.equal(first.loop,true);assert.equal(first.inline,true);
  await page.waitForFunction(({selector,frames}) => document.querySelector(selector)?.getVideoPlaybackQuality().totalVideoFrames>frames+3,{selector,frames:first.frames});
  const second=await v.evaluate(v=>({time:v.currentTime,frames:v.getVideoPlaybackQuality().totalVideoFrames}));
  return {first,second};
}
async function released(handle) {
  // React's passive cleanup can follow the input/action completion by one commit.
  await (await handle.ownerFrame()).waitForFunction(v=>v.paused&&!v.hasAttribute('src'),handle,{timeout:3000});
  assert.equal(await handle.evaluate(v=>v.paused),true,'leaving pauses the actual detached media element');
  assert.equal(await handle.evaluate(v=>v.getAttribute('src')),null,'cleanup releases the media source');
}
async function imageFit(page,shape) {
  await page.getByRole('button',{name:shape,exact:true}).click();
  await page.getByRole('button',{name:'定位参考 合成山间晨光',exact:true}).hover();
  const preview=page.locator('.canvas-r1-agent-reference-preview.is-image');
  await preview.locator('img').evaluate(v=>v.decode());
  await page.waitForFunction(()=>{
    const img=document.querySelector('.canvas-r1-agent-reference-preview.is-image img');
    return img && Math.abs(img.parentElement.getBoundingClientRect().width/img.parentElement.getBoundingClientRect().height-img.naturalWidth/img.naturalHeight)<.01;
  });
  const bounds=await preview.evaluate(v=>{
    const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
    const img=v.querySelector('img');return {box:rect(v),image:rect(img),frame:rect(img.parentElement),panel:rect(v.closest('aside')),natural:[img.naturalWidth,img.naturalHeight],fit:getComputedStyle(img).objectFit};
  });
  assert.equal(bounds.fit,'contain');
  assert.ok(Math.abs(bounds.image.width/bounds.image.height-bounds.natural[0]/bounds.natural[1])<.01);
  assert.ok(Math.abs(bounds.image.width-bounds.frame.width)<1&&Math.abs(bounds.image.height-bounds.frame.height)<1,'no fixed black gutter inside media');
  assert.ok(bounds.box.width-bounds.image.width<=15,'only a subtle edge, no wide side bars');
  assert.ok(bounds.box.x>=bounds.panel.x&&bounds.box.y>=bounds.panel.y&&bounds.box.x+bounds.box.width<=bounds.panel.x+bounds.panel.width+1&&bounds.box.y+bounds.box.height<=bounds.panel.y+bounds.panel.height+1,'inside panel');
  return bounds;
}
(async()=>{
  fs.mkdirSync(dir,{recursive:true});
  // Fixture generation only: the installed QA FFmpeg, not the LGPL decoder shipped by the app.
  const ffmpeg=process.env.LR_FFMPEG || 'ffmpeg';
  const generated=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x180:rate=24','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','1.5','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart','-y',path.join(dir,'synthetic.mp4')],{encoding:'utf8',windowsHide:true});
  assert.equal(generated.status,0,generated.stderr);
  await build({entryPoints:[path.join(__dirname,'canvasAgentUi.fixture.tsx')],bundle:true,platform:'browser',format:'esm',jsx:'automatic',outfile:path.join(dir,'app.js')});
  fs.writeFileSync(path.join(dir,'index.html'),'<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><link rel="stylesheet" href="app.css"><style>html,body,#root{margin:0;width:100%;height:100%;background:var(--theme-app-bg);color:var(--text-primary);font-family:Arial,sans-serif}button,input,textarea{font:inherit}.canvas-host{position:absolute;left:180px;right:0;top:54px;bottom:0;overflow:hidden;background:var(--theme-canvas-workspace)}.canvas-host:fullscreen{left:0;top:0;width:100%;height:100%}.fixture-toolbar{position:absolute;top:12px;left:16px;display:flex;gap:8px}.fixture-toolbar button{background:var(--theme-surface-raised);color:var(--text-primary);border:1px solid var(--theme-border-strong);border-radius:7px;padding:6px}.synthetic-art{position:absolute;right:160px;top:170px;width:400px}.synthetic-art img{width:100%}</style><div id="root"></div><script type="module" src="app.js"></script></html>');
  const server=http.createServer((req,res)=>{
    const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';
    if(!['index.html','app.js','app.css','synthetic.mp4'].includes(name)){res.writeHead(404).end();return;}
    const bytes=fs.readFileSync(path.join(dir,name));
    res.setHeader('Content-Type',name.endsWith('.mp4')?'video/mp4':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');
    if(name.endsWith('.mp4')){
      res.setHeader('Accept-Ranges','bytes');const range=/bytes=(\d+)-(\d*)/.exec(req.headers.range||'');
      if(range){const start=Number(range[1]),end=range[2]?Math.min(Number(range[2]),bytes.length-1):bytes.length-1;res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${bytes.length}`,'Content-Length':end-start+1});res.end(bytes.subarray(start,end+1));return;}
    }
    res.end(bytes);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try{
    browser=await chromium.launch({headless:true,executablePath:process.env.LR_BROWSER_EXECUTABLE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/?video=1`);await page.waitForLoadState('networkidle');
    await page.locator('textarea').fill('HOVER-ONLY-20261020 · 不发送的合成草稿');
    assert.equal(await page.locator('video').count(),0);record('no decoder/source mounted before hover');
    for(const size of [{width:1440,height:900},{width:780,height:540},{width:680,height:430}]){
      await page.setViewportSize(size);
      for(const shape of ['方图','横图','竖图'])record(`${shape} tight full-image fit ${size.width}x${size.height}`,await imageFit(page,shape));
      if(size.width===1440||size.width===680)await page.screenshot({path:path.join(dir,`portrait-${size.width}.png`)});
    }
    await page.setViewportSize({width:1440,height:900});
    const card=page.getByRole('button',{name:'定位参考 合成视频',exact:true});await card.hover();
    const playback=await playing(page,'.canvas-r1-agent-reference-preview video');
    record('Agent no-poster video really decodes and advances silently',playback);
    await page.waitForFunction(frames=>document.querySelector('video')?.getVideoPlaybackQuality().totalVideoFrames>frames+40,playback.second.frames);
    record('video loops beyond its original 1.5-second duration');
    await page.screenshot({path:path.join(dir,'agent-video.png')});
    let handle=await page.locator('video').elementHandle();
    await page.locator('.fixture-toolbar').hover();await released(handle);assert.equal(await page.locator('video').count(),0);record('pointer leave releases video and source');
    await card.click();await playing(page,'.canvas-r1-agent-reference-preview video');handle=await page.locator('video').elementHandle();await page.locator('.fixture-toolbar').hover();await released(handle);record('pointer-click focus does not keep video playing after leaving');
    await page.keyboard.press('Tab');await card.focus();await playing(page,'.canvas-r1-agent-reference-preview video');handle=await page.locator('video').elementHandle();await page.locator('textarea').focus();await released(handle);record('keyboard focus preview plays and blur releases');
    await card.hover();await playing(page,'.canvas-r1-agent-reference-preview video');handle=await page.locator('video').elementHandle();await page.getByRole('button',{name:'收起 Agent',exact:true}).click();await released(handle);record('collapse releases decoder without losing draft');
    await page.getByRole('button',{name:'展开 Agent',exact:true}).click();assert.equal(await page.locator('video').count(),0);
    await page.getByRole('button',{name:'素材库弹窗',exact:true}).click();
    assert.equal(await page.locator('.clp-video-badge').count(),3);assert.equal(await page.locator('.clp-item').first().locator('.clp-video-badge').count(),0);record('only video rows get a small play triangle');
    await page.locator('.clp-item').filter({hasText:'合成视频'}).hover();record('picker hover actually plays video',await playing(page,'.clp-hover video'));await page.screenshot({path:path.join(dir,'picker-video.png')});
    handle=await page.locator('.clp-hover video').elementHandle();await page.locator('.clp-item').filter({hasText:'无封面视频'}).hover();await page.waitForFunction(()=>document.querySelector('.clp-hover-copy strong')?.textContent==='无封面视频');await playing(page,'.clp-hover video');await released(handle);assert.equal(await page.locator('video').count(),1);record('changing row releases previous source; video without cover plays');
    handle=await page.locator('.clp-hover video').elementHandle();await page.locator('.clp-list').evaluate(el=>el.dispatchEvent(new Event('scroll')));await released(handle);assert.equal(await page.locator('video').count(),0);record('list scroll releases hover');
    await page.locator('.clp-item').filter({hasText:'合成视频'}).hover();await playing(page,'.clp-hover video');handle=await page.locator('.clp-hover video').elementHandle();await page.getByRole('textbox',{name:'搜索库内容'}).fill('合成');await released(handle);record('search query releases old hover');
    await page.getByRole('textbox',{name:'搜索库内容'}).fill('');await page.locator('.clp-item').filter({hasText:'失效视频'}).hover();await page.waitForFunction(()=>!!document.querySelector('.clp-hover video')?.error);assert.equal(await page.locator('.clp-hover img').count(),1);record('failed video retains existing poster without retry loop');
    await page.keyboard.press('Escape');await page.keyboard.press('Escape');assert.equal(await page.locator('.clp-dialog').count(),0);assert.equal(await page.locator('video').count(),0);record('Escape dismissals release playback');
    await page.getByRole('button',{name:'全屏检查',exact:true}).click();await page.waitForFunction(()=>!!document.fullscreenElement);await card.hover();record('document fullscreen Agent video playback',await playing(page,'.canvas-r1-agent-reference-preview video'));await page.locator('.fixture-toolbar').hover();await page.getByRole('button',{name:'全屏检查',exact:true}).click();
    await page.getByRole('button',{name:'切换主题',exact:true}).click();record('light theme image remains tight',await imageFit(page,'竖图'));
    assert.equal(await page.locator('textarea').inputValue(),'HOVER-ONLY-20261020 · 不发送的合成草稿');assert.deepEqual(await page.evaluate(()=>window.fixtureEvents),['locate']);assert.deepEqual(errors,[]);record('draft/reference list retained; no send/model/apply/remove call; zero page errors');
  }finally{
    fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({checks,errors},null,2)+'\n');await browser?.close();await new Promise(resolve=>server.close(resolve));stop();
  }
  console.log(JSON.stringify({status:'PASS',checks:checks.length,output:dir}));
})().catch(error=>{console.error(error);process.exitCode=1;stop();});
