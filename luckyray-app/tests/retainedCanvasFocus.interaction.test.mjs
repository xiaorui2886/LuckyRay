// Real retained CanvasInner, synthetic bridge/data, isolated browser profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {createServer, transformWithEsbuild} from 'vite';

test('hidden or empty retained canvas does not render on graph focus or pointer release', async () => {
  const require=createRequire(import.meta.url);
  const {chromium}=await import(pathToFileURL(process.env.LUCKYRAY_QA_PLAYWRIGHT||require.resolve('playwright')).href);
  const root=process.cwd();
  let source=readFileSync('src/CanvasSpike.tsx','utf8').replaceAll('\r\n','\n');
  const seam=source.match(/function CanvasInner\([^\n]+\{/)?.[0];
  assert.ok(source.includes(seam),'instrument the real retained component');
  source=source.replace(seam,seam+' (window as any).__focusQA.renders++;');
  const entry=`import React,{useState,Profiler} from 'react';import{createRoot}from'react-dom/client';
    import CanvasSpike from '/src/CanvasSpike.tsx';
    const q=window.__focusQA;
    const now='2026-11-03T00:00:00Z';
    let snapshot={canvasId:'focus-fixture',name:'Synthetic retained canvas',createdAt:now,updatedAt:now,
      nodes:Array.from({length:80},(_,i)=>({id:'n'+i,type:'spike',position:{x:(i%10)*280,y:Math.floor(i/10)*220},
      data:{kind:'text',label:'Synthetic '+i,text:'Synthetic body'}})),edges:[],viewport:{x:0,y:0,zoom:1},generationHistory:[],revision:1};
    q.note={title:'Synthetic linked note',contentText:'Before',updatedAt:'1'};
    window.__LUCKYRAY__={listCanvases:async()=>[{id:'focus-fixture',name:snapshot.name,createdAt:now,updatedAt:now}],
      loadCanvas:async()=>structuredClone(snapshot),getSettings:async()=>({}),checkCanvasFiles:async()=>[],
      getNote:async()=>{q.reads++;return {...q.note};},saveCanvas:async value=>{q.saves++;snapshot=structuredClone(value);return {revision:2};},
      saveCanvasThumbnail:async()=>{},listAssets:async()=>[],listNotes:async()=>[],
      listCanvasAssets:async()=>[],listCanvasMaterialFolders:async()=>({folders:[]}),listCanvasKnowledgeFolders:async()=>({folders:[]})};
    function App(){const[visible,setVisible]=useState(true),[,setShellTick]=useState(0);q.setVisible=setVisible;q.rerenderParent=()=>setShellTick(v=>v+1);
      return <><button id="graph-focus">Synthetic graph focus target</button><div id="retained" style={{display:visible?'block':'none'}} aria-hidden={!visible} inert={!visible}>
      <Profiler id="retained" onRender={(_id,_phase,duration)=>q.commits.push(duration)}><CanvasSpike visible={visible}/></Profiler></div></>;}
    createRoot(document.getElementById('root')).render(<App/>);`;
  const server=await createServer({root,configFile:false,cacheDir:path.join(root,'output/playwright/retained-focus-cache'),logLevel:'error',
    esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0},plugins:[{name:'retained-focus-fixture',enforce:'pre',
      resolveId(id){if(id==='/focus-entry.js')return '\0focus-entry';},
      async load(id){if(id==='\0focus-entry')return(await transformWithEsbuild(entry,'entry.tsx',{loader:'tsx',jsx:'transform'})).code;},
      transform(_code,id){if(id.replaceAll('\\','/').split('?')[0].endsWith('/src/CanvasSpike.tsx'))return source;},
      configureServer(s){s.middlewares.use((req,res,next)=>{if(!req.url.startsWith('/focus-fixture'))return next();res.setHeader('Content-Type','text/html');res.end('<style>html,body{margin:0}#retained{width:1200px;height:760px}</style><div id="root"></div><script type="module" src="/focus-entry.js"></script>');});}
    }]});
  let browser;
  try{
    await server.listen();browser=await chromium.launch({channel:'msedge',headless:true});
    const page=await browser.newPage({viewport:{width:1280,height:840}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>{window.__focusQA={renders:0,reads:0,saves:0,commits:[]};});
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/focus-fixture#canvas/main/focus-fixture`);
    await page.waitForSelector('.react-flow__node',{timeout:30000});
    await page.waitForTimeout(600);
    const baseline=await page.evaluate(()=>({...window.__focusQA,commits:undefined,setVisible:undefined}));
    await page.evaluate(()=>window.__focusQA.setVisible(false));await page.waitForTimeout(150);
    const hiddenBefore=await page.evaluate(()=>window.__focusQA.renders);
    await page.evaluate(()=>window.__focusQA.rerenderParent());await page.waitForTimeout(100);
    const parentAfter=await page.evaluate(()=>window.__focusQA.renders);
    await page.locator('#graph-focus').focus();
    for(let i=0;i<3;i++){await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.waitForTimeout(80);}
    const hiddenAfter=await page.evaluate(()=>window.__focusQA.renders);
    await page.locator('#graph-focus').dispatchEvent('pointerdown',{button:0,buttons:1});await page.waitForTimeout(100);
    const dragged=await page.evaluate(()=>window.__focusQA.renders);
    await page.evaluate(()=>{window.dispatchEvent(new Event('pointerup'));window.dispatchEvent(new Event('pointercancel'));});
    await page.waitForTimeout(100);
    const released=await page.evaluate(()=>window.__focusQA.renders);
    await page.evaluate(()=>window.__focusQA.setVisible(true));await page.waitForTimeout(150);
    const visibleBefore=await page.evaluate(()=>window.__focusQA.renders);
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.waitForTimeout(100);
    const visibleAfter=await page.evaluate(()=>window.__focusQA.renders);
    console.log(JSON.stringify({case:'real-CanvasInner',nodes:80,initialRenders:baseline.renders,
      hiddenParentRenders:parentAfter-hiddenBefore,hiddenFocusRenders:hiddenAfter-parentAfter,hiddenDragStartRenders:dragged-hiddenAfter,hiddenReleaseRenders:released-dragged,emptyVisibleFocusRenders:visibleAfter-visibleBefore,errors}));
    assert.deepEqual(errors,[]);
    assert.equal(parentAfter-hiddenBefore,0,'unrelated shell updates must not render the retained canvas');
    assert.equal(hiddenAfter-parentAfter,0,'hidden canvas must not render on graph/window focus');
    assert.equal(dragged-hiddenAfter,0,'hidden idle canvas must not render on graph drag start');
    assert.equal(released-dragged,0,'hidden idle canvas must not render on graph release');
    assert.equal(visibleAfter-visibleBefore,0,'canvas without linked notes needs no focus refresh');
  }finally{await browser?.close();await server.close();}
});
