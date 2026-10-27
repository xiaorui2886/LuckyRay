// Production node + CSS regression: stacked outputs must not leak generation effects.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), assert = require('node:assert/strict');
const {build} = require(process.env.LR_ESBUILD_MODULE || 'esbuild');
const {chromium} = require(process.env.LR_PLAYWRIGHT_MODULE || 'playwright-core');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-generation-presentation-'));
  const fixture = `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {SpikeNodeView,applyGenerationTaskToNodes,I18nProvider,ReactFlowProvider} from './CanvasSpike';
  const image='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="400"><rect width="240" height="400" fill="teal"/></svg>');
  function App(){const [data,setData]=useState({kind:'generator',label:'Image',generationKind:'image',generationTask:{id:'task',status:'running',request:{kind:'image'}},resultMediaUrl:image,resultMediaItems:[{url:image},{url:image+'#2'}]});window.setTask=(status,retryable=true)=>setData(d=>applyGenerationTaskToNodes([{id:'node',data:d}],{...d.generationTask,status,error:{retryable,message:'Check configuration details'}})[0].data);window.clearImage=()=>setData(d=>({...d,resultMediaUrl:undefined,resultMediaItems:[]}));return <I18nProvider locale="zh-CN"><ReactFlowProvider><SpikeNodeView id="node" data={data} selected={true}/></ReactFlowProvider></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);`;
  await build({stdin:{contents:fixture,loader:'tsx',resolveDir:path.resolve('src')},bundle:true,platform:'browser',format:'esm',jsx:'automatic',outfile:path.join(dir,'app.js'),define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'production-node',setup(b){b.onLoad({filter:/[\\/]CanvasSpike\.tsx$/},args=>({contents:fs.readFileSync(args.path,'utf8')+'\nexport {SpikeNodeView,applyGenerationTaskToNodes,I18nProvider,ReactFlowProvider};',loader:'tsx',resolveDir:path.dirname(args.path)}));}}]});
  fs.writeFileSync(path.join(dir,'index.html'),'<link rel="stylesheet" href="/app.css"><style>body{margin:100px;background:#111;color:white}</style><div id="root"></div><script type="module" src="/app.js"></script>');
  const server=http.createServer((req,res)=>{const file=path.join(dir,req.url==='/'?'index.html':req.url.slice(1));if(!fs.existsSync(file)){res.writeHead(404).end();return;}res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
  try {
    browser=await chromium.launch({headless:true,executablePath:process.env.LR_BROWSER_EXECUTABLE||'/usr/bin/chromium',args:['--no-sandbox']});
    const page=await browser.newPage({viewport:{width:1000,height:850}});
    const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
    await page.goto('http://127.0.0.1:'+server.address().port);
    try { await page.waitForSelector('.canvas-generator-process'); }
    catch (error) { throw Error(`Production generation fixture did not mount: ${JSON.stringify(pageErrors)}`, {cause:error}); }
    const running=await page.evaluate(()=>{const output=document.querySelector('.canvas-generator-output'),process=document.querySelector('.canvas-generator-process'),rect=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};};return {overflow:getComputedStyle(output).overflow,clip:getComputedStyle(process).overflow,radius:getComputedStyle(process).borderRadius,outputPseudo:getComputedStyle(output,'::after').content,processPseudo:getComputedStyle(process,'::after').content,output:rect(output),process:rect(process),handles:[...document.querySelectorAll('.canvas-node-handle,.canvas-node-handle-passive')].every(h=>!output.contains(h))};});
    assert.equal(running.overflow,'visible');assert.equal(running.clip,'hidden');assert.notEqual(running.radius,'0px');assert.equal(running.outputPseudo,'none');assert.equal(running.processPseudo,'""');assert.ok(running.handles);assert.ok(Math.abs(running.output.w-running.process.w)<=2);
    await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.locator('.canvas-generator-process').evaluate(el=>getComputedStyle(el,'::after').animationName),'none');
    await page.evaluate(()=>window.setTask('failed'));await page.waitForSelector('.is-card-status');assert.equal(await page.locator('.canvas-generator-process').count(),0);assert.equal(await page.locator('img').count(),1);assert.equal(await page.locator('[role="alert"]').count(),1);assert.equal(await page.locator('.is-card-status button').textContent(),'重试');
    const center=await page.locator('.is-card-status').evaluate(el=>{const a=el.getBoundingClientRect(),b=el.parentElement.getBoundingClientRect();return Math.abs(a.x+a.width/2-b.x-b.width/2)+Math.abs(a.y+a.height/2-b.y-b.height/2);});assert.ok(center<2);
    await page.evaluate(()=>window.setTask('failed',false));await page.waitForTimeout(50);assert.equal(await page.locator('.is-card-status button').count(),0);
    await page.evaluate(()=>window.setTask('cancelled'));await page.waitForTimeout(50);assert.equal(await page.locator('.is-card-status [role="status"]').textContent(),'已取消');assert.equal(await page.locator('img').count(),1);
    await page.evaluate(()=>{window.clearImage();window.setTask('failed');});await page.waitForTimeout(50);assert.equal(await page.locator('.canvas-generator-output-empty').count(),0);assert.equal(await page.locator('.is-card-status').count(),1);
    await page.evaluate(()=>window.setTask('running'));await page.waitForSelector('.canvas-generator-process');assert.equal(await page.locator('.is-card-status').count(),0);
    await page.evaluate(()=>window.setTask('succeeded'));await page.waitForTimeout(50);assert.equal(await page.locator('.is-card-status,.canvas-generator-process').count(),0);
    console.log('PASS: production generation overlay clipping, reduced motion, centered failure/cancel, retryability, retained old result, empty failure and state cleanup.');
  } finally {
    await browser?.close();server.close();
    assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('lr-generation-presentation-'));
    fs.rmSync(dir,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
