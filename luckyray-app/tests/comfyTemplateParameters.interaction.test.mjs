import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {createServer,transformWithEsbuild} from 'vite';

test('custom video parameter edits commit on click and survive browser reload without submitting',async()=>{
  const require=createRequire(import.meta.url),root=process.cwd();
  const {chromium}=await import(pathToFileURL(process.env.LUCKYRAY_QA_PLAYWRIGHT||require.resolve('playwright')).href);
  const entry=`import React,{useState,useEffect}from'react';import{createRoot}from'react-dom/client';
    import{CanvasTemplateParameters}from'/src/features/canvas/CanvasComfyTemplates.tsx';
    import{readComfyTemplate,compileComfyTemplate}from'/src/core/canvas/comfyTemplate.ts';
    const template=readComfyTemplate({format:'luckyray.comfy-template',version:1,id:'tpl-ui-video',name:'Synthetic video',
      graph:{'1':{class_type:'SyntheticVideo',inputs:{prompt:'Synthetic',frames:97,seed:17,steps:6,audio_steps:8}},
      '2':{class_type:'VHS_VideoCombine',inputs:{images:['1',0],audio:['1',1],frame_rate:24,format:'video/h264-mp4',save_output:true,filename_prefix:'synthetic'}}},
      images:[],prompt:{nodeId:'1',input:'prompt'},output:{nodeId:'2',kind:'video'},parameters:[['1','frames','帧数'],['1','seed','种子'],['1','steps','采样步数'],['2','frame_rate','帧率']].map(([nodeId,input,label])=>({nodeId,input,label}))});
    function App(){const[values,setValues]=useState(()=>JSON.parse(localStorage.getItem('synthetic-video-values')||'{}'));
      useEffect(()=>localStorage.setItem('synthetic-video-values',JSON.stringify(values)),[values]);
      return <><CanvasTemplateParameters template={template} values={values} onChange={setValues}/>
      <button id="snapshot" onClick={()=>window.__snapshot=compileComfyTemplate(template,'Synthetic',0,values)}>Build request locally</button></>;}
    createRoot(document.getElementById('root')).render(<App/>);`;
  const server=await createServer({root,configFile:false,logLevel:'error',cacheDir:path.join(root,'output/playwright/template-values-cache'),esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0},plugins:[{
    name:'custom-video-values-fixture',resolveId(id){if(id==='/values-entry.js')return '\0values-entry';},
    async load(id){if(id==='\0values-entry')return(await transformWithEsbuild(entry,'values.tsx',{loader:'tsx',jsx:'transform'})).code;},
    configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url!=='/values-fixture')return next();res.setHeader('Content-Type','text/html');res.end('<div id="root"></div><script type="module" src="/values-entry.js"></script>');});}
  }]});
  let browser;
  try{
    await server.listen();browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/values-fixture`);
    const inputs=page.locator('input');await inputs.nth(0).fill('81');await inputs.nth(1).fill('42');await inputs.nth(2).fill('4');await inputs.nth(3).fill('20');
    // Real pointer click supplies blur and click in browser order; no Enter/pre-blur workaround.
    await page.locator('#snapshot').click();let snapshot=await page.evaluate(()=>window.__snapshot);
    assert.deepEqual(snapshot.graph['1'].inputs,{prompt:'Synthetic',frames:81,seed:42,steps:4,audio_steps:8});assert.equal(snapshot.graph['2'].inputs.frame_rate,20);
    await page.reload();await page.locator('#snapshot').click();assert.deepEqual(await page.evaluate(()=>window.__snapshot),snapshot);
    assert.deepEqual(errors,[]);console.log(JSON.stringify({parameterEdits:4,lastEditCommittedOnClick:true,reloadPreserved:true,generationRequests:0}));
  }finally{await browser?.close();await server.close();}
});
