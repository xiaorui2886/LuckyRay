import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=readFileSync(new URL('../src/features/notes/ScopedNoteDocumentSurface.tsx',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const start=source.indexOf('  const refreshMetadata=useCallback(async()=>{');
const end=source.indexOf('\n  useEffect(',start);
function fixture(){
 let invalidated=0,ready={revision:'r1',runtime:null,invalidationRevision:0},value={notes:[],tags:[],completeness:{complete:true}},resolve,reject;
 const runtime={};ready.runtime=runtime;
 const scope={useCallback:f=>f,runtime,viewId:'v',bindingEpoch:{current:1},invalidationRef:{current:1},metadataSequence:{current:0},alive:{current:true},
  controller:{session:{getSnapshot:()=>({revision:'r1'})},metadata:()=>new Promise((a,b)=>{resolve=a;reject=b;})},
  metadataCheckpoint:{current:{ready,value}},onRevisionInvalidated:()=>invalidated++,setMetadata:x=>value=x,setMetadataProblem:()=>{},setMetadataReady:x=>ready=x,
  NoteRuntimeError:class extends Error{}};
 vm.createContext(scope);vm.runInContext(ts.transpileModule(source.slice(start,end)+'\nglobalThis.refresh=refreshMetadata;', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,scope);
 return {scope,get invalidated(){return invalidated;},get ready(){return ready;},value,resolve:x=>resolve(x),reject:x=>reject(x)};
}
test('unchanged metadata check retains an already rendered proof while pending and after completion',async()=>{
 const f=fixture(),p=f.scope.refresh();assert.equal(f.invalidated,0,'checking is not missing metadata');
 f.resolve(structuredClone(f.value));await p;assert.equal(f.invalidated,0);assert.equal(f.ready.invalidationRevision,1);
});
test('changed metadata and read failure invalidate the old proof rather than silently keep it',async()=>{
 const f=fixture(),p=f.scope.refresh();f.resolve({...f.value,tags:['changed']});await p;assert.equal(f.invalidated,1);
 const g=fixture(),q=g.scope.refresh();g.reject(Error('read failed'));await q;assert.equal(g.invalidated,1);assert.equal(g.ready,null);
});
test('actual revision change cannot reuse a metadata proof during revalidation',async()=>{
 const f=fixture();f.scope.controller.session.getSnapshot=()=>({revision:'r2'});const p=f.scope.refresh();assert.equal(f.invalidated,1);assert.equal(f.ready,null);f.resolve(f.value);await p;
});
test('renderer-check effect cleanup does not revoke unchanged readiness between hint checks',()=>{
 const begin=source.indexOf('  useEffect(()=>{\n    if(restoring'),end=source.indexOf('panelsReady]);',begin)+'panelsReady]);'.length;assert.ok(begin>0&&end>begin);
 let cleanup,invalidated=0,acknowledged=0,cancelled=0,frame;const runtime={};
 const scope={useEffect:f=>{cleanup=f();},restoring:false,actionsReady:true,panelsReady:true,visible:true,composing:{current:false},onRevisionReady:()=>acknowledged++,onRevisionInvalidated:()=>invalidated++,
  state:{revision:'r1',content:'text',status:'ready',dirty:false},metadataReady:{revision:'r1',runtime,invalidationRevision:0},attachmentsReady:{revision:'r1',runtime,invalidationRevision:0},
  runtime,invalidationRevision:0,invalidationRef:{current:0},mode:'live',live:{current:{getValue:()=> 'text'}},source:{current:null},layoutRevision:'a',compositionEpoch:0,capabilityRevision:0,
  requestAnimationFrame:f=>{frame=f;return 1;},cancelAnimationFrame:()=>cancelled++};
 vm.createContext(scope);const code=ts.transpileModule(source.slice(begin,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInContext(code,scope);frame();assert.equal(acknowledged,1);cleanup();assert.equal(cancelled,1);assert.equal(invalidated,0);
 scope.invalidationRevision=1;scope.invalidationRef.current=1;vm.runInContext(code,scope);assert.equal(invalidated,0);assert.equal(acknowledged,1);
 scope.state.dirty=true;vm.runInContext(code,scope);assert.equal(invalidated,1);
});
