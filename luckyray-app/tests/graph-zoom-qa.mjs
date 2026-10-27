// Isolated, synthetic component check. Does not connect to the user's app/profile.
import {createServer} from 'vite';
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const {chromium} = await import(process.env.LUCKYRAY_QA_PLAYWRIGHT ? pathToFileURL(process.env.LUCKYRAY_QA_PLAYWRIGHT).href : 'playwright');
const root=process.cwd(), out=root+'/output/playwright/'+(process.env.GRAPH_QA_OUTPUT||'graph-zoom-r2');
mkdirSync(out,{recursive:true});
const baseline=process.argv.includes('--baseline');
const count=Number(process.env.GRAPH_QA_COUNT || 1800);
const topology=process.env.GRAPH_QA_TOPOLOGY || 'forest';
const mode=baseline?'baseline':'candidate';
const sourcePath='src/features/graph/GraphPage.tsx';
const baselineRef=process.env.GRAPH_QA_BASELINE||'fba7865';
const source=baseline ? execFileSync('git',['show',baselineRef+':luckyray-app/'+sourcePath],{encoding:'utf8'}) : readFileSync(sourcePath,'utf8');
const physicsBaseline=baseline&&process.env.GRAPH_QA_BASELINE?new Map(['graphPhysics.ts','graphSpatial.ts'].map(file=>['/src/features/graph/'+file,execFileSync('git',['show',baselineRef+':luckyray-app/src/features/graph/'+file],{encoding:'utf8'})])):new Map();
const trace = `
 const qa = window.__qa, p=paramsRef.current;
 qa.alpha=p.alpha; qa.camera={scale:p.scale,panX:p.panX,panY:p.panY};
 qa.nodes=sceneCacheRef.current.visibleNodes.filter(n=>!n.hidden).map(n=>({id:n.id,x:n.x,y:n.y}));
 const record={t:performance.now(),camera:{...qa.camera},drawMs:performance.now()-qaStart,labels:qa.labelIds||[],inputs:qa.inputs.length};
 qa.trace.push(record);
 qa.nativeRaf(()=>{record.nextRaf=performance.now();});
`;
const instrumented=source.replace('const draw = useCallback((timestamp: number) => {','const draw = useCallback((timestamp: number) => { const qaStart=performance.now(); (window as any).__qa.labelIds=[];')
 .replace('  }, [drawArrow]);', trace+'\n  }, [drawArrow]);');
const presentationPath='src/features/graph/graphPresentation.ts';
const presentation=baseline?execFileSync('git',['show',baselineRef+':luckyray-app/'+presentationPath],{encoding:'utf8'}):readFileSync(presentationPath,'utf8');
const instrumentedPresentation=presentation.replace('  return result;\n}', '  (window as any).__qa.labelIds=result.map(c=>c.id); return result;\n}');
const entry=`import React, {Activity} from 'react';
import {createRoot} from 'react-dom/client';
import GraphPage from '/src/features/graph/GraphPage.tsx';
import {I18nProvider} from '/src/core/i18n/index.ts';
import {graphDataProvider} from '/src/core/services/graph.ts';
import '/src/core/theme/themeTokens.css';
const nodes=Array.from({length:${count}},(_,id)=>({id,key:'note-'+id,entityId:'fixture-'+id,label:'长中文标题与项目资料😀 '+id,type:id%23===0?'tag':id%19===0?'material':'note'}));
const edges=[];for(let i=1;i<nodes.length;i++){if('${topology}'==='isolated')continue;if('${topology}'==='clusters'){if(i%40)edges.push([i,Math.floor(i/40)*40+Math.floor(i%40/4)]);}else{if(i%7!==0)edges.push([i,Math.floor(i/5)]);if(i%11===0)edges.push([i,Math.max(0,i-10)]);}}
graphDataProvider.buildSeed=async()=>({nodes,edges,source:'real'});
const root=createRoot(document.getElementById('root'));
window.__qaMount=(hidden=false)=>root.render(<I18nProvider locale="zh-CN"><Activity mode={hidden?'hidden':'visible'}><GraphPage/></Activity></I18nProvider>);
window.__qaUnmount=()=>root.render(null);window.__qaMount();`;
const server=await createServer({configFile:false,root,esbuild:{jsx:'automatic'},logLevel:'error',server:{host:'127.0.0.1',port:0},plugins:[{
 name:'graph-qa',enforce:'pre',resolveId(id){if(id==='/graph-qa-entry.js')return '\0graph-qa';},async load(id){if(id==='\0graph-qa'){const {transformWithEsbuild}=await import('vite');return (await transformWithEsbuild(entry,'entry.tsx',{loader:'tsx',jsx:'transform'})).code;}},transform(code,id){if(id.replaceAll('\\','/').endsWith('/'+sourcePath))return instrumented; if(id.replaceAll('\\','/').endsWith('/'+presentationPath))return instrumentedPresentation; for(const [path,source] of physicsBaseline)if(id.replaceAll('\\','/').endsWith(path))return source;},
 configureServer(server){server.middlewares.use(async(req,res,next)=>{
 if(req.url==='/graph-qa.html'){res.setHeader('Content-Type','text/html');res.end('<html><style>html,body,#root{margin:0;width:100%;height:100%;display:flex;font-family:Segoe UI;background:var(--bg-base);color:var(--text-primary)}button,input,select{font:inherit}#root{flex-direction:column}</style><div id="root"></div><script type="module" src="/graph-qa-entry.js"></script></html>');}
 else next();
 });}
}],optimizeDeps:{include:['react','react-dom/client']}});
let browser;
const summary=values=>{const s=values.slice().sort((a,b)=>a-b);return {count:s.length,p50:s[Math.floor(s.length*.5)]||0,p95:s[Math.floor(s.length*.95)]||0,max:s.at(-1)||0};};
try {
 await server.listen();
 browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:Number(process.env.GRAPH_QA_DPR||1)});
 const errors=[]; page.on('pageerror',e=>errors.push(String(e)));
 await page.addInitScript(()=>{
   window.__qa={trace:[],inputs:[],workers:0,callbacks:0};
   const q=window.__qa;
   q.nativeRaf=window.requestAnimationFrame.bind(window);
   window.requestAnimationFrame=callback=>q.nativeRaf(t=>{q.callbacks++;callback(t);});
   const Base=window.Worker;window.Worker=class extends Base {constructor(...args){super(...args);q.workers++;}terminate(){q.workers--;super.terminate();}};
   document.addEventListener('wheel',e=>q.inputs.push({t:performance.now(),x:e.clientX,y:e.clientY,delta:e.deltaY,camera:{...q.camera}}),true);
   // Reproducible R1 random seeds; R2 derives each node position from its key.
   let seed=379;Math.random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
   localStorage.setItem('luckyray-graph-view-v1',JSON.stringify({filters:{note:true,material:true,tag:true,web:true},scale:1,panX:0,panY:0}));
 });
 await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/graph-qa.html');
 await page.waitForFunction(()=>window.__qa.alpha<.001,null,{timeout:60000});
 await page.waitForTimeout(400);
 const world=await page.evaluate(()=>window.__qa.nodes);
 const extent={width:Math.max(...world.map(n=>n.x))-Math.min(...world.map(n=>n.x)),height:Math.max(...world.map(n=>n.y))-Math.min(...world.map(n=>n.y))};
 await page.locator('.graph-side-toggle').click();
 await page.getByText('力度',{exact:true}).click();
 await page.getByRole('button',{name:'恢复聚焦',exact:true}).click();
 await page.locator('.graph-side-close').click();
 await page.mouse.move(5,5);await page.waitForTimeout(400);
 await page.screenshot({path:out+'/'+mode+'-'+count+'-overview.png'});
 const overview=await page.evaluate(()=>window.__qa.camera);
 const stages=[];
 async function gesture(name,x,y,deltas,delay=18) {
   await page.mouse.move(x,y);await page.waitForTimeout(80);
   await page.evaluate(()=>{window.__qa.trace=[];window.__qa.inputs=[];});
   for(const delta of deltas) {await page.mouse.wheel(0,delta);if(delay)await page.waitForTimeout(delay);}
   await page.waitForTimeout(600);
   const data=await page.evaluate(()=>({trace:window.__qa.trace,inputs:window.__qa.inputs,camera:window.__qa.camera}));
   const latencies=[],paintOpportunities=[],anchorDrifts=[],directions=[];
   for (let i=0;i<data.inputs.length;i++) {
     const input=data.inputs[i], frame=data.trace.find(f=>f.t>=input.t&&f.inputs>=i+1);
     if(!frame) continue;
     latencies.push(frame.t-input.t); if(frame.nextRaf)paintOpportunities.push(frame.nextRaf-input.t);
     const worldX=(input.x-input.camera.panX)/input.camera.scale, worldY=(input.y-input.camera.panY)/input.camera.scale;
     anchorDrifts.push(Math.hypot(worldX*frame.camera.scale+frame.camera.panX-input.x,worldY*frame.camera.scale+frame.camera.panY-input.y));
     directions.push(Math.sign(frame.camera.scale-input.camera.scale)===-Math.sign(input.delta));
   }
   const lastInput=data.inputs.at(-1).t;
   const moving=data.trace.filter((f,i)=>i&&Math.abs(Math.log(f.camera.scale/data.trace[i-1].camera.scale))>1e-7);
   const stopMs=Math.max(0,(moving.at(-1)?.t||lastInput)-lastInput);
   let churn=0;for(let i=1;i<data.trace.length;i++){const a=new Set(data.trace[i-1].labels),b=new Set(data.trace[i].labels);churn += [...a].filter(id=>!b.has(id)).length+[...b].filter(id=>!a.has(id)).length;}
   const record={name,events:data.inputs.length,draw:summary(data.trace.map(f=>f.drawMs)),eventToDraw:summary(latencies),eventToNextRaf:summary(paintOpportunities),frameIntervals:summary(moving.slice(1).map((f,i)=>f.t-moving[i].t)),stopMs,maxAnchorDrift:Math.max(0,...anchorDrifts),directionsCorrect:directions.every(Boolean),labelChurn:churn,finalLabelCount:data.trace.at(-1)?.labels.length||0,camera:data.camera};
   stages.push(record);
   writeFileSync(out+'/'+mode+'-'+count+'-'+name+'-trace.json',JSON.stringify(data));
   if(!baseline){assert.ok(record.maxAnchorDrift<.5, name+' anchor');assert.ok(stopMs<350,name+' stopping');assert.ok(record.directionsCorrect,name+' reverse response');}
 }
 await gesture('direction-change',540,360,[-100,1,1,1],0);
 await gesture('forward',540,360,Array(14).fill(-55));
 await page.screenshot({path:out+'/'+mode+'-'+count+'-detail.png'});
 // Reverse while the previous direction still has outstanding movement.
 await gesture('reverse',740,460,[-180,4,4,4,4],0);
 await gesture('return',380,280,Array(14).fill(55));
 const after=await page.evaluate(()=>window.__qa.nodes);
 const displacement=Math.max(...world.map((a,i)=>Math.hypot(a.x-after[i].x,a.y-after[i].y)));
 assert.ok(displacement<.001,'zoom must not reheat or rearrange the graph');
 const beforeIdle=await page.evaluate(()=>window.__qa.callbacks);await page.waitForTimeout(1000);
 const idleFrames=await page.evaluate(n=>window.__qa.callbacks-n,beforeIdle);assert.equal(idleFrames,0);
 await page.evaluate(()=>window.__qaMount(true));await page.waitForTimeout(300);
 const beforeHidden=await page.evaluate(()=>window.__qa.callbacks);await page.waitForTimeout(800);
 const hidden=await page.evaluate(n=>({callbacks:window.__qa.callbacks-n,workers:window.__qa.workers}),beforeHidden);
 assert.deepEqual(hidden,{callbacks:0,workers:0});
 await page.evaluate(()=>window.__qaMount());await page.waitForTimeout(300);
 const resumed=await page.evaluate(()=>window.__qa.nodes);
 const resumeDisplacement=Math.max(...after.map((a,i)=>Math.hypot(a.x-resumed[i].x,a.y-resumed[i].y)));
 assert.ok(resumeDisplacement<.001);
 await page.evaluate(()=>window.__qaUnmount());await page.waitForTimeout(300);
 assert.equal(await page.evaluate(()=>window.__qa.workers),0);
 assert.deepEqual(errors,[]);
 const result={mode,count,topology,dpr:Number(process.env.GRAPH_QA_DPR||1),viewport:{width:1280,height:800},extent,overview,stages,displacement,idleFrames,hidden,resumeDisplacement,errors};
 writeFileSync(out+'/'+mode+'-'+count+'.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
} finally {await browser?.close();await server.close();}
