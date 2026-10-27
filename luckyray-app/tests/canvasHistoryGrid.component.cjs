const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const esbuild = require(require.resolve('esbuild', { paths: [fs.realpathSync(root + '/node_modules/vite')] }));
const { chromium } = require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const entry = `import React from 'react';import {createRoot} from 'react-dom/client';import CanvasSpike from './src/CanvasSpike';
  let canvas={canvasId:'qa',id:'qa',name:'QA canvas',createdAt:'2026-01-01',updatedAt:'2026-01-01',nodes:[],edges:[],viewport:{x:0,y:0,zoom:1},generationHistory:[],revision:1,contentDigest:'qa-1'};
  const image='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#567c9d"/></svg>');
  canvas.generationHistory=['image','video','text'].map((kind,index)=>({version:4,id:'history:'+kind,taskId:'task:'+kind,sourceNodeId:'source:'+kind,resultNodeId:'result:'+kind,kind,status:'succeeded',request:{kind,prompt:'Fixture '+kind,model:'qa-'+kind,references:[]},attempt:1,prompt:'Fixture '+kind,model:'qa-'+kind,createdAt:'2026-01-01T12:00:00Z',updatedAt:'2026-01-01T12:00:00Z',...(kind==='text'?{outputText:'Readable generated text sample'}:{outputMediaUrl:image,outputThumbnailUrl:image})}));
  window.calls={renames:[],saves:[],settings:[]};window.renameDelay=0;
  window.__TAURI_INTERNALS__={invoke:async(command)=>{
    if(command==='canvas_media_profiles_list')return {version:1,activeProfileId:'qa-media',profiles:[{id:'qa-media',name:'QA Media',baseUrl:'https://example.test/v1',imageModel:'qa-image',videoModel:'qa-video',imageProtocol:'openai-image',videoProtocol:'disabled',revision:1,apiKeyConfigured:true}]};
    if(command==='plugin:sql|load')return 'sqlite:qa';
    if(command==='plugin:sql|select')return [];
    throw new Error('Synthetic fixture: unsupported command');
  }};
  window.__LUCKYRAY__={
   getSettings:async()=>({aiProvider:'custom',aiModel:'qa-text',aiImageModel:'qa-image',aiVideoModel:'qa-video',aiImageBaseURL:'https://example.test/v1',aiImageApiKeyConfigured:true}),
   setSettings:async patch=>{window.calls.settings.push(patch);return patch;},
   listCanvases:async()=>[{...canvas}],loadCanvas:async()=>({...canvas}),
   saveCanvas:async value=>{window.calls.saves.push(value);canvas={...canvas,...value,revision:canvas.revision+1};return {...canvas};},
   renameCanvas:async(id,name)=>{window.calls.renames.push({id,name});await new Promise(r=>setTimeout(r,window.renameDelay));canvas={...canvas,name,revision:canvas.revision+1};return {...canvas};},
   saveCanvasThumbnail:async()=>{},getCanvasThumbnailUrl:()=>'',getCanvasStorageDir:async()=>'',
   getAppSettings:async()=>({}),listAssets:async()=>[],listNotes:async()=>[],listTags:async()=>[]
  };createRoot(document.getElementById('root')).render(<CanvasSpike/>);`;
  const built = await esbuild.build({stdin:{contents:entry,resolveDir:root,loader:'tsx'},bundle:true,write:false,format:'esm',platform:'browser',jsx:'automatic',loader:{'.css':'empty'}});
  const css = fs.readFileSync(path.join(root,'src/canvas-spike-scroll.css'),'utf8') + fs.readFileSync(path.join(root,'src/features/canvas/canvas-history-grid.css'),'utf8');
  const server = http.createServer((req,res)=>{
    res.setHeader('Content-Type',req.url==='/fixture.js'?'text/javascript':req.url==='/style.css'?'text/css':'text/html');
    res.end(req.url==='/fixture.js'?built.outputFiles[0].text:req.url==='/style.css'?css:'<style>html,body,#root{margin:0;height:100%;background:#111;color:#eee}body{--text-primary:#eee;--theme-border-strong:#555;--theme-glass-bg:#222}</style><link rel="stylesheet" href="/style.css"><div id="root"></div><script type="module" src="/fixture.js"></script>');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let browser;
  try {
    browser=await chromium.launch(process.env.LUCKYRAY_BROWSER_EXECUTABLE?{headless:true,executablePath:process.env.LUCKYRAY_BROWSER_EXECUTABLE}:{headless:true,channel:'msedge'});
    const page=await browser.newPage({viewport:{width:1440,height:1080}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:'+server.address().port);
    const title=page.locator('.canvas-editor-current');
    await title.filter({hasText:'QA canvas'}).waitFor();
    await page.locator('.canvas-generation-history-anchor > button').click();
    const panel=page.locator('.canvas-generation-history-panel');await panel.waitFor();
    assert.equal(await panel.locator('.is-grid article').count(),3);
    assert.equal(await panel.locator('.canvas-generation-history-actions:visible').count(),0,'actions hidden until requested');
    assert.equal(await panel.locator('.canvas-history-text-thumbnail').textContent(),'Readable generated text sample');
    const grid=await panel.locator('.canvas-generation-history-list').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length);
    assert.equal(grid,2,'two thumbnail columns');
    const thumb=await panel.locator('.canvas-generation-history-preview').first().boundingBox();assert(Math.abs(thumb.width-thumb.height)<2,'square thumbnail');
    await panel.locator('.canvas-history-kind-tabs button').nth(1).click();assert.equal(await panel.locator('article').count(),1);assert(await panel.locator('article').evaluate(el=>el.classList.contains('kind-image')));
    await panel.locator('.canvas-history-kind-tabs button').nth(2).click();assert.equal(await panel.locator('article').count(),1);assert(await panel.locator('article').evaluate(el=>el.classList.contains('kind-video')));
    await panel.locator('.canvas-history-kind-tabs button').nth(0).click();
    await panel.locator('.canvas-history-view-toggle button').nth(1).click();assert.equal(await panel.locator('.is-list article').count(),3);
    const more=panel.locator('summary').first();await more.focus();await page.keyboard.press('Enter');
    assert.equal(await panel.locator('details[open]').count(),1);assert(await panel.locator('.canvas-generation-history-actions').first().isVisible());
    assert.equal(await panel.locator('.canvas-generation-history-actions').first().locator('button').count(),7,'all image actions retained');
    await page.keyboard.press('Escape');assert.equal(await panel.locator('details[open]').count(),0);assert(await panel.isVisible(),'Escape dismisses disclosure before panel');assert(await more.evaluate(el=>el===document.activeElement));
    await more.click();await panel.locator('.canvas-generation-history-search').click();assert.equal(await panel.locator('details[open]').count(),0,'outside disclosure closes it');assert(await panel.isVisible());
    await panel.locator('.canvas-generation-history-search').fill('Fixture text');assert.equal(await panel.locator('article').count(),1);await panel.locator('.canvas-generation-history-search').fill('');
    await page.mouse.click(20,900);assert.equal(await panel.isVisible(),false,'outside panel closes');
    await page.locator('.canvas-generation-history-anchor > button').click();assert.equal(await panel.locator('details[open]').count(),0,'reopening has no stale disclosure');
    await page.keyboard.press('Escape');assert.equal(await panel.isVisible(),false);
    assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'passed',checks:20,scope:'real CanvasSpike history grid/list with synthetic immutable history; no live generation'}));
  } finally {await browser?.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
