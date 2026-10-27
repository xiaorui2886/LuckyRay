import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ReactFlow, ReactFlowProvider, Background, useReactFlow} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import '../src/canvas-spike-scroll.css';
import '../src/features/canvas/canvasCreative.css';
import {CanvasCreativeRail} from '../src/features/canvas/CanvasCreativeRail';
import {CanvasImageToolbar} from '../src/features/canvas/CanvasGridSplit';
// The build harness exposes the real private components without changing product exports.
import {SpikeNodeView,CanvasGroupNodeView,MaterialCompactComposer} from '../src/CanvasSpike';
import {I18nProvider} from '../src/core/i18n/index';
import {planGridNodes,equalGrid,gridCells,restoreGridSliceInteraction} from '../src/core/canvas/imageGrid';
const svg=(w:number,h:number,color:string,label:string)=>'data:image/svg+xml,'+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${color}"/><circle cx="${w/2}" cy="${h/2}" r="${h/3}" fill="#ffffff44"/><text x="20" y="35" font-family="sans-serif" font-size="24" fill="white">${label}</text></svg>`);
const source=svg(900,600,'#315769','原图 / 3 × 3');
let id=0;const spec=equalGrid(3,3);const plan=planGridNodes({sourceId:'source',label:'分镜',source:{x:80,y:160,width:300,height:200},occupied:[],spec,id:()=>String(++id),staged:gridCells(900,600,spec).map((cell,i)=>({cell,png:'',path:svg(cell.width,cell.height,['#315769','#755e4b','#6a566f'][i%3],String(i+1))}))});
const types={spike:SpikeNodeView,group:CanvasGroupNodeView};
const fixtureSlices=plan.children.map(node=>new URLSearchParams(location.search).has('legacy')?{...node,dragHandle:'.canvas-node-drag-handle',extent:'parent' as const}:node);
function Demo(){
 const flow=useReactFlow();const [always,setAlways]=useState(false);const [actions,setActions]=useState('');
 const [node,setNode]=useState<any>({id:'generation',position:{x:0,y:0},data:{kind:'generator',label:'生成',generationKind:'image',generationPrompt:''}});
 const [snap,setSnap]=useState(false);
 (window as any).setZoom=(zoom:number)=>flow.setViewport({x:20,y:20,zoom});
 (window as any).setKind=(kind:string)=>setNode((n:any)=>({...n,data:{...n.data,generationKind:kind}}));
 (window as any).getGridNodes=()=>flow.getNodes();
 (window as any).setFixtureSnap=setSnap;
 return <div className="canvas-editor-stage" style={{width:'100vw',height:'100vh'}}><ReactFlow defaultNodes={[{id:'source',type:'spike',position:{x:80,y:160},style:{width:300,height:200},selected:true,data:{kind:'image',label:'原图',refKind:'image',refMediaUrl:source,refThumbnailUrl:source}},plan.group,...fixtureSlices].map(restoreGridSliceInteraction) as any} defaultEdges={plan.edges} nodeTypes={types as any} snapToGrid={snap} snapGrid={[28,28]} defaultViewport={{x:20,y:20,zoom:.65}}><Background/><CanvasImageToolbar nodeId="source" source={source} onSplit={()=>setActions('split')}/></ReactFlow>
 <CanvasCreativeRail alwaysVisible={always} onAction={setActions}/>
 <button id="always" style={{position:'absolute',right:12,top:12}} onClick={()=>setAlways(v=>!v)}>常显</button><output id="action" style={{position:'absolute',top:12,left:12}}>{actions}</output>
 <div style={{position:'absolute',bottom:20,left:'25%',width:'65%',maxWidth:780}}><MaterialCompactComposer embedded node={node} onDataChange={(patch:any)=>setNode((n:any)=>({...n,data:{...n.data,...patch}}))} onAddReference={()=>{}} onSubmit={()=>setActions('generate')} imageModels={['image-test']} videoModels={['video-test']} mediaProfile={{apiKeyConfigured:true,imageProtocol:'openai',videoProtocol:'openai'} as any} connectedInputs={[{edgeId:'text-edge',sourceNodeId:'text',role:'promptContext',reference:{id:'text',kind:'text',label:'镜头脚本',text:'雨夜，小屋灯火。镜头缓慢推进，窗边的人抬起头。'}},{edgeId:'image-edge',sourceNodeId:'image',role:'reference',reference:{id:'image',kind:'image',label:'场景参考图',mediaUrl:source,thumbnailUrl:source}}] as any} onRemoveConnectedInput={()=>setActions('disconnect')}/></div>
 </div>;
}
createRoot(document.getElementById('root')!).render(<I18nProvider locale="zh-CN"><ReactFlowProvider><Demo/></ReactFlowProvider></I18nProvider>);
