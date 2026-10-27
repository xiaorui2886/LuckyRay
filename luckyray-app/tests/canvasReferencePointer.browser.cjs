// Real browser mouse/pointer capture smoke against the production composer.
// LR_TEST_TOOLS points to a tooling installation with esbuild and playwright-core.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), assert = require('node:assert/strict');
const tools = require('node:module').createRequire(process.env.LR_TEST_TOOLS + '/package.json');
const {build} = tools('esbuild'), {chromium} = tools('playwright-core');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lr-pointer-browser-'));
 const source=path.resolve('src/CanvasSpike.tsx');
 const fixture=`
 import {createRoot} from 'react-dom/client';
 import {REFERENCE_TEST_PROFILE as profile} from '../tests/fixtures/references/profile';
 const refs=[{id:'a',mentionKey:'a',kind:'image',label:'Image A',mediaUrl:'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="40" height="40"%3E%3Crect width="40" height="40" fill="red"/%3E%3C/svg%3E'},{id:'b',mentionKey:'b',kind:'image',label:'Image B',mediaUrl:'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="40" height="40"%3E%3Crect width="40" height="40" fill="blue"/%3E%3C/svg%3E'}];
 function Fixture(){const [data,setData]=useState({kind:'image',generationPrompt:'Draw',generationReferences:refs});
 const node={id:'n',data};
 (window as any).qa={data,request:createGenerationRequestSnapshot(node as any,[],[],'',[profile.imageModel],profile.imageModel,[profile.videoModel],profile.videoModel,profile)};
 return <MaterialCompactComposer node={node as any} connectedInputs={[]} mediaProfile={profile} imageModels={[profile.imageModel]} defaultImageModel={profile.imageModel} videoModels={[profile.videoModel]} defaultVideoModel={profile.videoModel} embedded={true} onSubmit={()=>{}} onAddReference={()=>{}} onDataChange={patch=>setData(previous=>({...previous,...patch}))} onReorderReferences={(from,to)=>{(window as any).commits=((window as any).commits||0)+1;const entries=createCanvasReferencePlan('image',[],data.generationReferences,undefined,(data as any).generationInputOrder);const plan=planReferenceReorder(entries,from,to);if(plan)setData(previous=>({...previous,generationInputOrder:plan.order}));}}/>;}
 createRoot(document.getElementById('root')!).render(<I18nProvider locale="en-US"><ReactFlowProvider><Fixture/></ReactFlowProvider></I18nProvider>);
 `;
 await build({stdin:{contents:fs.readFileSync(source,'utf8')+fixture,loader:'tsx',resolveDir:path.dirname(source),sourcefile:source},bundle:true,platform:'browser',format:'iife',jsx:'automatic',outfile:path.join(dir,'app.js'),define:{'process.env.NODE_ENV':'"development"'}});
 fs.writeFileSync(path.join(dir,'index.html'),`<link rel="stylesheet" href="/app.css"><style>body{margin:80px;background:#222;color:white}.canvas-generation-composer{width:700px}.canvas-composer-reference-strip{display:flex;gap:14px}.canvas-composer-reference-item{position:relative;display:inline-block;width:60px;height:60px}.canvas-reference-open img{width:60px;height:60px}.canvas-composer-reference-remove{position:absolute;right:0;top:0}.canvas-reference-number{position:absolute;bottom:0;pointer-events:none}</style><div id="root"></div><script src="/app.js"></script>`);
 const server=http.createServer((req,res)=>{const file=path.join(dir,req.url==='/'?'index.html':req.url.slice(1));if(!fs.existsSync(file)){res.writeHead(404).end();return;}res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let browser;
 try {
  browser=await chromium.launch({headless:true,executablePath:process.env.LR_CHROMIUM||'/usr/bin/chromium',args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1100,height:750}});
  await page.goto('http://127.0.0.1:'+server.address().port);
  const chips=page.locator('.canvas-reference-open');await chips.first().waitFor();
  const center=async locator=>{const b=await locator.boundingBox();return{x:b.x+b.width/2,y:b.y+b.height/2};};
  const from=await center(chips.nth(0)),to=await center(chips.nth(1));
  await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(to.x,to.y,{steps:8});
  assert.equal(await page.locator('.is-drop-target').count(),1);
  assert.equal(await page.locator('.is-dragging').count(),1);
  await page.mouse.up();await page.waitForFunction(()=>window.commits===1);
  assert.deepEqual(await page.evaluate(()=>window.qa.data.generationInputOrder),['b','a']);
  assert.deepEqual(await page.evaluate(()=>window.qa.request.references.map(r=>r.id)),['b','a']);
  assert.equal(await page.evaluate(()=>window.qa.data.generationPrompt),'Draw');
  assert.equal(await page.locator('.is-dragging,.is-drop-target').count(),0);
  const second=await center(chips.nth(0));await page.mouse.move(second.x,second.y);await page.mouse.down();await page.mouse.move(1000,650,{steps:8});await page.mouse.up();
  assert.equal(await page.evaluate(()=>window.commits),1);assert.equal(await page.evaluate(()=>window.qa.data.generationPrompt),'Draw');
  await chips.nth(0).click();await page.waitForFunction(()=>window.qa.data.generationPrompt.includes('[[lr-ref:b]]'));
  console.log('PASS: real Chromium pointer capture, live drop highlight, single commit, provider order, outside release, no phantom token, fresh click. Fixture uses production composer; no native WebView/model call.');
 } finally {await browser?.close();server.close();fs.rmSync(dir,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
