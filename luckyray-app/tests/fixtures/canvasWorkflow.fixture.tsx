import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CanvasWorkflowLibrary} from '../../src/features/canvas/CanvasWorkflowLibrary';
import {builtinWorkflows, WorkflowError} from '../../src/core/canvas/workflowTemplates';
import {CanvasReferencePacks} from '../../src/features/canvas/CanvasReferencePacks';
export {builtinWorkflows};
export function mountWorkflow(el:HTMLElement,selectionCount=2){
 const events:any[]=[];let mode='success';
 function App(){const [open,setOpen]=useState(true);return open?<CanvasWorkflowLibrary selectionCount={selectionCount} onClose={()=>{events.push(['close']);setOpen(false);}}
 onInsert={t=>{if(mode==='insert-error')throw new WorkflowError('canvas-changed');events.push(['insert',t]);}}
 onExport={async name=>{events.push(['export',name]);if(mode==='export-error')throw new Error('disk full');return {cancelled:mode==='cancel',placeholders:1,omittedEdges:2};}}/>:<p>closed</p>;}
 const root=createRoot(el);root.render(<React.StrictMode><App/></React.StrictMode>);return {root,events,setMode:(value:string)=>{mode=value;}};
}
export function mountEmptyPack(el:HTMLElement){
 const events:string[]=[];const root=createRoot(el);
 root.render(<CanvasReferencePacks nodes={[]} edges={[]} selectedIds={[]} resolveUrl={u=>u} onClose={()=>events.push('close')} onCreate={()=>null} onRename={()=>{}} onUnmark={()=>{}} onApply={()=>null} onLocate={()=>{}}/>);
 return {root,events};
}
