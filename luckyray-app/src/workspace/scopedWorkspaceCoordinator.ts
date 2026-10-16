import {NoteDocumentControllers,type NoteDocumentController} from '../features/notes/NoteDocumentController';
import {assertNoteAuthority,noteRuntimeMissingActions,type NoteActionRequest,type NoteAuthority,type NoteRuntime} from '../features/notes/NoteRuntime';
import type {ScopedNoteSurfacePanels} from '../features/notes/ScopedNoteDocumentSurface';
import {isCurrentGraphDataProof,type GraphDataProof,type GraphRuntime,type GraphRuntimeFeature} from '../features/graph/GraphRuntime';
import {LayoutStore} from './layoutStore';
import {nativeNoteDocumentId} from './nativeNoteRuntime';
import type {ViewRef} from './layout';
import type {NotePresentationHandle,NoteViewPresentationSnapshot} from '../features/notes/noteViewPresentation';
import {createGraphViewPresentation,type GraphViewPresentationController} from './graphViewPresentation';

export type ScopedHostProof =
 | {kind:'note';authority:NoteAuthority;revision:string}
 | (GraphDataProof & {vaultId:string});
export type ScopedHostTarget = Readonly<{id:string;viewId:string}>;
export type ScopedHostAcknowledgment = {targetId:string;viewId:string;proof:ScopedHostProof};
/** Injected transaction boundary. This is not a native command or a renderer
 * grant API. Native wiring must supply an authenticated receipt implementation.
 * cancelTarget may revoke only the admission created by this transaction.
 * Proofs currently attest content/data rendering only. Native transfer must also
 * carry and acknowledge per-view presentation (editor/camera state); that
 * migration is not implemented or production-enabled by this fixture adapter. */
export type ScopedHostTransfer = {
 open(view:ViewRef,proof:ScopedHostProof,signal:AbortSignal):Promise<ScopedHostTarget>;
 waitReady(target:ScopedHostTarget,proof:ScopedHostProof,signal:AbortSignal):Promise<ScopedHostAcknowledgment>;
 releaseSource(view:ViewRef,proof:ScopedHostProof,signal:AbortSignal):Promise<void>;
 cancelTarget(target:ScopedHostTarget):Promise<void>;
};
export type ScopedHostResult={ok:true}|{ok:false;error:string};
type BaseBinding={invalidationRevision?:number;generation?:number;frozen?:boolean;parked?:boolean;panelRequest?:{panel:'index'|'attachments'|'tags';id:number};navigationRequest?:{id:number;heading?:string;blockId?:string};view:ViewRef;token:symbol;open:boolean;ready:ScopedHostProof|null;dispose:()=>void;unsubscribe:()=>void};
export type ScopedNoteBinding=BaseBinding & {kind:'note';runtime:NoteRuntime;controller:NoteDocumentController;panels:ScopedNoteSurfacePanels;releaseLease:()=>void;presentation?:NotePresentationHandle};
export type ScopedGraphBinding=BaseBinding & {kind:'graph';runtime:GraphRuntime;presentation?:GraphViewPresentationController};
export type ScopedHostBinding=ScopedNoteBinding|ScopedGraphBinding;
const graphFeatures:readonly GraphRuntimeFeature[]=['read','tagRelation','open','createMissing','openDefault','reveal','askAi','screenshot'];
const proofKey=(proof:ScopedHostProof)=>proof.kind==='note'
 ? JSON.stringify(['note',proof.authority.sourceId,proof.authority.vaultId,proof.authority.documentId,proof.revision])
 : JSON.stringify(['graph',proof.vaultId,proof.snapshotId,proof.revision]);
const errorText=(error:unknown)=>error instanceof Error?error.message:String(error);
function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
 if(signal.aborted){void promise.catch(()=>{});return Promise.reject(Error('workspace-host-transaction-cancelled'));}
 return new Promise((resolve,reject)=>{
  const abort=()=>{signal.removeEventListener('abort',abort);reject(Error('workspace-host-transaction-cancelled'));};
  signal.addEventListener('abort',abort,{once:true});
  promise.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
 });
}
function requireView(view:ViewRef,kind:'note'|'graph',vaultId:string){
 if(!view||view.kind!==kind||view.library.kind!=='knowledge'||view.library.id!==vaultId||!view.id||view.id.length>128||/[\0\r\n]/.test(view.id))throw Error('workspace-host-invalid-binding');
}
function immutableView(view:ViewRef):ViewRef{return Object.freeze({...view,library:Object.freeze({...view.library})});}

/** One window coordinator, zero ambient bridge/native/global-source access.
 * Views own stable surfaces; document authority owns one shared CAS draft.
 * Supplied runtimes are already-scoped dependencies, never picked by the child.
 * All production mounting and native command registration remain separate. */
export class ScopedWorkspaceCoordinator {
 readonly documents=new NoteDocumentControllers();
 private entries=new Map<string,ScopedHostBinding>();
 private listeners=new Set<()=>void>();
 private pendingTargets=new Map<string,ScopedHostTarget>();
 private migrations=new Map<string,{entry:ScopedNoteBinding;portable:NoteViewPresentationSnapshot;snapshot:{revision:string;content:string};disposePrevious:()=>void;running:boolean}>();
 private state={version:0,busy:false,error:'',uncertainTargets:[] as readonly ScopedHostTarget[],recoveringViews:[] as readonly string[]};
 private transaction:AbortController|null=null;
 private alive=true;
 readonly store:LayoutStore;
 constructor(store:LayoutStore){this.store=store;}
 getSnapshot=()=>this.state;
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 private publish(error=this.state.error){this.state={version:this.state.version+1,busy:!!this.transaction,error,uncertainTargets:[...this.pendingTargets.values()],recoveringViews:[...this.migrations.keys()]};for(const listener of this.listeners)listener();}
 getView=(viewId:string)=>this.entries.get(viewId);
 listViews=()=>[...this.entries.values()].filter(entry=>entry.open);
 reportError(error:unknown){this.publish(errorText(error));}
 notify(){this.publish();}
 // A bodyless hint requests revalidation, not an assertion that the rendered
 // data became unavailable. Session/capability changes revoke independently;
 // the surface revokes when its metadata/media check actually changes or fails.
 invalidateNoteData(viewId:string){const entry=this.entries.get(viewId);if(!entry?.open||entry.kind!=='note')return;entry.invalidationRevision=(entry.invalidationRevision??0)+1;this.publish();}
 hasFrozenViews(){return this.listViews().some(entry=>entry.frozen);}
 setPanel(viewId:string,kind:'index'|'attachments'|'tags'){const entry=this.requireEntry(viewId);entry.panelRequest={panel:kind,id:(entry.panelRequest?.id??0)+1};this.publish();}
 setNavigation(viewId:string,options:{heading?:string;blockId?:string}){const entry=this.requireEntry(viewId);entry.navigationRequest={...options,id:(entry.navigationRequest?.id??0)+1};this.publish();}
 attachNotePresentation=(viewId:string,handle:NotePresentationHandle|null)=>{const entry=this.entries.get(viewId);if(entry?.kind!=='note')return;entry.presentation=handle??undefined;if(handle&&entry.frozen)handle.freeze();this.publish();};
 freezeView(viewId:string){const entry=this.requireEntry(viewId);if(entry.frozen)throw Error('workspace-host-view-frozen');entry.presentation?.freeze();entry.frozen=true;this.store.dispatch({type:'activate',viewId});this.publish();}
 async activateView(viewId:string){const entry=this.requireEntry(viewId);if(entry.kind==='note')await entry.presentation?.activate();else await entry.presentation?.release();entry.frozen=false;entry.parked=false;this.publish();}
 async abortView(viewId:string){const entry=this.requireEntry(viewId);await entry.presentation?.abort();entry.frozen=false;entry.parked=false;this.publish();}
 parkView(viewId:string){const entry=this.requireEntry(viewId);if(!entry.frozen)throw Error('workspace-host-source-not-frozen');entry.parked=true;this.publish();}
 commitRelease(viewId:string){const entry=this.requireEntry(viewId);if(!entry.frozen||!entry.parked)throw Error('workspace-host-source-not-parked');this.remove(entry);}
 cancelAdmission(viewId:string){const entry=this.entries.get(viewId);if(!entry?.open)return;if(entry.kind==='note'&&(entry.controller.isComposing()||entry.controller.session.getSnapshot().dirty))throw Error('workspace-host-target-has-input');this.remove(entry);}
 async productionReady(viewId:string,timeout=20000):Promise<ScopedHostProof>{
  const end=Date.now()+timeout;
  while(Date.now()<end){const entry=this.requireEntry(viewId),proof=this.currentProof(entry);if(proof&&entry.presentation)return proof;await new Promise(resolve=>setTimeout(resolve,35));}
  throw Error('workspace-host-render-or-presentation-not-ready');
 }
 async migrateNote(viewId:string,view:ViewRef,runtime:NoteRuntime,panels:ScopedNoteSurfacePanels,snapshot:{revision:string;content:string},portable:NoteViewPresentationSnapshot,dispose:()=>void,onBound?:(entry:ScopedNoteBinding)=>void){
  const previous=this.requireEntry(viewId);if(previous.kind!=='note'||!previous.frozen||previous.controller.isComposing())throw Error('workspace-host-rename-not-frozen');
  const state=previous.controller.session.getSnapshot();if(state.dirty||state.revision!==portable.revision||state.content!==portable.content||snapshot.content!==portable.content)throw Error('workspace-host-rename-draft-changed');
  requireView(view,'note',runtime.authority.vaultId);if(view.id!==viewId||runtime.authority.sourceId!==previous.runtime.authority.sourceId)throw Error('workspace-host-rename-scope-mismatch');
  // Retain the old controller in documents until the new exact grant has painted.
  previous.unsubscribe();previous.releaseLease();this.entries.delete(viewId);
  const layout=this.store.getSnapshot();this.store.restore({...layout,views:{...layout.views,[viewId]:view}});
  const next=this.bindNote(view,runtime,panels,dispose);next.generation=(previous.generation??0)+1;next.frozen=true;next.controller.session.receive(snapshot);onBound?.(next);this.publish();
  this.migrations.set(viewId,{entry:next,portable,snapshot,disposePrevious:previous.dispose,running:false});this.publish();
  const result=await this.retryMigration(viewId);if(!result.ok)throw Error(result.error);
 }
 async retryMigration(viewId:string):Promise<ScopedHostResult>{
  const migration=this.migrations.get(viewId);if(!migration)return {ok:false,error:'workspace-host-rename-recovery-missing'};
  if(migration.running)return {ok:false,error:'workspace-host-rename-recovery-running'};
  migration.running=true;
  try{
   const {entry,portable,snapshot}=migration;if(this.requireEntry(viewId)!==entry||!entry.frozen)throw Error('workspace-host-rename-binding-changed');
   await this.productionReady(viewId);
   const current=entry.controller.session.getSnapshot();if(current.dirty||current.revision!==snapshot.revision||current.content!==snapshot.content)throw Error('workspace-host-rename-baseline-changed');
   await entry.presentation!.restore({...portable,authority:entry.runtime.authority,revision:snapshot.revision,content:snapshot.content});
   await this.productionReady(viewId);await this.activateView(viewId);migration.disposePrevious();this.migrations.delete(viewId);this.publish('');return {ok:true};
  }catch(error){const message='workspace-host-rename-restore-failed: '+errorText(error);this.publish(message);return {ok:false,error:message};}
  finally{migration.running=false;this.publish();}
 }

 isActionCurrent(request:NoteActionRequest,runtime:NoteRuntime){
  const entry=this.entries.get(request.viewId);
  return !!entry&&this.isCurrent(entry)&&entry.kind==='note'&&entry.runtime===runtime
   &&!this.transaction&&entry.controller.isActionCurrent(request);
 }
 private requireLive(){if(!this.alive)throw Error('workspace-host-disposed');}
 private requireEntry(viewId:string){this.requireLive();const entry=this.entries.get(viewId);if(!entry?.open)throw Error('workspace-host-view-closed');return entry;}
 private isCurrent(entry:ScopedHostBinding,token=entry.token){return this.alive&&entry.open&&this.entries.get(entry.view.id)===entry&&entry.token===token;}
 private invalidate(entry:ScopedHostBinding){entry.ready=null;this.publish();}
 bindNote(view:ViewRef,runtime:NoteRuntime,panels:ScopedNoteSurfacePanels={},dispose:()=>void=()=>{}){
  this.requireLive();requireView(view,'note',runtime.authority.vaultId);if(!view.resourceId||nativeNoteDocumentId({vaultId:view.library.id,relativePath:view.resourceId})!==runtime.authority.documentId)throw Error('workspace-host-document-mismatch');if(runtime.kind!=='scoped')throw Error('workspace-host-unscoped-runtime');
  if(this.entries.has(view.id))throw Error('workspace-host-view-already-bound');
  const stored=this.store.getSnapshot().views[view.id];if(stored&&(stored.kind!==view.kind||stored.library.id!==view.library.id||stored.resourceId!==view.resourceId))throw Error('workspace-host-layout-binding-mismatch');
  const controller=this.documents.get(runtime),releaseLease=controller.attachView(view.id,runtime);
  const entry:ScopedNoteBinding={kind:'note',view:immutableView(view),runtime,controller,panels:Object.freeze({...panels}),releaseLease,dispose,unsubscribe:()=>{},token:Symbol(view.id),open:true,ready:null};
  const stopSession=controller.session.subscribe(()=>this.invalidate(entry)),stopCapabilities=runtime.actions.subscribeCapabilities?.(()=>this.invalidate(entry));entry.unsubscribe=()=>{stopSession();stopCapabilities?.();};this.entries.set(view.id,entry);
  this.store.dispatch({type:'open',view:entry.view,groupId:this.store.getSnapshot().focusedGroup});this.publish();return entry;
 }
 /** Same-authority transport replacement never replaces a draft/controller or
  * editor key. Renames/other authorities require a separate validated migration. */
 regrantNote(viewId:string,runtime:NoteRuntime,dispose:()=>void=()=>{}){
  const entry=this.requireEntry(viewId);if(entry.kind!=='note'||runtime.kind!=='scoped')throw Error('workspace-host-invalid-regrant');
  assertNoteAuthority(runtime.authority,entry.controller.authority);
  const oldDispose=entry.dispose;entry.controller.replaceRuntime(runtime,viewId);entry.runtime=runtime;entry.dispose=dispose;entry.token=Symbol(viewId);
  this.transaction?.abort();this.invalidate(entry);try{oldDispose();}catch(error){this.publish(errorText(error));}return entry;
 }
 bindGraph(view:ViewRef,runtime:GraphRuntime,dispose:()=>void=()=>{}){
  this.requireLive();requireView(view,'graph',runtime.vaultId);if(runtime.kind!=='scoped'||runtime.allowWorker!==false)throw Error('workspace-host-unscoped-runtime');
  if(this.entries.has(view.id))throw Error('workspace-host-view-already-bound');
  const stored=this.store.getSnapshot().views[view.id];if(stored&&(stored.kind!==view.kind||stored.library.id!==view.library.id||stored.resourceId!==view.resourceId))throw Error('workspace-host-layout-binding-mismatch');
  const identity=(runtime as GraphRuntime & {identity?:{viewId:string;vaultId:string;sourceId:string;generation:number}}).identity;
  const entry:ScopedGraphBinding={presentation:identity?createGraphViewPresentation(identity,runtime):undefined,kind:'graph',view:immutableView(view),runtime,dispose,unsubscribe:()=>{},token:Symbol(view.id),open:true,ready:null};
  const stopData=runtime.subscribe(()=>this.invalidate(entry)),stopReadiness=(runtime as GraphRuntime & {subscribeReadiness?:(listener:()=>void)=>()=>void}).subscribeReadiness?.(()=>this.invalidate(entry));entry.unsubscribe=()=>{stopData();stopReadiness?.();};this.entries.set(view.id,entry);
  this.store.dispatch({type:'open',view:entry.view,groupId:this.store.getSnapshot().focusedGroup});this.publish();return entry;
 }
 missing(viewId:string):string[]{
  const entry=this.requireEntry(viewId);
  if(entry.kind==='graph')return [...entry.runtime.completeness().missing,...(!entry.runtime.completeness().complete?['graph-incomplete']:[]),...graphFeatures.filter(feature=>!entry.runtime.capability(feature).available).map(feature=>`graph:${feature}`)];
  return [...(entry.panels.readiness?.().missing??[]),...noteRuntimeMissingActions(entry.runtime).map(kind=>`parent-action:${kind}`),...(typeof entry.panels.index==='function'?[]:['panel:index']),...(typeof entry.panels.attachments==='function'?[]:['panel:attachments'])];
 }
 /** Only the full renderer's post-render callback supplies these proofs. This
  * method is never exposed as a native IPC handler. */
 noteRendered(viewId:string,runtime:NoteRuntime,revision:string){
  const entry=this.entries.get(viewId);if(!entry||!this.isCurrent(entry)||entry.kind!=='note'||entry.runtime!==runtime||this.missing(viewId).length)return false;
  const state=entry.controller.session.getSnapshot();if(entry.controller.isComposing()||!revision||state.revision!==revision||state.status!=='ready'||state.dirty)return false;
  const proof:ScopedHostProof={kind:'note',authority:entry.controller.authority,revision};if(!entry.ready||proofKey(entry.ready)!==proofKey(proof)){entry.ready=proof;this.publish();}return true;
 }
 graphRendered(viewId:string,runtime:GraphRuntime,proof:GraphDataProof){
  const entry=this.entries.get(viewId);if(!entry||!this.isCurrent(entry)||entry.kind!=='graph'||entry.runtime!==runtime||this.missing(viewId).length)return false;
  if(!isCurrentGraphDataProof(runtime,proof))return false;
  const ready:ScopedHostProof={...proof,kind:'graph',vaultId:runtime.vaultId};if(!entry.ready||proofKey(entry.ready)!==proofKey(ready)){entry.ready=ready;this.publish();}return true;
 }
 invalidateRendered(viewId:string,runtime:NoteRuntime|GraphRuntime){
  const entry=this.entries.get(viewId);if(entry&&this.isCurrent(entry)&&entry.runtime===runtime&&entry.ready)this.invalidate(entry);
 }
 private currentProof(entry:ScopedHostBinding):ScopedHostProof|null{
  if(!this.isCurrent(entry)||!entry.ready||this.missing(entry.view.id).length)return null;
  if(entry.kind==='note'){
   const state=entry.controller.session.getSnapshot();if(entry.controller.isComposing()||state.status!=='ready'||state.dirty||state.revision!==entry.ready.revision)return null;
  }else{
   if(entry.ready.kind!=='graph'||!isCurrentGraphDataProof(entry.runtime,entry.ready))return null;
  }
  return entry.ready;
 }
 private waitRendered(entry:ScopedHostBinding,token:symbol,signal:AbortSignal){
  return new Promise<ScopedHostProof>((resolve,reject)=>{
   let stop=()=>{};
   const finish=()=>{stop();signal.removeEventListener('abort',abort);};
   const abort=()=>{finish();reject(Error('workspace-host-transaction-cancelled'));};
   const check=()=>{if(!this.isCurrent(entry,token)){finish();reject(Error('workspace-host-binding-changed'));return;}const proof=this.currentProof(entry);if(proof){finish();resolve(proof);}};
   stop=this.subscribe(check);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();else check();
  });
 }
 private remove(entry:ScopedHostBinding){
  // Keep the owner/draft in documents, including uncertain/error states.
  entry.open=false;entry.ready=null;entry.unsubscribe();if(entry.kind==='note')entry.releaseLease();
  try{entry.dispose();}catch(error){this.publish(errorText(error));}
  this.store.dispatch({type:'close',viewId:entry.view.id});this.publish();
 }
 async flushAll(){this.requireLive();return this.documents.flushAll();}
 undoLayout(redo=false){
  this.requireLive();if(this.transaction)return false;
  const current=this.store.getSnapshot();
  const apply=redo?this.store.redo.bind(this.store):this.store.undo.bind(this.store);
  const applied=apply(next=>{
   const ids=Object.keys(current.views);if(ids.length!==Object.keys(next.views).length)return false;
   return ids.every(id=>{const entry=this.entries.get(id),view=next.views[id];return !!entry?.open&&!!view&&view.kind===entry.view.kind&&view.library.id===entry.view.library.id&&view.resourceId===entry.view.resourceId;});
  });
  if(!applied)this.publish('此历史步骤涉及新增或已关闭的标签，需要重新验证授权；当前布局已保留。');
  return applied;
 }
 async close(viewId:string,release:(view:ViewRef,signal:AbortSignal)=>Promise<void>,signal?:AbortSignal):Promise<ScopedHostResult>{
  return this.run(async ownSignal=>{
   const entry=this.requireEntry(viewId),token=entry.token;
   if(entry.kind==='note'&&!await abortable(entry.controller.flushForClose(),ownSignal))throw Error('workspace-host-save-or-ime-blocked');
   const before=entry.kind==='note'?entry.controller.session.getSnapshot():null;
   await abortable(release(entry.view,ownSignal),ownSignal);
   if(!this.isCurrent(entry,token)||(entry.kind==='note'&&(entry.controller.isComposing()||entry.controller.session.getSnapshot()!==before)))throw Error('workspace-host-source-changed');
   this.remove(entry);
  },signal);
 }
 async transfer(viewId:string,transport:ScopedHostTransfer,signal?:AbortSignal,move=true):Promise<ScopedHostResult>{
  return this.run(async ownSignal=>{
   const entry=this.requireEntry(viewId),token=entry.token;
   if(this.missing(viewId).length)throw Error(`workspace-host-incomplete:${this.missing(viewId).join(',')}`);
   this.store.dispatch({type:'activate',viewId});
   if(entry.kind==='note'&&!await abortable(entry.controller.flush(),ownSignal))throw Error('workspace-host-save-or-ime-blocked');
   const proof=await this.waitRendered(entry,token,ownSignal),key=proofKey(proof);
   const requireSource=()=>{const current=this.currentProof(entry);if(ownSignal.aborted||!this.isCurrent(entry,token)||!current||proofKey(current)!==key)throw Error('workspace-host-source-changed');};
   let target:ScopedHostTarget|undefined,releaseStarted=false;
   try{
    requireSource();
    const opening=transport.open(entry.view,proof,ownSignal);
    // A late admission is cleaned with a separate deadline; uncertain
    // receipts remain visible for explicit recovery instead of disappearing.
    void opening.then(value=>{if(ownSignal.aborted&&!target)void this.cleanupTarget(transport,value);},()=>{});
    target=await abortable(opening,ownSignal);
    if(typeof target.id!=='string'||!target.id||target.id.length>128||/[\0\r\n]/.test(target.id)||target.viewId!==viewId)throw Error('workspace-host-invalid-target');
    requireSource();
    const ready=await abortable(transport.waitReady(target,proof,ownSignal),ownSignal);requireSource();
    if(ready.targetId!==target.id||ready.viewId!==viewId||proofKey(ready.proof)!==key)throw Error('workspace-host-target-not-ready');
    if(move){releaseStarted=true;await abortable(transport.releaseSource(entry.view,proof,ownSignal),ownSignal);requireSource();this.remove(entry);}
   }catch(error){
    // Once release has begun, an uncertain native reply must not destroy the
    // acknowledged target. Keep source/draft too and require explicit recovery.
    if(target&&!releaseStarted){
     if(!await this.cleanupTarget(transport,target,ownSignal))throw Error(`${errorText(error)}; workspace-host-target-cleanup-unconfirmed`);
    }
    throw error;
   }
  },signal);
 }
 private async cleanupTarget(transport:ScopedHostTransfer,target:ScopedHostTarget,external?:AbortSignal){
  const key=JSON.stringify([target.id,target.viewId]);this.pendingTargets.set(key,Object.freeze({...target}));this.publish();
  const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,2000);
  external?.addEventListener('abort',abort,{once:true});if(external?.aborted)abort();
  try{
   await abortable(Promise.resolve().then(()=>transport.cancelTarget(target)),controller.signal);
   this.pendingTargets.delete(key);this.publish();return true;
  }catch{this.publish('workspace-host-target-cleanup-unconfirmed');return false;}
  finally{clearTimeout(timer);external?.removeEventListener('abort',abort);}
 }
 private async run(action:(signal:AbortSignal)=>Promise<void>,external?:AbortSignal):Promise<ScopedHostResult>{
  if(this.transaction||this.hasFrozenViews())return {ok:false,error:'workspace-host-busy'};
  try{this.requireLive();}catch(error){return {ok:false,error:errorText(error)};}
  const controller=new AbortController();this.transaction=controller;
  const abort=()=>controller.abort();external?.addEventListener('abort',abort,{once:true});if(external?.aborted)abort();
  const timer=setTimeout(abort,20_000);this.publish('');
  try{if(controller.signal.aborted)throw Error('workspace-host-transaction-cancelled');await action(controller.signal);return {ok:true};}
  catch(error){const message=errorText(error);this.publish(message);return {ok:false,error:message};}
  finally{clearTimeout(timer);external?.removeEventListener('abort',abort);if(this.transaction===controller)this.transaction=null;this.publish();}
 }
 /** Unmount invalidates pending work but intentionally retains all draft owners.
  * Application quit must call/accept flushAll before disposing its host. */
 dispose(){
  if(!this.alive)return;this.alive=false;this.transaction?.abort();
  for(const entry of this.entries.values()){entry.ready=null;entry.unsubscribe();if(entry.kind==='note')entry.releaseLease();try{entry.dispose();}catch{/* retained draft remains available for diagnostics/recovery */}}
  this.publish();this.listeners.clear();
 }
}
