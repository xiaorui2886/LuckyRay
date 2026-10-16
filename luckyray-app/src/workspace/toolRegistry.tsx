import {createContext,useContext,useEffect,type ReactNode} from 'react';
import type {ToolKind} from './toolLayout';
export type ToolAdapter={title:string;kinds:ToolKind[];titleFor?:(objectId:string)=>string;captureObject?:(kind:ToolKind)=>string|undefined;render:(kind:ToolKind,objectId?:string)=>ReactNode};
export class ToolRegistry{
 private adapters=new Map<string,ToolAdapter>();private listeners=new Set<()=>void>();private version=0;
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 getSnapshot=()=>this.version;
 get(viewId:string){return this.adapters.get(viewId);}
 set(viewId:string,adapter:ToolAdapter){if(this.adapters.get(viewId)===adapter)return;this.adapters.set(viewId,adapter);this.publish();}
 remove(viewId:string,adapter:ToolAdapter){if(this.adapters.get(viewId)!==adapter)return;this.adapters.delete(viewId);this.publish();}
 private publish(){this.version++;this.listeners.forEach(listener=>listener());}
}
export const WorkspaceToolsContext=createContext<ToolRegistry|null>(null);
export function useWorkspaceTools(viewId:string|undefined,adapter:ToolAdapter|null){
 const registry=useContext(WorkspaceToolsContext);
 useEffect(()=>{if(!registry||!viewId||!adapter)return;registry.set(viewId,adapter);return()=>registry.remove(viewId,adapter);},[registry,viewId,adapter]);
}
