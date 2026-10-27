// Lifecycle/contract tests with a test-only viewport stub. NOT a WebGL/pixel validation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
const require=createRequire(import.meta.url);
const tools=process.env.LR_TEST_TOOLS?createRequire(path.join(process.env.LR_TEST_TOOLS,'package.json')):require;
const runtime=process.env.LR_TEST_RUNTIME?createRequire(path.join(process.env.LR_TEST_RUNTIME,'package.json')):require;
const {JSDOM}=tools('jsdom'),esbuild=createRequire(runtime.resolve('vite/package.json'))('esbuild');
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dom=new JSDOM('<body><button id="prior">Prior</button></body>',{url:'https://director-capture.invalid'});
for(const key of ['window','document','HTMLElement','Node','navigator'])Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
const out=path.join(os.tmpdir(),`lr-director-capture-${process.pid}.cjs`);
const state=globalThis.__captureTest={mode:'success',mounted:0,unmounted:0,captured:0};
const stub=`import {forwardRef,useImperativeHandle,useLayoutEffect} from 'react';export const DirectorViewport=forwardRef((props,ref)=>{const s=globalThis.__captureTest;s.props=props;useImperativeHandle(ref,()=>({capture:async()=>{if(!s.ready)throw Error('not-ready');s.captured++;if(s.mode==='invalid')return 'data:image/png;base64,FAKE';if(s.mode==='deferred')await new Promise(resolve=>s.release=resolve);return 'data:image/png;base64,iVBORw0KGgoTEST-ONLY';}}));useLayoutEffect(()=>{s.mounted++;s.ready=true;if(s.mode==='gpu-error')props.onError('GPU unavailable');return()=>{s.unmounted++;s.ready=false;};},[]);return <canvas/>;});`;
await esbuild.build({stdin:{contents:`export {captureDirectorScene} from './src/features/canvas/director/captureDirectorScene';export {createDirectorDocument} from './src/core/canvas/director/model';`,resolveDir:repo,loader:'tsx'},outfile:out,bundle:true,platform:'node',format:'cjs',jsx:'automatic',plugins:[{name:'test-viewport',setup(build){build.onResolve({filter:/\/DirectorViewport$/},()=>({path:'viewport',namespace:'mock'}));build.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:stub,loader:'tsx',resolveDir:repo}));build.onResolve({filter:/^react(?:\/.*)?$|^react-dom(?:\/.*)?$/},args=>({path:runtime.resolve(args.path),external:true}));}}]});
const {captureDirectorScene,createDirectorDocument}=require(out);
const clean=()=>assert.equal(document.querySelector('[data-director-capture]'),null);
try{
 await test('capture waits for committed layout, freezes scene, disables edits and cleans up',async()=>{
  const scene=createDirectorDocument().scene,before=structuredClone(scene);const png=await captureDirectorScene(scene,{signal:new AbortController().signal});
  assert.match(png,/^data:image\/png;base64,iVBORw0KGgo/);assert.equal(state.captured,1);assert.equal(state.mounted,state.unmounted);clean();
  assert.equal(state.props.mode,'camera');assert.equal(state.props.guides,false);assert.equal(state.props.onTransform('x',{}),false);assert.equal(state.props.onCameraChange({}),false);
  state.props.scene.objects[0].position[0]=999;assert.deepEqual(scene,before);
 });
 await test('pre-aborted request mounts nothing',async()=>{
  const control=new AbortController();control.abort();const count=state.mounted;await assert.rejects(captureDirectorScene(createDirectorDocument().scene,{signal:control.signal}),/aborted/);assert.equal(state.mounted,count);clean();
 });
 await test('GPU failure and invalid PNG reject, never supply replacement pixels',async()=>{
  state.mode='gpu-error';await assert.rejects(captureDirectorScene(createDirectorDocument().scene,{signal:new AbortController().signal}),/GPU unavailable/);clean();
  state.mode='invalid';await assert.rejects(captureDirectorScene(createDirectorDocument().scene,{signal:new AbortController().signal}),/invalid-director-capture/);clean();assert.equal(state.mounted,state.unmounted);
 });
 await test('cancellation during capture unmounts and removes event listener',async()=>{
  state.mode='deferred';const controller=new AbortController();const promise=captureDirectorScene(createDirectorDocument().scene,{signal:controller.signal});assert.equal(typeof state.release,'function');controller.abort();await assert.rejects(promise,/aborted/);clean();assert.equal(state.mounted,state.unmounted);state.release();
 });
 await test('production helper imports real viewport and has no fake readiness timer',()=>{
  const source=fs.readFileSync(path.join(repo,'src/features/canvas/director/captureDirectorScene.tsx'),'utf8');assert.match(source,/from '\.\/DirectorViewport'/);assert.match(source,/flushSync/);assert.doesNotMatch(source,/setTimeout|setInterval|TEST-ONLY|data:image/);
 });
}finally{fs.rmSync(out,{force:true});dom.window.close();delete globalThis.__captureTest;}
