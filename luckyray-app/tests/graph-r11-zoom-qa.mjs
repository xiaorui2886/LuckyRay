// Production component and worker with synthetic seeds only. No user profile access.
import {createServer,transformWithEsbuild} from 'vite';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const {chromium}=await import(pathToFileURL(process.env.LUCKYRAY_QA_PLAYWRIGHT).href);
const root=process.cwd(),ref=process.env.GRAPH_QA_REF;
const out=root+'/output/playwright/'+(process.env.GRAPH_QA_OUTPUT||'graph-r11-zoom');mkdirSync(out,{recursive:true});
const load=p=>ref?execFileSync('git',['show',ref+':luckyray-app/'+p],{encoding:'utf8'}):readFileSync(p,'utf8');
let source=load('src/features/graph/GraphPage.tsx');
source=source.replace('const draw = useCallback((timestamp: number) => {',`const draw = useCallback((timestamp: number) => { const qaLabels:any[]=[];`)
.replace('ctx.fillText(label.text, label.left + 4, label.top + 2);',`ctx.fillText(label.text, label.left + 4, label.top + 2); qaLabels.push({...label,opacity:ctx.globalAlpha,renderedFont:ctx.font,renderedWidth:ctx.measureText(label.text).width});`)
.replace('  }, [drawArrow]);',`const q=(window as any).__r8,p=paramsRef.current; q.draws++;q.ms=performance.now()-timestamp;q.camera={scale:p.scale,panX:p.panX,panY:p.panY};q.alpha=p.alpha;q.nodes=sceneCacheRef.current.visibleNodes.filter(n=>!n.hidden).map(n=>({id:n.id,x:n.x*p.scale+p.panX,y:n.y*p.scale+p.panY}));q.labels=qaLabels;q.candidates=labels;q.memory=labelMemoryRef.current.size;q.active=revealActiveRef.current;q.elapsed=revealTimeline?timestamp-revealTimeline.startedAt:0;q.duration=revealTimeline?.totalDuration;q.count=revealedNodes.size;q.width=width;q.height=height;q.drag=draggingNodeRef.current?.id;q.hover=hoveredRef.current?.id;q.fit=()=>{const c=fitGraphCamera(sceneCacheRef.current.visibleNodes,width,height);if(c){setCameraImmediately(c);markGraphDirty("viewport");}};q.move=(scale:number,x:number,y:number)=>{setCameraImmediately({scale,panX:x,panY:y});markGraphDirty('viewport');};if(q.record)q.frames.push({t:timestamp,active:q.active,count:q.count,camera:q.camera,alpha:q.alpha,drag:q.drag,hover:q.hover,focus:q.labels.filter(l=>l.priority===3).map(l=>l.id),node:q.nodes.find(n=>n.id===q.tracked)});\n }, [drawArrow]);`);
const entry=`import React,{Activity} from 'react';import {createRoot} from 'react-dom/client';import GraphPage from '/src/features/graph/GraphPage.tsx';import {I18nProvider} from '/src/core/i18n/index.ts';import {graphDataProvider} from '/src/core/services/graph.ts';import '/src/core/theme/themeTokens.css';
const url=new URL(location.href),count=Number(url.searchParams.get('count')||1),isolates=url.searchParams.has('isolates');
const nodes=Array.from({length:count},(_,id)=>({id,key:'r8-'+id,entityId:'fixture-'+id,label:'长中文名称与资料引用😀 '.repeat(4)+id,type:'note',timelineAt:100000+id*1000}));
const edges=[];if(!isolates)for(let i=1;i<count;i++){if(i%5!==0)edges.push([i,Math.floor(i/5)]);if(i%11===0)edges.push([i,i-1]);}
graphDataProvider.buildSeed=async()=>({nodes,edges,source:'real'});const root=createRoot(document.getElementById('root'));window.__mount=(hidden=false)=>root.render(<I18nProvider locale="zh-CN"><Activity mode={hidden?'hidden':'visible'}><GraphPage/></Activity></I18nProvider>);window.__unmount=()=>root.render(null);window.__mount();`;
const files=new Map(['src/core/services/graphPlayback.ts','src/features/graph/graphPresentation.ts','src/features/graph/graphCamera.ts'].map(p=>[p,load(p)]));
const server=await createServer({configFile:false,root,esbuild:{jsx:'automatic'},logLevel:'error',server:{host:'127.0.0.1',port:0},plugins:[{name:'r8',enforce:'pre',resolveId(id){if(id==='/entry.js')return '\0r8';},async load(id){if(id==='\0r8')return(await transformWithEsbuild(entry,'entry.tsx',{loader:'tsx',jsx:'transform'})).code;},transform(code,id){id=id.replaceAll('\\','/');if(id.endsWith('/src/features/graph/GraphPage.tsx'))return source;for(const[p,s]of files)if(id.endsWith('/'+p))return s;},configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url.startsWith('/qa')){res.setHeader('Content-Type','text/html');res.end('<style>html,body,#root{margin:0;width:100%;height:100%;display:flex;background:var(--bg-base);color:var(--text-primary)}#root{flex-direction:column}</style><div id="root"></div><script type="module" src="/entry.js"></script>');}else next();});}}]});
let browser;const result={ref:ref||'candidate',viewports:[],errors:[]};
try{
 await server.listen();browser=await chromium.launch({channel:'msedge',headless:true});
 for(const viewport of [{width:1280,height:800},{width:2560,height:1392}]){
  const page=await browser.newPage({viewport,deviceScaleFactor:2});page.on('pageerror',e=>result.errors.push(String(e)));
  await page.addInitScript(()=>{window.__r8={draws:0,frames:[],record:false};localStorage.setItem('luckyray-graph-view-v1',JSON.stringify({filters:{note:true},scale:.9,panX:0,panY:0,spatialVersion:3,labelReveal:.25}));});
  await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/qa?count=1800');await page.waitForFunction(()=>window.__r8.alpha<.001,null,{timeout:60000});
  const row={viewport,detail:[],wheel:[]};result.viewports.push(row);
  await page.evaluate(()=>window.__r8.fit());await page.waitForTimeout(150);
  row.fit=await page.evaluate(()=>({camera:window.__r8.camera,labels:window.__r8.labels.length,alpha:window.__r8.candidates[0].alpha}));
  for(const scale of [.5,.7,.9,1,1.2,1.5,2,3]){
   await page.evaluate(scale=>{const q=window.__r8,n=q.nodes[0],p=q.camera;const wx=(n.x-p.panX)/p.scale,wy=(n.y-p.panY)/p.scale;q.move(scale,q.width*.31-wx*scale,q.height*.42-wy*scale);},scale);
   await page.waitForTimeout(80);
   row.detail.push(await page.evaluate(()=>({scale:window.__r8.camera.scale,alpha:window.__r8.candidates[0].alpha,labels:window.__r8.labels.length})));
  }
  if(!ref){assert.ok(row.detail.filter(r=>r.scale<=1).every(r=>r.alpha===0&&r.labels===0));assert.ok(row.detail.find(r=>r.scale===1.2).alpha<.08);}
  const pointer=await page.evaluate(()=>{const q=window.__r8,n=q.nodes[0],p=q.camera;const wx=(n.x-p.panX)/p.scale,wy=(n.y-p.panY)/p.scale;q.move(.7,q.width*.31-wx*.7,q.height*.42-wy*.7);return {x:q.width*.31+2,y:q.height*.42-1};});
  await page.waitForTimeout(100);const canvas=await page.locator('canvas').first().boundingBox();
  await page.mouse.move(canvas.x+pointer.x,canvas.y+pointer.y);await page.waitForTimeout(80);
  const origin=await page.evaluate(()=>{const q=window.__r8;q.tracked=q.hover;return q.nodes.find(n=>n.id===q.hover);});assert.ok(origin);
  await page.evaluate(()=>{window.__r8.record=true;window.__r8.frames=[];});
  for(const delta of [-120,-120,-120,120,120,120]){
   await page.mouse.wheel(0,delta);await page.waitForTimeout(300);
   row.wheel.push(await page.evaluate(()=>{const q=window.__r8;return {scale:q.camera.scale,hover:q.hover,node:q.nodes.find(n=>n.id===q.tracked),focus:q.labels.filter(l=>l.priority===3).map(l=>l.id)};}));
  }
  const frames=await page.evaluate(()=>{window.__r8.record=false;return window.__r8.frames;});
  row.frames=frames.length;row.focusLosses=frames.filter(f=>f.hover!==origin.id||!f.focus.includes(origin.id)).length;
  row.maxAnchorError=Math.max(...frames.map(f=>Math.hypot(f.node.x-origin.x,f.node.y-origin.y)));
  if(!ref){assert.equal(row.focusLosses,0);assert.ok(row.maxAnchorError<.05);}
  // Moving into empty space must release the former node and use that cursor.
  await page.mouse.move(canvas.x+10,canvas.y+10);await page.waitForTimeout(80);
  const before=await page.evaluate(()=>window.__r8.camera);
  await page.mouse.wheel(0,-60);await page.waitForTimeout(300);
  const after=await page.evaluate(()=>({camera:window.__r8.camera,hover:window.__r8.hover}));
  row.emptyAnchorError=Math.hypot((10-before.panX)/before.scale*after.camera.scale+after.camera.panX-10,(10-before.panY)/before.scale*after.camera.scale+after.camera.panY-10);
  assert.ok(row.emptyAnchorError<.05);assert.equal(after.hover,undefined);
  await page.waitForTimeout(200);const draws=await page.evaluate(()=>window.__r8.draws);await page.waitForTimeout(500);row.idleDraws=await page.evaluate(()=>window.__r8.draws)-draws;assert.equal(row.idleDraws,0);
  await page.screenshot({path:out+'/'+(ref?'baseline':'candidate')+'-'+viewport.width+'.png'});
  await page.close();console.log(JSON.stringify(row));
 }
 assert.deepEqual(result.errors,[]);
}finally{writeFileSync(out+'/'+(ref?'baseline':'candidate')+'.json',JSON.stringify(result,null,2));await browser?.close();await server.close();}
