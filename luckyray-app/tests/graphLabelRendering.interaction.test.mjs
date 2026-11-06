// Exercise the real graph renderer with synthetic notes; never attach to Main.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {createServer,transformWithEsbuild} from 'vite';

test('graph labels retain their geometry without typesetting every camera frame', async()=>{
 const require=createRequire(import.meta.url);
 const {chromium}=await import(pathToFileURL(process.env.LUCKYRAY_QA_PLAYWRIGHT||require.resolve('playwright')).href);
 const root=process.cwd(),out=path.join(root,'output/playwright/graph-label-rendering');mkdirSync(out,{recursive:true});
 let source=readFileSync(path.join(root,'src/features/graph/GraphPage.tsx'),'utf8').replaceAll('\r\n','\n');
 const seam='    reportGraphPaint();\n  }, [drawArrow, invalidatePaintReadiness, reportGraphPaint]);';
 assert.ok(source.includes(seam));
 source=source.replace('  const draw = useCallback((timestamp: number) => {','  const draw = useCallback((timestamp: number) => {\n    const qaStarted=performance.now();');
 source=source.replace(seam,`    const q=(window as any).__labels;
    q.alpha=params.alpha;q.draws++;q.labels=labels;
    q.move=(scale:number,x:number,y:number)=>{setCameraImmediately({scale,panX:x,panY:y});markGraphDirty('viewport');};
    q.nodes=scene.visibleNodes.map(n=>({x:n.x,y:n.y}));
    if(q.record)q.costs.push(performance.now()-qaStarted);
`+seam);
 const entry=`import React,{Activity} from 'react';import {createRoot} from 'react-dom/client';
 import GraphPage from '/src/features/graph/GraphPage.tsx';import {I18nProvider} from '/src/core/i18n/index.ts';
 import {graphDataProvider} from '/src/core/services/graph.ts';import '/src/core/theme/themeTokens.css';
 const nodes=Array.from({length:199},(_,id)=>({id,key:'label-'+id,entityId:'synthetic-'+id,
 label:'合成图谱资料与连接关系 · Synthetic label '+id,type:'note'}));
 graphDataProvider.buildSeed=async()=>({nodes,edges:nodes.slice(1).map(n=>[n.id,Math.floor((n.id-1)/4)]),source:'real'});
 const root=createRoot(document.getElementById('root'));window.__mount=(hidden=false)=>root.render(<I18nProvider locale="zh-CN"><Activity mode={hidden?'hidden':'visible'}><GraphPage/></Activity></I18nProvider>);window.__mount();`;
 const server=await createServer({root,configFile:false,logLevel:'error',cacheDir:path.join(out,'vite-cache'),esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0},
  plugins:[{name:'graph-label-rendering',enforce:'pre',resolveId(id){if(id==='/label-entry.js')return '\0label-entry';},
   async load(id){if(id==='\0label-entry')return(await transformWithEsbuild(entry,'entry.tsx',{loader:'tsx',jsx:'transform'})).code;},
   transform(code,id){if(id.replaceAll('\\','/').split('?')[0].endsWith('/src/features/graph/GraphPage.tsx'))return source;},
   configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url!=='/label-test')return next();res.setHeader('Content-Type','text/html');res.end('<style>html,body,#root{margin:0;width:100%;height:100%;display:flex;background:#101014}#root{flex-direction:column}</style><div id="root"></div><script type="module" src="/label-entry.js"></script>');});}}]});
 let browser;
 try{
  await server.listen();browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1443,height:903},deviceScaleFactor:1.5}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
   window.__labels={draws:0,costs:[],record:false,mainText:0,otherText:0,imageDraws:0};
   localStorage.setItem('luckyray-graph-view-v1',JSON.stringify({spatialVersion:3,scale:2,panX:700,panY:400,filters:{note:true},labelReveal:0}));
   const p=CanvasRenderingContext2D.prototype,fill=p.fillText,image=p.drawImage;
   p.fillText=function(...args){if(this.canvas.classList.contains('graph-canvas'))window.__labels.mainText++;else window.__labels.otherText++;return fill.apply(this,args);};
   p.drawImage=function(...args){if(this.canvas.classList.contains('graph-canvas'))window.__labels.imageDraws++;return image.apply(this,args);};
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/label-test`);
  await page.waitForFunction(()=>window.__labels.alpha<.001,null,{timeout:45000});
  const stats=await page.evaluate(async()=>{
   const q=window.__labels,wait=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
   const center=q.nodes.reduce((a,n)=>({x:a.x+n.x/q.nodes.length,y:a.y+n.y/q.nodes.length}),{x:0,y:0});
   const base={x:530-center.x*2,y:420-center.y*2};q.move(2,base.x,base.y);await wait();
   const before={main:q.mainText,other:q.otherText,images:q.imageDraws};q.record=true;
   for(let i=0;i<120;i++){const scale=2*Math.exp(Math.sin(i*.12)*.45);q.move(scale,base.x+40*Math.sin(i*.15),base.y+24*Math.cos(i*.15));await wait();}
   q.record=false;const costs=q.costs.slice().sort((a,b)=>a-b);
   const zoom={frames:costs.length,mainText:q.mainText-before.main,newText:q.otherText-before.other,images:q.imageDraws-before.images,
    p50:costs[Math.floor(costs.length*.5)],p95:costs[Math.floor(costs.length*.95)],max:costs.at(-1)};
   q.move(2,base.x,base.y);await wait();
   const geometry=q.labels.map(l=>({id:l.id,x:l.x,y:l.y,font:l.fontSize,alpha:l.alpha}));
   const warm={main:q.mainText,other:q.otherText};
   for(let i=0;i<16;i++){q.move(2,base.x+i,base.y+i/2);await wait();}
   return{zoom,warmMain:q.mainText-warm.main,warmNewText:q.otherText-warm.other,geometry,visible:q.labels.filter(l=>l.alpha>0).length};
  });
  console.log(JSON.stringify({...stats,geometry:undefined}));writeFileSync(path.join(out,process.env.GRAPH_LABEL_BASELINE?'baseline.json':'candidate.json'),JSON.stringify(stats,null,2));
  await page.screenshot({path:path.join(out,process.env.GRAPH_LABEL_BASELINE?'baseline.png':'candidate.png')});
  assert.ok(stats.visible>10,'exercise a populated graph, not an empty overview');
  assert.equal(stats.warmMain,0,'warm camera movement must reuse label rasters instead of re-typesetting on the main canvas');
  assert.equal(stats.warmNewText,0,'fixed-scale movement must reuse the same text');
  assert.ok(stats.zoom.images>0);
  const rasterChecks=await page.evaluate(async()=>{
   const {GraphLabelPainter}=await import('/src/features/graph/graphLabelPainter.ts');
   const painter=new GraphLabelPainter(),rows=[];
   const bounds=ctx=>{const {width,height}=ctx.canvas,p=ctx.getImageData(0,0,width,height).data;
    let left=width,right=0,top=height,bottom=0,mass=0;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){const a=p[(y*width+x)*4+3];mass+=a;if(a>12){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}}
    return{left,right,top,bottom,mass};};
   // Ordinary names first become visible above scale .85 (11.52px); the
   // overview's smaller fonts have alpha zero and focused names are >=12px.
   for(const dpr of [1,1.5,2])for(const size of [11.53,12,14.27,18])for(const color of ['#d6d9de','#8664ff']){
    const contexts=[0,1].map(()=>{const c=document.createElement('canvas');c.width=800*dpr;c.height=60*dpr;const x=c.getContext('2d',{willReadFrequently:true});x.setTransform(dpr,0,0,dpr,0,0);x.globalAlpha=.76;x.textBaseline='top';return x;});
    const [direct,cached]=contexts,text='合成中文与英文 Synthetic label 123';
    direct.font=`${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;direct.fillStyle=color;direct.fillText(text,12,10);
    painter.draw(cached,text,12,10,size,color,dpr);
    await new Promise(resolve=>setTimeout(resolve,25));cached.clearRect(0,0,800,60);
    painter.draw(cached,text,12,10,size,color,dpr);
    const a=bounds(direct),b=bounds(cached);rows.push({dpr,size,color,maxEdgeDelta:Math.max(...['left','right','top','bottom'].map(k=>Math.abs(a[k]-b[k]))),alphaRatio:b.mass/a.mass});
   }
   const c=document.createElement('canvas'),ctx=c.getContext('2d');c.width=200;c.height=40;
   painter.draw(ctx,'clear lifecycle',4,4,12,'#d6d9de',1);const first=bounds(ctx);painter.clear();ctx.clearRect(0,0,200,40);
   painter.draw(ctx,'clear lifecycle',4,4,12,'#d6d9de',1);const after=bounds(ctx);painter.clear();
   return{rows,clearPreservesPixels:JSON.stringify(first)===JSON.stringify(after)};
  });
  writeFileSync(path.join(out,'raster-checks.json'),JSON.stringify(rasterChecks,null,2));
  console.log(JSON.stringify({rasterChecks}));
  assert.ok(rasterChecks.rows.every(r=>r.maxEdgeDelta<=3),'do not clip glyphs or move the existing baseline');
  assert.ok(rasterChecks.rows.every(r=>r.alphaRatio>.8&&r.alphaRatio<1.2),'retain visible text contrast at low zoom and display densities');
  assert.ok(rasterChecks.clearPreservesPixels);
  const idle=await page.evaluate(()=>window.__labels.draws);await page.waitForTimeout(200);assert.equal(await page.evaluate(()=>window.__labels.draws),idle);
  await page.evaluate(()=>window.__mount(true));await page.waitForTimeout(100);const hidden=await page.evaluate(()=>window.__labels.draws);
  await page.waitForTimeout(120);assert.equal(await page.evaluate(()=>window.__labels.draws),hidden);
  assert.deepEqual(errors,[]);
 }finally{await browser?.close();await server.close();}
});
