// Production component and worker with synthetic seeds only. No user profile access.
import {createServer,transformWithEsbuild} from 'vite';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const {chromium}=await import(pathToFileURL(process.env.LUCKYRAY_QA_PLAYWRIGHT).href);
const root=process.cwd(),ref=process.env.GRAPH_QA_REF;
const out=root+'/output/playwright/'+(process.env.GRAPH_QA_OUTPUT||'graph-r9');mkdirSync(out,{recursive:true});
const load=p=>ref?execFileSync('git',['show',ref+':luckyray-app/'+p],{encoding:'utf8'}):readFileSync(p,'utf8');
let source=load('src/features/graph/GraphPage.tsx');
source=source.replace('const draw = useCallback((timestamp: number) => {',`const draw = useCallback((timestamp: number) => { const qaLabels:any[]=[];`)
.replace('ctx.fillText(label.text, label.left + 4, label.top + 2);',`ctx.fillText(label.text, label.left + 4, label.top + 2); qaLabels.push({...label,opacity:ctx.globalAlpha});`)
.replace('  }, [drawArrow]);',`const q=(window as any).__r8,p=paramsRef.current; q.draws++;q.ms=performance.now()-timestamp;q.camera={scale:p.scale,panX:p.panX,panY:p.panY};q.alpha=p.alpha;q.nodes=sceneCacheRef.current.visibleNodes.filter(n=>!n.hidden).map(n=>({id:n.id,x:n.x*p.scale+p.panX,y:n.y*p.scale+p.panY}));q.labels=qaLabels;q.candidates=labels;q.memory=labelMemoryRef.current.size;q.active=revealActiveRef.current;q.elapsed=revealTimeline?timestamp-revealTimeline.startedAt:0;q.duration=revealTimeline?.totalDuration;q.count=revealedNodes.size;q.width=width;q.height=height;q.drag=draggingNodeRef.current?.id;q.move=(scale:number,x:number,y:number)=>{setCameraImmediately({scale,panX:x,panY:y});markGraphDirty('viewport');};if(q.record)q.frames.push({t:timestamp,active:q.active,count:q.count,camera:q.camera,alpha:q.alpha,drag:q.drag});\n }, [drawArrow]);`);
const entry=`import React,{Activity} from 'react';import {createRoot} from 'react-dom/client';import GraphPage from '/src/features/graph/GraphPage.tsx';import {I18nProvider} from '/src/core/i18n/index.ts';import {graphDataProvider} from '/src/core/services/graph.ts';import '/src/core/theme/themeTokens.css';
const url=new URL(location.href),count=Number(url.searchParams.get('count')||1),isolates=url.searchParams.has('isolates');
const nodes=Array.from({length:count},(_,id)=>({id,key:'r8-'+id,entityId:'fixture-'+id,label:'长中文名称与资料引用😀 '.repeat(4)+id,type:'note',timelineAt:100000+id*1000}));
const edges=[];if(!isolates)for(let i=1;i<count;i++){if(i%5!==0)edges.push([i,Math.floor(i/5)]);if(i%11===0)edges.push([i,i-1]);}
graphDataProvider.buildSeed=async()=>({nodes,edges,source:'real'});const root=createRoot(document.getElementById('root'));window.__mount=(hidden=false)=>root.render(<I18nProvider locale="zh-CN"><Activity mode={hidden?'hidden':'visible'}><GraphPage/></Activity></I18nProvider>);window.__unmount=()=>root.render(null);window.__mount();`;
const files=new Map(['src/core/services/graphPlayback.ts','src/features/graph/graphPresentation.ts'].map(p=>[p,load(p)]));
const server=await createServer({configFile:false,root,esbuild:{jsx:'automatic'},logLevel:'error',server:{host:'127.0.0.1',port:0},plugins:[{name:'r8',enforce:'pre',resolveId(id){if(id==='/entry.js')return '\0r8';},async load(id){if(id==='\0r8')return(await transformWithEsbuild(entry,'entry.tsx',{loader:'tsx',jsx:'transform'})).code;},transform(code,id){id=id.replaceAll('\\','/');if(id.endsWith('/src/features/graph/GraphPage.tsx'))return source;for(const[p,s]of files)if(id.endsWith('/'+p))return s;},configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url.startsWith('/qa')){res.setHeader('Content-Type','text/html');res.end('<style>html,body,#root{margin:0;width:100%;height:100%;display:flex;background:var(--bg-base);color:var(--text-primary)}#root{flex-direction:column}</style><div id="root"></div><script type="module" src="/entry.js"></script>');}else next();});}}]});
let browser;const result={ref:ref||'candidate',stages:[],errors:[]};
try{
 await server.listen();browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:2});page.on('pageerror',e=>result.errors.push(String(e)));
 await page.addInitScript(()=>{window.__r8={draws:0,frames:[],record:false};localStorage.setItem('luckyray-graph-view-v1',JSON.stringify({filters:{note:true},scale:.9,panX:0,panY:0,spatialVersion:3,labelReveal:0}));});
 await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/qa?count=1800');await page.waitForFunction(()=>window.__r8.alpha<.001,null,{timeout:60000});
 for(const scale of [.3,.7,1.5]){
  const report=await page.evaluate(async scale=>{
   const q=window.__r8,wait=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))),history=new Map(),out={scale,frames:0,eligible:0,missing:0,opacityChanges:0,offsetChanges:0,firstAppearanceJumps:0,maxFrameMs:0,maxMemory:0};
   const ctx=document.createElement('canvas').getContext('2d');ctx.font='12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
   const measure=text=>ctx.measureText(text).width;
   for(const t of [...Array.from({length:91},(_,i)=>i/90),...Array.from({length:91},(_,i)=>(90-i)/90)]){
    q.move(scale,300-700*t,150-150*t);await wait();out.frames++;out.maxFrameMs=Math.max(out.maxFrameMs,q.ms);out.maxMemory=Math.max(out.maxMemory,q.memory);
    const labels=new Map(q.labels.map(l=>[l.id,l]));const current=new Map();
    for(const c of q.candidates){
     if(c.alpha<=0)continue;let text=c.text.trim();const max=Math.min(c.priority>=2?320:150,q.width-12);
     // Older baselines have no fontSize and used ellipsis; current names keep
     // full text with scale-dependent metrics. Neither may flicker on pan.
     if(c.fontSize===undefined&&measure(text)>max){const chars=Array.from(text);let lo=0,hi=chars.length;while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(measure(chars.slice(0,mid).join('')+'…')<=max)lo=mid;else hi=mid-1;}text=chars.slice(0,lo).join('')+'…';}
     const w=measure(text)*(c.fontSize??12)/12+8,left=c.x-w/2,top=c.y+c.radius+5;
     // Strictly interior names cannot legitimately disappear due to clipping.
     if(left<4||left+w>q.width-4||top<4||top+(c.fontSize??12)*1.5>q.height-4)continue;
     out.eligible++;const actual=labels.get(c.id),old=history.get(c.id);
     if(!actual)out.missing++;
     if(old&&old.alpha===c.alpha&&old.priority===c.priority){
      if(Boolean(old.drawn)!==Boolean(actual))out.firstAppearanceJumps++;
      if(actual&&old.drawn&&Math.abs(actual.opacity-old.opacity)>1e-6)out.opacityChanges++;
      if(actual&&old.drawn&&Math.abs(actual.top-c.y-old.offset)>1e-6)out.offsetChanges++;
     }
     current.set(c.id,{alpha:c.alpha,priority:c.priority,drawn:!!actual,opacity:actual?.opacity,offset:actual?actual.top-c.y:null});
    }history.clear();for(const[k,v]of current)history.set(k,v);
   }return out;
  },scale);
  result.stages.push(report);console.log(JSON.stringify(report));if(!ref){assert.equal(report.missing,0);assert.equal(report.firstAppearanceJumps,0);assert.equal(report.opacityChanges,0);assert.equal(report.offsetChanges,0);assert.ok(report.maxMemory<=1800);}
 }
 await page.screenshot({path:out+'/'+(ref?'baseline':'candidate')+'-pan.png'});
 const zoom=await page.evaluate(async()=>{
  const q=window.__r8,wait=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))),values=[];
  for(let i=0;i<=30;i++){q.move(.22+i*.003,400,250);await wait();values.push({alpha:q.candidates[0]?.alpha,labels:q.labels.length});}return values;
 });result.zoom=zoom;
 if(!ref){assert.ok(zoom.some(z=>z.alpha>0&&z.alpha<.035&&z.labels>0),'low alpha is painted rather than cut off');}
 await page.waitForTimeout(400);const before=await page.evaluate(()=>window.__r8.draws);await page.waitForTimeout(800);result.idleDraws=await page.evaluate(()=>window.__r8.draws)-before;assert.equal(result.idleDraws,0);
 await page.evaluate(()=>window.__mount(true));await page.waitForTimeout(300);const hidden=await page.evaluate(()=>window.__r8.draws);await page.waitForTimeout(500);assert.equal(await page.evaluate(()=>window.__r8.draws),hidden);
 await page.evaluate(()=>window.__unmount());assert.deepEqual(result.errors,[]);
}finally{writeFileSync(out+'/'+(ref?'baseline':'candidate')+'.json',JSON.stringify(result,null,2));await browser?.close();await server.close();}
