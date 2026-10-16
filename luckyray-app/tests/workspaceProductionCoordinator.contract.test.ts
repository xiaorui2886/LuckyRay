import test from 'node:test';
import assert from 'node:assert/strict';
import {ScopedWorkspaceCoordinator} from '../src/workspace/scopedWorkspaceCoordinator.ts';
import {LayoutStore} from '../src/workspace/layoutStore.ts';
import {NOTE_PRODUCTION_PARENT_ACTIONS,type NoteRuntime} from '../src/features/notes/NoteRuntime.ts';
import {nativeNoteDocumentId} from '../src/workspace/nativeNoteRuntime.ts';
import type {NotePresentationHandle,NoteViewPresentationSnapshot} from '../src/features/notes/noteViewPresentation.ts';
const view=(path='A.md')=>({id:'notes-view-one',kind:'note' as const,library:{kind:'knowledge' as const,id:'vault'},title:path,resourceId:path});
const runtime=(path='A.md',source='source'):NoteRuntime=>({kind:'scoped',authority:{vaultId:'vault',sourceId:source,documentId:nativeNoteDocumentId({vaultId:'vault',relativePath:path})},documents:{read:async()=>({authority:runtime(path,source).authority,revision:'r1',content:'text'}),write:async()=>{throw Error('unexpected write');}},metadata:{read:async()=>({ok:false,code:'unavailable',message:'unused'})},attachments:{resolve:async()=>({ok:true,value:[]}),mediaUrl:()=>''},actions:{capabilities:NOTE_PRODUCTION_PARENT_ACTIONS,request:async request=>({...request,result:{ok:true,value:{kind:'acknowledged'}}})}});
const panels={index:()=>null,attachments:()=>null};
function portable(r:NoteRuntime):NoteViewPresentationSnapshot{return {version:1,authority:r.authority,revision:'r1',content:'text',mode:'source',live:null,sourceSelection:{start:1,end:2,direction:'forward'},sourceScroll:{top:0,left:0},contentScroll:{top:0,left:0},media:[]};}
function handle(calls:string[]):NotePresentationHandle{return {capture:async()=>{throw Error('unused capture');},restore:async()=>{calls.push('restore');},freeze:()=>{calls.push('freeze');},activate:async()=>{calls.push('activate');},abort:async()=>{calls.push('abort');}};}
test('queued incoming note freeze reaches the real handle on first registration',()=>{
 const c=new ScopedWorkspaceCoordinator(new LayoutStore('child')),r=runtime(),calls:string[]=[];c.bindNote(view(),r,panels);c.freezeView(view().id);assert.equal(c.hasFrozenViews(),true);c.attachNotePresentation(view().id,handle(calls));assert.deepEqual(calls,['freeze']);
});
test('rename migrates exact authority/controller and restores portable state before unfreezing',async()=>{
 const c=new ScopedWorkspaceCoordinator(new LayoutStore('child')),old=runtime(),next=runtime('B.md'),calls:string[]=[];const entry=c.bindNote(view(),old,panels,()=>calls.push('dispose-old'));
 await entry.controller.load();c.attachNotePresentation(view().id,handle(calls));c.noteRendered(view().id,old,'r1');c.freezeView(view().id);
 const applying=c.migrateNote(view().id,view('B.md'),next,panels,{content:'text',revision:'r2'},portable(old),()=>{});
 await Promise.resolve();const rebound=c.getView(view().id)!;assert.equal(rebound.kind,'note');assert.notEqual(rebound,entry);assert.equal(rebound.frozen,true);
 c.attachNotePresentation(view().id,handle(calls));c.noteRendered(view().id,next,'r2');await applying;
 assert.equal(c.getView(view().id)?.frozen,false);assert.equal(c.store.getSnapshot().views[view().id].resourceId,'B.md');assert.equal(calls.at(-1),'dispose-old');assert.ok(calls.indexOf('restore')<calls.indexOf('activate'));assert.equal(entry.controller.session.getSnapshot().content,'text');
});
test('rename never replaces a newer local draft or an unrelated source incarnation',async()=>{
 const c=new ScopedWorkspaceCoordinator(new LayoutStore('child')),r=runtime(),entry=c.bindNote(view(),r,panels);await entry.controller.load();c.attachNotePresentation(view().id,handle([]));c.freezeView(view().id);entry.controller.edit('newer draft');
 await assert.rejects(c.migrateNote(view().id,view('B.md'),runtime('B.md'),panels,{content:'text',revision:'r2'},portable(r),()=>{}),/draft-changed/);assert.equal(c.getView(view().id),entry);assert.equal(entry.controller.session.getSnapshot().content,'newer draft');
 const d=new ScopedWorkspaceCoordinator(new LayoutStore('other')),entry2=d.bindNote(view(),r,panels);await entry2.controller.load();d.attachNotePresentation(view().id,handle([]));d.freezeView(view().id);
 await assert.rejects(d.migrateNote(view().id,view('B.md'),runtime('B.md','different'),panels,{content:'text',revision:'r2'},portable(r),()=>{}),/scope-mismatch/);assert.equal(d.getView(view().id),entry2);
});
test('park keeps the binding/controller alive and close cannot retire a frozen source',async()=>{
 const c=new ScopedWorkspaceCoordinator(new LayoutStore('child')),entry=c.bindNote(view(),runtime(),panels);await entry.controller.load();c.attachNotePresentation(view().id,handle([]));c.freezeView(view().id);c.parkView(view().id);
 assert.equal(c.getView(view().id),entry);assert.equal(entry.open,true);assert.equal(entry.parked,true);let closed=false;
 assert.deepEqual(await c.close(view().id,async()=>{closed=true;}),{ok:false,error:'workspace-host-busy'});assert.equal(closed,false);c.commitRelease(view().id);assert.equal(entry.open,false);assert.equal(entry.controller.session.getSnapshot().content,'text');
});
test('post-rename renderer failure retains new grant and portable state for an explicit forward retry',async()=>{
 const c=new ScopedWorkspaceCoordinator(new LayoutStore('child')),old=runtime(),next=runtime('B.md'),calls:string[]=[];const prior=c.bindNote(view(),old,panels,()=>calls.push('dispose-old'));await prior.controller.load();c.attachNotePresentation(view().id,handle(calls));c.freezeView(view().id);
 const realReady=c.productionReady.bind(c);c.productionReady=async()=>{throw Error('temporary metadata failure');};
 await assert.rejects(c.migrateNote(view().id,view('B.md'),next,panels,{revision:'r2',content:'text'},portable(old),()=>{}),/temporary metadata failure/);
 const migrated=c.getView(view().id);assert.equal(migrated?.view.resourceId,'B.md');assert.equal(migrated?.frozen,true);assert.deepEqual(c.getSnapshot().recoveringViews,[view().id]);assert.equal(calls.includes('dispose-old'),false);
 c.productionReady=realReady;c.attachNotePresentation(view().id,handle(calls));c.noteRendered(view().id,next,'r2');assert.deepEqual(await c.retryMigration(view().id),{ok:true});assert.equal(c.getView(view().id),migrated);assert.equal(migrated?.frozen,false);assert.deepEqual(c.getSnapshot().recoveringViews,[]);assert.equal(calls.at(-1),'dispose-old');
});
