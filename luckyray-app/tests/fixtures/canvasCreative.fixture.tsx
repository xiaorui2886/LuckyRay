import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CanvasVersionReview} from '../../src/features/canvas/CanvasVersionReview';
import {CanvasReferencePacks} from '../../src/features/canvas/CanvasReferencePacks';
import type {CanvasGenerationHistoryEntry} from '../../src/core/canvas/generationHistory';
const base:CanvasGenerationHistoryEntry={version:4,id:'a',taskId:'ta',sourceNodeId:'n',resultNodeId:'r',kind:'image',status:'succeeded',attempt:1,prompt:'第一张的描述',model:'model-A',createdAt:'2026-10-09T00:00:00Z',updatedAt:'2026-10-09T00:00:00Z',request:{kind:'image',prompt:'第一张的描述',model:'model-A',aspect:'1:1',references:[]},outputMediaItems:[{url:'https://qa.invalid/a.png'},{url:'https://qa.invalid/a2.png'}]};
export function mountReview(el:HTMLElement,empty=false){
 const events:any[]=[];let control:any;
 function App(){const [history,setHistory]=useState(empty?[]:[base,{...base,id:'b',taskId:'tb',prompt:'第二张的描述',model:'model-B',request:{...base.request,aspect:'16:9'},outputMediaItems:undefined,outputMediaUrl:'https://qa.invalid/b.png'}]);
 const [open,setOpen]=useState(true);control={clear:()=>setHistory([])};
 return open?<CanvasVersionReview history={history} initialId="a" resolveUrl={url=>url} onPick={(id,index)=>{events.push(['pick',id,index]);setHistory(h=>h.map(e=>e.id===id?{...e,preferredImageIndexes:e.preferredImageIndexes?.includes(index)?[]:[index]}:e));}} onRestore={e=>events.push(['restore',e.outputMediaItems])} onClose={()=>{events.push(['close']);setOpen(false);}}/>:<p>closed</p>;}
 const root=createRoot(el);root.render(<App/>);return {root,events,get control(){return control;}};
}
export function mountPacks(el:HTMLElement){
 const events:any[]=[];
 const nodes:any[]=[{id:'g',data:{kind:'group',label:'主角参考',referencePack:{version:1,kind:'character'}}},{id:'p',parentId:'g',data:{kind:'image',label:'侧面图',refMediaUrl:'asset://image'}},{id:'n',parentId:'g',data:{kind:'noteRef',label:'人物说明',payload:'note'}},{id:'t',data:{kind:'generator',label:'下一镜头',generationKind:'video'}}];
 function App(){const [data,setData]=useState(nodes);return <CanvasReferencePacks nodes={data} edges={[]} selectedIds={['g']} resolveUrl={url=>url} onClose={()=>events.push(['close'])} onLocate={id=>events.push(['locate',id])} onApply={(...args)=>{events.push(['apply',...args]);return null;}} onCreate={(...args)=>{events.push(['create',...args]);return null;}} onRename={(id,name)=>{events.push(['rename',id,name]);setData(old=>old.map(n=>n.id===id?{...n,data:{...n.data,label:name}}:n));}} onUnmark={id=>{events.push(['unmark',id]);setData(old=>old.map(n=>n.id===id?{...n,data:{...n.data,referencePack:undefined}}:n));}}/>;}
 const root=createRoot(el);root.render(<App/>);return {root,events};
}
