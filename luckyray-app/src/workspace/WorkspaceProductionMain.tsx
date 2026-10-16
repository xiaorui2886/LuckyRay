import {useEffect,useState,useRef} from 'react';
import {listen,emit} from '@tauri-apps/api/event';
import {knowledgeStore} from '../core/services/knowledgeStore';
import {isTauri} from '@tauri-apps/api/core';
import type {BridgeVaultMetadata} from '../core/bridge/bridgeTypes';
import {NOTES_NATIVE_DETACH_EVENT,notesNativeViews,type NotesNativeViewAdapter,type NotesNativeViewBinding} from '../features/notes/notesNativeViewRegistry';
import {GRAPH_NATIVE_DETACH_EVENT,graphNativeViews,type GraphNativeViewBinding,type GraphNativeViewAdapter} from '../features/graph/graphNativeViewRegistry';
import type {NoteViewBaseline,NoteViewPresentationSnapshot} from '../features/notes/noteViewPresentation';
import {validateGraphViewPresentation} from './graphViewPresentation';
import type {ScopedGraphSnapshot} from './scopedGraphRuntime';
import {WorkspaceNoteMainActions} from './WorkspaceNoteMainActions';
import {WorkspaceGraphMainActions} from './WorkspaceGraphMainActions';
import {workspaceCommand,type NativeViewGrant} from './nativeClient';
import {transferNativePresentation,validateHandoff,type HandoffOffer,type HandoffSource,NativeHandoffRecovery,NativeHandoffAdmissions} from './nativeHandoff';
import {registerWorkspaceFlush,workspaceCompositionActive} from './windowLifecycle';

export type BoundScoped={view:NativeViewGrant;registration:BridgeVaultMetadata;materialLibraryId?:string;requestedMaterialLibraryId?:string|null;legacyMaterialLibraryId?:string;note?:NoteViewBaseline;snapshot?:ScopedGraphSnapshot};
let installed=false,activeTransactions=0;
const mainAdmissions=new NativeHandoffAdmissions(workspaceCommand,'main');
const mainRecoveries=new Map<string,NativeHandoffRecovery>();
const mainRecoveryListeners=new Set<()=>void>();
function rememberMainRecovery(recovery:NativeHandoffRecovery){
 if(mainRecoveries.has(recovery.recoveryId))return;mainRecoveries.set(recovery.recoveryId,recovery);
 recovery.onComplete(()=>{if(mainRecoveries.get(recovery.recoveryId)!==recovery)return;mainRecoveries.delete(recovery.recoveryId);for(const listener of mainRecoveryListeners)listener();});
 for(const listener of mainRecoveryListeners)listener();
}
let admissionRoute:string|null=null;
export function consumeWorkspaceAdmissionRoute(route:string){const expected=admissionRoute;admissionRoute=null;return expected===route;}
function navigateAdmission(route:'notes'|'graph'){if(window.location.hash!==`#${route}`){admissionRoute=route;window.location.hash=`#${route}`;}}

const viewOperations=new Map<string,Promise<unknown>>();
function mainViewCommand<T>(viewId:string,request:unknown):Promise<T>{
 const result=(viewOperations.get(viewId)??Promise.resolve()).catch(()=>{}).then(()=>workspaceCommand<T>(request));viewOperations.set(viewId,result);return result;
}
const noteBindings=new Map<string,{adapter:NotesNativeViewAdapter;stop:()=>void;identity:string}>();
const graphBindings=new Map<string,string>();
const noteBindingOperations=new Map<string,Promise<void>>();
const pendingNoteBindings=new Map<string,{adapter:NotesNativeViewAdapter;abandoned:boolean}>();
const graphBindingOperations=new Map<string,Promise<ScopedGraphSnapshot>>();
const pendingGraphBindings=new Map<string,{adapter:GraphNativeViewAdapter;abandoned:boolean}>();
const retirements=new Map<string,{after:()=>void;pending?:Promise<void>}>();
function retireScoped(viewId:string,after:()=>void=()=>{}):Promise<void>{
 let job=retirements.get(viewId);if(!job){job={after};retirements.set(viewId,job);}if(job.pending)return job.pending;
 const held=job;
 held.pending=mainViewCommand(viewId,{op:'releaseScoped',viewId}).then(()=>{if(retirements.get(viewId)===held){held.after();retirements.delete(viewId);}}).finally(()=>{held.pending=undefined;});
 return held.pending;
}

const noteIdentity=(binding:NotesNativeViewBinding)=>JSON.stringify([binding.viewId,binding.generation,binding.documentId,binding.workspaceSourceId,binding.vault.id,binding.vault.rootPath,binding.vault.createdAt]);
function watchBoundNote(viewId:string){
 const adapter=notesNativeViews.get(viewId),existing=noteBindings.get(viewId);if(existing?.adapter===adapter&&existing.identity===noteIdentity(adapter.binding()))return;
 existing?.stop();
 const publish=(dirty:boolean)=>{void mainViewCommand(viewId,{op:'boundDirty',viewId,dirty}).then(()=>dirty?mainViewCommand(viewId,{op:'integratedNotReady',viewId}):undefined).catch(error=>{window.dispatchEvent(new CustomEvent('luckyray:workspace-save-error',{detail:String(error)}));});};
 noteBindings.set(viewId,{adapter,stop:notesNativeViews.subscribeDirty(viewId,publish),identity:noteIdentity(adapter.binding())});publish(adapter.isDirty());
}
function unwatchBoundNote(viewId:string,expected?:NotesNativeViewAdapter){if(expected&&noteBindings.get(viewId)?.adapter!==expected)return;noteBindings.get(viewId)?.stop();noteBindings.delete(viewId);}
async function bindMainNote(binding:NotesNativeViewBinding,adapter:NotesNativeViewAdapter){
 const viewId=binding.viewId;
 // The complete ownership transaction must be serial. Queuing only IPC would
 // let an abandoned response retire a later replacement under the same ID.
 const operation=(noteBindingOperations.get(viewId)??Promise.resolve()).catch(()=>{}).then(async()=>{
  if(notesNativeViews.get(viewId)!==adapter)throw Error('workspace-main-note-adapter-replaced');
  if(retirements.has(viewId))await retireScoped(viewId);
  const identity=noteIdentity(binding),held=noteBindings.get(viewId);if(held?.adapter===adapter&&held.identity===identity)return;
  if(!binding.workspaceSourceId)throw Error('workspace-main-note-read-proof-required');
  if(held)await retireScoped(viewId,()=>{if(noteBindings.get(viewId)===held)unwatchBoundNote(viewId);});
  if(notesNativeViews.get(viewId)!==adapter||noteIdentity(adapter.binding())!==identity)throw Error('workspace-main-note-adapter-replaced');
  const pending={adapter,abandoned:false};pendingNoteBindings.set(viewId,pending);
  let accepted=false;
  try{
   const view={id:viewId,kind:'note',libraryId:binding.vaultId,resourceId:binding.relativePath,title:binding.title};
   const bound=await mainViewCommand<BoundScoped>(viewId,{op:'bindScoped',view,materialLibraryId:null});
   if(pending.abandoned||!bound.note||bound.note.authority.sourceId!==binding.workspaceSourceId||bound.note.authority.documentId!==binding.documentId||!sameRegistration(bound.registration,binding.vault)
    ||notesNativeViews.get(viewId)!==adapter||noteIdentity(adapter.binding())!==identity)throw Error('workspace-main-note-captured-binding-changed');
   watchBoundNote(viewId);accepted=true;
  }finally{
   if(pendingNoteBindings.get(viewId)===pending)pendingNoteBindings.delete(viewId);
   if(!accepted)await retireScoped(viewId);
  }
 });
 noteBindingOperations.set(viewId,operation);
 try{await operation;}finally{if(noteBindingOperations.get(viewId)===operation)noteBindingOperations.delete(viewId);}
}

export const mainWorkspaceFrozen=()=>notesNativeViews.hasFrozenViews()||graphNativeViews.hasFrozenViews();
function sameRegistration(a:BridgeVaultMetadata,b:BridgeVaultMetadata){return ['id','rootPath','mode','createdAt','schemaVersion'].every(key=>a?.[key as keyof BridgeVaultMetadata]===b?.[key as keyof BridgeVaultMetadata]);}
/** Installed before Graph's first mount. Identity comes from the exact view's
 * captured provenance, never the current source at the time of transfer. */
export function installWorkspaceProductionMain(){
 if(installed||!isTauri())return;installed=true;
 graphNativeViews.installSourceVerifier(async(binding:GraphNativeViewBinding)=>{
  const viewId=binding.viewId,adapter=graphNativeViews.registered(viewId);
  if(!adapter)throw Error('workspace-main-graph-adapter-unavailable');
  const operation=(graphBindingOperations.get(viewId)??Promise.resolve()).catch(()=>{}).then(async()=>{
   if(graphNativeViews.registered(viewId)!==adapter)throw Error('workspace-main-graph-adapter-replaced');
   if(retirements.has(viewId))await retireScoped(viewId);
   const identityOf=(value:GraphNativeViewBinding)=>JSON.stringify([value.vaultId,value.generation,value.vault.rootPath,value.vault.createdAt,value.materialLibraryId]);
   const identity=identityOf(binding),old=graphBindings.get(viewId);
   if(old&&old!==identity)await retireScoped(viewId,()=>{if(graphBindings.get(viewId)===old)graphBindings.delete(viewId);});
   if(graphNativeViews.registered(viewId)!==adapter)throw Error('workspace-main-graph-adapter-replaced');
   // A hidden retained canvas may not have a painted scene yet. Registration
   // identity owns this read; GraphPage separately admits the DTO only for its
   // exact still-current seed/provenance before exposing a transferable proof.
   const pending={adapter,abandoned:false};pendingGraphBindings.set(viewId,pending);let accepted=false;
   try{
    const bound=await mainViewCommand<BoundScoped>(viewId,{op:'bindScoped',view:{id:viewId,kind:'graph',libraryId:binding.vaultId,resourceId:null,title:binding.title},materialLibraryId:binding.materialLibraryId});
    if(pending.abandoned||graphNativeViews.registered(viewId)!==adapter||!sameRegistration(bound.registration,binding.vault)||bound.view.id!==viewId||bound.view.libraryId!==binding.vaultId
     ||(binding.materialLibraryId===null?(bound.requestedMaterialLibraryId!==null||!bound.materialLibraryId||bound.materialLibraryId!==bound.legacyMaterialLibraryId):bound.materialLibraryId!==binding.materialLibraryId)||!bound.snapshot)throw Error('workspace-graph-captured-source-mismatch');
    graphBindings.set(viewId,identity);accepted=true;return bound.snapshot;
   }finally{
    if(pendingGraphBindings.get(viewId)===pending)pendingGraphBindings.delete(viewId);
    if(!accepted)await retireScoped(viewId,()=>{if(graphBindings.get(viewId)===old)graphBindings.delete(viewId);});
   }
  });
  graphBindingOperations.set(viewId,operation);
  try{return await operation;}finally{if(graphBindingOperations.get(viewId)===operation)graphBindingOperations.delete(viewId);}
 });
}
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function withReceiver<T>(get:()=>Promise<T>):Promise<T>{
 const end=Date.now()+7000;let last:unknown;
 while(Date.now()<end){try{return await get();}catch(error){last=error;if(!/not mounted|receiver-unavailable|receiver-source-unavailable|Main must already have the matching vault open/.test(String(error)))throw error;}await wait(40);}
 throw last??Error('workspace-main-receiver-unavailable');
}
function mainSource(kind:'note'|'graph',viewId:string):HandoffSource{
 if(kind==='note'){
  const adapter=notesNativeViews.get(viewId),identity=adapter.binding();
  const owns=()=>{try{return notesNativeViews.get(viewId)===adapter;}catch{return false;}};
  const requireOwner=()=>{if(!owns())throw Error('workspace-main-note-adapter-replaced');};
  const view={id:viewId,kind,libraryId:identity.vaultId,resourceId:identity.relativePath,title:identity.title};
  return {view,freeze:()=>{requireOwner();adapter.freeze();},flush:async()=>{requireOwner();return adapter.flush();},capture:async()=>{requireOwner();
   const current=adapter.binding();if(current.viewId!==identity.viewId||current.generation!==identity.generation||current.documentId!==identity.documentId)throw Error('workspace-main-note-binding-changed');
   const bound=await mainViewCommand<BoundScoped>(view.id,{op:'bindScoped',view,materialLibraryId:null});
   if(!bound.note||!current.workspaceSourceId||bound.note.authority.sourceId!==current.workspaceSourceId||!sameRegistration(bound.registration,identity.vault)||bound.view.id!==viewId||bound.note.authority.documentId!==identity.documentId||bound.note.authority.vaultId!==identity.vaultId)throw Error('workspace-main-note-baseline-mismatch');
   requireOwner();const presentation=await adapter.capture(bound.note);requireOwner();watchBoundNote(viewId);await mainViewCommand(viewId,{op:'boundDirty',viewId,dirty:false});
   return {revision:bound.note.revision,sourceId:bound.note.authority.sourceId,presentation};
  },release:async()=>{requireOwner();await adapter.release();},commitRelease:async()=>{if(owns())await adapter.commitRelease();unwatchBoundNote(viewId,adapter);},activate:async()=>{requireOwner();await adapter.activate();},abort:async()=>{requireOwner();await adapter.abort();}};
 }
 const adapter=graphNativeViews.get(viewId),identity=adapter.binding();
 const owns=()=>graphNativeViews.registered(viewId)===adapter;
 const requireOwner=()=>{if(!owns())throw Error('workspace-main-graph-adapter-replaced');};
 const view={id:viewId,kind,libraryId:identity.vaultId,title:identity.title};
 return {view,freeze:()=>{requireOwner();adapter.freeze();},flush:async()=>{requireOwner();return adapter.flush();},capture:async()=>{requireOwner();
  const current=adapter.binding();if(current.generation!==identity.generation||current.sourceId!==identity.sourceId||current.materialLibraryId!==identity.materialLibraryId)throw Error('workspace-main-graph-binding-changed');
  const snapshot=await graphNativeViews.verifySource(current);requireOwner();const presentation=await adapter.capture(snapshot);requireOwner();
  await mainViewCommand(viewId,{op:'boundDirty',viewId,dirty:false});return {revision:snapshot.revision,sourceId:snapshot.sourceId!,presentation};
 },release:async()=>{requireOwner();await adapter.release();},commitRelease:async()=>{if(owns())await adapter.commitRelease();},activate:async()=>{requireOwner();await adapter.activate();},abort:async()=>{requireOwner();await adapter.abort();}};
}
async function receiveMain(offer:HandoffOffer,alive:()=>boolean,report:(error:unknown)=>void){
 let noteAdapter:NotesNativeViewAdapter|undefined,graphAdapter:GraphNativeViewAdapter|undefined,noteReservation:symbol|undefined;
 // Preparation belongs to the same admission observer as presentation restore.
 // A rejected mount/read still observes the source's exact terminal decision.
 return mainAdmissions.receive(offer,{
  restore:async()=>{
   if(!alive())throw Error('workspace-main-receiver-unmounted');
   navigateAdmission(offer.sourceView.kind==='note'?'notes':'graph');
   if(offer.sourceView.kind==='note'){
    const baseline=offer.presentation as NoteViewPresentationSnapshot;
    if(baseline.authority?.sourceId!==offer.proof.identity.sourceId||baseline.authority.documentId!==offer.proof.identity.documentId||baseline.revision!==offer.proof.revision)throw Error('workspace-main-note-presentation-scope-mismatch');
    noteAdapter??=await withReceiver(()=>{if(notesNativeViews.incomingToken(offer.targetViewId))throw Error('workspace-main-note-target-already-reserved');const prepared=notesNativeViews.prepareIncoming({viewId:offer.targetViewId,vaultId:offer.proof.identity.vaultId,documentId:offer.proof.identity.documentId!,relativePath:offer.sourceView.resourceId!,title:offer.sourceView.title});noteReservation??=notesNativeViews.incomingToken(offer.targetViewId);return prepared;});
    if(!alive())throw Error('workspace-main-receiver-unmounted');
    if(!noteAdapter.isFrozen())noteAdapter.freeze();
    if(!await noteAdapter.flush())throw Error('workspace-main-note-target-save-blocked');
    const grant={...offer.sourceView,id:offer.targetViewId};
    const bound=await mainViewCommand<BoundScoped>(grant.id,{op:'bindScoped',view:grant,materialLibraryId:null});
    if(!bound.note||!noteAdapter.binding().workspaceSourceId||bound.note.authority.sourceId!==noteAdapter.binding().workspaceSourceId||!sameRegistration(bound.registration,noteAdapter.binding().vault))throw Error('workspace-main-note-target-baseline-missing');
    watchBoundNote(offer.targetViewId);await noteAdapter.restore(bound.note,baseline);return {revision:bound.note.revision,sourceId:bound.note.authority.sourceId};
   }
   if(!validateGraphViewPresentation(offer.presentation)||offer.presentation.source.viewId!==offer.sourceView.id||offer.presentation.source.sourceId!==offer.proof.identity.sourceId)throw Error('workspace-main-graph-presentation-scope-mismatch');
   const portable=offer.presentation;
   graphAdapter??=await withReceiver(()=>graphNativeViews.prepareIncoming({viewId:offer.targetViewId,vaultId:offer.proof.identity.vaultId,sourceId:offer.proof.identity.sourceId,title:offer.sourceView.title}));
   if(!alive())throw Error('workspace-main-receiver-unmounted');
   if(!await graphAdapter.flush())throw Error('workspace-main-graph-target-not-ready');
   const snapshot=await graphNativeViews.verifySource(graphAdapter.binding());
   const ack=await graphAdapter.restore(snapshot,portable,portable.source,offer.proof.presentationHash);
   if(ack.presentationHash!==offer.proof.presentationHash||ack.target.viewId!==offer.targetViewId||ack.captureId!==portable.captureId)throw Error('workspace-main-graph-presentation-ack-mismatch');
   return {revision:ack.proof.revision,sourceId:ack.proof.sourceId!,snapshotId:ack.proof.snapshotId};
  },failed:report,
  activate:async()=>{if(noteAdapter){if(notesNativeViews.get(offer.targetViewId)!==noteAdapter)throw Error('workspace-main-note-target-replaced');await noteAdapter.activate();}else if(graphAdapter){if(graphNativeViews.registered(offer.targetViewId)!==graphAdapter)throw Error('workspace-main-graph-target-replaced');await graphAdapter.activate();}else throw Error('workspace-main-target-not-prepared');},
  cancel:async()=>{
   if(noteReservation){await notesNativeViews.cancelIncoming(offer.targetViewId,noteReservation);if(noteAdapter)unwatchBoundNote(offer.targetViewId,noteAdapter);}
   if(graphAdapter&&graphNativeViews.registered(offer.targetViewId)===graphAdapter){await graphAdapter.release();if(graphNativeViews.registered(offer.targetViewId)===graphAdapter)await graphAdapter.commitRelease();}
   // The registry cancels only this exact reserved incoming identity, including
   // a staged pane whose renderer never returned a handle.
  },
 },alive);
}

/** One Main consumer tree, under the application's modal isolation provider. */
export function WorkspaceProductionMain(){
 const [error,setError]=useState(''),[recoveries,setRecoveries]=useState<NativeHandoffRecovery[]>(()=>[...mainRecoveries.values()]),[retrying,setRetrying]=useState<string|null>(null);
 const recoveryHolds=useRef(new Set(mainRecoveries.keys()));
 const retry=(recovery:NativeHandoffRecovery)=>{setRetrying(recovery.recoveryId);void recovery.retry().catch(error=>setError(String(error))).finally(()=>setRetrying(null));};
 useEffect(()=>{
  if(!isTauri())return;
  let alive=true,reading=false,incomingTail=Promise.resolve() as Promise<unknown>;const received=new Set<string>(),stops:Array<()=>void>=[];
  const recoveryChanged=()=>{if(!alive)return;recoveryHolds.current=new Set(mainRecoveries.keys());setRecoveries([...mainRecoveries.values()]);};mainRecoveryListeners.add(recoveryChanged);recoveryChanged();
  const report=(error:unknown)=>{if(error instanceof NativeHandoffRecovery)rememberMainRecovery(error);if(!alive)return;setError(error instanceof Error?error.message:String(error));};
  let observedKnowledge=knowledgeStore.getSnapshot(),hintTimer:ReturnType<typeof setTimeout>|undefined;
  const stopKnowledge=knowledgeStore.subscribe(()=>{
   const next=knowledgeStore.getSnapshot(),previous=observedKnowledge;observedKnowledge=next;
   if(next.version===previous.version&&next.markdownIndex===previous.markdownIndex&&next.attachmentChanges===previous.attachmentChanges&&next.attachmentResolutionRevision===previous.attachmentResolutionRevision&&next.vault===previous.vault)return;
   if(hintTimer!==undefined)return;
   hintTimer=setTimeout(()=>{hintTimer=undefined;if(!alive)return;void Promise.all([emit('luckyray:workspace-note-changed'),emit('luckyray:workspace-graph-changed')]).catch(report);},40);
  });

  let coverageRunning=false,coverageRequested=false,coverageRevision=0;
  // Polling is observation, not revocation. Actual registry changes revoke
  // immediately, even while an earlier bind/check is awaiting IPC. Native
  // generation checks prevent that earlier pass from publishing stale trust.
  let coverageLease:Promise<{generation:number}>|undefined;
  const syncCoverage=async()=>{
   coverageRequested=true;if(coverageRunning)return;coverageRunning=true;
   try{while(alive&&coverageRequested){coverageRequested=false;const revision=coverageRevision,registryGeneration=notesNativeViews.coverageGeneration();
    const pending=coverageLease;
    const lease=await (pending??workspaceCommand<{generation:number}>({op:'mainBindingCoverage'}));
    if(coverageLease===pending)coverageLease=undefined;
    const bindings=notesNativeViews.list();
    for(const binding of bindings){if(!binding.workspaceSourceId)continue;const adapter=notesNativeViews.get(binding.viewId);await bindMainNote(binding,adapter);}
    await Promise.all(bindings.map(binding=>viewOperations.get(binding.viewId)??Promise.resolve()));
    if(alive&&revision===coverageRevision&&registryGeneration===notesNativeViews.coverageGeneration()&&retirements.size===0&&notesNativeViews.coverageReady())await workspaceCommand({op:'mainBindingCoverage',ready:true,generation:lease.generation});
   }}catch(error){if(!/workspace-main-bindings-changed|workspace-operation-in-progress/.test(String(error)))report(error);}finally{coverageRunning=false;}
  };
  const revokeCoverage=()=>{coverageRevision++;coverageLease=workspaceCommand<{generation:number}>({op:'mainBindingCoverage',ready:false});void coverageLease.catch(report);void syncCoverage();};
  const stopNoteViews=notesNativeViews.subscribe(revokeCoverage);
  revokeCoverage();
  const stopNoteRemoval=notesNativeViews.onUnregister((viewId,adapter)=>{
   void workspaceCommand({op:'integratedNotReady',viewId}).catch(()=>{});
   const pending=pendingNoteBindings.get(viewId);if(pending?.adapter===adapter)pending.abandoned=true;
   const held=noteBindings.get(viewId);if(held?.adapter!==adapter)return;
   void retireScoped(viewId,()=>{if(noteBindings.get(viewId)===held)unwatchBoundNote(viewId);}).catch(error=>{if(!/workspace-operation-in-progress|workspace-document-has-unsaved-input/.test(String(error)))report(error);});
  });
  const stopGraphRemoval=graphNativeViews.onUnregister((viewId,adapter)=>{void workspaceCommand({op:'integratedNotReady',viewId}).catch(()=>{});const pending=pendingGraphBindings.get(viewId);if(pending?.adapter===adapter)pending.abandoned=true;const identity=graphBindings.get(viewId);if(!identity)return;void retireScoped(viewId,()=>{if(graphBindings.get(viewId)===identity)graphBindings.delete(viewId);}).catch(error=>{if(!/workspace-operation-in-progress/.test(String(error)))report(error);});});
  void syncCoverage();

  const drain=async()=>{
   if(reading)return;reading=true;
   try{for(const offer of await workspaceCommand<HandoffOffer[]>({op:'handoffPending'})){
    if(!alive)return;validateHandoff(offer);if(offer.targetWindow!=='main'||received.has(offer.id)||mainAdmissions.owns(offer.id)||!['pending','applied','cancelled'].includes(offer.phase))continue;
    received.add(offer.id);activeTransactions++;
    incomingTail=incomingTail.catch(report).then(()=>offer.phase==='cancelled'?mainAdmissions.cancelled(offer,()=>alive):receiveMain(offer,()=>alive,report)).catch(report).finally(()=>{received.delete(offer.id);activeTransactions--;});
   }}catch(error){report(error);}finally{reading=false;}
  };
  const detach=(kind:'note'|'graph')=>(event:Event)=>{
   const detail=(event as CustomEvent<{viewId?:string;move?:boolean}>).detail;
   if(!detail||typeof detail.viewId!=='string'||(detail.move!==undefined&&typeof detail.move!=='boolean')||activeTransactions>0||recoveryHolds.current.size>0||mainWorkspaceFrozen()||workspaceCompositionActive())return;
   try{const source=mainSource(kind,detail.viewId);activeTransactions++;
    void transferNativePresentation(workspaceCommand,source,detail.move!==false).catch(report).finally(()=>{activeTransactions--;});
   }catch(error){report(error);}
  };
  const notes=detach('note'),graph=detach('graph');window.addEventListener(NOTES_NATIVE_DETACH_EVENT,notes);window.addEventListener(GRAPH_NATIVE_DETACH_EVENT,graph);
  const stopFlush=registerWorkspaceFlush(async()=>activeTransactions===0&&recoveryHolds.current.size===0&&!mainWorkspaceFrozen());
  void listen('luckyray:workspace-handoff-available',()=>void drain()).then(stop=>{if(alive)stops.push(stop);else stop();}).catch(report);
  const timer=setInterval(()=>{void drain();for(const viewId of retirements.keys())void retireScoped(viewId).catch(()=>{});void syncCoverage();},1000);void drain();
  return()=>{alive=false;mainRecoveryListeners.delete(recoveryChanged);clearInterval(timer);if(hintTimer!==undefined)clearTimeout(hintTimer);stopKnowledge();stopNoteViews();stopNoteRemoval();stopGraphRemoval();stopFlush();for(const stop of stops)stop();window.removeEventListener(NOTES_NATIVE_DETACH_EVENT,notes);window.removeEventListener(GRAPH_NATIVE_DETACH_EVENT,graph);};
 },[]);
 const openDocument=async(view:NativeViewGrant)=>{
  navigateAdmission('notes');
  const bound=await mainViewCommand<BoundScoped>(view.id,{op:'bindScoped',view,materialLibraryId:null});if(!bound.note)throw Error('workspace-main-note-baseline-missing');
  const adapter=await withReceiver(()=>notesNativeViews.prepareIncoming({viewId:view.id,vaultId:view.libraryId,documentId:bound.note!.authority.documentId,relativePath:view.resourceId!,title:view.title}));
  if(!adapter.isFrozen())adapter.freeze();try{if(!await adapter.flush())throw Error('workspace-main-note-open-failed');await adapter.capture(bound.note);watchBoundNote(view.id);await adapter.activate();}catch(error){await adapter.abort();throw error;}
 };
 return <><WorkspaceNoteMainActions/><WorkspaceGraphMainActions openDocument={openDocument}/>{recoveries.map(recovery=><div key={recovery.recoveryId} role="alert" className="workspace-conflict">{recovery.message}<button disabled={retrying===recovery.recoveryId} onClick={()=>retry(recovery)}>重试恢复窗口状态</button></div>)}{error&&<div role="alert" className="workspace-conflict">{error}<button onClick={()=>setError('')}>关闭提示</button></div>}</>;
}
