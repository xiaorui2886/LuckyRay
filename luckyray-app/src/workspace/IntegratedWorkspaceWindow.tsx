import {useCallback,useEffect,useMemo,useState,useSyncExternalStore} from 'react';
import {convertFileSrc} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import type {NoteAuthority,NoteActionRequest,NoteActionValue,NoteParentActionKind} from '../features/notes/NoteRuntime';
import type {NoteViewPresentationSnapshot} from '../features/notes/noteViewPresentation';
import type {ScopedNoteDocumentSurfaceProps} from '../features/notes/ScopedNoteDocumentSurface';
import {LayoutStore} from './layoutStore';
import {groups,type ViewRef} from './layout';
import {ScopedWorkspaceCoordinator,type ScopedHostProof,type ScopedHostBinding} from './scopedWorkspaceCoordinator';
import {ScopedWorkspaceHost} from './ScopedWorkspaceHost';
import {createNativeNoteActions} from './nativeNoteActions';
import {createNativeNoteRuntime,type NativeNoteRuntime} from './nativeNoteRuntime';
import {ScopedNoteIndexPanel,ScopedNoteAttachmentsPanel,ScopedNoteTagsPanel,scopedNotePanelReadiness} from './ScopedNotePanels';
import {loadNativeGraphRuntime,type NativeGraphRuntime} from './nativeGraphRuntime';
import {validateGraphViewPresentation} from './graphViewPresentation';
import {nativeGrant,viewRefFromGrant,workspaceCommand,type NativeViewGrant,type NativeWindowSession} from './nativeClient';
import {transferNativePresentation,validateHandoff,type HandoffOffer,type HandoffSource,NativeHandoffRecovery,NativeHandoffAdmissions} from './nativeHandoff';
import {registerWorkspaceFlush,workspaceCompositionActive} from './windowLifecycle';
import {trackWorkspaceWindowPlacement} from './nativeWindowPlacement';
import {WindowChooser} from './WindowChooser';
import {createWorkspaceInvalidations} from './nativeWorkspaceInvalidation';

const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
type GraphReceipt={id:string;requestId:number;viewId:string;revision:string;generation:number};
async function graphAction(request:Record<string,unknown>){
 const receipt=await workspaceCommand<GraphReceipt>(request);
 if(!/^[a-f0-9]{64}$/.test(receipt.id)||receipt.viewId!==request.viewId||receipt.requestId!==request.requestId||!receipt.revision||receipt.generation!==0)throw Error('workspace-graph-action-receipt-mismatch');
 const end=Date.now()+180000;
 while(Date.now()<end){
  const status=await workspaceCommand<{state:string;result?:{ok:boolean;message?:string;value?:{kind:string;result?:'saved'|'copied'}}}>({op:'graphActionStatus',...receipt});
  if(status.state==='completed'){if(!status.result?.ok)throw Error(status.result?.message||'workspace-graph-action-failed');return status.result.value;}
  if(status.state!=='pending')throw Error('workspace-graph-action-invalid-status');await wait(150);
 }
 throw Error('workspace-graph-action-timeout');
}
/** Authenticated child composition. It has no Main shell, global source picker,
 * SQL bridge, filesystem route, or second LightSeek owner. */
export function IntegratedWorkspaceWindow({initial}:{initial:NativeWindowSession}){
 const coordinator=useMemo(()=>{
  const store=new LayoutStore(initial.label,localStorage),grants=new Map((initial.views??[{view:initial.view,open:true}]).filter(entry=>entry.open).map(entry=>[entry.view.id,entry.view]));
  for(const view of Object.values(store.getSnapshot().views)){const grant=grants.get(view.id);if(!grant||grant.kind!==view.kind||grant.libraryId!==view.library.id||grant.resourceId!==view.resourceId)store.dispatch({type:'close',viewId:view.id});}
  return new ScopedWorkspaceCoordinator(store);
 },[initial.label]);
 const state=useSyncExternalStore(coordinator.subscribe,coordinator.getSnapshot);
 const layout=useSyncExternalStore(coordinator.store.subscribe,coordinator.store.getSnapshot);
 const [recoveries,setRecoveries]=useState<NativeHandoffRecovery[]>([]),[retrying,setRetrying]=useState<string|null>(null);
 const [chooser,setChooser]=useState<ViewRef|null>(null);
 const resources=useMemo(()=>({active:true,receiving:new Set<string>(),loading:new Map<string,Promise<ScopedHostBinding|undefined>>(),noteCaptures:new Map<string,NoteViewPresentationSnapshot>(),graphListeners:new Set<()=>void>(),dirtyStops:new Map<string,{runtime:NativeNoteRuntime;stop:()=>void}>(),renewers:new Map<string,()=>Promise<void>>(),busy:false,actionCount:0,recoveryHolds:new Set<string>(),incomingTail:Promise.resolve() as Promise<unknown>,readinessTail:Promise.resolve() as Promise<unknown>}),[coordinator]);
 const readinessCommand=<T,>(request:unknown):Promise<T>=>{
  const op=(request as {op?:string}).op;if(op!=='integratedReady'&&op!=='integratedNotReady')return workspaceCommand<T>(request);
  const result=resources.readinessTail.catch(()=>{}).then(()=>workspaceCommand<T>(request));resources.readinessTail=result;return result;
 };
 const admissions=useMemo(()=>new NativeHandoffAdmissions(readinessCommand,initial.label),[resources]);
 const report=useCallback((error:unknown)=>{if(error instanceof NativeHandoffRecovery){resources.recoveryHolds.add(error.recoveryId);setRecoveries(current=>current.some(item=>item.recoveryId===error.recoveryId)?current:[...current,error]);}coordinator.reportError(error);},[coordinator]);
 const invalidations=useMemo(()=>createWorkspaceInvalidations({
  blocked:()=>!resources.active||resources.busy||resources.actionCount>0||resources.recoveryHolds.size>0||coordinator.hasFrozenViews()||coordinator.getSnapshot().busy||workspaceCompositionActive()||coordinator.listViews().some(entry=>entry.kind==='note'&&(entry.controller.isComposing()||entry.controller.session.getSnapshot().status==='saving')),
  notes:async()=>{const entries=coordinator.listViews().filter(entry=>entry.kind==='note');await Promise.all([...new Set(entries.flatMap(entry=>entry.kind==='note'?[entry.controller]:[]))].map(controller=>controller.session.refresh()));for(const entry of entries)if(coordinator.getView(entry.view.id)===entry)coordinator.invalidateNoteData(entry.view.id);},
  graph:()=>{for(const listener of resources.graphListeners)listener();},failed:report,
 }),[coordinator,resources,report]);
 const retry=(recovery:NativeHandoffRecovery)=>{setRetrying(recovery.recoveryId);void recovery.retry().then(()=>{resources.recoveryHolds.delete(recovery.recoveryId);setRecoveries(current=>current.filter(item=>item!==recovery));}).catch(report).finally(()=>{setRetrying(null);invalidations.kick();});};
 const publishOpen=()=>workspaceCommand({op:'setOpenViews',ids:coordinator.listViews().map(entry=>entry.view.id),known:coordinator.listViews().map(entry=>entry.view.id)});
 const clean=async()=>{
  if(resources.busy||resources.actionCount>0||resources.recoveryHolds.size>0||coordinator.hasFrozenViews()||workspaceCompositionActive()||!await coordinator.flushAll())return false;
  await Promise.all(coordinator.listViews().map(entry=>workspaceCommand({op:'dirty',viewId:entry.view.id,dirty:false})));return true;
 };
 const release=async(view:ViewRef)=>{
  if(workspaceCompositionActive())throw Error('workspace-host-ime-active');
  if(coordinator.listViews().length===1){if(!await clean())throw Error('workspace-host-unsaved-input');await workspaceCommand({op:'close',label:null});}
  else await workspaceCommand({op:'setOpenViews',ids:coordinator.listViews().filter(entry=>entry.view.id!==view.id).map(entry=>entry.view.id),known:coordinator.listViews().map(entry=>entry.view.id)});
 };
 const noteServices=async(grant:NativeViewGrant,expectedAuthority?:NoteAuthority)=>{
  const authority=await workspaceCommand<NoteAuthority>({op:'noteAuthority',viewId:grant.id});
  if(expectedAuthority&&JSON.stringify(authority)!==JSON.stringify(expectedAuthority))throw Error('workspace-host-note-regrant-mismatch');
  const capabilities=await workspaceCommand<{actions:NoteParentActionKind[];expiresInMs:number}>({op:'noteActionCapabilities',viewId:grant.id});
  let runtime:NativeNoteRuntime;
  const actions=createNativeNoteActions({viewId:grant.id,authority,command:workspaceCommand,capabilities:capabilities.actions,capabilityLeaseMs:capabilities.expiresInMs,
   isCurrent:(request:NoteActionRequest)=>resources.active&&coordinator.isActionCurrent(request,runtime),
   showPanel:panel=>coordinator.setPanel(grant.id,panel),promptTitle:()=>window.prompt('新笔记名称'),
   closeView:async()=>{const result=await coordinator.close(grant.id,release);if(!result.ok)throw Error(result.error);},
   freezeForAction:async request=>{
    const entry=coordinator.getView(grant.id);if(entry?.kind!=='note')throw Error('workspace-note-view-closed');
    const shared=coordinator.listViews().filter(candidate=>candidate.kind==='note'&&candidate.controller===entry.controller);
    if(request.action.kind==='rename-document'&&shared.length>1)throw Error('请先关闭此窗口中同一笔记的其他标签，再重命名。');
    const releases:Array<()=>void>=[];resources.actionCount++;
    try{await invalidations.settled();for(const candidate of shared){if(candidate.kind!=='note'||!candidate.presentation?.freezeAction)throw Error('workspace-note-action-view-not-ready');releases.push(candidate.presentation.freezeAction());}
     if(request.action.kind==='rename-document')resources.noteCaptures.set(grant.id,await entry.presentation!.capture());
     return()=>{for(const stop of releases)stop();resources.actionCount--;invalidations.kick();};
    }catch(error){for(const stop of releases)stop();resources.actionCount--;invalidations.kick();throw error;}
   },
  });
  runtime=createNativeNoteRuntime(grant.id,authority,{command:workspaceCommand,mediaUrl:token=>convertFileSrc(token,'workspace-attachment'),actions});
  const panels={readiness:()=>scopedNotePanelReadiness(runtime,{outline:true,management:true,attachments:true}),
   index:(input:Parameters<NonNullable<NonNullable<ScopedNoteDocumentSurfaceProps['panels']>['index']>>[0])=><ScopedNoteIndexPanel {...input} runtime={runtime}/>,
   attachments:(input:Parameters<NonNullable<NonNullable<ScopedNoteDocumentSurfaceProps['panels']>['attachments']>>[0])=><ScopedNoteAttachmentsPanel {...input} runtime={runtime}/>,
   tags:(input:Parameters<NonNullable<NonNullable<ScopedNoteDocumentSurfaceProps['panels']>['tags']>>[0])=><ScopedNoteTagsPanel {...input} runtime={runtime}/>,
  };
  const refresh=()=>runtime.refreshCapabilities();
  return {runtime,panels,refresh,dispose:()=>{if(resources.renewers.get(grant.id)===refresh)resources.renewers.delete(grant.id);const watcher=resources.dirtyStops.get(grant.id);if(watcher?.runtime===runtime){watcher.stop();resources.dirtyStops.delete(grant.id);}actions.dispose();runtime.dispose();}};
 };
 const watchNote=(viewId:string,runtime:NativeNoteRuntime,refresh=()=>runtime.refreshCapabilities())=>{
  const entry=coordinator.getView(viewId);if(entry?.kind!=='note')return;
  let dirty:boolean|undefined;
  const publish=()=>{const next=entry.controller.session.getSnapshot().dirty;if(next===dirty)return;dirty=next;void workspaceCommand({op:'dirty',viewId,dirty:next}).catch(report);};
  resources.dirtyStops.get(viewId)?.stop();resources.dirtyStops.set(viewId,{runtime,stop:entry.controller.session.subscribe(publish)});resources.renewers.set(viewId,refresh);publish();
 };
 const runGraphAction=async(request:Record<string,unknown>)=>{resources.actionCount++;try{await invalidations.settled();return await graphAction(request);}finally{resources.actionCount--;invalidations.kick();}};
 const bind=async(grant:NativeViewGrant,frozen=false)=>{
  const existing=coordinator.getView(grant.id);if(existing?.open){if(frozen)throw Error('workspace-host-target-already-bound');return existing;}
  const pending=resources.loading.get(grant.id);if(pending){if(frozen)throw Error('workspace-host-target-binding-in-progress');return pending;}
  const task=(async()=>{
   if(grant.kind==='note'){
    const service=await noteServices(grant);if(!resources.active){service.dispose();return;}
    const owner=coordinator.documents.get(service.runtime);if(frozen&&(owner.isComposing()||owner.session.getSnapshot().dirty)){service.dispose();throw Error('workspace-host-target-has-existing-draft');}
    coordinator.bindNote(viewRefFromGrant(grant),service.runtime,service.panels,service.dispose);watchNote(grant.id,service.runtime,service.refresh);
   }else if(grant.kind==='graph'){
    let runtime:NativeGraphRuntime;
    runtime=await loadNativeGraphRuntime(grant.id,grant.libraryId,0,{
     command:workspaceCommand,capabilities:()=>workspaceCommand({op:'graphCapabilities',viewId:grant.id}),
     actions:['open','createMissing','openDefault','reveal','askAi'],nodeActions:{document:['open','openDefault','reveal','askAi'],'missing-document':['createMissing'],tag:['open','askAi'],'library-asset':['open','openDefault','reveal','askAi'],'vault-asset':['open','openDefault','reveal','askAi']},
     subscribe:(_view,listener)=>{resources.graphListeners.add(listener);return()=>{resources.graphListeners.delete(listener);};},
     mutateTag:workspaceCommand,nodeAction:async request=>{await runGraphAction({...request});},
     exportScreenshot:async request=>{const {image,viewId,snapshotId,sourceId,revision,requestId}=request;const result=await runGraphAction({op:'graphScreenshot',viewId,snapshotId,sourceId,revision,requestId,bytes:Array.from(new Uint8Array(await image.arrayBuffer()))});if(result?.kind!=='screenshot'||!result.result)throw Error('workspace-graph-screenshot-not-completed');return result.result;},
    });
    if(!resources.active){runtime.dispose();return;}
    coordinator.bindGraph(viewRefFromGrant(grant),runtime,()=>{resources.renewers.delete(grant.id);runtime.dispose();});
    resources.renewers.set(grant.id,()=>runtime.refreshCapabilities());
   }else throw Error('workspace-host-unsupported-view');
   if(frozen)coordinator.freezeView(grant.id);return coordinator.getView(grant.id);
  })();resources.loading.set(grant.id,task);try{return await task;}finally{resources.loading.delete(grant.id);}
 };
 const incoming=async(offer:HandoffOffer)=>{
  validateHandoff(offer);if(offer.targetWindow!==initial.label||resources.receiving.has(offer.id)||admissions.owns(offer.id)||!['pending','applied','cancelled'].includes(offer.phase))return;
  resources.receiving.add(offer.id);
  try{
   if(offer.phase==='cancelled'){await admissions.cancelled(offer,()=>resources.active);return;}
   let admissionEntry:ScopedHostBinding|undefined;
   await admissions.receive(offer,{
    restore:async()=>{
     admissionEntry??=await bind({...offer.sourceView,id:offer.targetViewId},true);
     const entry=coordinator.getView(offer.targetViewId);if(!entry||entry!==admissionEntry)throw Error('workspace-host-target-not-bound');
     if(!entry.frozen)coordinator.freezeView(offer.targetViewId);
     coordinator.store.dispatch({type:'activate',viewId:offer.targetViewId});
     await coordinator.productionReady(offer.targetViewId);
     if(entry.kind==='note'){
      const portable=offer.presentation as NoteViewPresentationSnapshot;
      if(portable.authority?.sourceId!==offer.proof.identity.sourceId||portable.authority.documentId!==offer.proof.identity.documentId||portable.revision!==offer.proof.revision)throw Error('workspace-host-note-presentation-scope-mismatch');
      await entry.presentation!.restore(portable);
     }else{
      if(!validateGraphViewPresentation(offer.presentation)||offer.presentation.source.viewId!==offer.sourceView.id||offer.presentation.source.sourceId!==offer.proof.identity.sourceId)throw Error('workspace-host-graph-presentation-scope-mismatch');
      const ack=await entry.presentation!.apply(offer.presentation,offer.presentation.source,offer.proof.presentationHash);
      if(ack.presentationHash!==offer.proof.presentationHash||ack.target.viewId!==offer.targetViewId||ack.captureId!==offer.presentation.captureId)throw Error('workspace-host-graph-apply-mismatch');
     }
     const proof=await coordinator.productionReady(offer.targetViewId);
     return proof.kind==='note'?{revision:proof.revision,sourceId:proof.authority.sourceId}:{revision:proof.revision,sourceId:proof.sourceId!,snapshotId:proof.snapshotId};
    },failed:report,activate:async()=>{if(!admissionEntry||coordinator.getView(offer.targetViewId)!==admissionEntry)throw Error('workspace-host-target-replaced');await coordinator.activateView(offer.targetViewId);},cancel:async()=>{if(admissionEntry&&coordinator.getView(offer.targetViewId)===admissionEntry){coordinator.cancelAdmission(offer.targetViewId);await publishOpen();}},
   },()=>resources.active);
  }catch(error){report(error);}finally{resources.receiving.delete(offer.id);}
 };
 const sync=async()=>{
  const offers=await workspaceCommand<HandoffOffer[]>({op:'handoffPending'});
  const pending=new Set(offers.filter(offer=>offer.phase==='pending'||offer.phase==='applied').map(offer=>offer.targetViewId));
  const session=await workspaceCommand<NativeWindowSession>({op:'bootstrap'});
  if(!session.integrated||session.label!==initial.label)throw Error('workspace-host-session-changed');
  for(const entry of session.views??[{view:session.view,open:true}])if(entry.open&&!pending.has(entry.view.id))await bind(entry.view);
  for(const offer of offers){resources.incomingTail=resources.incomingTail.catch(report).then(()=>incoming(offer));}
  if(!offers.length&&!resources.busy&&!coordinator.hasFrozenViews())await publishOpen();
 };
 const transfer=async(view:ViewRef,move=true,targetLabel?:string)=>{
  if(resources.busy||resources.actionCount>0||resources.recoveryHolds.size>0||coordinator.hasFrozenViews()||workspaceCompositionActive())return;
  const entry=coordinator.getView(view.id);if(!entry?.open)return;resources.busy=true;coordinator.notify();
  const source:HandoffSource={view:{...nativeGrant(view),resourceId:view.resourceId},freeze:()=>coordinator.freezeView(view.id),flush:async()=>entry.kind==='note'?entry.controller.flush():entry.presentation!.flush(),
   capture:async()=>{
    const proof=await coordinator.productionReady(view.id);
    await workspaceCommand({op:'dirty',viewId:view.id,dirty:false});
    if(entry.kind==='note'&&proof.kind==='note')return {revision:proof.revision,sourceId:proof.authority.sourceId,presentation:await entry.presentation!.capture()};
    if(entry.kind==='graph'&&proof.kind==='graph')return {revision:proof.revision,sourceId:proof.sourceId!,presentation:entry.presentation!.capture({kind:'graph',revision:proof.revision,snapshotId:proof.snapshotId,sourceId:proof.sourceId})};
    throw Error('workspace-host-source-proof-mismatch');
   },release:async()=>coordinator.parkView(view.id),commitRelease:async()=>{if(coordinator.getView(view.id)?.open)coordinator.commitRelease(view.id);await publishOpen();if(!coordinator.listViews().length)await workspaceCommand({op:'close',label:null});},activate:()=>coordinator.activateView(view.id),abort:()=>coordinator.abortView(view.id),
  };
  try{await invalidations.settled();await transferNativePresentation(workspaceCommand,source,move,targetLabel);}catch(error){report(error);}finally{resources.busy=false;coordinator.notify();invalidations.kick();}
 };
 const actionResult:NonNullable<ScopedNoteDocumentSurfaceProps['onActionResult']>=async(result:NoteActionValue,origin)=>{
  if(result.kind==='saved'){const current=coordinator.getView(origin.viewId);if(current?.kind==='note')await workspaceCommand({op:'dirty',viewId:origin.viewId,dirty:current.controller.session.getSnapshot().dirty});return;}
  if(result.kind!=='renamed')return;
  const portable=resources.noteCaptures.get(origin.viewId),entry=coordinator.getView(origin.viewId);
  if(!portable||entry?.kind!=='note'||portable.revision!==origin.revision||portable.content!==origin.content||!result.viewGrant||!result.authority||!result.snapshot)throw Error('workspace-host-rename-capture-missing');
  coordinator.freezeView(origin.viewId);
  const services=await noteServices(result.viewGrant,result.authority);
  resources.renewers.set(origin.viewId,services.refresh);
  await coordinator.migrateNote(origin.viewId,viewRefFromGrant(result.viewGrant),services.runtime,services.panels,result.snapshot,portable,services.dispose,()=>watchNote(origin.viewId,services.runtime,services.refresh));
  resources.noteCaptures.delete(origin.viewId);await workspaceCommand({op:'dirty',viewId:origin.viewId,dirty:false});
 };
 const rendered=useCallback((viewId:string,proof:ScopedHostProof)=>{
  if(coordinator.getView(viewId)?.frozen)return;
  void readinessCommand({op:'integratedReady',viewId,revision:proof.revision,sourceId:proof.kind==='note'?proof.authority.sourceId:proof.sourceId,snapshotId:proof.kind==='graph'?proof.snapshotId:null}).catch(report);
 },[coordinator,report]);
 useEffect(()=>{
  resources.active=true;const stops:Array<()=>void>=[];let syncing=Promise.resolve();
  const resync=()=>{syncing=syncing.then(()=>sync()).catch(report);};
  const local={target:{kind:'WebviewWindow' as const,label:initial.label}};
  const attach=async()=>{
   for(const [event,handler] of [
    ['luckyray:workspace-handoff-available',()=>resync()],['luckyray:workspace-views-changed',()=>resync()],
    ['luckyray:workspace-note-changed',()=>invalidations.mark('note')],
    ['luckyray:workspace-graph-changed',()=>invalidations.mark('graph')],
    ['luckyray:workspace-close-requested',()=>{void clean().then(saved=>saved?workspaceCommand({op:'close',label:null}):report('未保存的输入、输入法文字或移动中的视图仍保留在此窗口。')).catch(report);}],
   ] as const){const stop=await listen(event,handler,local);if(resources.active)stops.push(stop);else stop();}
   const stopNavigation=await listen<{viewId:string;options?:{headingPath?:string;blockId?:string}}>('luckyray:workspace-note-navigation',event=>{
    const {viewId,options}=event.payload;if(!viewId||!options)return;
    syncing=syncing.then(async()=>{await sync();const entry=coordinator.getView(viewId);if(entry?.kind!=='note')throw Error('workspace-note-navigation-view-missing');coordinator.store.dispatch({type:'activate',viewId});coordinator.setNavigation(viewId,{heading:options.headingPath,blockId:options.blockId});}).catch(report);
   },local);if(resources.active)stops.push(stopNavigation);else stopNavigation();resync();
  };
  void attach().catch(report);
  const previousReady=new Map<string,ScopedHostProof|null>();
  const stopReadiness=coordinator.subscribe(()=>{for(const entry of coordinator.listViews()){if(!entry.ready&&previousReady.get(entry.view.id)!==null)void readinessCommand({op:'integratedNotReady',viewId:entry.view.id}).catch(report);previousReady.set(entry.view.id,entry.ready);}});
  const stopInvalidations=coordinator.subscribe(()=>invalidations.kick());
  const compositionFinished=()=>invalidations.kick();document.addEventListener('compositionend',compositionFinished);
  const stopFlush=registerWorkspaceFlush(clean);
  let renewing=false;const renewal=setInterval(()=>{if(renewing)return;renewing=true;void Promise.allSettled([...resources.renewers.values()].map(renew=>renew())).then(results=>{for(const result of results)if(result.status==='rejected')report(result.reason);}).finally(()=>{renewing=false;});},1800);
  let placement:(()=>void)|undefined;void trackWorkspaceWindowPlacement(viewRefFromGrant(initial.view),report).then(stop=>{if(resources.active)placement=stop;else stop();}).catch(report);
  return()=>{resources.active=false;clearInterval(renewal);stopInvalidations();document.removeEventListener('compositionend',compositionFinished);invalidations.dispose();stopReadiness();stopFlush();for(const stop of stops)stop();placement?.();for(const watcher of resources.dirtyStops.values())watcher.stop();coordinator.dispose();};
 },[coordinator]);
 const activeId=groups(layout.root).find(group=>group.id===layout.focusedGroup)?.active,active=activeId?layout.views[activeId]:undefined;
 return <div className="workspace-window" style={{height:'100%',display:'flex',flexDirection:'column'}}><div className="workspace-toolbar"><strong>工作区窗口</strong><button disabled={!active||resources.busy||coordinator.hasFrozenViews()} onClick={()=>active&&void transfer(active,true,'main')}>合并到主窗口</button><button disabled={!active||resources.busy||coordinator.hasFrozenViews()} onClick={()=>active&&setChooser(active)}>移到其他窗口</button></div>
  {recoveries.map(recovery=><div key={recovery.recoveryId} role="alert" className="workspace-conflict">{recovery.message}<button disabled={retrying===recovery.recoveryId} onClick={()=>retry(recovery)}>重试恢复窗口状态</button></div>)}
  <div style={{flex:1,minHeight:0}} aria-busy={state.busy||resources.busy}><ScopedWorkspaceHost coordinator={coordinator} closeView={release} onWindow={(view,move)=>void transfer(view,move)} onChooseWindow={setChooser} onActionResult={actionResult} onRendered={rendered}/></div>
  {chooser&&<WindowChooser current={initial.label} onClose={()=>setChooser(null)} onMain={()=>{setChooser(null);void transfer(chooser,true,'main');}} onChoose={label=>{setChooser(null);void transfer(chooser,true,label);}}/>}
 </div>;
}
