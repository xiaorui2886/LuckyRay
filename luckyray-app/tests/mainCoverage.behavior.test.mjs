import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
const file='luckyray-app/src/workspace/WorkspaceProductionMain.tsx';
const source=process.env.R9_TEST_SOURCE_REF?execFileSync('git',['show',`${process.env.R9_TEST_SOURCE_REF}:${file}`],{encoding:'utf8'}):readFileSync(new URL('../src/workspace/WorkspaceProductionMain.tsx',import.meta.url),'utf8');
const start=source.indexOf('  let coverageRunning='),end=source.indexOf('  const stopNoteRemoval=',start);
assert.ok(start>0&&end>start);
const js=ts.transpileModule(source.slice(start,end)+'\nglobalThis.poll=syncCoverage;', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(){
 let generation=0,ready=false,epoch=0,eligible=true,listener,hold;
 const history=[],errors=[];
 const scope={alive:true,retirements:new Map(),viewOperations:new Map(),report:e=>errors.push(String(e)),
  notesNativeViews:{coverageGeneration:()=>epoch,coverageReady:()=>eligible,list:()=>[{viewId:'v',workspaceSourceId:'source'}],get:()=>({}),subscribe:f=>{listener=f;return()=>{};}},
  bindMainNote:async()=>{if(hold)await hold;},
  workspaceCommand:async request=>{
   if(request.ready===false){generation++;ready=false;}
   if(request.ready===true){if(request.generation!==generation)throw Error('workspace-main-bindings-changed');ready=true;}
   history.push({request:{...request},generation,ready});return {generation,ready};
  }};
 vm.createContext(scope);vm.runInContext(js,scope);
 return {scope,history,errors,get ready(){return ready;},change(value){epoch++;eligible=value;listener();},
  hold(){let release;hold=new Promise(r=>release=r);return()=>{hold=null;release();};}};
}
test('passive coverage checks do not withdraw an unchanged live capability',async()=>{
 const f=fixture();await f.scope.poll();await tick();assert.equal(f.ready,true);f.history.length=0;
 const release=f.hold(),pending=f.scope.poll();await tick();
 assert.equal(f.ready,true,'checking is not revocation');release();await pending;
 for(let i=0;i<10;i++)await f.scope.poll();
 assert.equal(f.history.some(x=>!x.ready),false);assert.deepEqual(f.errors,[]);
});
test('actual coverage loss invalidates while a previous check is still pending',async()=>{
 const f=fixture();await f.scope.poll();await tick();const release=f.hold(),pending=f.scope.poll();await tick();
 f.change(false);await tick();assert.equal(f.ready,false);release();await pending;await tick();assert.equal(f.ready,false);
 f.change(true);await tick();await tick();assert.equal(f.ready,true);
});
test('identity generation change fences a delayed ready publication',async()=>{
 const f=fixture();await f.scope.poll();await tick();const release=f.hold(),pending=f.scope.poll();await tick();
 f.change(false);f.change(false);release();await pending;await tick();assert.equal(f.ready,false);
 assert.equal(f.history.at(-1).ready,false);
});
