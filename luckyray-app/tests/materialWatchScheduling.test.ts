import assert from "node:assert/strict";
import test from "node:test";
import { materialLibrarySession } from "../src/core/services/materialLibraryContext.ts";
import { startMaterialWatchService, stopMaterialWatchService, setLibraryRootWatch } from "../src/features/materials/materialWatch.ts";

test("real watch scheduler coalesces event paths, uses five-minute fallback, and drops disabled queued work", async t => {
  const storage=new Map<string,string>();
  t.mock.timers.enable({apis:["setTimeout","Date"]});
  const target=Object.assign(new EventTarget(),{setTimeout:(fn:()=>void,ms:number)=>setTimeout(fn,ms),clearTimeout:(id:ReturnType<typeof setTimeout>)=>clearTimeout(id),
    __TAURI_INTERNALS__:{transformCallback:()=>1,unregisterCallback:()=>{}}});
  Object.assign(globalThis,{window:target,localStorage:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value)},
    CustomEvent:class<T> extends Event {detail:T;constructor(name:string,options?:{detail:T}){super(name);this.detail=options?.detail as T;}}});
  const snapshot={libraryId:"A",generation:1,status:"ready",error:null,registry:{activeId:"A",legacyId:"A",libraries:[{id:"A",visible:true,state:"ready",preferences:{}}]}};
  t.mock.method(materialLibrarySession,"getSnapshot",()=>snapshot);
  t.mock.method(materialLibrarySession,"capture",()=>({libraryId:"A",generation:1}));
  t.mock.method(materialLibrarySession,"writePreference",(key:string,value:string,id:string)=>storage.set(`${key}:${id}`,value));
  const calls:Record<string,any>[]=[];let channel:any;
  t.mock.method(materialLibrarySession,"request",async(action:Record<string,any>)=>{
    calls.push(action);
    if(action.op==="watchLibraryRoot"){channel=action.channel;return "watch-token";}
    if(action.op==="unwatchLibraryRoot")return null;
    if(action.op==="importLibraryRoot")return {importedCount:0,skippedDuplicateCount:0,failedCount:0,failedItems:[],assets:[],changed:false};
    throw Error(action.op);
  });
  const flush=async()=>{for(let i=0;i<10;i++)await new Promise<void>(resolve=>setImmediate(resolve));};
  const imports=()=>calls.filter(c=>c.op==="importLibraryRoot");
  try {
    setLibraryRootWatch("A","D:/A",true);
    startMaterialWatchService({importFolder:async()=>{throw Error("no legacy");}} as never);
    await flush();assert.ok(channel);
    t.mock.timers.tick(500);await flush();assert.equal(imports().length,1);
    t.mock.timers.tick(10000);await flush();assert.equal(imports().length,1);
    channel.onmessage({paths:["D:/A/one"]});channel.onmessage({paths:["D:/A/one","D:/A/two"]});
    t.mock.timers.tick(349);await flush();assert.equal(imports().length,1);
    t.mock.timers.tick(1);await flush();assert.equal(imports().length,2);
    assert.deepEqual(imports()[1].paths,["D:/A/one","D:/A/two"]);
    t.mock.timers.tick(299999);await flush();assert.equal(imports().length,2);
    t.mock.timers.tick(1);await flush();assert.equal(imports().length,3);assert.equal(imports()[2].paths,undefined);
    channel.onmessage({paths:["D:/A/disabled"]});setLibraryRootWatch("A","D:/A",false);
    t.mock.timers.tick(10000);await flush();assert.equal(imports().length,3);
    assert.equal(calls.filter(c=>c.op==="unwatchLibraryRoot").length,1);
  } finally {stopMaterialWatchService();}
});
