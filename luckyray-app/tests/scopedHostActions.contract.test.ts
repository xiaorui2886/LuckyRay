import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createScopedHostActions,type ScopedHostActionHandlers} from '../src/workspace/scopedHostActions';
import {NOTE_PRODUCTION_PARENT_ACTIONS,NoteRuntimeError,type NoteActionRequest,type NoteActionReply,type NoteAuthority} from '../src/features/notes/NoteRuntime';

const authority:NoteAuthority={vaultId:'vault-a',sourceId:'issued-source-a',documentId:'document-a'};
function request(changes:Partial<NoteActionRequest>={}):NoteActionRequest {
  return {requestId:1,viewId:'view-a',authority,revision:'r1',generation:0,content:'baseline',action:{kind:'ask-ai'},...changes};
}
const acknowledged:NoteActionReply['result']={ok:true,value:{kind:'acknowledged'}};
function fixture(handlers:ScopedHostActionHandlers={}) {
  let current=request();
  const checked:NoteActionRequest[]=[];
  const actions=createScopedHostActions({viewId:'view-a',authority,handlers,isCurrent:value=>{
    checked.push(value);
    return value.viewId===current.viewId&&value.authority.vaultId===current.authority.vaultId
      &&value.authority.sourceId===current.authority.sourceId&&value.authority.documentId===current.authority.documentId
      &&value.revision===current.revision&&value.generation===current.generation&&value.content===current.content;
  }});
  return {actions,checked,setCurrent:(changes:Partial<NoteActionRequest>)=>{current={...current,...changes};}};
}
function pending() {
  let resolve!:(value:NoteActionReply['result'])=>void;
  let reject!:(error:unknown)=>void;
  const result=new Promise<NoteActionReply['result']>((done,fail)=>{resolve=done;reject=fail;});
  return {result,resolve,reject};
}
function expectCode(reply:NoteActionReply,code:string) {
  assert.equal(reply.result.ok,false);
  if(!reply.result.ok)assert.equal(reply.result.code,code);
}
function expectCorrelation(reply:NoteActionReply,input:NoteActionRequest) {
  assert.deepEqual(Object.keys(reply).sort(),['requestId','viewId','authority','revision','generation','result'].sort());
  assert.deepEqual({...reply,result:undefined},{requestId:input.requestId,viewId:input.viewId,authority:input.authority,revision:input.revision,generation:input.generation,result:undefined});
}

test('uninstalled routes are unsupported and reply correlation never includes the body',async()=>{
  const f=fixture();const input=request();const reply=await f.actions.request(input);
  assert.deepEqual(f.actions.capabilities,[]);expectCode(reply,'unsupported');expectCorrelation(reply,input);
  assert.equal('content' in reply,false);assert.equal('action' in reply,false);
});

test('capabilities derive only from installed own data-property functions and remain frozen',async()=>{
  let calls=0,getterCalls=0;
  const handlers=Object.create({'create-note':()=>acknowledged}) as ScopedHostActionHandlers;
  Object.defineProperty(handlers,'ask-ai',{value:()=>{calls++;return acknowledged;},configurable:true});
  Object.defineProperty(handlers,'suggest-ai',{get:()=>{getterCalls++;return ()=>acknowledged;},configurable:true});
  Object.defineProperty(handlers,'browse-documents',{value:true,configurable:true});
  Object.defineProperty(handlers,'not-a-note-action',{value:()=>acknowledged});
  const f=fixture(handlers);
  assert.deepEqual(f.actions.capabilities,['ask-ai']);assert.equal(getterCalls,0);
  assert.ok(Object.isFrozen(f.actions));assert.ok(Object.isFrozen(f.actions.capabilities));
  assert.ok(f.actions.capabilities!.length<NOTE_PRODUCTION_PARENT_ACTIONS.length);
  Object.defineProperty(handlers,'ask-ai',{value:()=>{throw Error('mutated');}});
  Object.defineProperty(handlers,'close-view',{value:()=>acknowledged});
  assert.equal((await f.actions.request(request())).result.ok,true);assert.equal(calls,1);
  expectCode(await f.actions.request(request({requestId:2,action:{kind:'close-view'}})),'unsupported');
  expectCode(await f.actions.request(request({requestId:3,action:{kind:'create-note',title:'New'}})),'unsupported');
  assert.deepEqual(f.actions.capabilities,['ask-ai']);assert.equal(getterCalls,0);
});

test('foreign view, vault, source incarnation and document never reach a handler',async()=>{
  let calls=0;const f=fixture({'ask-ai':()=>{calls++;return acknowledged;}});
  const changes:Partial<NoteActionRequest>[]=[{viewId:'view-b'},...(['vaultId','sourceId','documentId'] as const).map(key=>({authority:{...authority,[key]:'foreign'}}))];
  for(const change of changes){const input=request(change);const reply=await f.actions.request(input);expectCode(reply,'scope-mismatch');expectCorrelation(reply,input);}
  assert.equal(calls,0);assert.equal(f.checked.length,0);
  assert.equal((await f.actions.request(request())).result.ok,true);assert.equal(calls,1);
});

test('request IDs must be positive safe integers and increase without replaying effects',async()=>{
  const calls:number[]=[];const f=fixture({'ask-ai':input=>{calls.push(input.requestId);return acknowledged;}});
  for(const requestId of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,NaN])expectCode(await f.actions.request(request({requestId})),'invalid-result');
  for(const requestId of [2,4])assert.equal((await f.actions.request(request({requestId}))).result.ok,true);
  for(const requestId of [4,3,1])expectCode(await f.actions.request(request({requestId})),'stale-result');
  expectCode(await f.actions.request(request({requestId:5,action:{kind:'browse-attachments'}})),'unsupported');
  expectCode(await f.actions.request(request({requestId:5})),'stale-result');
  assert.equal((await f.actions.request(request({requestId:6}))).result.ok,true);assert.deepEqual(calls,[2,4,6]);
});

test('concurrent increasing IDs correlate independently when services finish out of order',async()=>{
  const first=pending(),second=pending();
  const f=fixture({'ask-ai':input=>input.requestId===1?first.result:second.result});
  const one=request(),two=request({requestId:2});
  const replyOne=f.actions.request(one),replyTwo=f.actions.request(two);
  second.resolve({ok:true,value:{kind:'acknowledged',message:'second'}});
  const secondReply=await replyTwo;expectCorrelation(secondReply,two);assert.equal(secondReply.result.ok,true);
  first.resolve({ok:true,value:{kind:'acknowledged',message:'first'}});
  const firstReply=await replyOne;expectCorrelation(firstReply,one);assert.equal(firstReply.result.ok,true);
});

test('revision, generation, content and source are checked before and after awaiting services',async()=>{
  const changes:Partial<NoteActionRequest>[]=[{revision:'r2'},{generation:1},{content:'new draft'},{authority:{...authority,sourceId:'recreated-source'}}];
  for(const change of changes){
    let calls=0;const before=fixture({'ask-ai':()=>{calls++;return acknowledged;}});before.setCurrent(change);
    expectCode(await before.actions.request(request()),'stale-result');assert.equal(calls,0);
    const deferred=pending();const after=fixture({'ask-ai':()=>{calls++;return deferred.result;}});
    const reply=after.actions.request(request());after.setCurrent(change);deferred.resolve(acknowledged);
    expectCode(await reply,'stale-result');assert.equal(calls,1);assert.ok(after.checked.length>=2);
  }
});

test('close and same-view regrant dispose the old adapter and invalidate pending results',async()=>{
  let calls=0;const deferred=pending();const old=fixture({'ask-ai':()=>{calls++;return deferred.result;}});
  const reply=old.actions.request(request());old.actions.dispose();old.actions.dispose();
  const replacement=fixture({'ask-ai':()=>acknowledged});
  assert.equal((await replacement.actions.request(request())).result.ok,true);
  deferred.resolve(acknowledged);expectCode(await reply,'stale-result');
  expectCode(await old.actions.request(request({requestId:2})),'stale-result');assert.equal(calls,1);
});

test('a stale binding supersedes an async provider rejection',async()=>{
  const deferred=pending(),f=fixture({'ask-ai':()=>deferred.result});const reply=f.actions.request(request());
  f.actions.dispose();deferred.reject(new NoteRuntimeError('unsupported','provider is absent'));
  expectCode(await reply,'stale-result');
});

test('typed file insertion preserves actual File identity and captures mutable payload containers',async()=>{
  const deferred=pending();const file=new File(['image bytes'],'picture.png',{type:'image/png'});
  const files=[file],selection={start:1,end:3};let captured:NoteActionRequest|undefined;
  const f=fixture({'insert-files':input=>{
    captured=input;
    // Contextual typing exposes only the insertion payload for this route.
    const received:File=input.action.files[0];assert.equal(received,file);
    assert.equal(input.action.selection.end,3);
    return deferred.result;
  }});
  const input=request({action:{kind:'insert-files',files,selection}});
  const reply=f.actions.request(input);files.length=0;selection.start=0;
  assert.ok(captured);assert.ok(Object.isFrozen(captured));assert.ok(Object.isFrozen(captured.authority));
  assert.equal(captured.action.kind,'insert-files');
  if(captured.action.kind==='insert-files'){
    assert.deepEqual(captured.action.selection,{start:1,end:3});assert.equal(captured.action.files.length,1);
    assert.equal(captured.action.files[0],file);assert.notEqual(captured.action.files,files);
    assert.ok(Object.isFrozen(captured.action.files));
  }
  deferred.resolve({ok:true,value:{kind:'replace-range',selection:{start:1,end:3},text:'![picture](granted.png)'}});
  const result=await reply;assert.equal(result.result.ok,true);expectCorrelation(result,input);
  assert.equal(await file.text(),'image bytes');assert.equal('files' in result,false);
});

test('correlation and authority are captured before provider invocation and mutation',async()=>{
  const localAuthority={...authority},deferred=pending();const f=fixture({'ask-ai':()=>deferred.result});
  const input={...request(),authority:localAuthority};const expected=request();const reply=f.actions.request(input);
  localAuthority.documentId='tampered';input.requestId=99;input.viewId='other';input.revision='r2';input.generation=50;
  deferred.resolve({...acknowledged,requestId:99,authority:{...authority,documentId:'foreign'},content:'hidden'} as NoteActionReply['result']);
  const result=await reply;expectCorrelation(result,expected);assert.deepEqual(result.result,acknowledged);
});

test('invalid action envelope and selection never invoke installed routes',async()=>{
  let calls=0;const f=fixture({'write-ai':()=>{calls++;return acknowledged;},'open-external':()=>{calls++;return acknowledged;}});
  for(const change of [{revision:''},{generation:-1},{generation:0.5},{content:null},{action:{kind:'unknown'}},{action:{kind:'open-external',url:'file:///private'}}] as Partial<NoteActionRequest>[])
    expectCode(await f.actions.request(request(change)),'invalid-result');
  for(const selection of [{start:-1,end:1},{start:2,end:1},{start:0,end:100},{start:0.5,end:1}])
    expectCode(await f.actions.request(request({action:{kind:'write-ai',action:'rewrite',selection}})),'invalid-result');
  assert.equal(calls,0);
});

test('provider errors are explicit and malformed transaction results cannot escape',async()=>{
  const errors=[new NoteRuntimeError('unsupported','not installed'),Error('private provider detail')];
  for(const error of errors){
    const f=fixture({'ask-ai':()=>{throw error;}});const result=await f.actions.request(request());
    expectCode(result,error instanceof NoteRuntimeError?'unsupported':'unavailable');
    assert.equal(JSON.stringify(result).includes('private provider detail'),false);
  }
  for(const result of [undefined,{ok:true},{ok:true,value:{kind:'unknown'}},{ok:false,code:'made-up',message:'bad'},
    {ok:true,value:{kind:'replace-range',selection:{start:0,end:100},text:'bad'}},
    {ok:true,value:{kind:'suggestion',tags:[1]}},{ok:true,value:{kind:'renamed',title:'New',documentId:''}}]){
    const f=fixture({'ask-ai':()=>result as NoteActionReply['result']});expectCode(await f.actions.request(request()),'invalid-result');
  }
});

test('the adapter has no native invocation, global bridge, polling or payload serialization',()=>{
  const source=readFileSync(new URL('../src/workspace/scopedHostActions.ts',import.meta.url),'utf8');
  assert.doesNotMatch(source,/JSON\.(?:stringify|parse)|@tauri-apps|setInterval\s*\(|setTimeout\s*\(|getLuckyRayBridge|knowledgeStore|window\.api|\.invoke\s*\(/);
});
