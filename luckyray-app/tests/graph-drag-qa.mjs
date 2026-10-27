// Production GraphPage + worker, synthetic data only; never opens a user profile.
import {createServer, transformWithEsbuild} from 'vite';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const {chromium}=await import(pathToFileURL(process.env.LUCKYRAY_QA_PLAYWRIGHT).href);
const ref=process.env.GRAPH_QA_REF, mode=ref?'baseline':'candidate';
const root=process.cwd(),out=root+'/output/playwright/'+(process.env.GRAPH_QA_OUTPUT||'graph-drag-r5');mkdirSync(out,{recursive:true});
const duration=Number(process.env.GRAPH_QA_DRAG_MS||12000);
const count=Number(process.env.GRAPH_QA_COUNT||900),delay=Number(process.env.GRAPH_QA_WORKER_DELAY||0);
const load=file=>ref?execFileSync('git',['show',ref+':luckyray-app/src/features/graph/'+file],{encoding:'utf8'}):readFileSync('src/features/graph/'+file,'utf8');
let source=load('GraphPage.tsx');
source=source.replace('const draw = useCallback((timestamp: number) => {',`const draw = useCallback((timestamp: number) => { const qaStart=performance.now(); const qaLabels:any[]=[];`)
 .replace('ctx.fillText(label.text, label.left + 4, label.top + 2);',`ctx.fillText(label.text, label.left + 4, label.top + 2); qaLabels.push({id:label.id,alpha:ctx.globalAlpha,side:labelMemoryRef.current.get(label.id)?.side,geometricSide:label.top<label.y?'above':'below',y:label.y,priority:label.priority});`)
 .replace('  }, [drawArrow]);',`const q=(window as any).__dragQA,p=paramsRef.current; q.alpha=p.alpha; q.nodes=sceneCacheRef.current.visibleNodes.map(n=>({id:n.id,x:n.x*p.scale+p.panX,y:n.y*p.scale+p.panY,wx:n.x,wy:n.y,links:n.links})); q.camera={scale:p.scale,panX:p.panX,panY:p.panY}; if(q.record)q.frames.push({t:performance.now(),ms:performance.now()-qaStart,labels:qaLabels,states:labels.filter(c=>{if(c.alpha<=.035||c.x<0||c.x>width||c.y<0||c.y>height)return false;const r=labelMemoryRef.current.get(c.id)?.label;return !r||(r.left<width&&r.left+r.width>0&&r.top<height&&r.top+r.height>0);}).map(c=>({id:c.id,opacity:labelMemoryRef.current.get(c.id)?.opacity??0,priority:c.priority,selected:(globalThis as any).__labelSelected?.includes(c.id),x:c.x,y:c.y,alpha:c.alpha})),drag:draggingNodeRef.current?.id??null,node:q.nodes.find((n:any)=>n.id===q.target),pointer:q.pointer,neighbours:q.nodes.filter((n:any)=>n.id!==q.target&&n.links>0).slice(0,60).map((n:any)=>({id:n.id,x:n.x,y:n.y})),accepted:q.accepted,received:q.received});\n }, [drawArrow]);`)
 .replace('const response = event.data;', 'const response = event.data; (window as any).__dragQA.received++;')
 .replace('recordGraphPhysicsWorkTime(response.workTime);', '(window as any).__dragQA.accepted++; recordGraphPhysicsWorkTime(response.workTime);')
 .replace('const reacted = pushNodesAlongDragPath(', '(window as any).__dragQA.sweeps++; const reacted = pushNodesAlongDragPath(');
const files=new Map(['graphPhysics.ts','graphSpatial.ts','graphPresentation.ts'].map(f=>[f,load(f)]));
files.set('graphPresentation.ts',files.get('graphPresentation.ts').replace('const selectedIds = new Set(selected.map(c => c.id));','const selectedIds = new Set(selected.map(c => c.id)); (globalThis as any).__labelSelected = [...selectedIds];'));
const entry=`import React from 'react';import {createRoot} from 'react-dom/client';import GraphPage from '/src/features/graph/GraphPage.tsx';import {I18nProvider} from '/src/core/i18n/index.ts';import {graphDataProvider} from '/src/core/services/graph.ts';import '/src/core/theme/themeTokens.css';
const nodes=Array.from({length:${count}},(_,id)=>({id,key:'drag-'+id,entityId:'fixture-'+id,label:'资料与引用笔记 '+id,type:'note'}));const edges=[];
for(let group=0;group<6;group++){const base=group*30;for(let j=1;j<30;j++){edges.push([base,base+j]);if(j<9)for(let k=j+1;k<9;k++)edges.push([base+j,base+k]);}if(group)edges.push([base,base-30]);}
graphDataProvider.buildSeed=async()=>({nodes,edges,source:'real'});createRoot(document.getElementById('root')).render(<I18nProvider locale="zh-CN"><GraphPage/></I18nProvider>);`;
const server=await createServer({configFile:false,root,esbuild:{jsx:'automatic'},logLevel:'error',server:{host:'127.0.0.1',port:0},plugins:[{name:'drag-qa',enforce:'pre',resolveId(id){if(id==='/entry.js')return '\0drag-qa';},async load(id){if(id==='\0drag-qa')return(await transformWithEsbuild(entry,'entry.tsx',{loader:'tsx',jsx:'transform'})).code;},transform(code,id){id=id.replaceAll('\\','/');if(id.endsWith('/src/features/graph/GraphPage.tsx'))return source;for(const [f,s]of files)if(id.endsWith('/src/features/graph/'+f))return s;},configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url==='/qa'){res.setHeader('Content-Type','text/html');res.end('<style>html,body,#root{margin:0;width:100%;height:100%;display:flex;background:var(--bg-base);color:var(--text-primary)}#root{flex-direction:column}</style><div id="root"></div><script type="module" src="/entry.js"></script>');}else next();});}}]});
let browser;
try{
 await server.listen();browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:Number(process.env.GRAPH_QA_WIDTH||1280),height:Number(process.env.GRAPH_QA_HEIGHT||800)},deviceScaleFactor:Number(process.env.GRAPH_QA_DPR||1)});const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.addInitScript(({delay})=>{
  window.__dragQA={frames:[],accepted:0,received:0,sweeps:0,record:false};
  document.addEventListener('pointermove',e=>window.__dragQA.pointer={x:e.clientX,y:e.clientY,t:performance.now()},true);
  const Base=Worker;if(delay)window.Worker=class extends Base{set onmessage(fn){super.onmessage=fn?e=>setTimeout(()=>fn(e),delay):null;}};
  localStorage.setItem('luckyray-graph-view-v1',JSON.stringify({filters:{note:true,material:true,tag:true,web:true},scale:1,panX:0,panY:0}));
 },{delay});
 await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/qa');
 try { await page.waitForFunction(()=>window.__dragQA.alpha<.001,null,{timeout:60000}); }
 catch(error) {
   const state=await page.evaluate(()=>({alpha:window.__dragQA.alpha,accepted:window.__dragQA.accepted,received:window.__dragQA.received,nodes:window.__dragQA.nodes?.length,visibility:document.visibilityState}));
   writeFileSync(out+'/'+mode+'-'+delay+'-timeout.json',JSON.stringify({state,errors},null,2));
   console.error(JSON.stringify({state,errors}));throw error;
 }
 const layout=await page.evaluate(()=>window.__dragQA.nodes);
 await page.screenshot({path:out+'/'+mode+'-'+delay+'-before.png'});
 // Pan a real hub to the centre, then zoom at that same point to readable names.
 let hub=layout.filter(n=>n.links>20&&n.x>20&&n.x<1260&&n.y>30&&n.y<760).sort((a,b)=>Math.hypot(a.x-640,a.y-400)-Math.hypot(b.x-640,b.y-400))[0];assert.ok(hub,'visible hub');
 await page.mouse.move(20,750);await page.mouse.down({button:'middle'});await page.mouse.move(20+640-hub.x,750+400-hub.y,{steps:15});await page.mouse.up({button:'middle'});
 const stages=[];
 for(const [index,targetScale]of (process.env.GRAPH_QA_SCALES?process.env.GRAPH_QA_SCALES.split(',').map(Number):[.45,.9,1.6]).entries()){
  for(let attempt=0;attempt<12;attempt++){
    const current=await page.evaluate(()=>window.__dragQA.camera.scale);
    if(Math.abs(Math.log(targetScale/current))<.01)break;
    await page.mouse.move(640,400);await page.mouse.wheel(0,Math.max(-160,Math.min(160,-Math.log(targetScale/current)/.0025)));await page.waitForTimeout(350);
  }
  hub=await page.evaluate(id=>window.__dragQA.nodes.find(n=>n.id===id),hub.id);
  // Re-centre after the previous relaxation using a canvas pan, not private state.
  await page.mouse.move(20,750);await page.mouse.down({button:'middle'});await page.mouse.move(20+640-hub.x,750+400-hub.y,{steps:15});await page.mouse.up({button:'middle'});
  hub=await page.evaluate(id=>window.__dragQA.nodes.find(n=>n.id===id),hub.id);
  await page.mouse.move(hub.x,hub.y);await page.waitForTimeout(100);await page.mouse.down();
  await page.evaluate(id=>{const q=window.__dragQA;q.target=id;q.frames=[];q.record=true;q.accepted=0;q.received=0;q.sweeps=0;},hub.id);
  const began=Date.now();let i=0;
  while(Date.now()-began<duration){const t=(Date.now()-began)/duration*6*Math.PI;await page.mouse.move(640+180*Math.sin(t),400+110*Math.sin(2*t));await page.waitForTimeout(12);i++;}
  await page.mouse.up();await page.waitForTimeout(700);
  const data=await page.evaluate(()=>{const q=window.__dragQA;q.record=false;return{frames:q.frames,accepted:q.accepted,received:q.received,sweeps:q.sweeps,target:q.target,camera:q.camera};});
  let churn=0,sideFlips=0,restarts=0,targetMissing=0;const seen=new Map();const held=data.frames.filter(f=>f.drag!==null);
  for(let n=0;n<held.length;n++){const f=held[n],ids=new Set(f.labels.map(l=>l.id));if(!ids.has(data.target))targetMissing++;if(n){const prev=new Set(held[n-1].labels.map(l=>l.id));churn+=[...prev].filter(id=>!ids.has(id)).length+[...ids].filter(id=>!prev.has(id)).length;}
   for(const l of f.labels){const old=seen.get(l.id);if(old){if(old.side!==l.side)sideFlips++;if(old.alpha>.5&&l.alpha<.15)restarts++;}seen.set(l.id,l);}}
  let continuousSideFlips=0,interiorSideFlips=0;
  for(let n=1;n<held.length;n++){const previous=new Map(held[n-1].labels.map(l=>[l.id,l]));for(const l of held[n].labels){const p=previous.get(l.id);if(p&&p.side!==l.side)continuousSideFlips++;if(p&&p.y>40&&p.y<760&&l.y>40&&l.y<760&&p.geometricSide!==l.geometricSide)interiorSideFlips++;}}
  const errorsPx=held.filter(f=>f.node&&f.pointer).map(f=>Math.hypot(f.node.x-f.pointer.x,f.node.y-f.pointer.y)).sort((a,b)=>a-b);
  let opacityReversals=0,selectionChanges=0,visibilityLosses=0,admissions=0;let histories=new Map();
  for(const f of held){const next=new Map();for(const s of f.states){const old=histories.get(s.id),dir=old?Math.sign(s.opacity-old.opacity):0;
   if(old&&old.priority===s.priority){if(old.selected!==s.selected)selectionChanges++;if(old.selected&&!s.selected)visibilityLosses++;if(!old.selected&&s.selected)admissions++;if(dir&&old.dir&&dir!==old.dir)opacityReversals++;}
   next.set(s.id,{...s,dir:dir||(old?.dir||0)});
  }histories=next;
  }
  const percentile=(xs,p)=>xs.length?[...xs].sort((a,b)=>a-b)[Math.min(xs.length-1,Math.floor(xs.length*p))]:0;
  const gaps=[],motionGaps=[],jumps=[],cpu=held.map(f=>f.ms);let lastMotion=null,heldFrames=0;
  for(let n=1;n<held.length;n++){
   const a=held[n-1],b=held[n];gaps.push(b.t-a.t);
   const motion=Math.max(...b.neighbours.map((v,k)=>Math.hypot(v.x-a.neighbours[k].x,v.y-a.neighbours[k].y)));
   if(motion>.001){jumps.push(motion);if(lastMotion!==null)motionGaps.push(b.t-lastMotion);lastMotion=b.t;}else heldFrames++;
  }
  const cadence={drawGapP50:percentile(gaps,.5),drawGapP95:percentile(gaps,.95),neighbourGapP50:percentile(motionGaps,.5),neighbourGapP95:percentile(motionGaps,.95),neighbourHoldFraction:heldFrames/Math.max(1,held.length-1),maxNeighbourJump:percentile(jumps,1),neighbourJumpP95:percentile(jumps,.95),drawCpuP95:percentile(cpu,.95)};
  const released=data.frames.filter(f=>f.drag===null);
  const releaseGaps=released.slice(1).map((f,n)=>f.t-released[n].t);
  const release={frames:released.length,gapP50:percentile(releaseGaps,.5),gapP95:percentile(releaseGaps,.95)};
  const summary={index,cadence,release,scale:data.camera.scale,events:i,frames:held.length,churn,sideFlips,continuousSideFlips,interiorSideFlips,opacityReversals,selectionChanges,visibilityLosses,admissions,restarts,targetMissing,maxPointerError:errorsPx.at(-1),accepted:data.accepted,received:data.received,sweeps:data.sweeps};stages.push(summary);
  writeFileSync(out+'/'+mode+'-'+delay+'-'+index+'-trace.json',JSON.stringify(data));await page.screenshot({path:out+'/'+mode+'-'+delay+'-'+index+'.png'});
  if(!ref){assert.equal(continuousSideFlips,0,'visible names retain their anchor');assert.equal(interiorSideFlips,0,'visible labels keep their node-relative side');assert.equal(opacityReversals,0,'admitted names do not breathe during motion');assert.equal(visibilityLosses,0,'eligible visible names survive moving collisions');assert.equal(targetMissing,0,'grabbed name remains visible');assert.ok(errorsPx.at(-1)<5,'worker cannot overwrite the pointer-owned node');assert.ok(data.accepted/data.received>.9,'neighbour physics progresses during continuous motion');assert.equal(data.sweeps,0);}
 }
 await page.waitForFunction(()=>window.__dragQA.alpha<.001,null,{timeout:45000});
 await page.evaluate(()=>{window.__dragQA.record=true;window.__dragQA.frames=[];});
 await page.waitForTimeout(500);
 const idleFrames=await page.evaluate(()=>window.__dragQA.frames.length);assert.equal(idleFrames,0,'drag relaxation stops when settled');
 if(!ref&&process.env.GRAPH_QA_CADENCE_CHECK){for(const stage of stages){assert.ok(stage.cadence.neighbourGapP95<40,'normal worker neighbour updates avoid 50ms stair steps');assert.ok(stage.release.gapP95<40,'release retains responsive cadence');}}
 writeFileSync(out+'/'+mode+'-'+delay+'.json' ,JSON.stringify({mode,ref,count,delay,idleFrames,layout,stages,errors},null,2));console.log(JSON.stringify({mode,count,delay,stages,errors},null,2));assert.deepEqual(errors,[]);
}finally{await browser?.close();await server.close();}
