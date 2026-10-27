// Actual React sidebar, synthetic store/transport boundaries. Never opens a user profile.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const esbuild = require(require.resolve('esbuild', { paths: [fs.realpathSync(root + '/node_modules/vite')] }));
const { chromium } = require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE || 'playwright');
const mock = `
const state = window.qa = { calls: [], resolve: null, fail: false, noteMissing: false };
export const defineMessages = value => value;
export const useMessages = copy => ({locale:'zh-CN',t:(key,params={}) =>
 Object.entries(params).reduce((s,[k,v])=>s.replace('{'+k+'}',v),copy[key]['zh-CN'])});
const asset={id:'synthetic-video',name:'视频.mp4',kind:'video'};
const snapshot={allAssets:[asset],loaded:true,status:'ready'};
export const materialStore={subscribe:()=>()=>{},getSnapshot:()=>snapshot,ensureSnapshot:async()=>snapshot};
export const resolveMaterialPreviewTarget=()=>null;
export const resolveMaterialLightSeekAttachments=async items=>items.map(a=>({kind:'material',assetId:a.id,canonicalPath:'C:/synthetic/'+a.name,delivery:'file-attachment'}));
export const listNotes=async()=>[{id:'synthetic-note',title:'中文笔记',documentRef:'note'}];
export const getNote=async id=>state.noteMissing?null:{id,documentRef:'note'};
export const knowledgeStore={ensureSnapshot:async()=>({})};
export const resolveKnowledgeDocumentAbsolutePath=()=> 'C:/synthetic/中文笔记.md';
export const openInLightSeek=value=>{state.calls.push(value);return {intentId:'test-'+state.calls.length}};
export const peekUncertainOpenInLightSeekIntentId=()=>null;
export const waitForOpenInLightSeekIntent=()=>new Promise((resolve,reject)=>{state.resolve=()=>state.fail?reject(Error('synthetic-failure')):resolve()});
`;
(async () => {
 const built=await esbuild.build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import Sidebar from './src/features/ai/LightSeekContentBrowser';createRoot(document.getElementById('root')).render(<Sidebar/>);`,resolveDir:root,loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',plugins:[{name:'synthetic-boundaries',setup(build){
  build.onResolve({filter:/core\/(i18n\/index|services\/(knowledgeStore|materialStore|materials|materialCatalog|notes|openInLightSeek))$/},()=>({path:'mock',namespace:'test'}));
  build.onLoad({filter:/.*/,namespace:'test'},()=>({contents:mock,loader:'js'}));
 }}]});
 const css=fs.readFileSync(path.join(root,'src/app/appShell.css'),'utf8');
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?built.outputFiles[0].text:`<style>:root{--accent:#9285ff;--accent-muted:#242036;--bg:#101014;--bg-elevated:#202028;--text:#eee;--muted:#9ca1ad;--border:#30303b}body{margin:0;color:var(--text);background:var(--bg);font-family:sans-serif}${css}.lightseek-content-browser{height:720px}</style><main class="react-nav-shell"><div id="root"></div></main><script src="/app.js"></script>`)});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let browser;
 try {
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:440,height:740}});page.setDefaultTimeout(5000);
  await page.goto('http://127.0.0.1:'+server.address().port);
  const video=page.getByRole('button',{name:'添加到输入框：视频.mp4',exact:true});
  await video.click();
  await page.waitForFunction(()=>window.qa.calls.length===1);
  assert.equal(await video.isDisabled(),true,'busy cards prevent duplicate input');
  assert.equal(await page.locator('.lightseek-content-browser-header,.lightseek-content-preview,.lightseek-content-send').count(),0);
  assert.equal(await page.locator('[role=status]').textContent(),'正在添加…');
  await page.evaluate(()=>window.qa.resolve());
  await page.waitForFunction(()=>document.querySelector('[role=status]').textContent.includes('已放入'));
  assert.equal(await video.isEnabled(),true);
  await page.getByRole('tab',{name:'知识库',exact:true}).click();
  await page.getByRole('button',{name:'添加到输入框：中文笔记',exact:true}).click();
  await page.waitForFunction(()=>window.qa.calls.length===2);
  const note=await page.evaluate(()=>window.qa.calls[1]);
  assert.equal(note.text,'');assert.equal(note.localResources[0].delivery,'file-attachment');
  assert.equal(note.localResources[0].canonicalPath,'C:/synthetic/中文笔记.md');
  assert.equal(await page.locator('.lightseek-content-note-icon svg').count(),1);
  await page.evaluate(()=>{window.qa.fail=true;window.qa.resolve()});
  await page.waitForFunction(()=>document.querySelector('[role=status]').textContent.includes('失败'));
  assert.equal(await page.getByRole('button',{name:'添加到输入框：中文笔记',exact:true}).isEnabled(),true,'failed delivery restores interaction');
  await page.evaluate(()=>window.qa.noteMissing=true);
  await page.getByRole('button',{name:'添加到输入框：中文笔记',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.lightseek-content-note').disabled);
  assert.equal(await page.evaluate(()=>window.qa.calls.length),2,'missing note cannot dispatch a guessed path');
  if(process.env.LUCKYRAY_SIDEBAR_SCREENSHOT){await page.screenshot({path:process.env.LUCKYRAY_SIDEBAR_SCREENSHOT});}
  console.log('PASS: direct material/note click, pending input guard, failure recovery, missing note, compact layout and note icon');
 } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1});
