import {invoke} from '@tauri-apps/api/core';
import type {ViewRef} from './layout';
import type {DocumentSnapshot,DocumentTransport} from './documentSession';
export type NativeViewGrant={id:string;kind:string;libraryId:string;resourceId?:string;title:string};
export type NativeViewState={view:NativeViewGrant;open:boolean;ready:boolean;dirty:boolean;renderedRevision?:string|null};
export type NativeWindowSession={integrated?:boolean;handoffId?:string|null;label:string;ready:boolean;renderedRevision?:string|null;view:NativeViewGrant;views?:NativeViewState[]};
export const windowViewState=(window:NativeWindowSession,id:string)=>window.views?.find(entry=>entry.view.id===id)??(window.view.id===id?{view:window.view,open:true,ready:window.ready,dirty:false,renderedRevision:window.renderedRevision}:undefined);
export const viewRefFromGrant=(view:NativeViewGrant):ViewRef=>({id:view.id,kind:view.kind==='graph'?'graph':'note',title:view.title,library:{kind:'knowledge',id:view.libraryId},resourceId:view.resourceId});
export const workspaceCommand=<T>(request:unknown)=>invoke<T>('workspace_window_command',{request});
export const nativeGrant=(view:ViewRef)=>({id:view.id,kind:view.kind,libraryId:view.library.id,resourceId:view.resourceId??null,title:view.title});
export function noteTransport(view:ViewRef,child:boolean):DocumentTransport{
 let initialized=false;
 return {
  read:async()=>{
   if(child)return workspaceCommand<DocumentSnapshot>({op:'readNote',viewId:view.id});
   if(!initialized){const snapshot=await workspaceCommand<DocumentSnapshot>({op:'bind',view:nativeGrant(view)});initialized=true;return snapshot;}
   return workspaceCommand<DocumentSnapshot>({op:'readBound',viewId:view.id});
  },
  write:(content,revision)=>workspaceCommand<DocumentSnapshot>({op:child?'writeNote':'writeBound',viewId:view.id,content,revision}),
 };
}
