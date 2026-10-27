import React from 'react';
import {createRoot} from 'react-dom/client';
import {ReactFlowProvider,useReactFlow} from '@xyflow/react';
import {CanvasInner} from '../src/CanvasSpike';
import {I18nProvider} from '../src/core/i18n/index';
import {planGridNodes,equalGrid,gridCells} from '../src/core/canvas/imageGrid';
const image='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#315769"/><circle cx="300" cy="200" r="110" fill="#eee"/></svg>');
let id=0;const spec=equalGrid(3,3);
const plan=planGridNodes({sourceId:'source',label:'Synthetic test grid',source:{x:40,y:90,width:300,height:200},occupied:[],spec,id:()=>String(++id),staged:gridCells(600,400,spec).map(cell=>({cell,png:'',path:image}))});
const entry={id:'group-drag-fixture',name:'Group drag fixture',createdAt:'2026-10-16T00:00:00Z',updatedAt:'2026-10-16T00:00:00Z',revision:0,contentDigest:'a'.repeat(64)};
let doc:any={...entry,canvasId:entry.id,schemaVersion:2,nodes:[{id:'source',type:'spike',position:{x:40,y:90},style:{width:300,height:200},data:{kind:'image',label:'Synthetic source',refKind:'image',refMediaUrl:image,refThumbnailUrl:image}},plan.group,...plan.children],edges:plan.edges,generationHistory:[],viewport:{x:20,y:20,zoom:.65}};
const qa=window as any;qa.__cardRenders={};qa.__saved=[];
qa.__fixture=()=>structuredClone(doc);
qa.__LUCKYRAY__={listCanvases:async()=>[{...entry,revision:doc.revision,contentDigest:doc.contentDigest}],loadCanvas:async()=>structuredClone(doc),getSettings:async()=>({}),getCanvasStorageDir:async()=>'',saveCanvasThumbnail:async()=>{},saveCanvas:async(payload:any)=>{doc=structuredClone({...payload,revision:doc.revision+1,contentDigest:'b'.repeat(64)});qa.__saved.push(structuredClone(doc));return {...entry,revision:doc.revision,contentDigest:doc.contentDigest};}};
qa.__TAURI_INTERNALS__={invoke:async(command:string)=>{if(command==='canvas_media_profiles_list')return {version:1,activeProfileId:'fixture',profiles:[{id:'fixture',name:'No model requests',baseUrl:'https://qa.invalid',imageModel:'',videoModel:'',imageProtocol:'disabled',videoProtocol:'disabled',textProtocol:'disabled',revision:0,apiKeyConfigured:false}]};throw Error('fixture-native-command-disabled');}};
localStorage.setItem('luckyray:canvas-ui-settings-v1',JSON.stringify({snapToGrid:new URLSearchParams(location.search).has('snap'),showGrid:true}));
location.hash='#canvas/main/'+entry.id;
function Probe(){const flow=useReactFlow();qa.getGridNodes=()=>flow.getNodes();return null;}
createRoot(document.getElementById('root')!).render(<I18nProvider locale="zh-CN"><ReactFlowProvider><CanvasInner/><Probe/></ReactFlowProvider></I18nProvider>);
