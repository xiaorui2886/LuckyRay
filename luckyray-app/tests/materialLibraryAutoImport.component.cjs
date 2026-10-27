const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const esbuild = require(require.resolve('esbuild', { paths: [fs.realpathSync(path.join(root, 'node_modules/vite'))] }));
const { chromium } = require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE);
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {MaterialLibrarySwitcher} from './src/features/materials/MaterialLibrarySwitcher';
import {materialLibrarySession} from './src/core/services/materialLibraryContext';
import {ApplicationModalIsolationProvider,createApplicationModalIsolationStore} from './src/app/applicationModalIsolation';
import './src/core/theme/themeTokens.css';
const registry={legacyId:'A',activeId:'A',libraries:['A','B'].map(id=>({id,name:'合成库 '+id,rootPath:'D:/synthetic/'+id,storageMode:'managed',state:'ready',visible:true,version:0,preferences:{}}))};
window.calls=[];
window.__TAURI_INTERNALS__={invoke:async(command,{request})=>{
 window.calls.push(structuredClone(request));const lib=registry.libraries.find(l=>l.id===request.libraryId);
 if(request.action.op==='registry')return structuredClone(registry);
 if(request.action.op==='libraryWatchRoot')return lib.rootPath;
 if(request.action.op==='preferences'){lib.preferences=request.action.value;return null;}
 throw Error('unexpected '+request.action.op);
}};
materialLibrarySession.initialize().then(()=>createRoot(document.getElementById('root')).render(<ApplicationModalIsolationProvider store={createApplicationModalIsolationStore()}><MaterialLibrarySwitcher/></ApplicationModalIsolationProvider>));
`;
async function run(){
 const built=await esbuild.build({stdin:{contents:entry,resolveDir:root,loader:'tsx'},bundle:true,write:false,outdir:'out',format:'iife',jsx:'automatic',loader:{'.svg':'dataurl','.woff2':'dataurl','.png':'dataurl'},plugins:[{name:'raw-svg',setup(build){build.onLoad({filter:/\.svg\?raw$/},args=>({contents:fs.readFileSync(args.path.slice(0,-4),'utf8'),loader:'text'}));build.onResolve({filter:/\.svg\?raw$/},args=>({path:path.resolve(args.resolveDir,args.path)}));}}]});
 const js=built.outputFiles.find(f=>f.path.endsWith('.js')).text,css=built.outputFiles.find(f=>f.path.endsWith('.css'))?.text||'';
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?js:'<!doctype html><html data-theme="dark"><style>'+css+'</style><div id="root"></div><script src="/app.js"></script>');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{
  browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1000,height:900}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+server.address().port);
  await page.getByRole('button',{name:'管理素材库',exact:true}).click();
  const row=page.locator('section[aria-label="合成库 B"]');const check=row.getByRole('checkbox');
  await page.waitForFunction(()=>!document.querySelector('section[aria-label="合成库 B"] input').disabled);
  assert.equal(await check.isChecked(),false);await check.check();
  await page.waitForFunction(()=>window.calls.some(c=>c.libraryId==='B'&&c.action.op==='preferences'));
  assert.equal(await check.isChecked(),true);
  assert.equal(await page.locator('section[aria-label="合成库 A"]').getByRole('checkbox').isChecked(),false);
  await page.getByRole('button',{name:'完成',exact:true}).click();await page.getByRole('button',{name:'管理素材库',exact:true}).click();
  assert.equal(await check.isChecked(),true,'saved opt-in restored after reopening management');
  await check.uncheck();await page.waitForTimeout(300);
  const commands=await page.evaluate(()=>window.calls);assert.ok(!commands.some(c=>['select','importLibraryRoot','importFolder'].includes(c.action.op)),'configuration does not import real data or switch libraries');
  const prefs=commands.filter(c=>c.action.op==='preferences');assert.ok(prefs.every(c=>c.libraryId==='B'));assert.equal(JSON.parse(prefs.at(-1).action.value['luckyray-material-watch-root-v1']).enabled,false);
  for(const theme of ['dark','light']){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.setViewportSize({width:560,height:750});assert.ok(await page.locator('dialog').evaluate(el=>el.scrollWidth<=el.clientWidth));}
  assert.deepEqual(errors,[]);console.log('MATERIAL-LIBRARY-AUTO-IMPORT-COMPONENT-PASS');
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
}
run().catch(error=>{console.error(error);process.exitCode=1;});
