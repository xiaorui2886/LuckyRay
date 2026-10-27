// Production Workspace -> number field -> production Viewport -> Three geometry.
// Only WebGLRenderer is replaced: no native-window or GPU/pixel claims.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';import fs from 'node:fs';import os from 'node:os';
const require=createRequire(import.meta.url), repo=process.env.LR_NUMERIC_REPO || path.resolve(import.meta.dirname,'..');
const tools=createRequire(path.join(process.env.LR_TEST_TOOLS,'package.json'));
const {JSDOM}=tools('jsdom'), esbuild=createRequire(require.resolve('vite/package.json'))('esbuild');
const dom=new JSDOM('<div id="root"></div>',{url:'https://test.invalid'});
for(const key of ['window','document','HTMLElement','Node','Event','navigator','MouseEvent','KeyboardEvent'])Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
globalThis.ResizeObserver=class{observe(){}disconnect(){}};globalThis.requestAnimationFrame=fn=>setTimeout(fn,0);globalThis.cancelAnimationFrame=clearTimeout;
Object.defineProperty(HTMLElement.prototype,'clientWidth',{get:()=>800,configurable:true});Object.defineProperty(HTMLElement.prototype,'clientHeight',{get:()=>600,configurable:true});
Object.defineProperty(HTMLElement.prototype,'getClientRects',{value(){return [{width:800,height:600}];}});
HTMLElement.prototype.setPointerCapture=function(id){this._capture=id;};HTMLElement.prototype.releasePointerCapture=function(){this._capture=null;};HTMLElement.prototype.hasPointerCapture=function(id){return this._capture===id;};
const errors=[];window.addEventListener('error',e=>errors.push(e.error));
globalThis.__numeric={commits:[],renders:0,closed:0};
const fake=`export * from ${JSON.stringify(require.resolve('three'))}; export class WebGLRenderer {constructor(){this.domElement=document.createElement('canvas');this.shadowMap={needsUpdate:false};this.ratio=1;}setPixelRatio(v){this.ratio=v;}getPixelRatio(){return this.ratio;}setSize(){}render(w,c){globalThis.__numeric.world=w;globalThis.__numeric.camera=c;globalThis.__numeric.renders++;this.shadowMap.needsUpdate=false;}dispose(){}forceContextLoss(){}}`;
const entry=`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{DirectorWorkspace}from'./src/features/canvas/director/DirectorWorkspace';import{createDirectorDocument}from'./src/core/canvas/director/model';import{getDirectorRig}from'./src/features/canvas/director/directorRigGeometry';function App(){const[doc,setDoc]=useState(createDirectorDocument());Object.assign(globalThis.__numeric,{doc,setDoc,getDirectorRig});return <DirectorWorkspace document={doc} onChange={next=>{globalThis.__numeric.commits.push(next);setDoc(next);}} onClose={()=>globalThis.__numeric.closed++} onExportShot={async()=>{}} english={true}/>;}const root=createRoot(document.querySelector('#root'));globalThis.__numeric.root=root;root.render(<App/>);`;
const out=path.join(os.tmpdir(),`numeric-runtime-${process.pid}.cjs`);
await esbuild.build({stdin:{contents:entry,resolveDir:repo,loader:'tsx'},outfile:out,bundle:true,platform:'node',format:'cjs',jsx:'automatic',loader:{'.css':'empty'},plugins:[{name:'gpu-stub',setup(b){b.onResolve({filter:/^three$/},()=>({path:'three',namespace:'fake'}));b.onLoad({filter:/.*/,namespace:'fake'},()=>({contents:fake,loader:'js',resolveDir:repo}));b.onResolve({filter:/^three\//},a=>({path:require.resolve(a.path)}));b.onResolve({filter:/^react(?:\/.*)?$|^react-dom(?:\/.*)?$/},a=>({path:require.resolve(a.path),external:true}));}}]});
const tick=()=>new Promise(r=>setTimeout(r,30));
const wait=async(predicate)=>{const end=Date.now()+5000;while(!predicate()){assert.ok(Date.now()<end,'observable state timeout');await tick();}};
const button=text=>[...document.querySelectorAll('button')].find(el=>el.textContent===text||el.getAttribute('aria-label')===text);
const click=async text=>{assert.ok(button(text),text);button(text).click();await tick();};
const field=(title,index=0)=>[...document.querySelectorAll('.director-section')].find(s=>s.querySelector('h3')?.textContent===title)?.querySelectorAll('input[type=number]')[index];
const pointer=(el,type,x,extra={})=>{const e=new MouseEvent(type,{bubbles:true,cancelable:true,clientX:x,button:0,...extra});Object.defineProperty(e,'pointerId',{value:1});el.dispatchEvent(e);return e;};
const drag=async(el,dx=50,extra={})=>{assert.ok(el);pointer(el,'pointerdown',100);pointer(el,'pointermove',100+dx,extra);await tick();};
const release=async(el,x=150)=>{pointer(el,'pointerup',x);await tick();};
const key=async(el,k,extra={})=>{el.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true,cancelable:true,...extra}));await tick();};
try {
 require(out);const s=globalThis.__numeric;await wait(()=>s.renders>0);
 const actorId=s.doc.scene.objects[0].id;
 const actor=()=>{let result;s.world.traverse(o=>{if(o.userData.directorId===actorId)result=o;});return result;};
 await click(s.doc.scene.objects[0].name);
 const x=field('Position · m');const initial=s.doc.scene.objects[0].position[0], count=s.commits.length;
 await drag(x);assert.equal(s.commits.length,count,'pointermove must not persist');assert.ok(Math.abs(actor().position.x-initial-1)<1e-9,'production geometry changes before release');
 pointer(x,'pointermove',200,{shiftKey:true});await tick();assert.ok(Math.abs(actor().position.x-(initial+1.1))<1e-9,'Shift switches precision without jumping');
 pointer(x,'pointermove',250);await tick();assert.ok(Math.abs(actor().position.x-(initial+2.1))<1e-9);
 await release(x,250);assert.equal(s.commits.length,count+1,'one save for whole gesture');
 await click('Undo');assert.equal(actor().position.x,initial,'one Undo restores whole gesture');
 await click('Redo');assert.ok(Math.abs(actor().position.x-initial-2.1)<1e-9);
 const saved=actor().position.x,n=s.commits.length;
 await drag(x);await key(x,'Escape');assert.equal(actor().position.x,saved);assert.equal(s.commits.length,n);assert.equal(s.closed,0,'Escape cancels field, not modal');
 await drag(x);pointer(x,'pointercancel',150);await tick();assert.equal(actor().position.x,saved);assert.equal(s.commits.length,n);
 await drag(x);pointer(x,'lostpointercapture',150);await tick();assert.equal(actor().position.x,saved);assert.equal(s.commits.length,n);
 await drag(x);window.dispatchEvent(new Event('blur'));await tick();assert.equal(actor().position.x,saved);assert.equal(s.commits.length,n);
 // Switching inspector during a drag unmounts and rolls back the transaction.
 await drag(x);await click('Light');assert.equal(actor().position.x,saved);assert.equal(s.commits.length,n);
 const light=field('Lighting and environment');const oldLight=s.doc.scene.lighting.intensity;
 await drag(light);let direct;s.world.traverse(o=>{if(o.isDirectionalLight&&o.castShadow)direct=o;});assert.ok(direct.intensity>oldLight);assert.equal(s.commits.length,n);await release(light);assert.equal(s.commits.length,n+1);
 await click('Camera');const focal=field('Camera');await click('Select camera in stage');
 const frustum=s.world.getObjectByName('director-camera-frustum'), oldFrustum=Array.from(frustum.geometry.attributes.position.array);
 await drag(focal);assert.notDeepEqual(Array.from(frustum.geometry.attributes.position.array),oldFrustum,'camera projection helper changes before release');assert.equal(s.commits.length,n+1);await release(focal);assert.equal(s.doc.scene.camera.focalLength,45);
 const cameraX=field('Camera position · m');const originalX=s.doc.scene.camera.position[0];
 await drag(cameraX);let cameraRoot;s.world.traverse(o=>{if(o.name==='director-camera-helper')cameraRoot=o;});
 assert.ok(cameraRoot,'production camera helper exists');assert.equal(cameraRoot.position.x,originalX+1);await release(cameraX);assert.equal(s.doc.scene.camera.position[0],originalX+1);
 // Actual FK bone rotation updates while persistent source document stays untouched.
 await click(s.doc.scene.objects[0].name);await click('Pose');
 let angle=document.querySelector('.director-angle-fields input');const bone=s.getDirectorRig(actor()).bones.get('chest'), before=bone.rotation.x, c=s.commits.length;
 await drag(angle,10);assert.notEqual(bone.rotation.x,before);assert.equal(s.commits.length,c);await release(angle,110);assert.equal(s.commits.length,c+1);
 const select=document.querySelector('.director-pose-panel select');select.value='pelvis';select.dispatchEvent(new Event('change',{bubbles:true}));await tick();
 const height=document.querySelector('.director-root-height input');assert.ok(height);await drag(height,50);assert.equal(s.commits.length,c+1);await release(height);assert.equal(s.commits.length,c+2);
 // Source replacement cancels stale preview and release cannot overwrite it.
 await click('Camera');const stale=field('Camera position · m');await drag(stale);
 const external=structuredClone(s.doc);external.scene.camera.position[0]=22;s.setDoc(external);await tick();await release(stale);assert.equal(s.doc.scene.camera.position[0],22);assert.equal(s.commits.length,c+2);
 // Typed and keyboard edits remain available; Escape rejects invalid/uncommitted input.
 const typed=field('Camera position · m');typed.focus();await key(typed,'Enter');
 Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(typed,'-12.345');typed.dispatchEvent(new Event('input',{bubbles:true}));await tick();await key(typed,'Enter');assert.equal(s.doc.scene.camera.position[0],-12.345);
 typed.focus();await key(typed,'ArrowUp',{shiftKey:true});assert.equal(s.doc.scene.camera.position[0],-12.335);
 // Transform rotation and scale are also live, clamped, and independently undoable.
 await click(s.doc.scene.objects[0].name);
 const rotation=field('Rotation · °');const oldAngle=actor().rotation.x, beforeRotation=s.commits.length;
 await drag(rotation,10);assert.ok(Math.abs(actor().rotation.x-oldAngle-10*Math.PI/180)<1e-9);assert.equal(s.commits.length,beforeRotation);await release(rotation,110);
 const scale=field('Scale');await drag(scale,-10000);assert.equal(actor().scale.x,.05,'scale clamps while previewing');await release(scale,-9900);assert.equal(s.doc.scene.objects[0].scale[0],.05);
 await click('Undo');assert.equal(actor().scale.x,1);
 // Input disabled via native fieldset cannot begin a scrub gesture.
 const row=[...document.querySelectorAll('.director-object-row')].find(row=>row.textContent===s.doc.scene.objects[0].name);
 row.querySelector('[aria-label="Lock"]').click();await tick();const lockedCount=s.commits.length, lockedX=actor().position.x;
 await drag(field('Position · m'));await release(field('Position · m'));assert.equal(s.commits.length,lockedCount);assert.equal(actor().position.x,lockedX);
 row.querySelector('[aria-label="Unlock"]').click();await tick();
 // Fast release flushes the pending animation frame, never dropping the last value.
 const fast=field('Position · m'), beforeFast=s.commits.length, startFast=actor().position.x;
 pointer(fast,'pointerdown',100);pointer(fast,'pointermove',125);pointer(fast,'pointermove',150);pointer(fast,'pointerup',150);await tick();
 assert.equal(s.commits.length,beforeFast+1);assert.ok(Math.abs(actor().position.x-startFast-1)<1e-9);
 await click('Save current shot');const duration=field('Current shot');const beforeDuration=s.commits.length;
 await drag(duration,50);assert.equal(s.commits.length,beforeDuration);assert.ok(document.querySelector('.director-shot-select small').textContent.includes('6s'));await release(duration);assert.equal(s.doc.shots[0].duration,6);
 // Cancel before an animation frame fires cannot leak a deferred preview/save.
 const beforeCancel=s.commits.length;pointer(duration,'pointerdown',100);pointer(duration,'pointermove',150);pointer(duration,'pointercancel',150);await tick();assert.equal(s.commits.length,beforeCancel);assert.equal(s.doc.shots[0].duration,6);
 await click('Camera');const empty=field('Camera position · m');empty.focus();await key(empty,'Enter');const oldTyped=s.doc.scene.camera.position[0], beforeEmpty=s.commits.length;
 Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(empty,'');empty.dispatchEvent(new Event('input',{bubbles:true}));await tick();empty.blur();await tick();assert.equal(s.commits.length,beforeEmpty);assert.equal(s.doc.scene.camera.position[0],oldTyped);
 // Vertical wheel maps to horizontal only while the strip can consume it.
 const strip=document.querySelector('.director-shot-strip');Object.defineProperty(strip,'scrollWidth',{value:1600,configurable:true});Object.defineProperty(strip,'clientWidth',{value:400});
 const wheel=(options)=>{const e=new dom.window.WheelEvent('wheel',{bubbles:true,cancelable:true,...options});strip.dispatchEvent(e);return e;};
 assert.equal(wheel({deltaY:80}).defaultPrevented,true);assert.equal(strip.scrollLeft,80);
 assert.equal(wheel({deltaY:3,deltaMode:1}).defaultPrevented,true);assert.equal(strip.scrollLeft,128);
 for(const opts of [{deltaY:20,deltaX:4},{deltaY:20,ctrlKey:true},{deltaY:20,metaKey:true},{deltaY:20,shiftKey:true}]){assert.equal(wheel(opts).defaultPrevented,false);assert.equal(strip.scrollLeft,128);}
 strip.scrollLeft=1200;assert.equal(wheel({deltaY:20}).defaultPrevented,false);assert.equal(strip.scrollLeft,1200);
 assert.equal(wheel({deltaY:-30}).defaultPrevented,true);assert.equal(strip.scrollLeft,1170);
 Object.defineProperty(strip,'scrollWidth',{value:400,configurable:true});strip.scrollLeft=0;assert.equal(wheel({deltaY:80}).defaultPrevented,false);assert.equal(strip.scrollLeft,0);
 // Regression: focus loss ends the drag, and a later pointerup cannot persist it.
 const blurField=field('Camera position · m'), blurStart=s.doc.scene.camera.position[0], blurCount=s.commits.length;
 await drag(blurField);button('Light').focus();await tick();await release(blurField);assert.equal(s.doc.scene.camera.position[0],blurStart);assert.equal(s.commits.length,blurCount);
 // Imported values accepted by the model must not be clamped merely by focus/blur.
 await click('Light');const imported=structuredClone(s.doc);imported.scene.lighting.azimuth=270;imported.scene.lighting.elevation=2;imported.shots[0].duration=900;s.setDoc(imported);await tick();
 for(const input of [field('Lighting and environment',2),field('Lighting and environment',3),field('Current shot')]){input.focus();button('Camera').focus();await tick();}
 assert.equal(s.doc.scene.lighting.azimuth,270);assert.equal(s.doc.scene.lighting.elevation,2);assert.equal(s.doc.shots[0].duration,900);assert.equal(s.commits.length,blurCount);
 // IME confirmation is not field submission.
 await click('Camera');const ime=field('Camera position · m');ime.focus();await key(ime,'Enter');Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(ime,'123');ime.dispatchEvent(new Event('input',{bubbles:true}));await tick();
 await key(ime,'Enter',{isComposing:true,keyCode:229});assert.equal(document.activeElement,ime);assert.equal(s.doc.scene.camera.position[0],blurStart);assert.equal(s.commits.length,blurCount);await key(ime,'Escape',{isComposing:true,keyCode:229});assert.equal(s.closed,0);assert.equal(document.activeElement,ime);assert.equal(ime.value,'123','IME Escape does not cancel field draft');await key(ime,'Escape');
 // Preview must not serialize the full document / saved-shot payload every frame.
 const stringify=JSON.stringify;let documentSerializations=0;JSON.stringify=function(value,...args){if(value?.scene&&Array.isArray(value?.shots))documentSerializations++;return stringify.call(this,value,...args);};
 try {const probe=field('Camera position · m');await drag(probe);pointer(probe,'pointermove',200);await tick();assert.equal(documentSerializations,0);pointer(probe,'pointercancel',200);await tick();assert.equal(documentSerializations,0);} finally {JSON.stringify=stringify;}
 assert.deepEqual(errors,[]);
 console.log('PASS production numeric Workspace + Viewport geometry: live object/FK/light, Shift transitions, one commit/Undo, Escape/pointercancel/blur/unmount/source rollback, camera/focal/pelvis, typed/keyboard, wheel overflow/modifiers/boundaries. GPU/native pixels NOT_RUN.');
} finally {globalThis.__numeric.root?.unmount();fs.rmSync(out,{force:true});dom.window.close();}
