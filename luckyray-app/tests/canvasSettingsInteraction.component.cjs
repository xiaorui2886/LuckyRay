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
  const css = fs.readFileSync(path.join(root,'src/canvas-spike-scroll.css'),'utf8');
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
    await page.locator('.canvas-settings-anchor > button').click();
    const panel=page.locator('.canvas-settings-panel');await panel.waitFor();
    await panel.locator('.canvas-media-profile-actions button').nth(1).click();
    const input=panel.locator('.canvas-media-profile-editor label input').first();await input.fill('QA unsaved draft');await input.focus();
    const box=await input.boundingBox();
    await page.mouse.move(box.x+box.width-8,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x-45,box.y+box.height/2,{steps:8});await page.mouse.up();
    assert(await panel.isVisible(),'selection drag released outside must not dismiss');assert.equal(await input.inputValue(),'QA unsaved draft');
    await panel.locator('.canvas-settings-heading').click();assert(await panel.isVisible(),'non-focusable interior must not dismiss');
    await panel.locator('.canvas-media-clear-key span').click();assert(await panel.isVisible(),'labels must not dismiss');
    await panel.getByRole('tab',{name:'画布外观'}).click();
    await panel.locator('.canvas-settings-toggle').first().click();assert(await panel.isVisible(),'toggle must not dismiss');
    await page.mouse.click(20,900);assert.equal(await panel.isVisible(),false,'outside click closes');
    await page.locator('.canvas-settings-anchor > button').click();
    await panel.getByRole('tab',{name:'生成配置'}).click();assert.equal(await input.inputValue(),'QA unsaved draft','reopening retains unsaved input');
    await page.keyboard.press('Escape');assert.equal(await panel.isVisible(),false,'Escape closes');
    await page.locator('.canvas-settings-anchor > button').click();assert.equal(await input.inputValue(),'QA unsaved draft','Escape does not discard');
    await panel.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await panel.locator('.canvas-media-profile-editor').count(),0,'explicit cancel discards');
    await page.keyboard.press('Escape');
    const toolbarBefore=await page.locator('.canvas-editor-floating-toolbar').boundingBox();
    await title.dblclick();const name=page.locator('.canvas-editor-title-input');
    const toolbarDuring=await page.locator('.canvas-editor-floating-toolbar').boundingBox();
    assert(Math.abs(toolbarBefore.width-toolbarDuring.width)<1,'rename preserves toolbar width');assert(Math.abs(toolbarBefore.x-toolbarDuring.x)<1,'rename preserves toolbar position');
    await name.fill('Renamed QA');
    await page.evaluate(()=>window.renameDelay=150);await name.press('Enter');await page.mouse.click(20,900);
    await page.waitForFunction(()=>document.querySelector('.canvas-editor-current')?.textContent==='Renamed QA');
    assert.equal(await page.evaluate(()=>window.calls.renames.length),1,'Enter plus blur must only rename once');
    await title.dblclick();await name.fill('Cancel this');await name.press('Escape');
    assert.equal(await title.textContent(),'Renamed QA');assert.equal(await page.evaluate(()=>window.calls.renames.length),1);
    await title.dblclick();await name.fill('   ');await name.press('Enter');assert.equal(await page.evaluate(()=>window.calls.renames.length),1);
    await title.dblclick();await name.press('Enter');assert.equal(await page.evaluate(()=>window.calls.renames.length),1,'unchanged name is no write');
    assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'passed',checks:15,scope:'real CanvasSpike browser UI with synthetic bridge; not native persistence'}));
  } finally {await browser?.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
