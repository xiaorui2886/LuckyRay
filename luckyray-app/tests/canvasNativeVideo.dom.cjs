// Actual component with a bounded IPC player fixture. No real profile or media.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),deps=process.env.TEST_DEPS_ROOT||root+'/node_modules';
const ts=require(path.join(deps,'typescript')),React=require(path.join(deps,'react'));
const {JSDOM}=require(path.join(process.env.TEST_DOM_DEPS_ROOT||deps,'jsdom'));
const dom=new JSDOM('<div id="app"></div>',{pretendToBeVisual:true});
global.window=dom.window;global.document=dom.window.document;global.navigator=dom.window.navigator;global.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=require(path.join(deps,'react-dom/client')),{act}=React;
const players=[];let pendingOpen=null,restored=0,active=null;
class Player {
 constructor(){this.muted=true;this.paused=true;this.time=0;this.closed=false;players.push(this);}
 async openComfy(name,bounds,preview){this.name=name;this.preview=preview;if(pendingOpen)await pendingOpen;}
 async open(libraryId,assetId,revision,bounds,preview){this.libraryId=libraryId;this.assetId=assetId;this.revision=revision;this.preview=preview;if(pendingOpen)await pendingOpen;}
 async snapshot(){return{time:this.time,duration:4.5,paused:this.paused,width:608,height:352,ended:false};}
 async previewFrame(){return{time:this.time,src:'data:image/png;base64,synthetic'};}
 play(){this.paused=false;return Promise.resolve();} pause(){this.paused=true;} close(){this.closed=true;this.paused=true;}
 set currentTime(n){this.time=n;}get currentTime(){return this.time;}
}
const source=ts.transpileModule(fs.readFileSync(root+'/src/features/canvas/CanvasNativeVideoPreview.tsx','utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const ctx={exports:{}};new Function('require','exports',source)(id=>{
 if(id==='react')return React;if(id==='react/jsx-runtime')return require(path.join(deps,'react/jsx-runtime'));
 if(id.endsWith('/i18n'))return{useI18n:()=>({t:k=>k})};
 if(id==='./CanvasVideoFrame'){
  const frame={exports:{}};
  const loadLayout=name=>{const mod={exports:{}};new Function('require','exports',ts.transpileModule(fs.readFileSync(root+'/src/core/canvas/'+name+'.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(key=>loadLayout(key.replace('./','')),mod.exports);return mod.exports;};
  new Function('require','exports',ts.transpileModule(fs.readFileSync(root+'/src/features/canvas/CanvasVideoFrame.tsx','utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(key=>key==='react/jsx-runtime'?require(path.join(deps,'react/jsx-runtime')):key.endsWith('/storyboardLayout')?loadLayout('storyboardLayout'):{useI18n:()=>({t:k=>k})},frame.exports);
  return frame.exports;
 }
 if(id.endsWith('/nativeFilmTransport'))return{NativeFilmTransport:Player,nativeComfyVideoAvailable:async()=>true,nativeFilmAvailable:async()=>true,transientNativeVideoError:()=>false};
 if(id.endsWith('/nativeVideoPreview'))return{nativeVideoMetadata:async(libraryId,assetId)=>{assert.equal(libraryId,'fixed-canvas-catalog');assert.equal(assetId,'synthetic-asset');return{sourceRevision:'same-source-revision'};}};
 if(id.endsWith('/materialLibraryContext'))return{materialLibrarySession:{request:async(action,scope)=>{assert.deepEqual(action,{op:'registry',include_hidden:false});assert.equal(scope,null);return{legacyId:'fixed-canvas-catalog',activeId:'other-selected-library'};}}};
 if(id.endsWith('/nativeVideoSurface'))return{videoSurfaceBounds:()=>({x:0,y:0,width:608,height:352}),observeCanvasVideoSurface:()=>()=>restored++};
 if(id==='./comfyVideoCover'){
  const mod={exports:{}};
  new Function('require','exports',ts.transpileModule(fs.readFileSync(root+'/src/features/canvas/comfyVideoCover.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(key=>key==='react'?React:{invoke:async()=>{throw Error('unexpected-cover-request');}},mod.exports);
  return mod.exports;
 }
 throw Error(id);
},ctx.exports);
const {CanvasNativeVideoPreview:Comp,comfyVideoResultName}=ctx.exports;
const name='comfy-'+ 'a'.repeat(64)+'.mp4';
assert.equal(comfyVideoResultName('C:\\output\\'+name),name);assert.equal(comfyVideoResultName('ordinary.mp4'),null);
const claim=(p,audible)=>{if(audible){if(active&&active!==p){active.muted=true;active.pause();}active=p;}else if(active===p)active=null;};
const r=createRoot(document.querySelector('#app'));
const draw=(selected=true,visible=true,resultName=name,mode='card')=>React.createElement(Comp,{resultName,selected,visible,onAudioClaim:claim,mode,poster:'data:image/jpeg;base64,cover'});
const event=(el,type,init={})=>el.dispatchEvent(new dom.window.MouseEvent(type,{bubbles:true,...init}));
const wait=()=>new Promise(r=>setTimeout(r,120));
(async()=>{
 await act(async()=>{r.render(React.createElement(Comp,{resultName:name,poster:'data:image/jpeg;base64,cold-cover',metadata:{width:608,height:352,duration:4.5},selected:false,visible:true,onAudioClaim:claim}));await wait();});
 assert.equal(players.length,0,'an unselected cold card shows its decoded cover without opening any player');
 assert.equal(document.querySelector('.canvas-native-video-surface img').getAttribute('src'),'data:image/jpeg;base64,cold-cover');
 assert.match(document.querySelector('.canvas-video-time').textContent,/0:04/,'cover metadata supplies duration before hover');
 await act(async()=>{r.render(draw());await wait();});let p=players.at(-1);
 assert.equal(p.muted,true);assert.equal(p.paused,true,'selection displays a frame without autoplay');
 await act(async()=>{event(document.querySelector('.canvas-native-video'),'mouseover');await wait();});
 assert.equal(p.paused,false);assert.equal(p.muted,true);
 await act(async()=>{event(document.querySelector('button[aria-pressed]'),'click');await wait();});
 assert.equal(p.muted,false);assert.equal(active,p);
 await act(async()=>{r.render(draw(false));await wait();});assert.equal(p.muted,true);assert.equal(active,null);
 const progress=document.querySelector('.canvas-video-progress');progress.setPointerCapture=()=>{};progress.getBoundingClientRect=()=>({left:0,width:100});
 let leaked=false;document.body.addEventListener('pointerdown',()=>leaked=true);
 await act(async()=>event(progress,'pointerdown',{clientX:50}));assert.equal(p.time,2.25);assert.equal(leaked,false,'seek must not drag the card');
 await act(async()=>window.dispatchEvent(new dom.window.Event('blur')));assert.equal(p.closed,true);assert.equal(active,null);
 const count=players.length;await act(async()=>window.dispatchEvent(new dom.window.Event('focus')));assert.equal(players.length,count,'focus never resumes native playback');
 await act(async()=>{r.render(draw(true));await wait();});p=players.at(-1);assert.equal(p.muted,true);
 await act(async()=>{r.render(draw(true,false));await wait();});assert.equal(p.closed,true);
 const beforeThumbnail=players.length;
 await act(async()=>{r.render(draw(false,true,name,'thumbnail'));await wait();});
 assert.equal(players.length,beforeThumbnail,'history cover does not start video before hover');
 assert.match(document.querySelector('img').src,/base64,(cover|synthetic)$/,'a stopped surface retains a real still before hover');
 await act(async()=>{event(document.querySelector('.canvas-native-video'),'mouseover');await wait();});
 p=players.at(-1);assert.equal(p.preview,true);assert.equal(p.paused,false);assert.equal(p.muted,true);
 assert.equal(document.querySelector('.canvas-video-controls'),null,'history hover has no nested playback buttons');
 assert.match(document.querySelector('img').src,/base64,synthetic$/,'history shows decoded frames, not just a poster');
 await act(async()=>{r.render(draw(true,false));await wait();});assert.equal(p.closed,true);
 await act(async()=>{r.render(React.createElement(Comp,{assetId:'synthetic-asset',selected:true,visible:true,onAudioClaim:claim}));await wait();});
 p=players.at(-1);assert.equal(p.libraryId,'fixed-canvas-catalog');assert.equal(p.assetId,'synthetic-asset');assert.equal(p.revision,'same-source-revision');assert.equal(p.paused,true);assert.equal(p.muted,true,'library fallback starts silent, like Comfy preview');
 assert.equal(p.name,undefined,'a catalog asset must not be opened as a generated result name');
 let finish;pendingOpen=new Promise(r=>finish=r);
 await act(async()=>{r.render(draw(true,true));await new Promise(r=>setImmediate(r));});const late=players.at(-1);
 await act(async()=>r.unmount());finish();await new Promise(r=>setTimeout(r,10));assert.equal(late.closed,true,'late opens close after unmount');
 assert.ok(restored>=2);assert.equal(active,null);
 console.log('PASS native canvas lifecycle: original result identity, selection paused, silent hover, sound claim, deselection mute, seek isolation, blur/hidden cleanup, no focus autoplay, late-open close. IPC fixture only.');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await act(async()=>r.unmount());dom.window.close();});
