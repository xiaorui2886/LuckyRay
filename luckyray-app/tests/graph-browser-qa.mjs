// Isolated, synthetic component check. Does not connect to the user's app/profile.
import {createServer} from 'vite';
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const {chromium} = await import(process.env.LUCKYRAY_QA_PLAYWRIGHT ? pathToFileURL(process.env.LUCKYRAY_QA_PLAYWRIGHT).href : 'playwright');
const root=process.cwd(), out=root+'/output/playwright/'+(process.env.GRAPH_QA_OUTPUT || 'graph-experience');
mkdirSync(out,{recursive:true});
const baseline=process.argv.includes('--baseline');
const count=Number(process.env.GRAPH_QA_COUNT || 900);
const mode=baseline?'baseline':'candidate';
const sourcePath='src/features/graph/GraphPage.tsx';
const source=baseline ? execFileSync('git',['show',(process.env.GRAPH_QA_BASELINE||'e91132c')+':luckyray-app/'+sourcePath],{encoding:'utf8'}) : readFileSync(sourcePath,'utf8');
const instrumented=source.replace('const draw = useCallback((timestamp: number) => {','const draw = useCallback((timestamp: number) => { const qaStart=performance.now(); (window as any).__qa.hover=sceneCacheRef.current.hoverId; (window as any).__qa.hoverHistory.push(sceneCacheRef.current.hoverId);')
 .replace('const openGraphNode = useCallback((node: GraphNode) => {','const openGraphNode = useCallback((node: GraphNode) => { (window as any).__qa.opens++;')
 .replace('  }, [drawArrow]);', '    (window as any).__qa.draws.push(performance.now()-qaStart); (window as any).__qa.alpha=paramsRef.current.alpha; (window as any).__qa.camera={scale:paramsRef.current.scale,panX:paramsRef.current.panX,panY:paramsRef.current.panY}; (window as any).__qa.nodes=sceneCacheRef.current.visibleNodes.filter(n=>!n.hidden).map(n=>({id:n.id,x:n.x*paramsRef.current.scale+paramsRef.current.panX,y:n.y*paramsRef.current.scale+paramsRef.current.panY}));\n  }, [drawArrow]);');
const entry=`import React, {Activity} from 'react';
import {createRoot} from 'react-dom/client';
import GraphPage from '/src/features/graph/GraphPage.tsx';
import {I18nProvider} from '/src/core/i18n/index.ts';
import {graphDataProvider} from '/src/core/services/graph.ts';
import '/src/core/theme/themeTokens.css';
const nodes=Array.from({length:${count}},(_,id)=>({id,key:'note-'+id,entityId:'fixture-'+id,label:'长中文标题与项目资料😀 '+id,type:id%23===0?'tag':id%19===0?'material':'note'}));
const edges=[];for(let i=1;i<nodes.length;i++){if(i%7!==0)edges.push([i,Math.floor(i/5)]);if(i%11===0)edges.push([i,Math.max(0,i-10)]);}
graphDataProvider.buildSeed=async()=>({nodes,edges,source:'real'});
const root=createRoot(document.getElementById('root'));
window.__qaMount=(hidden=false)=>root.render(<I18nProvider locale="zh-CN"><Activity mode={hidden?'hidden':'visible'}><GraphPage/></Activity></I18nProvider>);
window.__qaUnmount=()=>root.render(null);window.__qaMount();`;
const server=await createServer({configFile:false,root,esbuild:{jsx:'automatic'},logLevel:'error',server:{host:'127.0.0.1',port:0},plugins:[{
 name:'graph-qa',enforce:'pre',resolveId(id){if(id==='/graph-qa-entry.js')return '\0graph-qa';},async load(id){if(id==='\0graph-qa'){const {transformWithEsbuild}=await import('vite');return (await transformWithEsbuild(entry,'entry.tsx',{loader:'tsx',jsx:'transform'})).code;}},transform(code,id){if(id.replaceAll('\\','/').endsWith('/'+sourcePath))return instrumented;},
 configureServer(server){server.middlewares.use(async(req,res,next)=>{
 if(req.url==='/graph-qa.html'){res.setHeader('Content-Type','text/html');res.end('<html><style>html,body,#root{margin:0;width:100%;height:100%;display:flex;font-family:Segoe UI;background:var(--bg-base);color:var(--text-primary)}button,input,select{font:inherit}#root{flex-direction:column}</style><div id="root"></div><script type="module" src="/graph-qa-entry.js"></script></html>');}
 else next();
 });}
}],optimizeDeps:{include:['react','react-dom/client']}});
let browser;
try {
 await server.listen();
 browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:Number(process.env.GRAPH_QA_DPR || 1)});
 const errors=[];page.on('pageerror',e=>{errors.push(String(e));console.error('PAGE',String(e));});page.on('console',m=>{if(m.type()==='error')console.error(m.text());});
 await page.addInitScript(()=>{
   window.__qa={draws:[],frames:[],workers:0,opens:0,hoverHistory:[],labelRects:0,textDraws:0};
   const rect=CanvasRenderingContext2D.prototype.fillRect,text=CanvasRenderingContext2D.prototype.fillText;
   CanvasRenderingContext2D.prototype.fillRect=function(x,y,w,h){if(h===18&&w>=24)window.__qa.labelRects++;return rect.call(this,x,y,w,h);};
   CanvasRenderingContext2D.prototype.fillText=function(...args){window.__qa.textDraws++;return text.apply(this,args);};
   const WorkerBase=window.Worker;window.Worker=class extends WorkerBase {constructor(...args){super(...args);window.__qa.workers++;}terminate(){window.__qa.workers--;return super.terminate();}};
   const raf=window.requestAnimationFrame.bind(window);window.requestAnimationFrame=callback=>raf(t=>{const start=performance.now();callback(t);window.__qa.frames.push(performance.now()-start);});
   localStorage.setItem('luckyray-graph-view-v1',JSON.stringify({filters:{material:true,note:true,tag:true,web:true},scale:1.3,panX:0,panY:0}));
 });
 const start=Date.now();await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/graph-qa.html');
 await page.waitForFunction(()=>window.__qa.draws.length>1,{timeout:30000});
 const firstDrawMs=Date.now()-start;
 await page.waitForTimeout(6000);
 await page.screenshot({path:out+'/'+mode+'-dark.png'});
 const summary=values=>{const sorted=values.slice().sort((a,b)=>a-b);return {count:values.length,p50:sorted[Math.floor(sorted.length*.5)]||0,p95:sorted[Math.floor(sorted.length*.95)]||0,max:sorted.at(-1)||0};};
 const initial=await page.evaluate(()=>({draws:window.__qa.draws,frames:window.__qa.frames,workers:window.__qa.workers,heap:performance.memory?.usedJSHeapSize}));
 await page.evaluate(()=>{window.__qa.draws=[];window.__qa.frames=[];});
 const cameraBefore=await page.evaluate(()=>window.__qa.camera);
 await page.mouse.move(500,350);await page.mouse.wheel(0,-300);await page.waitForTimeout(1000);
 const cameraAfter=await page.evaluate(()=>window.__qa.camera);
 assert.ok(Math.abs((500-cameraBefore.panX)/cameraBefore.scale-(500-cameraAfter.panX)/cameraAfter.scale)<0.5, 'cursor-anchored zoom X');
 assert.ok(Math.abs((350-cameraBefore.panY)/cameraBefore.scale-(350-cameraAfter.panY)/cameraAfter.scale)<0.5, 'cursor-anchored zoom Y');
 const panStart=await page.evaluate(()=>({...window.__qa.camera}));
 // Middle mouse always pans, even if a fixture node happens to be at the start.
 await page.mouse.move(30,750);await page.mouse.down({button:'middle'});await page.mouse.move(160,660,{steps:20});await page.mouse.up({button:'middle'});await page.waitForTimeout(1000);
 const panEnd=await page.evaluate(()=>({...window.__qa.camera}));
 const panReleaseError=Math.hypot(panEnd.panX-panStart.panX-130,panEnd.panY-panStart.panY+90);
 if(!baseline) assert.ok(panReleaseError<0.1,`mouse pan stops at release: ${panReleaseError}px`);
 const interaction=await page.evaluate(()=>({draws:window.__qa.draws,frames:window.__qa.frames}));
 await page.waitForFunction(()=>window.__qa.alpha<0.001,{timeout:45000});
 const before=await page.evaluate(()=>window.__qa.draws.length);await page.waitForTimeout(1500);
 const idleDraws=(await page.evaluate(()=>window.__qa.draws.length))-before;
 assert.equal(idleDraws,0,'settled graph stops drawing');
 let hiddenFrames=null, hiddenWorkers=null, resumeDisplacement=null;
 if(!baseline && process.env.GRAPH_QA_EXTENDED){
   const nodesBefore=await page.evaluate(()=>window.__qa.nodes);
   await page.evaluate(()=>window.__qaMount(true));await page.waitForTimeout(400);
   hiddenWorkers=await page.evaluate(()=>window.__qa.workers);assert.equal(hiddenWorkers,0);
   const frames=await page.evaluate(()=>window.__qa.frames.length);await page.waitForTimeout(1000);
   hiddenFrames=(await page.evaluate(()=>window.__qa.frames.length))-frames;assert.equal(hiddenFrames,0);
   await page.evaluate(()=>window.__qaMount());await page.waitForTimeout(300);
   const nodesAfter=await page.evaluate(()=>window.__qa.nodes);
   resumeDisplacement=Math.max(...nodesBefore.map(a=>{const b=nodesAfter.find(b=>b.id===a.id);return b?Math.hypot(a.x-b.x,a.y-b.y):Infinity;}));
   assert.ok(resumeDisplacement<0.1, 'Activity resume must preserve settled node positions');
 }
 if(!baseline && process.env.GRAPH_QA_EXTENDED){
   const point=await page.evaluate(()=>window.__qa.nodes.find(n=>n.x>150&&n.x<900&&n.y>150&&n.y<650));
   assert.ok(point,'visible draggable node');
   await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x+70,point.y+30,{steps:12});await page.mouse.up();
   assert.equal(await page.evaluate(()=>window.__qa.opens),0,'drag must not open a note');
   await page.waitForTimeout(200);
   assert.equal(await page.evaluate(()=>window.__qa.hover),null,'released node must not retain stale hover');
   // Native WebView can deliver another pointermove after release. Reproduce
   // the event order while the node is still at the release point, then keep
   // the mouse still as the production physics moves the node away.
   const moving=await page.evaluate(id=>window.__qa.nodes.find(n=>n.id===id),point.id);
   await page.mouse.move(moving.x,moving.y);await page.mouse.down();
   await page.mouse.move(moving.x+150,moving.y+50,{steps:12});
   await page.evaluate(({x,y})=>{
     window.__qa.hoverHistory=[];
     const canvas=document.querySelector('canvas');
     const init={bubbles:true,pointerId:1,pointerType:'mouse',clientX:x,clientY:y,button:0,buttons:0};
     canvas.dispatchEvent(new PointerEvent('pointerup',init));
     canvas.dispatchEvent(new PointerEvent('pointermove',init));
   },{x:moving.x+150,y:moving.y+50});
   await page.waitForFunction(id=>window.__qa.hoverHistory.includes(id),point.id);
   await page.waitForFunction(()=>window.__qa.hover===null);
   await page.mouse.up();
   // The force comparison can move the old target while the round trip runs.
   // Test the context action on a settled, currently visible node.
   await page.waitForFunction(()=>window.__qa.alpha<.001);
   const node=await page.evaluate(()=>window.__qa.nodes.find(n=>n.x>150&&n.x<900&&n.y>150&&n.y<650));
   assert.ok(node,'settled context target');
   await page.mouse.click(node.x,node.y,{button:'right'});
   await page.locator('.graph-node-menu-item').filter({hasText:'仅看'}).click();
   await page.waitForTimeout(300);assert.ok((await page.locator('.graph-context-scopes').innerText()).includes('1'));
 }
 await page.locator('.graph-side-toggle').click();
 console.log((await page.locator('.graph-side-panel').innerText()).slice(0,700));
 if(!baseline && process.env.GRAPH_QA_EXTENDED){
   await page.getByRole('button',{name:'2 跳',exact:true}).click();
   assert.ok((await page.locator('.graph-context-scopes').innerText()).includes('2'));
   const search=page.locator('.graph-find-input-wrap input');await search.fill('长中文');
   await search.dispatchEvent('keydown',{key:'Enter',isComposing:true});
   assert.equal(await page.locator('.graph-search-scope').count(),0,'IME confirmation must not select a search result');
   await search.press('ArrowDown');await search.press('Enter');
   assert.equal(await page.locator('.graph-search-scope').count(),1);
   await page.locator('.graph-search-scope button').click();
   assert.equal(await page.locator('.graph-search-scope').count(),0);
 }
 if(!baseline){
   await page.getByText('颜色组',{exact:true}).click();await page.getByRole('button',{name:'添加颜色组'}).click();
   await page.getByRole('textbox',{name:'颜色组 1 条件'}).fill('长中文');
   await page.waitForTimeout(500);assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('luckyray-graph-view-v1')).colorGroups[0].query),'长中文');
   await page.getByText('筛选',{exact:true}).click();await page.waitForTimeout(400);
   assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('luckyray-graph-view-v1')).sections.filter),false);
   await page.evaluate(()=>document.documentElement.dataset.theme='light');await page.screenshot({path:out+'/candidate-light.png'});
 }
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('luckyray-graph-view-v1')));
 await page.locator('.graph-side-close').click();
 await page.locator('.graph-more-toggle').click();
 await page.locator('.graph-more-item').first().click();await page.waitForTimeout(500);
 assert.equal(await page.locator('.graph-pane').count(),2);
 await page.screenshot({path:out+'/'+mode+'-split.png'});
 const separator=page.getByRole('separator');const box=await separator.boundingBox();
 await page.mouse.move(box.x+box.width/2,box.y+100);await page.mouse.down();await page.mouse.move(box.x-90,box.y+100,{steps:5});await page.mouse.up();
 assert.equal(await page.locator('.graph-pane').count(),2);
 await page.evaluate(()=>window.__qaUnmount());await page.waitForTimeout(500);
 const workersAfterUnmount=await page.evaluate(()=>window.__qa.workers);assert.equal(workersAfterUnmount,0);
 const framesBefore=await page.evaluate(()=>window.__qa.frames.length);await page.waitForTimeout(1000);
 const framesAfterUnmount=(await page.evaluate(()=>window.__qa.frames.length))-framesBefore;assert.equal(framesAfterUnmount,0);
 if(!baseline){
   await page.evaluate(()=>window.__qaMount());await page.waitForTimeout(500);
   const restored=await page.evaluate(()=>window.__qa.camera);
   assert.ok(Math.abs(restored.scale-saved.scale)<0.001);
   assert.ok(Math.abs(restored.panX-saved.panX)<0.1);
   await page.locator('.graph-side-toggle').click();
   assert.equal(await page.getByRole('textbox',{name:'颜色组 1 条件'}).inputValue(),'长中文');
   assert.equal(await page.locator('details').filter({has:page.getByText('筛选',{exact:true})}).getAttribute('open'),null);
 }
 assert.deepEqual(errors,[]);
 const labelPainting=await page.evaluate(()=>({rectangles:window.__qa.labelRects,text:window.__qa.textDraws}));
 if(!baseline){assert.equal(labelPainting.rectangles,0,'labels do not paint rectangular backgrounds');assert.ok(labelPainting.text>0,'transparent labels still draw text');}
 const result={mode,count,dpr:Number(process.env.GRAPH_QA_DPR || 1),extended:!!process.env.GRAPH_QA_EXTENDED,firstDrawMs,panReleaseError,labelPainting,initial:{draw:summary(initial.draws),frame:summary(initial.frames),workers:initial.workers,heapBytes:initial.heap},interaction:{draw:summary(interaction.draws),frame:summary(interaction.frames)},idleDraws,hiddenFrames,hiddenWorkers,resumeDisplacement,workersAfterUnmount,framesAfterUnmount,saved,errors};
 writeFileSync(out+'/'+mode+'-'+count+'.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
} finally {await browser?.close();await server.close();}
