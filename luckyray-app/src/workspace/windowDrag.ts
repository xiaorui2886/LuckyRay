import {useEffect,useMemo,useRef} from 'react';
import {listen} from '@tauri-apps/api/event';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {workspaceCommand,nativeGrant} from './nativeClient';
import {workspaceCompositionActive} from './windowLifecycle';
import type {LayoutStore} from './layoutStore';
import {groups,type DropEdge,type ViewRef} from './layout';

export const WORKSPACE_DRAG_TYPE='application/x-luckyray-workspace-ticket';
export type WindowDropTarget={groupId:string;edge:DropEdge;index?:number};
export type WindowDragController={start:(view:ViewRef,data:DataTransfer)=>void;end:()=>void;drop:(data:DataTransfer,target:WindowDropTarget)=>void};
/** The browser carries an opaque one-use ticket, never a grant or document.
 * Native authenticates both app windows; source performs the existing safe move.
 */
export function useWindowDrag(store:LayoutStore,onTransfer:(view:ViewRef,target:string)=>Promise<void>,onError:(error:string)=>void){
 const latest=useRef({onTransfer,onError});latest.current={onTransfer,onError};
 const state=useMemo(()=>({outgoing:new Map<string,{viewId:string;ready:Promise<unknown>}>(),incoming:new Map<string,{target:WindowDropTarget;expires:number}>(),current:null as string|null}),[store]);
 const positionIncoming=(sourceId:string,receivedId=sourceId)=>{
  const pending=state.incoming.get(sourceId);if(!pending)return;
  if(pending.expires<Date.now()){state.incoming.delete(sourceId);return;}
  const layout=store.getSnapshot();if(!layout.views[receivedId])return;
  state.incoming.delete(sourceId);
  const groupId=groups(layout.root).some(group=>group.id===pending.target.groupId)?pending.target.groupId:layout.focusedGroup;
  store.dispatch({type:'move',viewId:receivedId,targetGroup:groupId,edge:pending.target.edge,index:pending.target.index,groupId:crypto.randomUUID(),splitId:crypto.randomUUID()});
 };
 useEffect(()=>{
  if(!('__TAURI_INTERNALS__' in window))return;
  let disposed=false;let stop:(()=>void)|undefined;
  void listen<{id:string;target:string}>('luckyray:workspace-drag-claimed',async event=>{
   const pending=state.outgoing.get(event.payload.id);if(!pending)return;state.outgoing.delete(event.payload.id);
   try{await pending.ready;const view=store.getSnapshot().views[pending.viewId];if(!view)throw Error('原标签已关闭，未移动。');await latest.current.onTransfer(view,event.payload.target);}
   catch(error){latest.current.onError(String(error));}
  },{target:{kind:'WebviewWindow',label:getCurrentWindow().label}}).then(unlisten=>{if(disposed)unlisten();else stop=unlisten;}).catch(error=>latest.current.onError(String(error)));
  const changed=store.subscribe(()=>{for(const id of state.incoming.keys())positionIncoming(id);});
  return()=>{disposed=true;stop?.();changed();for(const id of state.outgoing.keys())void workspaceCommand({op:'cancelDrag',id}).catch(()=>{});state.outgoing.clear();};
 },[store,state]);
 const controller:WindowDragController={
  start(view,data){
   if(workspaceCompositionActive())throw Error('请先完成当前输入法文字，再拖动标签。');
   const id=crypto.randomUUID();state.current=id;
   const ready=workspaceCommand({op:'beginDrag',id,view:nativeGrant(view)});state.outgoing.set(id,{viewId:view.id,ready});
   void ready.catch(error=>{state.outgoing.delete(id);latest.current.onError(String(error));});
   data.effectAllowed='move';data.setData(WORKSPACE_DRAG_TYPE,id);
  },
  end(){const id=state.current;state.current=null;if(!id)return;
   // Native drop delivery can precede the target renderer's asynchronous claim.
   // Keep local dispatch state until ticket expiry; cancel only unclaimed tickets.
   setTimeout(()=>{state.outgoing.delete(id);void workspaceCommand({op:'cancelDrag',id}).catch(()=>{});},46000);
  },
  drop(data,target){
   const id=data.getData(WORKSPACE_DRAG_TYPE);if(!/^[\da-f-]{36}$/i.test(id))return;
   const local=state.outgoing.get(id);
   if(local){state.outgoing.delete(id);store.dispatch({type:'move',viewId:local.viewId,targetGroup:target.groupId,edge:target.edge,index:target.index,groupId:crypto.randomUUID(),splitId:crypto.randomUUID()});void local.ready.then(()=>workspaceCommand({op:'cancelDrag',id})).catch(()=>{});return;}
   void (async()=>{
    if(workspaceCompositionActive())throw Error('请先完成目标窗口的输入法文字，再移动标签。');
    const result=await workspaceCommand<{viewId:string}>({op:'claimDrag',id});
    state.incoming.set(result.viewId,{target,expires:Date.now()+30000});positionIncoming(result.viewId);
   })().catch(error=>latest.current.onError('未移动标签：'+String(error)));
  },
 };
 return {controller:'__TAURI_INTERNALS__' in window?controller:undefined,positionIncoming};
}
