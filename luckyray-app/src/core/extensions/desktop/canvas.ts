import {invoke} from '@tauri-apps/api/core';
export type DesktopCanvasDocument={schemaVersion:number;canvasId:string;name:string;createdAt:string;updatedAt:string;nodes:unknown[];edges:unknown[];viewport:{x:number;y:number;zoom:number};revision:number;contentDigest:string;generationHistory?:unknown[]};
export type DesktopCanvasEntry={id:string;name:string;createdAt:string;updatedAt:string;revision?:number};
/** Saved documents only. Revision/digest conflicts are never retried or silently merged. */
export function desktopCanvas(ensure:()=>void){return {
 list:()=>{ensure();return invoke<DesktopCanvasEntry[]>('list_canvases');},
 read:(canvasId:string)=>{ensure();return invoke<DesktopCanvasDocument>('load_canvas',{canvasId});},
 create:async(name:string)=>{ensure();const r=await invoke<{canvas:DesktopCanvasEntry}>('create_canvas',{name});return r.canvas;},
 save:(canvas:DesktopCanvasDocument)=>{ensure();return invoke<DesktopCanvasEntry>('save_canvas',{canvas});},
 rename:(canvasId:string,name:string,expectedRevision:number,expectedDigest:string)=>{ensure();return invoke<DesktopCanvasEntry>('rename_canvas',{canvasId,name,expectedRevision,expectedDigest});},
 delete:(canvasId:string,expectedRevision:number,expectedDigest:string)=>{ensure();return invoke<void>('delete_canvas',{canvasId,expectedRevision,expectedDigest});},
};}
