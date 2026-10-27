// Production component and worker with synthetic seeds only. No user profile access.
import {createServer,transformWithEsbuild} from 'vite';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const {chromium}=await import(pathToFileURL(process.env.LUCKYRAY_QA_PLAYWRIGHT).href);
const root=process.cwd(),ref=process.env.GRAPH_QA_REF;
const out=root+'/output/playwright/'+(process.env.GRAPH_QA_OUTPUT||'graph-r10-zoom');mkdirSync(out,{recursive:true});
const load=p=>ref?execFileSync('git',['show',ref+':luckyray-app/'+p],{encoding:'utf8'}):readFileSync(p,'utf8');
let source=load('src/features/graph/GraphPage.tsx');
source=source.replace('const draw = useCallback((timestamp: number) => {',`const draw = useCallback((timestamp: number) => { const qaLabels:any[]=[];`)
.replace('ctx.fillText(label.text, label.left + 4, label.top + 2);',`ctx.fillText(label.text, label.left + 4, label.top + 2); qaLabels.push({...label,opacity:ctx.globalAlpha,renderedFont:ctx.font,renderedWidth:ctx.measureText(label.text).width});`)
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
 await page.addInitScript(()=>{window.__r8={draws:0,frames:[],record:false};localStorage.setItem('luckyray-graph-view-v1',JSON.stringify({filters:{note:true},scale:.9,panX:0,panY:0,spatialVersion:3,labelReveal:.45}));});
 await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/qa?count=1800');await page.waitForFunction(()=>window.__r8.alpha<.001,null,{timeout:60000});
 const zoom=await page.evaluate(async()=>{
  const q=window.__r8,wait=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))),rows=[];
  const scales=Array.from({length:101},(_,i)=>.2*Math.pow(15,i/100));
  for(const scale of [...scales,...scales.slice().reverse()]){
   const node=q.nodes[0],camera=q.camera,wx=(node.x-camera.panX)/camera.scale,wy=(node.y-camera.panY)/camera.scale;
   q.move(scale,q.width/2-wx*scale,q.height/2-wy*scale);await wait();
   const c=q.candidates.find(c=>c.id===0),l=q.labels.find(l=>l.id===0);
   rows.push({scale,alpha:c.alpha,drawn:!!l,font:l?parseFloat(l.renderedFont):null,fullText:l?l.text===c.text:null,
    widthError:l?Math.abs(l.width-8-l.renderedWidth):0,opacity:l?.opacity,cache:q.memory,drawMs:q.ms});
  }return rows;
 });
 result.zoom=zoom;
 const visible=zoom.filter(z=>z.drawn);
 result.summary={uniqueFonts:new Set(visible.map(z=>z.font)).size,truncatedFrames:visible.filter(z=>!z.fullText).length,maxWidthError:Math.max(...visible.map(z=>z.widthError)),maxDrawMs:Math.max(...zoom.map(z=>z.drawMs)),reversibilityMismatches:zoom.slice(0,101).filter((z,i)=>{const reverse=zoom[201-i];return z.alpha!==reverse.alpha||z.font!==reverse.font||z.drawn!==reverse.drawn;}).length};
 if(!ref){assert.ok(result.summary.uniqueFonts>50);assert.equal(result.summary.truncatedFrames,0);assert.equal(result.summary.reversibilityMismatches,0);assert.ok(result.summary.maxWidthError<2);}
 for(const scale of [.15,1.2]){
  const target=await page.evaluate(async scale=>{
   const q=window.__r8,n=q.nodes[0],p=q.camera,wx=(n.x-p.panX)/p.scale,wy=(n.y-p.panY)/p.scale;
   q.move(scale,q.width/2-wx*scale,q.height/2-wy*scale);await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
   return {x:q.width/2,y:q.height/2};
  },scale);
  const canvas=await page.locator('canvas').first().boundingBox();
  await page.mouse.move(canvas.x+target.x,canvas.y+target.y);await page.waitForTimeout(120);
  const hover=await page.evaluate(()=>{const q=window.__r8;return {focus:q.labels.filter(l=>l.priority===3).map(l=>({id:l.id,alpha:l.opacity,font:parseFloat(l.renderedFont),fullText:l.text===q.candidates.find(c=>c.id===l.id).text})),neighbours:q.labels.filter(l=>l.priority===2).length,lastPriority:q.labels.at(-1)?.priority};});
  result.stages.push({scale,hover});
  if(!ref){assert.equal(hover.focus.length,1);assert.ok(hover.focus[0].font>=12);assert.ok(hover.focus[0].fullText);assert.equal(hover.lastPriority,3);if(scale===.15)assert.equal(hover.neighbours,0);else assert.ok(hover.neighbours>0);}
  await page.screenshot({path:out+'/'+(ref?'baseline':'candidate')+'-hover-'+scale+'.png'});
  await page.mouse.move(2,2);await page.waitForTimeout(120);
  assert.equal(await page.evaluate(()=>window.__r8.labels.filter(l=>l.priority===3).length),0);
 }
 await page.waitForTimeout(400);const draws=await page.evaluate(()=>window.__r8.draws);await page.waitForTimeout(600);result.idleDraws=await page.evaluate(()=>window.__r8.draws)-draws;assert.equal(result.idleDraws,0);
 await page.evaluate(()=>window.__mount(true));await page.waitForTimeout(300);const hidden=await page.evaluate(()=>window.__r8.draws);await page.waitForTimeout(500);assert.equal(await page.evaluate(()=>window.__r8.draws),hidden);
 await page.evaluate(()=>window.__unmount());assert.deepEqual(result.errors,[]);
 console.log(JSON.stringify({ref:result.ref,summary:result.summary,stages:result.stages,idleDraws:result.idleDraws}));
}finally{writeFileSync(out+'/'+(ref?'baseline':'candidate')+'.json',JSON.stringify(result,null,2));await browser?.close();await server.close();}