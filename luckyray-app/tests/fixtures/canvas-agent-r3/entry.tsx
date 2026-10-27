// Production CanvasSpike + Agent panel, synthetic IO only. No real model or credentials.
import React from 'react';
import {createRoot} from 'react-dom/client';
import CanvasSpike from '../../../src/CanvasSpike';
(window as any).__TAURI_INTERNALS__={convertFileSrc:()=>'',invoke:async()=>{throw new Error('synthetic-native-unavailable');},transformCallback:()=>0};
const now=new Date().toISOString();
const image='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#839e93"/><stop offset="1" stop-color="#243b3d"/></linearGradient></defs><rect width="400" height="300" fill="url(#g)"/><circle cx="275" cy="85" r="42" fill="#dfc9a0"/><path d="M0 250L90 130L180 240L250 155L400 290V300H0" fill="#172d30"/></svg>');
const nodes=[{id:'reference-a',type:'spike',dragHandle:'.canvas-node-drag-handle',position:{x:140,y:160},data:{kind:'text',label:'雨后的森林',result:'清晨的薄雾，叶片上的露水，柔和的绿色。'},style:{width:260,height:180}},{id:'reference-b',type:'spike',position:{x:480,y:210},data:{kind:'text',label:'镜头与节奏',result:'从叶片特写开始，缓缓拉远到森林全景。'},style:{width:260,height:180}}];
nodes.push({id:'reference-image',type:'spike',position:{x:140,y:410},data:{kind:'image',label:'山间晨光',refKind:'image',refMediaUrl:image},style:{width:260,height:195}} as any);
let canvas={canvasId:'qa-agent-r3',name:'森林短片 · Agent 交互核对',createdAt:now,updatedAt:now,nodes,edges:[],viewport:{x:0,y:0,zoom:1},generationHistory:[],revision:1,contentDigest:'a'.repeat(64)};
(window as any).__LUCKYRAY__={listCanvases:async()=>[{id:canvas.canvasId,name:canvas.name,createdAt:now,updatedAt:now,nodeCount:2}],loadCanvas:async()=>canvas,saveCanvas:async(value:any)=>{canvas={...value,revision:canvas.revision+1,contentDigest:'b'.repeat(64)};return canvas;},getCanvasStorageDir:async()=>'/synthetic/canvas',checkCanvasFiles:async()=>({missing:[],orphaned:[]}),listAssets:async()=>[],listNotes:async()=>[],saveCanvasThumbnail:async()=>{},deleteCanvasThumbnail:async()=>{}};
createRoot(document.getElementById('root')!).render(<CanvasSpike/>);
