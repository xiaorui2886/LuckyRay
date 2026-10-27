// Real workspace JSX + mocked WebGL viewport. Not native-window/pixel verification.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
const require = createRequire(import.meta.url);
const tools = process.env.LR_TEST_TOOLS ? createRequire(path.join(process.env.LR_TEST_TOOLS, 'package.json')) : require;
const runtime = process.env.LR_TEST_RUNTIME ? createRequire(path.join(process.env.LR_TEST_RUNTIME, 'package.json')) : require;
const {JSDOM} = tools('jsdom'); const esbuild = createRequire(runtime.resolve('vite/package.json'))('esbuild');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dom = new JSDOM('<button id="prior">Before</button><div id="root"></div>', {url:'https://director-test.invalid'});
for (const key of ['window','document','HTMLElement','Node','Event','MouseEvent','KeyboardEvent','navigator']) Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(dom.window.HTMLElement.prototype,'getClientRects',{value(){return this.hidden ? [] : [{width:100,height:20}];}});
globalThis.requestAnimationFrame = fn=>setTimeout(fn,0); globalThis.cancelAnimationFrame=clearTimeout;
globalThis.__directorTest = { exports:[], close:0, captures:0 };
const out=path.join(os.tmpdir(),`lr-director-dom-${process.pid}.cjs`);
const stub=`import {forwardRef,useImperativeHandle} from 'react';export const DirectorViewport=forwardRef((props,ref)=>{globalThis.__directorTest.viewport=props;useImperativeHandle(ref,()=>({capture:async()=>{globalThis.__directorTest.captures++;if(globalThis.__directorTest.deferCapture)await new Promise(resolve=>globalThis.__directorTest.releaseCapture=resolve);return 'data:image/png;base64,TEST'},frameSelection:()=>{},resetOrbit:()=>{},alignCameraToOrbit:()=>{}}));return <div data-testid="mock-viewport"/>});`;
const entry=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {DirectorWorkspace} from './src/features/canvas/director/DirectorWorkspace';import {createDirectorDocument} from './src/core/canvas/director/model';function App(){const [doc,setDoc]=useState(createDirectorDocument());globalThis.__directorTest.document=doc;return <DirectorWorkspace document={doc} onChange={setDoc} onClose={()=>globalThis.__directorTest.close++} onExportShot={async(shot,png)=>globalThis.__directorTest.exports.push({shot,png})}/>};const root=createRoot(document.querySelector('#root'));globalThis.__directorTest.root=root;root.render(<App/>);`;
await esbuild.build({stdin:{contents:entry,resolveDir:repo,loader:'tsx'},outfile:out,bundle:true,platform:'node',format:'cjs',jsx:'automatic',loader:{'.css':'empty'},plugins:[{name:'viewport-mock',setup(build){build.onResolve({filter:/\/DirectorViewport$/},()=>({path:'viewport',namespace:'mock'}));build.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:stub,loader:'tsx',resolveDir:repo}));build.onResolve({filter:/^react(?:\/.*)?$|^react-dom(?:\/.*)?$/},args=>({path:runtime.resolve(args.path),external:true}));}}]});
const state=globalThis.__directorTest;const tick=()=>new Promise(resolve=>setTimeout(resolve,20));
const button=text=>[...document.querySelectorAll('button')].find(el=>el.textContent===text || el.getAttribute('aria-label')===text);
const click=async text=>{const el=button(text);assert.ok(el,`button ${text}`);el.click();await tick();};
const change=async(input,value)=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));await tick();};
const editNumber=async(input,value)=>{input.focus();await change(input,value);input.blur();await tick();};
try {
 document.querySelector('#prior').focus();require(out);await tick();await tick();
 assert.equal(document.activeElement.getAttribute('role'),'dialog');
 assert.equal(document.querySelector('.director-backdrop').parentElement.className, 'canvas-dialog-scope');
 assert.equal(document.querySelector('.director-backdrop').parentElement.parentElement, document.body, 'modal still escapes retained canvas stacking context');
 const initialDialog=document.activeElement;const shiftTab=new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true});initialDialog.dispatchEvent(shiftTab);assert.equal(shiftTab.defaultPrevented,true);assert.ok(initialDialog.contains(document.activeElement));assert.notEqual(document.activeElement,initialDialog);initialDialog.focus();
 assert.equal(state.document.scene.objects.length,2);
 await click('方体');assert.equal(state.document.scene.objects.length,3);assert.equal(state.viewport.selectedId,state.document.scene.objects[2].id);
 await click('撤销');assert.equal(state.document.scene.objects.length,2);await click('重做');assert.equal(state.document.scene.objects.length,3);
 await click('复制');assert.equal(state.document.scene.objects.length,4);assert.equal(state.document.scene.objects[3].locked,false);
 await click('删除');assert.equal(state.document.scene.objects.length,3);
 await click('保存当前镜头');const first=structuredClone(state.document.shots[0]);
 await click('人物');assert.equal(state.document.scene.objects.length,4);
 document.querySelector('.director-shot-select').click();await tick();assert.deepEqual(state.document.scene,first.scene);assert.equal(state.viewport.mode,'camera');
 await click('球体');assert.equal(state.document.scene.objects.length,4);
 await click('送入脚本分镜');assert.equal(state.exports.length,1);assert.deepEqual(state.exports[0].shot.scene,state.document.scene);assert.notDeepEqual(state.exports[0].shot.scene,first.scene);assert.equal(state.exports[0].png,'data:image/png;base64,TEST');
 // While capture is pending, mutating and close controls stay unavailable.
 state.deferCapture=true;await click('送入脚本分镜');assert.equal(button('人物').disabled,true);assert.equal(button('关闭导演台').disabled,true);assert.equal(button('撤销').disabled,true);
 document.querySelector('[role=dialog]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(state.close,0);state.releaseCapture();await tick();state.deferCapture=false;assert.equal(button('人物').disabled,false);assert.equal(state.exports.length,2);
 // Name editing is native text undo territory, not stage-history keyboard undo.
 const name=document.querySelector('.director-inspector input[type=text],.director-inspector input:not([type])');name.focus();const before=JSON.stringify(state.document);name.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true}));await tick();assert.equal(JSON.stringify(state.document),before);
 // Strict invalid imports do not replace scene; a valid import is undoable.
 const file=document.querySelector('input[type=file]');const sendFile=async text=>{Object.defineProperty(file,'files',{value:[{size:text.length,text:async()=>text}],configurable:true});file.dispatchEvent(new Event('change',{bubbles:true}));await tick();};
 await sendFile('{broken');assert.equal(JSON.stringify(state.document),before);assert.match(document.querySelector('[role=status]').textContent,/原场景未改变/);
 const imported=structuredClone(state.document);imported.scene.objects=[];await sendFile(JSON.stringify(imported));assert.equal(state.document.scene.objects.length,0);await click('撤销');assert.equal(JSON.stringify(state.document),before);
 // Camera target collisions must not enter persisted document.
 [...document.querySelectorAll('.director-inspector-tabs button')].find(el=>el.textContent==='镜头').click();await tick();
 const fields=[...document.querySelectorAll('.director-inspector .director-section')];const cameraSection=fields.find(el=>el.querySelector('h3')?.textContent==='机位 · 米');
 const axes=cameraSection.querySelectorAll('input');const target=[...state.document.scene.camera.target];await editNumber(axes[0],String(target[0]));await editNumber(axes[1],String(target[1]));const lastValid=JSON.stringify(state.document.scene.camera);await editNumber(axes[2],String(target[2]));assert.equal(JSON.stringify(state.document.scene.camera),lastValid);assert.match(document.querySelector('[role=status]').textContent,/无效/);assert.equal(Number(axes[2].value),state.document.scene.camera.position[2], 'rejected camera input must reset visible draft to persisted value');
 // Selection commands and wheel do not leak to canvas ancestors.
 let wheel=0;document.body.addEventListener('wheel',()=>wheel++);document.querySelector('.director-workspace').dispatchEvent(new Event('wheel',{bubbles:true}));assert.equal(wheel,0);
 const dialog=document.querySelector('[role=dialog]');dialog.focus();dialog.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(state.close,1);
 state.root.unmount();assert.equal(document.activeElement.id,'prior');
 console.log('PASS: workspace add/select/duplicate/delete, undo/redo, full-shot restore, current-scene export, strict import+undo, camera validation, editing keyboard isolation, wheel isolation and focus restore. WebGL viewport mocked; no visual or native validation.');
} finally {state.root?.unmount();fs.rmSync(out,{force:true});dom.window.close();}
