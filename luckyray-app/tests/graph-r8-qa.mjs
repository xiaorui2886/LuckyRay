// Production component and worker with synthetic seeds only. No user profile access.
import {createServer,transformWithEsbuild} from 'vite';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const {chromium}=await import(pathToFileURL(process.env.LUCKYRAY_QA_PLAYWRIGHT).href);
const root=process.cwd(),ref=process.env.GRAPH_QA_REF;
const out=root+'/output/playwright/'+(process.env.GRAPH_QA_OUTPUT||'graph-r9-edges');mkdirSync(out,{recursive:true});
const load=p=>ref?execFileSync('git',['show',ref+':luckyray-app/'+p],{encoding:'utf8'}):readFileSync(p,'utf8');
let source=load('src/features/graph/GraphPage.tsx');
source=source.replace('const draw = useCallback((timestamp: number) => {',`const draw = useCallback((timestamp: number) => { const qaLabels:any[]=[];`)
.replace('ctx.fillText(label.text, label.left + 4, label.top + 2);',`ctx.fillText(label.text, label.left + 4, label.top + 2); qaLabels.push({...label,opacity:ctx.globalAlpha});`)
.replace('  }, [drawArrow]);',`const q=(window as any).__r8,p=paramsRef.current; q.draws++;q.camera={scale:p.scale,panX:p.panX,panY:p.panY};q.alpha=p.alpha;q.nodes=sceneCacheRef.current.visibleNodes.filter(n=>!n.hidden).map(n=>({id:n.id,x:n.x*p.scale+p.panX,y:n.y*p.scale+p.panY}));q.labels=qaLabels;q.candidates=labels;q.memory=labelMemoryRef.current.size;q.active=revealActiveRef.current;q.elapsed=revealTimeline?timestamp-revealTimeline.startedAt:0;q.duration=revealTimeline?.totalDuration;q.count=revealedNodes.size;q.width=width;q.height=height;q.drag=draggingNodeRef.current?.id;q.move=(x:number,y:number)=>{setCameraImmediately({scale:p.scale,panX:x,panY:y});markGraphDirty('viewport');};if(q.record)q.frames.push({t:timestamp,active:q.active,count:q.count,camera:q.camera,alpha:q.alpha,drag:q.drag});\n }, [drawArrow]);`);
const entry=`import React,{Activity} from 'react';import {createRoot} from 'react-dom/client';import GraphPage from '/src/features/graph/GraphPage.tsx';import {I18nProvider} from '/src/core/i18n/index.ts';import {graphDataProvider} from '/src/core/services/graph.ts';import '/src/core/theme/themeTokens.css';
const url=new URL(location.href),count=Number(url.searchParams.get('count')||1),isolates=url.searchParams.has('isolates');
const nodes=Array.from({length:count},(_,id)=>({id,key:'r8-'+id,entityId:'fixture-'+id,label:'长中文名称与资料引用😀 '.repeat(4)+id,type:'note',timelineAt:100000+id*1000}));
const edges=[];if(!isolates)for(let i=1;i<count;i++){if(i%5!==0)edges.push([i,Math.floor(i/5)]);if(i%11===0)edges.push([i,i-1]);}
graphDataProvider.buildSeed=async()=>({nodes,edges,source:'real'});const root=createRoot(document.getElementById('root'));window.__mount=(hidden=false)=>root.render(<I18nProvider locale="zh-CN"><Activity mode={hidden?'hidden':'visible'}><GraphPage/></Activity></I18nProvider>);window.__unmount=()=>root.render(null);window.__mount();`;
const files=new Map(['src/core/services/graphPlayback.ts','src/features/graph/graphPresentation.ts'].map(p=>[p,load(p)]));
const server=await createServer({configFile:false,root,esbuild:{jsx:'automatic'},logLevel:'error',server:{host:'127.0.0.1',port:0},plugins:[{name:'r8',enforce:'pre',resolveId(id){if(id==='/entry.js')return '\0r8';},async load(id){if(id==='\0r8')return(await transformWithEsbuild(entry,'entry.tsx',{loader:'tsx',jsx:'transform'})).code;},transform(code,id){id=id.replaceAll('\\','/');if(id.endsWith('/src/features/graph/GraphPage.tsx'))return source;for(const[p,s]of files)if(id.endsWith('/'+p))return s;},configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url.startsWith('/qa')){res.setHeader('Content-Type','text/html');res.end('<style>html,body,#root{margin:0;width:100%;height:100%;display:flex;background:var(--bg-base);color:var(--text-primary)}#root{flex-direction:column}</style><div id="root"></div><script type="module" src="/entry.js"></script>');}else next();});}}]});
let browser;const result={ref:ref||'candidate',edges:[],playback:[],errors:[]};
try{
 await server.listen();browser=await chromium.launch({channel:'msedge',headless:true});
 const url='http://127.0.0.1:'+server.httpServer.address().port;
 async function open(width,height,dpr,query){
  const p=await browser.newPage({viewport:{width,height},deviceScaleFactor:dpr});p.on('pageerror',e=>result.errors.push(String(e)));
  await p.addInitScript(({scale})=>{window.__r8={draws:0,frames:[],record:false};localStorage.setItem('luckyray-graph-view-v1',JSON.stringify({filters:{note:true},scale,panX:0,panY:0,spatialVersion:3,labelReveal:0}));},{scale:query==='count=1'?2:.8});
  await p.goto(url+'/qa?'+query);await p.waitForFunction(()=>window.__r8.alpha<.001,null,{timeout:60000});return p;
 }
 if(!process.env.GRAPH_QA_PLAYBACK_ONLY)for(const [width,height,dpr]of [[800,600,1],[240,200,2]]){
  const p=await open(width,height,dpr,'count=1');
  const geometry=await p.evaluate(async()=>{
   const q=window.__r8,wait=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))),rows=[];
   const origin={...q.camera},n=q.nodes[0];q.move(origin.panX+q.width/2-n.x,origin.panY+q.height/2-n.y);await wait();
   const camera={...q.camera},label={...q.labels[0]},node={...q.nodes[0]};
   if(!label.id&&label.id!==0)throw Error('fixture label missing');
   for(const [dx,dy]of [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]]){
    for(const t of [...Array.from({length:31},(_,i)=>i/30),...Array.from({length:31},(_,i)=>(30-i)/30)]){
     const x=dx*(q.width/2+label.width+60)*t,y=dy*(q.height/2+80)*t;
     q.move(camera.panX+x,camera.panY+y);await wait();
     const left=label.left+x,top=label.top+y,intersects=left<q.width&&left+label.width>0&&top<q.height&&top+label.height>0;
     const actual=q.labels.find(l=>l.id===node.id);rows.push({dx,dy,t,intersects,drawn:!!actual,error:actual?Math.hypot(actual.left-left,actual.top-top):0,partial:intersects&&(left<0||left+label.width>q.width||top<0||top+label.height>q.height),outside:Math.abs(q.nodes[0].x-q.width/2)>q.width/2+32,memory:q.memory});
    }
   }return rows;
  });
  const summary={width,height,dpr,frames:geometry.length,mismatches:geometry.filter(r=>r.drawn!==r.intersects).length,maxOffsetError:Math.max(...geometry.map(r=>r.error)),partialFrames:geometry.filter(r=>r.partial&&r.drawn).length,outside32WithText:geometry.filter(r=>r.outside&&r.drawn).length};result.edges.push(summary);
  console.log('EDGE',JSON.stringify(summary));await p.screenshot({path:out+`/${ref?'baseline':'candidate'}-edge-${width}.png`});await p.close();
  if(!ref){assert.equal(summary.mismatches,0);assert.ok(summary.maxOffsetError<1e-6);assert.ok(summary.partialFrames>0);assert.ok(summary.outside32WithText>0);}
 }
 // R8 playback redesign was withdrawn by the user; retain edge regression only.
 assert.deepEqual(result.errors,[]);
}finally{writeFileSync(out+'/'+(ref?'baseline':'candidate')+(process.env.GRAPH_QA_PLAYBACK_ONLY?'-playback':'')+'.json',JSON.stringify(result,null,2));await browser?.close();await server.close();}
