const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.LR_PLAYWRIGHT_MODULE||'playwright-core');
const dir=path.resolve(process.argv[2]||'output/playwright/canvas-group-drag');
const diagnostic=process.env.LR_GROUP_DIAGNOSTIC_ONLY==='1';
const server=http.createServer((req,res)=>{const pathname=req.url.split('?')[0];const file=path.resolve(dir,'.'+(pathname==='/'?'/index.html':pathname));if(!file.startsWith(dir+path.sep)||!fs.existsSync(file)){res.writeHead(404).end();return;}res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');fs.createReadStream(file).pipe(res);});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;const results=[];try{
 browser=await chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage({viewport:{width:1360,height:950}});page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 for(const snap of [false,true]){
  await page.goto('http://127.0.0.1:'+server.address().port+(snap?'/?snap=1':'/'));await page.waitForFunction(()=>window.getGridNodes?.().some(n=>n.parentId&&n.measured?.width));
  const original=await page.evaluate(()=>window.getGridNodes().find(n=>n.data.kind==='group').position);
  const handle=page.locator('.canvas-group-drag-handle').first(),box=await handle.boundingBox();
  const x=box.x+box.width/2,y=box.y+box.height/2;
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+3,y+3);await page.waitForTimeout(80);
  await page.evaluate(()=>{window.__cardRenders={};});
  const samples=[];
  for(let i=1;i<=24;i++){
   await page.mouse.move(x+i*5,y+Math.sin(i/4)*20);
   await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>r())));
   samples.push(await page.evaluate(()=>{const child=window.getGridNodes().find(n=>n.parentId),parent=document.querySelector(`[data-id="${child.parentId}"]`).getBoundingClientRect(),el=document.querySelector(`[data-id="${child.id}"]`).getBoundingClientRect();return {lagX:el.x-parent.x-child.position.x*.65,lagY:el.y-parent.y-child.position.y*.65,groupX:window.getGridNodes().find(n=>n.id===child.parentId).position.x};}));
  }
  const childRenders=await page.evaluate(()=>window.getGridNodes().filter(n=>n.parentId).reduce((sum,n)=>sum+(window.__cardRenders[n.id]||0),0));
  if(!diagnostic)assert.equal(childRenders,0,'position changes must not re-render all grouped card contents');
  const uniqueGroupPositions=new Set(samples.map(s=>s.groupX)).size;
  if(!diagnostic)assert.ok(uniqueGroupPositions>=23,'group movement must remain continuous with grid alignment enabled');
  await page.waitForTimeout(650);const heldSaves=await page.evaluate(()=>window.__saved.length);
  if(!diagnostic)assert.equal(heldSaves,0,'held group drag must not serialize a thumbnail/document');
  await page.mouse.up();
  await page.waitForFunction(()=>window.__saved.length>0);
  const dropped=await page.evaluate(()=>window.getGridNodes().find(n=>n.data.kind==='group').position);
  if(snap){assert.equal(dropped.x%28,0);assert.equal(dropped.y%28,0);}
  assert.equal(await page.locator('.react-flow__edge').count(),9);
  await page.getByRole('button',{name:'撤销 Ctrl+Z',exact:true}).click();
  await page.waitForFunction(p=>{const n=window.getGridNodes().find(n=>n.data.kind==='group');return n.position.x===p.x&&n.position.y===p.y;},original);
  await page.getByRole('button',{name:'重做 Ctrl+Y',exact:true}).click();
  await page.waitForFunction(p=>{const n=window.getGridNodes().find(n=>n.data.kind==='group');return n.position.x===p.x&&n.position.y===p.y;},dropped);
  const maxLagPx=Math.max(...samples.map(s=>Math.hypot(s.lagX,s.lagY)));if(!diagnostic)assert.ok(maxLagPx<1,'group children must follow without CSS easing lag');
  results.push({snap,maxLagPx,childRenders,uniqueGroupPositions,heldSaves,original,dropped,samples,undoRedo:'PASS',saveAfterDrop:'PASS',provenanceEdges:9});
 }
 assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(dir,'group-drag-result.json'),JSON.stringify({mode:diagnostic?'diagnostic':'regression',scope:'Windows Edge, full production CanvasInner with synthetic in-memory storage; no real profile, native DB, model or network requests',results,errors},null,2));
 console.log(JSON.stringify(results.map(({samples,...result})=>result)));
 }finally{await browser?.close();server.close();}})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
