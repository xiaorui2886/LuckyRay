// Covers decode the verified result once; unmount cancels only that still job.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),deps=process.env.TEST_DEPS_ROOT||root+'/node_modules';
const React=require(path.join(deps,'react')),ts=require(path.join(deps,'typescript'));
const {JSDOM}=require(path.join(process.env.TEST_DOM_DEPS_ROOT||deps,'jsdom'));
const dom=new JSDOM('<div id="app"></div>',{pretendToBeVisual:true});
global.window=dom.window;global.document=dom.window.document;global.navigator=dom.window.navigator;global.IS_REACT_ACT_ENVIRONMENT=true;
const {act}=React,{createRoot}=require(path.join(deps,'react-dom/client'));
const requests=[],pending=[];
const registryReads=[];
const libraries={materialLibrarySession:{request:async(request,scope)=>{registryReads.push({request,scope});return{legacyId:'synthetic-legacy-catalog',activeId:'unrelated-active-library'};}}};
const host={invoke:async(name,args)=>{
 assert.equal(name,'material_video_preview_command');requests.push(args.request);
 if(args.request.op==='cancel')return{cancelled:true};
 return await new Promise((resolve,reject)=>pending.push({request:args.request,resolve,reject}));
}};
const native={exports:{}};
new Function('require','exports',ts.transpileModule(fs.readFileSync(root+'/src/features/materials/nativeVideoPreview.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(key=>key==='@tauri-apps/api/core'?host:{filmSampleTimes:()=>[]},native.exports);
const mod={exports:{}};
new Function('require','exports',ts.transpileModule(fs.readFileSync(root+'/src/features/canvas/comfyVideoCover.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(key=>key==='react'?React:key.includes('materialLibraryContext')?libraries:native.exports,mod.exports);
const {useComfyVideoCover,useCanvasVideoCover,comfyVideoResultName}=mod.exports;
const name=letter=>'comfy-'+letter.repeat(64)+'.mp4';
const cover={src:'data:image/jpeg;base64,synthetic',width:608,height:352,codec:'hevc',duration:4.5,sourceRevision:'synthetic'};
function Cover({source,visible=true}){const c=useComfyVideoCover(source,visible);return React.createElement('output',null,c?.src||'pending');}
function AssetCover({assetId,source,visible=true}){const c=useCanvasVideoCover(source,assetId,visible);return React.createElement('output',{'data-width':c?.width,'data-duration':c?.duration},c?.src||'pending');}
const r=createRoot(document.querySelector('#app'));
const draw=(source,n=1)=>React.createElement(React.Fragment,null,...Array.from({length:n},(_,i)=>React.createElement(Cover,{source,key:i})));
const turn=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
 assert.equal(comfyVideoResultName('C:\\output\\'+name('a')),name('a'));
 for(const value of ['ordinary.mp4','comfy-'+ 'z'.repeat(64)+'.mp4',name('a')+'?url=elsewhere'])assert.equal(comfyVideoResultName(value),null);
 await act(async()=>{r.render(draw('ordinary.mp4'));await turn();});assert.equal(requests.length,0);
 await act(async()=>{r.render(draw(name('a'),2));await turn();});assert.equal(pending.length,1,'two uses share the same cover job');
 assert.deepEqual(Object.keys(pending[0].request).sort(),['job','op','resultName']);assert.equal(pending[0].request.resultName,name('a'));
 await act(async()=>{pending[0].resolve(cover);await turn();});
 assert.deepEqual([...document.querySelectorAll('output')].map(e=>e.textContent),[cover.src,cover.src]);
 await act(async()=>{r.render(draw(name('b')));await turn();});assert.equal(document.querySelector('output').textContent,'pending','old result cover never leaks into another result');
 const active=pending.at(-1);assert.equal(active.request.resultName,name('b'));
 await act(async()=>{r.render(draw('ordinary.mp4'));await turn();});
 assert.equal(requests.at(-1).op,'cancel');assert.equal(requests.at(-1).job,active.request.job,'cancel targets only the still-decoding job');
 await act(async()=>{active.resolve(cover);await turn();r.render(draw(name('a')));await turn();});
 assert.equal(requests.filter(v=>v.op==='comfyCover'&&v.resultName===name('a')).length,1,'settled still is reused without redecoding');
 assert.equal(document.querySelector('output').textContent,cover.src);
 // Both host slots are busy with library tiles when the canvas first mounts.
 // The canvas must queue behind them, not start a third rejected request.
 const libraryA=native.exports.nativeVideoMetadata('synthetic-library','tile-a',new AbortController().signal);
 const libraryB=native.exports.nativeVideoMetadata('synthetic-library','tile-b',new AbortController().signal);
 const tiles=pending.slice(-2),before=requests.length;
 await act(async()=>{r.render(draw(name('c')));await turn();});
 assert.equal(requests.length,before,'canvas still does not exceed the shared two-job budget');
 await act(async()=>{tiles[0].resolve({});await libraryA;await turn();});
 assert.equal(pending.at(-1).request.resultName,name('c'));
 assert.equal(requests.filter(v=>v.op==='comfyCover'&&v.resultName===name('c')).length,1);
 await act(async()=>{pending.at(-1).resolve(cover);tiles[1].resolve({});await libraryB;await turn();});
 assert.equal(document.querySelector('output').textContent,cover.src,'cold entry recovers an occupied still slot without pointer input');
 // Do not retry a binding/security failure. Do not cache it as a permanent miss
 // either: leaving and returning to the canvas can read its current binding.
 const warn=console.warn,warnings=[];console.warn=(...v)=>warnings.push(v);
 try {
  await act(async()=>{r.render(draw(name('d')));await turn();});
  await act(async()=>{pending.at(-1).reject('comfyui-video-binding-missing');await turn();});
  assert.equal(requests.filter(v=>v.op==='comfyCover'&&v.resultName===name('d')).length,1);
  assert.deepEqual(warnings,[['[comfy-cover]',{code:'comfyui-video-binding-missing'}]]);
  await act(async()=>{r.render(React.createElement(Cover,{source:name('d'),visible:false}));await turn();});
  await act(async()=>{r.render(React.createElement(Cover,{source:name('d'),visible:true}));await turn();});
  assert.equal(requests.filter(v=>v.op==='comfyCover'&&v.resultName===name('d')).length,2,'a rejected promise must not poison future canvas entries');
  await act(async()=>{pending.at(-1).resolve(cover);await turn();});
  assert.equal(document.querySelector('output').textContent,cover.src);
 } finally {console.warn=warn;}
 // An ordinary catalog H3 reference needs a cover on entry, without hover,
 // selection, player open or generation. It must not borrow the active library.
 const assetStart=requests.length;
 await act(async()=>{r.render(React.createElement(AssetCover,{assetId:'catalog-h3',source:'synthetic-original.mp4'}));await turn();});
 assert.deepEqual(registryReads.at(-1),{request:{op:'registry',include_hidden:false},scope:null});
 const catalogMetadata=pending.at(-1);
 assert.equal(catalogMetadata.request.op,'metadata');assert.equal(catalogMetadata.request.libraryId,'synthetic-legacy-catalog');assert.equal(catalogMetadata.request.assetId,'catalog-h3');
 assert.equal(document.querySelector('output').textContent,'pending');
 await act(async()=>{catalogMetadata.resolve(cover);await turn();});
 const catalogStill=pending.at(-1);
 assert.equal(catalogStill.request.op,'thumbnail');assert.equal(catalogStill.request.libraryId,'synthetic-legacy-catalog');assert.equal(catalogStill.request.revision,cover.sourceRevision);assert.equal(catalogStill.request.cover,true);
 await act(async()=>{catalogStill.resolve({src:cover.src,time:.45});await turn();});
 assert.equal(document.querySelector('output').textContent,cover.src,'catalog cover arrives before any pointer event');
 assert.equal(document.querySelector('output').dataset.width,'608');assert.equal(document.querySelector('output').dataset.duration,'4.5');
 assert.deepEqual(requests.slice(assetStart).map(x=>x.op),['metadata','thumbnail']);
 await act(async()=>{r.render(React.createElement(AssetCover,{assetId:'other-catalog-video',source:'synthetic-other.mp4'}));await turn();});
 assert.equal(document.querySelector('output').textContent,'pending','previous asset cover is never shown for the next identity');
 const interrupted=pending.at(-1);
 await act(async()=>{r.render(React.createElement(AssetCover,{assetId:'other-catalog-video',source:'synthetic-other.mp4',visible:false}));await turn();});
 assert.equal(requests.at(-1).op,'cancel');assert.equal(requests.at(-1).job,interrupted.request.job);
 await act(async()=>{interrupted.resolve(cover);await turn();});
 assert.equal(document.querySelector('output').textContent,'pending','hidden-page metadata must not start a still or apply a stale cover');
 console.log('PASS Comfy cover DOM: exact result identity, deduplicated decode, result switch isolation, bounded still cancellation and RAM cache reuse. No video derivative or generation.');
 console.log('PASS catalog cover DOM: cold metadata/still without interaction, exact legacy catalog/revision, dimensions before playback, source switch isolation and hidden cancellation. IPC fixture only.');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await act(async()=>r.unmount());dom.window.close();});
