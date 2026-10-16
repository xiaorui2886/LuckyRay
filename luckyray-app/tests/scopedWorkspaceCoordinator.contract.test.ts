import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {ScopedWorkspaceCoordinator,type ScopedHostProof,type ScopedHostTransfer} from '../src/workspace/scopedWorkspaceCoordinator.ts';
import {LayoutStore} from '../src/workspace/layoutStore.ts';
import {nativeNoteDocumentId} from '../src/workspace/nativeNoteRuntime.ts';
import {NOTE_PRODUCTION_PARENT_ACTIONS,type NoteRuntime} from '../src/features/notes/NoteRuntime.ts';
import type {GraphRuntime} from '../src/features/graph/GraphRuntime.ts';
const panels={index:()=>null,attachments:()=>null};
const authority={vaultId:'vault-a',sourceId:'captured-source',documentId:nativeNoteDocumentId({vaultId:'vault-a',relativePath:'A.md'})};
const view=(id:string)=>({id,kind:'note' as const,title:'A',library:{kind:'knowledge' as const,id:'vault-a'},resourceId:'A.md'});
function runtime(backend={content:'initial',revision:'r1',writes:0},complete=true):NoteRuntime{
 return {kind:'scoped',authority,documents:{read:async()=>({...backend,authority}),write:async(content,revision)=>{assert.equal(revision,backend.revision);backend.writes++;backend.content=content;backend.revision=`r${backend.writes+1}`;return {...backend,authority};}},
 metadata:{read:async revision=>({ok:true,value:{authority,revision,metadata:{notes:[],tags:[],links:[],backlinks:[],documentTags:[],favorite:false},completeness:{complete:true,missing:[],truncated:false,scope:'linked-and-backlinked',noteSuggestions:'linked-and-backlinked'}}})},
 attachments:{resolve:async()=>({ok:true,value:[]}),mediaUrl:()=>{throw Error('no fixture media');}},actions:{capabilities:complete?NOTE_PRODUCTION_PARENT_ACTIONS:[],request:async r=>({...r,result:{ok:true,value:{kind:'acknowledged'}}})}};
}
async function fixture(){const store=new LayoutStore('fixture'),c=new ScopedWorkspaceCoordinator(store),r=runtime(),entry=c.bindNote(view('one'),r,panels);await entry.controller.load();c.noteRendered('one',r,'r1');return {c,r,entry,store};}
test('R9 bodyless checks retain a rendered proof; observed content changes still revoke it',async()=>{
 const {c,entry}=await fixture();const proof=entry.ready;
 for(let n=0;n<5;n++){await entry.controller.session.refresh();c.invalidateNoteData('one');assert.equal(entry.ready,proof);}
 assert.equal(entry.invalidationRevision,5);
 entry.controller.session.receive({revision:'r2',content:'actual external edit'});assert.equal(entry.ready,null);
});
function transfer(proof:ScopedHostProof){const calls:string[]=[];const transport:ScopedHostTransfer={open:async v=>{calls.push('open');return {id:'target',viewId:v.id};},waitReady:async t=>{calls.push('ready');return {targetId:t.id,viewId:t.viewId,proof};},releaseSource:async()=>{calls.push('release');},cancelTarget:async()=>{calls.push('cancel');}};return {calls,transport};}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));

test('duplicate views share one draft/CAS owner, close of either grant leaves remaining transport live',async()=>{
 const backend={content:'initial',revision:'r1',writes:0},a=runtime(backend),b=runtime(backend),c=new ScopedWorkspaceCoordinator(new LayoutStore('fixture'));
 const first=c.bindNote(view('one'),a,panels),second=c.bindNote(view('two'),b,panels);assert.equal(first.controller,second.controller);await first.controller.load();
 first.controller.edit('both panes');assert.equal(second.controller.session.getSnapshot().content,'both panes');assert.equal(await c.flushAll(),true);assert.equal(backend.writes,1);
 assert.deepEqual(await c.close('one',async()=>{}),{ok:true});second.controller.edit('remaining live');assert.equal(await c.flushAll(),true);assert.equal(backend.writes,2);assert.equal(c.noteRendered('one',a,'r2'),false);
});
test('same-authority regrant preserves owner/draft and rejects stale renderer callbacks',async()=>{
 const {c,r,entry}=await fixture();entry.controller.edit('unsaved survives');const replacement=runtime();const old=entry.controller;
 c.regrantNote('one',replacement);assert.equal(entry.controller,old);assert.equal(old.session.getSnapshot().content,'unsaved survives');assert.equal(c.noteRendered('one',r,'r1'),false);
 assert.throws(()=>c.regrantNote('one',{...replacement,authority:{...authority,sourceId:'other-source'}}),/来源/);assert.equal(entry.runtime,replacement);
});
test('foreign document/view binding and persisted layout mismatch are rejected before mounting',()=>{
 const c=new ScopedWorkspaceCoordinator(new LayoutStore('fixture'));assert.throws(()=>c.bindNote({...view('one'),resourceId:'B.md'},runtime(),panels),/document-mismatch/);
 c.store.dispatch({type:'open',view:{...view('one'),resourceId:'B.md'},groupId:c.store.getSnapshot().focusedGroup});assert.throws(()=>c.bindNote(view('one'),runtime(),panels),/layout-binding-mismatch/);
});
test('missing actions or either panel never yields ready or creates target',async()=>{
 for(const [complete,p] of [[false,panels],[true,{index:()=>null}],[true,{}]] as const){
  const c=new ScopedWorkspaceCoordinator(new LayoutStore('fixture')),r=runtime(undefined,complete),e=c.bindNote(view('one'),r,p);await e.controller.load();assert.equal(c.noteRendered('one',r,'r1'),false);
  const f=transfer({kind:'note',authority,revision:'r1'});assert.equal((await c.transfer('one',f.transport)).ok,false);assert.deepEqual(f.calls,[]);assert.ok(c.store.getSnapshot().views.one);
 }
});
test('source releases only after full matching target proof; controller draft remains retained',async()=>{
 const {c,entry,store}=await fixture(),f=transfer({kind:'note',authority,revision:'r1'});assert.deepEqual(await c.transfer('one',f.transport),{ok:true});assert.deepEqual(f.calls,['open','ready','release']);assert.equal(store.getSnapshot().views.one,undefined);assert.equal(entry.controller.session.getSnapshot().content,'initial');
});
test('wrong target, revision or source proof retains source and cancels only admitted target',async()=>{
 for(const field of ['target','revision','source']){
  const {c,store}=await fixture(),f=transfer({kind:'note',authority,revision:'r1'});
  f.transport.waitReady=async t=>({targetId:field==='target'?'other':t.id,viewId:t.viewId,proof:{kind:'note',authority:field==='source'?{...authority,sourceId:'foreign'}:authority,revision:field==='revision'?'r0':'r1'}});
  assert.equal((await c.transfer('one',f.transport)).ok,false);assert.deepEqual(f.calls,['open','cancel']);assert.ok(store.getSnapshot().views.one);
 }
});
test('editing while target waits aborts release and retains newer draft',async()=>{
 const {c,entry,store}=await fixture(),f=transfer({kind:'note',authority,revision:'r1'});
 f.transport.waitReady=async t=>{entry.controller.edit('newer typing');return {targetId:t.id,viewId:t.viewId,proof:{kind:'note',authority,revision:'r1'}};};
 assert.equal((await c.transfer('one',f.transport)).ok,false);assert.deepEqual(f.calls,['open','cancel']);assert.ok(store.getSnapshot().views.one);assert.equal(entry.controller.session.getSnapshot().content,'newer typing');
});
test('IME in any duplicate view blocks transfer/close/all-dirty flush without removing drafts',async()=>{
 const {c,entry,r}=await fixture();c.bindNote(view('two'),r,panels);entry.controller.setComposing('two',true);entry.controller.edit('composition');const f=transfer({kind:'note',authority,revision:'r1'});
 assert.equal((await c.transfer('one',f.transport)).ok,false);assert.equal((await c.close('one',async()=>{throw Error('must not release');})).ok,false);assert.equal(await c.flushAll(),false);assert.deepEqual(f.calls,[]);assert.equal(entry.controller.session.getSnapshot().content,'composition');
 entry.controller.setComposing('two',false);assert.equal(await c.flushAll(),true);
});
test('save conflict retains source/draft and never attempts target admission',async()=>{
 const {c,entry,r}=await fixture();r.documents.write=async()=>{throw Error('conflict');};entry.controller.edit('local remains');const f=transfer({kind:'note',authority,revision:'r1'});
 assert.equal((await c.transfer('one',f.transport)).ok,false);assert.equal(entry.controller.session.getSnapshot().content,'local remains');assert.deepEqual(f.calls,[]);
});
test('uncertain source-release failure retains both acknowledged target and source draft',async()=>{
 const {c,store}=await fixture(),f=transfer({kind:'note',authority,revision:'r1'});f.transport.releaseSource=async()=>{f.calls.push('release');throw Error('uncertain');};
 assert.equal((await c.transfer('one',f.transport)).ok,false);assert.deepEqual(f.calls,['open','ready','release']);assert.ok(store.getSnapshot().views.one);
});
test('cancelled late target admission is cleaned without closing source or leaking receipt',async()=>{
 const {c,store}=await fixture(),f=transfer({kind:'note',authority,revision:'r1'}),abort=new AbortController();let admit:(v:{id:string;viewId:string})=>void=()=>{};
 f.transport.open=()=>new Promise(resolve=>{admit=resolve;});const pending=c.transfer('one',f.transport,abort.signal);await tick();abort.abort();assert.equal((await pending).ok,false);
 admit({id:'late',viewId:'one'});await tick();assert.deepEqual(f.calls,['cancel']);assert.ok(store.getSnapshot().views.one);assert.equal(c.getSnapshot().busy,false);
});
test('close during release uncertainty or newer edits keeps tab and draft; operations are serialized',async()=>{
 const {c,entry,store}=await fixture();let finish:()=>void=()=>{};const closing=c.close('one',()=>new Promise(resolve=>{finish=resolve;}));await tick();
 assert.deepEqual(await c.close('one',async()=>{}),{ok:false,error:'workspace-host-busy'});entry.controller.edit('new edit');finish();assert.equal((await closing).ok,false);assert.ok(store.getSnapshot().views.one);assert.equal(entry.controller.session.getSnapshot().content,'new edit');
});

test('explicit close cancellation retains the exact controller and ignores a late release completion',async()=>{
 const {c,entry,store}=await fixture(),abort=new AbortController();let finish:()=>void=()=>{};
 entry.controller.edit('cancelled close 中文🙂\n');
 const closing=c.close('one',()=>new Promise<void>(resolve=>{finish=resolve;}),abort.signal);
 await tick();abort.abort();assert.equal((await closing).ok,false);finish();await tick();
 assert.equal(c.getView('one'),entry);assert.ok(entry.open);assert.ok(store.getSnapshot().views.one);
 assert.equal(entry.controller.session.getSnapshot().content,'cancelled close 中文🙂\n');
 assert.deepEqual(entry.controller.runtime.authority,authority);
});
test('dispose invalidates pending admission and late renderer callbacks, without discarding dirty owner',async()=>{
 const {c,entry,r}=await fixture();entry.controller.edit('retained after teardown');c.dispose();assert.equal(c.noteRendered('one',r,'r1'),false);assert.equal(entry.controller.session.getSnapshot().content,'retained after teardown');assert.equal((await c.close('one',async()=>{})).ok,false);
});
test('graph snapshot invalidation while waiting blocks stale proof and preserves independent graph view',async()=>{
 let current={kind:'graph' as const,snapshotId:'s1',revision:'g1'},listener=()=>{};
 const r:GraphRuntime={kind:'scoped',allowWorker:false,vaultId:'vault-a',readSeed:async()=>({nodes:[],edges:[]}) as never,subscribe:fn=>{listener=fn;return()=>{};},capability:()=>({available:true}),completeness:()=>({complete:true,missing:[]}),renderedRevision:()=>current.revision,dataProof:()=>current,mutateRelation:async()=>({}) as never,act:async()=>{},exportScreenshot:async()=> 'copied',contextNodeKey:()=>null,publishContext:()=>{}};
 const c=new ScopedWorkspaceCoordinator(new LayoutStore('fixture'));c.bindGraph({...view('graph'),kind:'graph',resourceId:undefined},r);assert.equal(c.graphRendered('graph',r,current),true);
 const f=transfer({...current,vaultId:'vault-a'});f.transport.waitReady=async t=>{current={kind:'graph',snapshotId:'s2',revision:'g2'};listener();return {targetId:t.id,viewId:t.viewId,proof:{kind:'graph',snapshotId:'s1',revision:'g1',vaultId:'vault-a'}};};
 assert.equal((await c.transfer('graph',f.transport)).ok,false);assert.deepEqual(f.calls,['open','cancel']);assert.ok(c.store.getSnapshot().views.graph);assert.equal(c.graphRendered('graph',r,{kind:'graph',snapshotId:'s1',revision:'g1'}),false);
});
test('composition uses real full renderers, host leases and flat keyed domain hosts without native activation',()=>{
 const host=readFileSync(new URL('../src/workspace/ScopedWorkspaceHost.tsx',import.meta.url),'utf8');assert.match(host,/<WorkspaceHost/);assert.match(host,/<ScopedNoteDocumentSurface/);assert.match(host,/<ScopedGraphDocumentSurface/);assert.match(host,/viewLease="host"/);assert.doesNotMatch(host,/WorkspaceNoteView|<App|GlobalAppSidebar|workspaceCommand|installLuckyRayBridge/);
 const main=readFileSync(new URL('../src/main.tsx',import.meta.url),'utf8'),old=readFileSync(new URL('../src/workspace/WorkspaceWindow.tsx',import.meta.url),'utf8');assert.doesNotMatch(main+old,/ScopedWorkspaceHost/);
 const drag=readFileSync(new URL('../src/workspace/nativeTabDrag.ts',import.meta.url),'utf8');assert.match(drag,/PRODUCTION_PHYSICAL_TEAROUT_VERIFIED\s*=\s*false/);
});

test('copy waits for target proof but never releases the original source',async()=>{
 const {c,store}=await fixture(),f=transfer({kind:'note',authority,revision:'r1'});assert.deepEqual(await c.transfer('one',f.transport,undefined,false),{ok:true});assert.deepEqual(f.calls,['open','ready']);assert.ok(store.getSnapshot().views.one);
});

test('layout undo preserves membership authority: moves work, closed grant resurrection is vetoed',async()=>{
 const {c,store,r}=await fixture();c.bindNote(view('two'),r,panels);
 store.dispatch({type:'move',viewId:'one',targetGroup:store.getSnapshot().focusedGroup,edge:'right',groupId:'split-group',splitId:'split'});
 assert.equal(store.getSnapshot().root.kind,'split');assert.equal(c.undoLayout(),true);assert.equal(store.getSnapshot().root.kind,'group');
 await c.close('one',async()=>{});const after=store.getSnapshot();assert.equal(c.undoLayout(),false);assert.equal(store.getSnapshot(),after);assert.equal(c.undoLayout(),false);assert.equal(store.getSnapshot(),after);
});

test('IME beginning after target admission prevents release even with matching ready proof',async()=>{
 const {c,entry,store}=await fixture(),f=transfer({kind:'note',authority,revision:'r1'});
 f.transport.waitReady=async t=>{entry.controller.setComposing('one',true);return {targetId:t.id,viewId:t.viewId,proof:{kind:'note',authority,revision:'r1'}};};
 assert.equal((await c.transfer('one',f.transport)).ok,false);assert.deepEqual(f.calls,['open','cancel']);assert.ok(store.getSnapshot().views.one);
});
test('failed target cleanup never traps the transaction after external cancellation',async()=>{
 const {c,store}=await fixture(),f=transfer({kind:'note',authority,revision:'r1'}),abort=new AbortController();
 f.transport.waitReady=async()=>{throw Error('target died');};f.transport.cancelTarget=()=>new Promise(()=>{});
 const pending=c.transfer('one',f.transport,abort.signal);await tick();abort.abort();const result=await pending;assert.equal(result.ok,false);assert.match(result.ok?'':result.error,/cleanup-unconfirmed/);assert.equal(c.getSnapshot().busy,false);assert.ok(store.getSnapshot().views.one);
});
test('renderer metadata/media revocation invalidates previously-ready proof before source release',async()=>{
 const {c,r,store}=await fixture(),f=transfer({kind:'note',authority,revision:'r1'});f.transport.waitReady=async t=>{c.invalidateRendered('one',r);return {targetId:t.id,viewId:t.viewId,proof:{kind:'note',authority,revision:'r1'}};};
 assert.equal((await c.transfer('one',f.transport)).ok,false);assert.deepEqual(f.calls,['open','cancel']);assert.ok(store.getSnapshot().views.one);
 const surface=readFileSync(new URL('../src/features/notes/ScopedNoteDocumentSurface.tsx',import.meta.url),'utf8');assert.match(surface,/onRevisionInvalidated\?\.\(\)/);assert.match(surface,/compositionEpoch/);
});

test('late cancelled admission cleanup failure preserves exact receipt for recovery',async()=>{
 const {c}=await fixture(),f=transfer({kind:'note',authority,revision:'r1'}),abort=new AbortController();let admit:(v:{id:string;viewId:string})=>void=()=>{};
 f.transport.open=()=>new Promise(resolve=>{admit=resolve;});f.transport.cancelTarget=async()=>{throw Error('cannot confirm cleanup');};
 const pending=c.transfer('one',f.transport,abort.signal);await tick();abort.abort();await pending;admit({id:'late-uncertain',viewId:'one'});await tick();
 assert.deepEqual(c.getSnapshot().uncertainTargets,[{id:'late-uncertain',viewId:'one'}]);assert.match(c.getSnapshot().error,/cleanup-unconfirmed/);assert.equal(c.getSnapshot().busy,false);
});
test('installed handlers can revalidate exact in-flight source at their side-effect boundary',async()=>{
 const {c,r,entry}=await fixture();let captured:any;
 r.actions.request=async request=>{captured=request;assert.equal(c.isActionCurrent(request,r),true);entry.controller.edit('new typing');assert.equal(c.isActionCurrent(request,r),false);return {...request,result:{ok:true,value:{kind:'acknowledged'}}};};
 await assert.rejects(()=>entry.controller.request('one',{kind:'set-favorite',favorite:true}),/变化/);assert.equal(c.isActionCurrent(captured,r),false);
});


test('live native lease renewal preserves the exact coordinator rendered proof without a new frame',async()=>{
 const {createNativeNoteActions}=await import('../src/workspace/nativeNoteActions.ts');
 let advertised=[...NOTE_PRODUCTION_PARENT_ACTIONS];
 const liveAuthority={...authority,sourceId:`note-source-v1:${'a'.repeat(64)}`};
 const actions=createNativeNoteActions({viewId:'one',authority:liveAuthority,capabilities:advertised,capabilityLeaseMs:10000,isCurrent:()=>true,showPanel:()=>{},closeView:()=>{},command:async<T>()=>({actions:advertised,expiresInMs:10000} as T)});
 const {createNativeNoteRuntime}=await import('../src/workspace/nativeNoteRuntime.ts');
 const r=createNativeNoteRuntime('one',liveAuthority,{actions,mediaUrl:()=>{throw Error('not used');},command:async<T>(command:import('../src/workspace/nativeNoteRuntime').NativeNoteCommand)=>{if(command.op!=='readNote')throw Error('unexpected native operation');return {authority:liveAuthority,documentRef:{vaultId:'vault-a',relativePath:'A.md'},content:'initial',revision:'r1'} as T;}}),c=new ScopedWorkspaceCoordinator(new LayoutStore('renewal-fixture'));
 try {
  const entry=c.bindNote(view('one'),r,panels);await entry.controller.load();assert.equal(c.noteRendered('one',r,'r1'),true);
  const proof=entry.ready;assert.ok(proof);
  // No renderer callback occurs while the WebView is hidden/throttled.
  for(let i=0;i<5;i++)await r.refreshCapabilities();
  assert.equal(entry.ready,proof,'a lease extension must not clear the exact rendered revision');
  advertised=advertised.filter(kind=>kind!=='ask-ai');await r.refreshCapabilities();
  assert.equal(entry.ready,null,'actual revocation still invalidates readiness');
  assert.equal(c.noteRendered('one',r,'r1'),false,'rendering cannot bypass a missing required capability');
 } finally {c.dispose();r.dispose();actions.dispose();}
});
