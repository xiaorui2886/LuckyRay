import {workspaceCommand,nativeGrant,windowViewState,type NativeWindowSession} from './nativeClient';
import type {DocumentSession} from './documentSession';
import type {ViewRef} from './layout';
import {transferView} from './windowTransfer';

export async function transferNativeNote(view:ViewRef,session:DocumentSession,move:boolean,removeSource:()=>void|Promise<void>,targetLabel?:string){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
 const wait=async(label:string,revision?:string)=>{while(!controller.signal.aborted){
  const window=(await workspaceCommand<NativeWindowSession[]>({op:'list'})).find(window=>window.label===label);
  if(!window)return false;const entry=windowViewState(window,view.id);
  if(entry?.open&&entry.ready&&!entry.dirty&&(!revision||entry.renderedRevision===revision))return true;
  await new Promise(resolve=>setTimeout(resolve,100));
 }return false;};
 try{return await transferView(view,move,{
  flush:async()=>{await session.load();return session.flush();},
  revision:()=>{const state=session.getSnapshot();return state.status==='ready'&&!state.dirty?state.revision:null;},
  open:async()=>{const target=await workspaceCommand<NativeWindowSession>(targetLabel?{op:'attach',label:targetLabel,view:nativeGrant(view)}:{op:'open',view:nativeGrant(view)});return {label:target.label,viewId:view.id};},
  waitReady:target=>wait(target.label),waitRevision:(target,revision)=>wait(target.label,revision),removeSource,
  cancelTarget:async target=>{if(!targetLabel)await workspaceCommand({op:'close',label:target.label});},
 },controller.signal);}finally{clearTimeout(timer);}
}
