import {useCallback,useLayoutEffect,useRef,useState,useSyncExternalStore} from 'react';
import {ScopedNoteDocumentSurface} from '../features/notes/ScopedNoteDocumentSurface';
import type {GraphDataProof} from '../features/graph/GraphRuntime';
import {ScopedGraphDocumentSurface} from './ScopedGraphDocumentSurface';
import {WorkspaceHost,type WorkspaceViewContext} from './WorkspaceHost';
import {ScopedWorkspaceCoordinator,type ScopedHostProof,type ScopedHostTransfer} from './scopedWorkspaceCoordinator';
import type {ViewRef} from './layout';
import type {ScopedNoteDocumentSurfaceProps} from '../features/notes/ScopedNoteDocumentSurface';

export type ScopedWorkspaceHostProps={
 coordinator:ScopedWorkspaceCoordinator;
 /** Both services are explicitly injected. Missing routes never pretend success. */
 closeView?:(view:ViewRef,signal:AbortSignal)=>Promise<void>;
 transfer?:ScopedHostTransfer;
 onWindow?:(view:ViewRef,move:boolean)=>void;
 onChooseWindow?:(view:ViewRef)=>void;
 onActionResult?:ScopedNoteDocumentSurfaceProps['onActionResult'];
 onRendered?:(viewId:string,proof:ScopedHostProof)=>void;
};
/** Stable callbacks avoid readiness-invalidated/readiness-ready render loops.
 * Captured runtime identity cannot be rewritten by a later in-place regrant. */
function ScopedBoundView({coordinator,viewId,context,layoutRevision,onRendered,interactionLocked,portalContainer,onActionResult}:{onActionResult?:ScopedWorkspaceHostProps['onActionResult'];coordinator:ScopedWorkspaceCoordinator;viewId:string;context:WorkspaceViewContext;layoutRevision:string;onRendered?:ScopedWorkspaceHostProps['onRendered'];interactionLocked:boolean;portalContainer:HTMLElement|null}){
 const entry=coordinator.getView(viewId),runtime=entry?.runtime;
 const note=entry?.kind==='note'?entry:undefined,noteRuntime=note?.runtime;
 const graph=entry?.kind==='graph'?entry:undefined,graphRuntime=graph?.runtime;
 const observer=useRef(onRendered);observer.current=onRendered;
 const focus=useCallback(()=>coordinator.store.dispatch({type:'activate',viewId}),[coordinator,viewId]);
 const invalidate=useCallback(()=>{if(runtime)coordinator.invalidateRendered(viewId,runtime);},[coordinator,viewId,runtime]);
 useLayoutEffect(()=>{invalidate();return invalidate;},[invalidate,context.visible,layoutRevision]);
 const noteReady=useCallback((revision:string)=>{
  if(note&&noteRuntime&&coordinator.noteRendered(viewId,noteRuntime,revision))observer.current?.(viewId,{kind:'note',authority:note.controller.authority,revision});
 },[coordinator,viewId,note,noteRuntime]);
 const graphReady=useCallback((proof:GraphDataProof)=>{
  if(graphRuntime&&coordinator.graphRendered(viewId,graphRuntime,proof))observer.current?.(viewId,{...proof,vaultId:graphRuntime.vaultId});
 },[coordinator,viewId,graphRuntime]);
 if(!entry?.open)return null;
 if(note&&noteRuntime)return <div style={{display:'flex',width:'100%',height:'100%',minHeight:0,opacity:entry.parked?0:1,pointerEvents:entry.parked?'none':undefined}}><ScopedNoteDocumentSurface key={entry.generation??0} viewId={viewId} title={entry.view.title}
  runtime={noteRuntime} controller={note.controller} panels={note.panels} viewLease="host" visible={context.visible}
  onPresentationHandle={coordinator.attachNotePresentation} onActionResult={onActionResult} invalidationRevision={entry.invalidationRevision} panelRequest={entry.panelRequest} navigationRequest={entry.navigationRequest} interactionLocked={interactionLocked||!!entry.frozen} portalContainer={portalContainer} layoutRevision={layoutRevision} onFocus={focus} onRevisionReady={noteReady} onRevisionInvalidated={invalidate}/></div>;
 if(graphRuntime)return <div style={{display:'flex',width:'100%',height:'100%',minHeight:0,opacity:entry.parked?0:1,pointerEvents:entry.parked?'none':undefined}}><ScopedGraphDocumentSurface presentation={graph?.presentation} viewId={viewId} runtime={graphRuntime} visible={context.visible} focused={context.focused}
  layoutRevision={layoutRevision} onFocus={focus} onRevisionReady={graphReady} onRevisionInvalidated={invalidate}/></div>;
 return null;
}
/** Full content-only composition used by the authenticated integrated host.
 * No App/sidebar/global vault/bootstrap/LSH owner is mounted here. */
export function ScopedWorkspaceHost({coordinator,closeView,transfer,onRendered,onWindow,onChooseWindow,onActionResult}:ScopedWorkspaceHostProps){
 const state=useSyncExternalStore(coordinator.subscribe,coordinator.getSnapshot);
 const layout=useSyncExternalStore(coordinator.store.subscribe,coordinator.store.getSnapshot);
 const root=useRef<HTMLDivElement>(null);
 const [portalContainer,setPortalContainer]=useState<HTMLElement|null>(null);
 const setRoot=useCallback((element:HTMLDivElement|null)=>{root.current=element;setPortalContainer(element);},[]);
 useLayoutEffect(()=>{const element=root.current;if(!element)return;element.inert=state.busy||coordinator.hasFrozenViews();return()=>{element.inert=false;};},[state.version,coordinator]);
 return <div className="workspace-window" data-scoped-workspace-host={layout.windowId} style={{height:'100%',display:'flex',flexDirection:'column'}}>
  {state.error&&<div className="workspace-conflict" role="alert">{state.error}{state.recoveringViews.map(viewId=><button key={viewId} onClick={()=>void coordinator.retryMigration(viewId)}>重试恢复已重命名笔记</button>)}</div>}
  <div ref={setRoot} aria-busy={state.busy} style={{position:'relative',flex:1,minHeight:0}}>
   <WorkspaceHost store={coordinator.store}
    onUndoLayout={()=>{coordinator.undoLayout();}} onRedoLayout={()=>{coordinator.undoLayout(true);}}
    beforeClose={async view=>{await coordinator.close(view.id,closeView??(async()=>{throw Error('workspace-host-close-route-unavailable');}));return false;}}
    onChooseWindow={onChooseWindow}
    onWindow={onWindow??(transfer?(view,move)=>{void coordinator.transfer(view.id,transfer,undefined,move);}:undefined)}
    renderView={(view,context)=><ScopedBoundView key={view.id} coordinator={coordinator} viewId={view.id} context={context} layoutRevision={JSON.stringify(layout.root)} onRendered={onRendered} onActionResult={onActionResult} interactionLocked={state.busy} portalContainer={portalContainer}/>}/>
  </div>
 </div>;
}
