import assert from "node:assert/strict";
import test from "node:test";
import { materialLibrarySession, type MaterialLibrarySnapshot } from "../src/core/services/materialLibraryContext.ts";
import { readLibraryRootWatch, setLibraryRootWatch, runMaterialWatchScan, readMaterialWatchStatuses } from "../src/features/materials/materialWatch.ts";

test("root opt-in is per library, rechecks disabled/hidden targets and retains errors without changing legacy preferences", async t => {
  const storage = new Map<string,string>([["luckyray-settings-v1", JSON.stringify({"general.watchFolder":false})]]);
  Object.assign(globalThis,{ localStorage:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value)},
    window:new EventTarget(), CustomEvent:class<T> extends Event {detail:T;constructor(name:string,options?:{detail:T}){super(name);this.detail=options?.detail as T;}} });
  const snapshot:MaterialLibrarySnapshot={status:"ready",error:null,generation:1,libraryId:"A",registry:{activeId:"A",legacyId:"A",libraries:["A","B","C"].map(id=>({id,name:id,rootPath:`D:/${id}`,visible:true,state:"ready",storageMode:"managed",preferences:{},version:0}))}};
  t.mock.method(materialLibrarySession,"getSnapshot",()=>snapshot);
  t.mock.method(materialLibrarySession,"writePreference",(key:string,value:string,id:string)=>storage.set(`${key}:${id}`,value));
  const calls:{id:string;root:string}[]=[];
  let release!:()=>void;
  t.mock.method(materialLibrarySession,"request",async(action:{op:string;expectedRoot:string},id:string)=>{
    calls.push({id,root:action.expectedRoot});
    if(calls.length===1) await new Promise<void>(resolve=>release=resolve);
    if(action.expectedRoot==="D:/changed") throw new Error("library-watch-root-changed");
    return {importedCount:1,skippedDuplicateCount:2,failedCount:0,failedItems:[],assets:[],changed:true};
  });
  const bridge={importFolder:async()=>{throw new Error("legacy global setting must stay off");}} as never;
  assert.deepEqual(readLibraryRootWatch("A"),{enabled:false,root:""});
  assert.equal((await runMaterialWatchScan(bridge)).scanned,0);
  setLibraryRootWatch("B","D:/B",true);setLibraryRootWatch("C","D:/C",true);
  const first=runMaterialWatchScan(bridge), concurrent=runMaterialWatchScan(bridge);
  assert.deepEqual(calls,[{id:"B",root:"D:/B"}],"inactive B is imported explicitly, never into current A");
  snapshot.libraryId="C";snapshot.generation++;
  setLibraryRootWatch("C","D:/C",false);
  release();
  assert.deepEqual(await concurrent,await first);
  assert.equal(calls.length,1,"toggle-off before a queued library begins prevents its scan");
  assert.equal(readMaterialWatchStatuses("B")["library-root"].lastImportedCount,1);
  assert.deepEqual(readMaterialWatchStatuses("C"),{});
  snapshot.registry!.libraries.find(lib=>lib.id==="B")!.visible=false;
  assert.equal((await runMaterialWatchScan(bridge)).scanned,0);
  snapshot.registry!.libraries.find(lib=>lib.id==="B")!.visible=true;
  setLibraryRootWatch("B","D:/changed",true);
  assert.equal((await runMaterialWatchScan(bridge)).errors,1);
  assert.match(readMaterialWatchStatuses("B")["library-root"].lastError!,/root-changed/);
  assert.equal(storage.get("luckyray-settings-v1"),'{"general.watchFolder":false}');
  setLibraryRootWatch("B","D:/changed",false);
  assert.equal((await runMaterialWatchScan(bridge)).scanned,0);
});
