// Isolated production adapter + progress view; no real profiles or media writes.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const esbuild=require(require.resolve('esbuild',{paths:[fs.realpathSync(root+'/node_modules/vite')]}));
const {chromium}=require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE||'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@playwright/mcp/node_modules/playwright');
(async()=>{
 const source=fs.readFileSync(root+'/src/features/materials/MaterialsPage.tsx','utf8');
 const component=source.slice(source.indexOf('function ImportProgressOverlay('),source.indexOf('\nfunction ImportModePrompt('));
 const entry=`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{createMaterialLibraryAdapter}from'./src/core/services/materialLibraryAdapter';
 ${component}
 window.messages=[];function Fixture(){const[p,set]=useState({current:0,total:1,label:'导入素材'});window.start=async()=>createMaterialLibraryAdapter({},'frozen-library').importAssets({paths:['fixture.mp4'],onProgress:v=>{window.messages.push(v);set({...v,label:'导入素材'})}});return <ImportProgressOverlay progress={p}/>};createRoot(document.getElementById('root')).render(<Fixture/>);`;
 const stubs={name:'scope-fixtures',setup(build){build.onResolve({filter:/materialLibraryContext$|materialAssetAdapter$|materialCatalog$|@tauri-apps\/api\/core$/},args=>({path:args.path,namespace:'fixture'}));build.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'js',contents:args.path.endsWith('materialLibraryContext')?`export const materialLibrarySession={getSnapshot:()=>({registry:{libraries:[]}}),request:(action,library)=>{window.request={action,library};window.channel=action.progress;return new Promise((resolve,reject)=>{window.finish=()=>resolve({assets:[],skippedDuplicateCount:0,failedItems:[]});window.fail=()=>reject(Error('fixture-failed'))})}};`:args.path.endsWith('materialAssetAdapter')?'export const adaptMaterialAssetMedia=a=>a;':args.path.endsWith('materialCatalog')?'export const toMaterialCatalogError=e=>e;':'export const invoke=()=>{throw Error("dialog not expected")};export class Channel{onmessage=()=>{}};'}));}};
 const bundle=await esbuild.build({stdin:{contents:entry,loader:'tsx',resolveDir:root},bundle:true,write:false,plugins:[stubs]});
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript':'text/html;charset=utf-8');res.end(req.url==='/app.js'?bundle.outputFiles[0].text:'<div id="root"></div><script src="/app.js"></script>')});await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);
 const bar=page.getByRole('progressbar');await bar.waitFor({state:'attached'});assert.equal(await bar.getAttribute('aria-valuenow'),null);
 await page.evaluate(()=>{window.task=window.start()});await page.waitForFunction(()=>window.channel);
 assert.equal(await page.evaluate(()=>window.request.library),'frozen-library');
 await page.evaluate(()=>window.channel.onmessage({current:0,total:1,bytesRead:1073741824,bytesTotal:2147483648}));await page.waitForFunction(()=>document.querySelector('[role=progressbar]').getAttribute('aria-valuenow')==='50');assert.match(await page.getByRole('status').innerText(),/1024 \/ 2048 MB/);
 await page.evaluate(()=>window.channel.onmessage({current:0,total:1,bytesRead:2147483648,bytesTotal:2147483648}));await page.waitForFunction(()=>document.querySelector('[role=progressbar]').getAttribute('aria-valuenow')==='99');
 await page.evaluate(async()=>{window.finish();await window.task});await page.waitForFunction(()=>document.querySelector('[role=progressbar]').getAttribute('aria-valuenow')==='100');
 const count=await page.evaluate(()=>window.messages.length);await page.evaluate(()=>window.channel.onmessage({current:0,total:1}));assert.equal(await page.evaluate(()=>window.messages.length),count);
 await page.evaluate(()=>{window.task=window.start().catch(e=>window.failure=e.message)});await page.evaluate(async()=>{window.fail();await window.task});const failed=await page.evaluate(()=>window.messages.length);await page.evaluate(()=>window.channel.onmessage({current:1,total:1}));assert.equal(await page.evaluate(()=>window.messages.length),failed);assert.equal(await page.evaluate(()=>window.failure),'fixture-failed');
 console.log('IMPORT PROGRESS PASS: production scoped adapter streams bytes, indeterminate preparation, 50%/99%/commit100%, late success/failure messages ignored; mocked Channel transport.');
 }finally{await browser?.close();await new Promise(r=>server.close(r))}
})().catch(e=>{console.error(e);process.exitCode=1});
