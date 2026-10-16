import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createNativeNoteActions,serializeNativeNoteAction,type NativeNoteActionStatus,type NativeNoteActionCommand} from '../src/workspace/nativeNoteActions';
import {generateScopedNoteSuggestion,generateScopedNoteWrite,parseScopedNoteSuggestion,validateNoteMainClaim} from '../src/workspace/nativeNoteMainProtocol';
import type {NoteActionRequest,NoteParentActionKind} from '../src/features/notes/NoteRuntime';
const authority={vaultId:'vault-a',sourceId:`note-source-v1:${'a'.repeat(64)}`,documentId:'kdoc-12'};
const request=(kind:NoteParentActionKind='ask-ai'):NoteActionRequest=>({requestId:1,viewId:'view-a',authority,revision:'r1',generation:2,content:'hello world',action:{kind} as NoteActionRequest['action']});
function fixture(status:NativeNoteActionStatus={state:'completed',result:{ok:true,value:{kind:'acknowledged'}}}){
 let current=true,freezes=0,releases=0;const calls:NativeNoteActionCommand[]=[];
 const actions=createNativeNoteActions({viewId:'view-a',authority,capabilities:['ask-ai','suggest-ai','write-ai','rename-document'],isCurrent:()=>current,command:async<T>(input:NativeNoteActionCommand)=>{calls.push(input);return status as T;},wait:async()=>{},freezeForAction:async()=>{freezes++;return()=>{releases++;};}});
 return {actions,calls,setCurrent:(value:boolean)=>{current=value;},counts:()=>({freezes,releases})};
}
test('native installed routes are explicit and backend capability omission stays visible',async()=>{
 const f=fixture();assert.deepEqual(f.actions.capabilities,['rename-document','ask-ai','suggest-ai','write-ai']);
 const reply=await f.actions.request(request('create-note'));assert.equal(reply.result.ok,false);assert.equal(f.calls.length,0);
});
test('source/view/revision and monotonic request checks precede any native effect',async()=>{
 const f=fixture();assert.equal((await f.actions.request({...request(),viewId:'other'})).result.ok,false);assert.equal(f.calls.length,0);
 assert.equal((await f.actions.request({...request(),authority:{...authority,sourceId:'recreated'}})).result.ok,false);assert.equal(f.calls.length,0);
 assert.equal((await f.actions.request(request())).result.ok,true);assert.deepEqual(f.counts(),{freezes:1,releases:1});
 assert.equal((await f.actions.request(request())).result.ok,false);assert.equal(f.calls.length,1);
});
test('closed or changed controller never forwards an action',async()=>{
 const f=fixture();f.setCurrent(false);assert.equal((await f.actions.request(request())).result.ok,false);assert.equal(f.calls.length,0);
 const disposed=fixture();disposed.actions.dispose();assert.equal((await disposed.actions.request(request())).result.ok,false);assert.equal(disposed.calls.length,0);
});
test('Main handler lease expires locally and notifies readiness before another request',async(t)=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});
 let notifications=0;
 const actions=createNativeNoteActions({viewId:'view-a',authority,capabilities:['ask-ai'],capabilityLeaseMs:5,isCurrent:()=>true,command:async<T>()=>({actions:['ask-ai'],expiresInMs:5} as T)});
 const stop=actions.subscribeCapabilities!(()=>{notifications++;});assert.ok(actions.capabilities!.includes('ask-ai'));
 t.mock.timers.tick(15);assert.ok(!actions.capabilities!.includes('ask-ai'));assert.ok(notifications>0);
 await actions.refreshCapabilities();assert.ok(actions.capabilities!.includes('ask-ai'));stop();actions.dispose();
});
test('fake inline AI acknowledgement is rejected and exact suggestions are returned',async()=>{
 assert.equal((await fixture().actions.request(request('suggest-ai'))).result.ok,false);
 const f=fixture({state:'completed',result:{ok:true,value:{kind:'suggestion',summary:'Summary',tags:['one']}}});assert.equal((await f.actions.request(request('suggest-ai'))).result.ok,true);
 const write={...request(),action:{kind:'write-ai' as const,action:'rewrite' as const,selection:{start:0,end:5}}};assert.equal((await fixture().actions.request(write)).result.ok,false);
});
test('pending receipt must remain bound to exact request/view/revision/generation',async()=>{
 const f=fixture({state:'pending',id:'c'.repeat(64),requestId:2,viewId:'view-a',revision:'r1',generation:2});
 const reply=await f.actions.request(request());assert.equal(reply.result.ok,false);assert.equal(f.calls.length,1);assert.deepEqual(f.counts(),{freezes:1,releases:1});
});
test('rename cannot rebind without a complete validated new grant',async()=>{
 const f=fixture({state:'completed',result:{ok:true,value:{kind:'renamed',title:'New',documentId:'forged'}}});
 assert.equal((await f.actions.request({...request(),action:{kind:'rename-document',title:'New'}})).result.ok,false);
});
test('a renderer path-shaped object cannot masquerade as a user File',async()=>{
 await assert.rejects(()=>serializeNativeNoteAction({kind:'insert-files',selection:{start:0,end:0},files:[{name:'private.txt',size:3,arrayBuffer:async()=>new ArrayBuffer(3),path:'/private'} as File]}));
});
test('Main suggestion performs real bounded provider call and validates JSON response',async()=>{
 let prompt='';const suggestion=await generateScopedNoteSuggestion({kind:'suggestAi',title:'Example',content:'x'.repeat(9000),currentTags:['current'],knownTags:['known']},async(messages)=>{prompt=messages[0].content;return {success:true,content:'{"summary":"Brief","tags":["#one","one","two"]}'};});
 assert.equal(suggestion.kind,'suggestion');assert.deepEqual(suggestion.tags,['one','two']);assert.ok(prompt.length<6000);assert.match(prompt,/current/);assert.match(prompt,/known/);
 assert.throws(()=>parseScopedNoteSuggestion('{"tags":[{"path":"/private"}]}'));
});
test('Main inline writing generates a proposal without applying content or charging on unrelated actions',async()=>{
 let calls=0;const result=await generateScopedNoteWrite({kind:'writeAi',action:'rewrite',content:'hello world',selection:{start:0,end:5}},async()=>{calls++;return {success:true,content:'goodbye'};});
 assert.deepEqual(result,{kind:'replace-range',selection:{start:0,end:5},text:'goodbye'});assert.equal(calls,1);
 await assert.rejects(()=>generateScopedNoteWrite({kind:'writeAi',action:'title',content:'hello',selection:{start:0,end:5}},async()=>{calls++;return {success:true,content:'Title'};}));assert.equal(calls,1);
 assert.throws(()=>validateNoteMainClaim({id:'a'.repeat(64),claimToken:'b'.repeat(64),remainingMs:1,action:{kind:'runShell'} as never}));
});
test('child action module contains no global service, path API, provider or SQL fallback',()=>{
 const source=readFileSync(new URL('../src/workspace/nativeNoteActions.ts',import.meta.url),'utf8');assert.doesNotMatch(source,/getLuckyRayBridge|readActiveKnowledge|knowledgeStore|plugin-fs|plugin-sql|aiChatComplete|window\.api/);
});


test('renewing the same live capability set does not retire rendered readiness',async()=>{
 let notifications=0;
 const actions=createNativeNoteActions({viewId:'view-a',authority,capabilities:['ask-ai','rename-document'],capabilityLeaseMs:10000,isCurrent:()=>true,command:async<T>()=>({actions:['rename-document','ask-ai','ask-ai'],expiresInMs:10000} as T)});
 const stop=actions.subscribeCapabilities!(()=>{notifications++;});
 try {for(let i=0;i<5;i++)await actions.refreshCapabilities();assert.equal(notifications,0,'same permissions/identity are a lease renewal, not a new rendered document');assert.deepEqual(actions.capabilities,['rename-document','ask-ai']);}
 finally{stop();actions.dispose();}
});
test('real permission removal still notifies and denies the next action',async()=>{
 let notifications=0;
 const actions=createNativeNoteActions({viewId:'view-a',authority,capabilities:['ask-ai'],capabilityLeaseMs:10000,isCurrent:()=>true,command:async<T>()=>({actions:[],expiresInMs:10000} as T)});
 const stop=actions.subscribeCapabilities!(()=>{notifications++;});
 try {await actions.refreshCapabilities();assert.equal(notifications,1);assert.deepEqual(actions.capabilities,[]);assert.equal((await actions.request(request())).result.ok,false);}
 finally{stop();actions.dispose();}
});

test('an older capability response cannot undo a newer revocation',async()=>{
 const replies:Array<(value:unknown)=>void>=[];
 const actions=createNativeNoteActions({viewId:'view-a',authority,capabilities:['ask-ai'],capabilityLeaseMs:10000,isCurrent:()=>true,command:<T>()=>new Promise<T>(resolve=>replies.push(value=>resolve(value as T)))});
 try {
  const old=actions.refreshCapabilities(),newer=actions.refreshCapabilities();
  replies[1]({actions:[],expiresInMs:10000});await newer;assert.deepEqual(actions.capabilities,[]);
  replies[0]({actions:['ask-ai'],expiresInMs:10000});await old;
  assert.deepEqual(actions.capabilities,[],'stale positive completion must not restore revoked permission');
 } finally {actions.dispose();}
});
test('expiry and later restoration each invalidate once, independent of unchanged action names',async(t)=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});
 let notifications=0;
 const actions=createNativeNoteActions({viewId:'view-a',authority,capabilities:['ask-ai'],capabilityLeaseMs:5,isCurrent:()=>true,command:async<T>()=>({actions:['ask-ai'],expiresInMs:10000} as T)});
 const stop=actions.subscribeCapabilities!(()=>{notifications++;});
 try {t.mock.timers.tick(20);assert.equal(notifications,1);assert.deepEqual(actions.capabilities,[]);await actions.refreshCapabilities();assert.equal(notifications,2);assert.deepEqual(actions.capabilities,['ask-ai']);}
 finally{stop();actions.dispose();}
});
