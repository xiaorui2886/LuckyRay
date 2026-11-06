import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve("vite/package.json"))("esbuild");
const bundle = await esbuild.build({
  entryPoints:[fileURLToPath(new URL("../src/core/extensions/events.ts",import.meta.url))],
  bundle:true,format:"esm",write:false,
  plugins:[{name:"mock-tauri",setup(b){
    b.onResolve({filter:/^@tauri-apps\/api\/(core|event)$/},args=>({path:args.path,namespace:"fixture"}));
    b.onLoad({filter:/.*/,namespace:"fixture"},()=>({contents:"export const invoke=()=>Promise.reject(Error('mock')); export const listen=()=>Promise.reject(Error('mock'));"}));
  }}],
});
globalThis.window = new EventTarget();
const {startPluginEventPump,pluginEventStatus} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const waitUntil = async predicate => { for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error("fixture timeout"); };

test("event pump claims once, isolates failure and cancels disabled plugin work",async()=>{
  let listener, onPackages, detached=false, aborted=false;
  const enabled = new Set(["bad","good","pending"]);
  const claims = new Map(["bad","good","pending"].map(id=>[id,{id,scope:{materialIds:[],canvasIds:[],knowledge:null,writes:false,theme:{}},event:{}}]));
  const calls=[];
  const dependencies={
    listen:async callback=>{listener=callback;return ()=>{detached=true;};},
    claim:async token=>{const claim=claims.get(token);if(!claim)throw Error("already claimed");claims.delete(token);return claim;},
    packages:{subscribe:callback=>{onPackages=callback;return ()=>{};},snapshot:()=>({ready:true,packages:[...enabled].map(id=>({enabled:true,package:{manifest:{id}}}))})},
    run:async(id,_scope,_event,signal)=>{
      calls.push(id);
      if(id==="bad")throw Error("fixture-plugin-error");
      if(id==="pending")return new Promise((_,reject)=>signal.addEventListener("abort",()=>{aborted=true;reject(Error("cancelled"));},{once:true}));
      return {ui:{title:"synthetic result"},receipts:[],outcomes:[],unconfirmed:[],failures:[]};
    },
  };
  const stop=await startPluginEventPump(dependencies);
  listener({payload:"bad"}); listener({payload:"good"}); listener({payload:"good"});
  await waitUntil(()=>pluginEventStatus("good")?.state==="done");
  assert.deepEqual(calls,["bad","good"]);
  assert.equal(pluginEventStatus("bad").state,"failed");
  assert.equal(pluginEventStatus("good").ui.title,"synthetic result");
  listener({payload:"pending"}); await waitUntil(()=>calls.includes("pending"));
  enabled.delete("pending"); onPackages();
  await waitUntil(()=>aborted);
  assert.equal(pluginEventStatus("pending"),null);
  stop(); assert.equal(detached,true); assert.equal(pluginEventStatus("good"),null);
});

test('overflow releases unconsumed native tokens and later events still run',async()=>{
 let listener;let release;const first=new Promise(resolve=>{release=resolve;});let calls=0;const pending=new Map();const discarded=[];
 const scope={materialIds:[],canvasIds:[],knowledge:null,writes:false,theme:{}};
 const stop=await startPluginEventPump({listen:async f=>{listener=f;return()=>{};},claim:async token=>{const value=pending.get(token);assert.ok(value);pending.delete(token);return value;},discard:async token=>{discarded.push(token);pending.delete(token);},packages:{subscribe:()=>()=>{},snapshot:()=>({ready:true,packages:[{enabled:true,package:{manifest:{id:'test'}}}]})},run:async()=>{calls++;if(calls===1)await first;return{ui:{title:'ok'},receipts:[],outcomes:[],unconfirmed:[],failures:[]};}});
 const send=token=>{pending.set(token,{id:'test',scope,event:{}});listener({payload:token});};
 send('first');await waitUntil(()=>calls===1);
 for(let i=0;i<128;i++)send(`burst-${i}`);
 assert.equal(discarded.length,1);release();await waitUntil(()=>calls===128&&pending.size===0);
 send('after');await waitUntil(()=>calls===129);assert.equal(pending.size,0);stop();
});
