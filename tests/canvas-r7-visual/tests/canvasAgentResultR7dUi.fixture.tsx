// Synthetic data in real ReactFlow. No CanvasSpike, bridge, host, model or paid job imports.
import { StrictMode, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlow, ReactFlowProvider, useReactFlow, useNodesState, useNodesInitialized, getViewportForBounds, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { CanvasAgentPanel } from '../src/features/canvas/CanvasAgentPanel';
import { CanvasMotionProvider } from '../src/features/canvas/CanvasMotionContext';
import { canvasAgentExecutionNodeIds, navigateCanvasAgentExecution, type CanvasAgentResultBounds } from '../src/features/canvas/canvasAgentResultNavigation';
import { synchronizeCanvasNodeSelection } from '../src/features/canvas/canvasSelectionTransform';
import type { CanvasAgentExecution } from '../src/core/canvas/agent/types';
import '../src/core/theme/themeTokens.css';

const owner={canvasId:'synthetic-result-canvas',loadEpoch:1};
const execution:CanvasAgentExecution={planId:'synthetic-execution',owner,status:'completed',steps:[
  {id:'s1',nodeId:'draft',title:'Created image draft',kind:'image',status:'draft'},
  {id:'s2',nodeId:'edited',title:'Edited text',kind:'text',status:'succeeded'},
  {id:'s3',nodeId:'draft',title:'Duplicate real result ID',kind:'image',status:'succeeded'},
  {id:'s4',nodeId:'removed',title:'Removed result',kind:'video',status:'succeeded'},
  {id:'s5',nodeId:'pending',title:'Running existing result',kind:'image',status:'running'},
  {id:'s6',nodeId:'failed',title:'Failed existing result',kind:'video',status:'failed'},
]};
const initialNodes:Node[]=[
  {id:'draft',position:{x:2200,y:100},data:{label:'Created image draft'}},
  {id:'edited',position:{x:3000,y:500},data:{label:'Edited text'}},
  {id:'unrelated',position:{x:80,y:100},data:{label:'Unrelated node'},selected:true},
  {id:'pending',position:{x:200,y:800},data:{label:'Running result'}},
  {id:'failed',position:{x:700,y:800},data:{label:'Failed result'}},
].map(node=>({...node,style:{width:220,height:120}}));
const initialViewport={x:0,y:0,zoom:.8};
function Fixture() {
  const flow=useReactFlow(),ready=useNodesInitialized();
  const [nodes,setNodes,onNodesChange]=useNodesState(initialNodes),[currentOwner,setOwner]=useState(owner);
  const [events,setEvents]=useState<{nodeIds:string[];selectAll:boolean}[]>([]),[viewport,setViewport]=useState(initialViewport);
  const [lastBounds,setLastBounds]=useState<CanvasAgentResultBounds|null>(null);
  const stage=useRef<HTMLDivElement>(null);
  const state=useRef({owner:currentOwner,execution,nodes});state.current={owner:currentOwner,execution,nodes};
  const locate=(expected:CanvasAgentExecution,nodeId?:string)=>navigateCanvasAgentExecution(expected,nodeId,{
    readCurrent:()=>state.current,
    getBounds:ids=>flow.getNodesBounds(ids),
    apply:({nodeIds,bounds,selectAll})=>{
      setEvents(values=>[...values,{nodeIds,selectAll}]);setLastBounds(bounds);
      if(selectAll){
        setNodes(values=>synchronizeCanvasNodeSelection(values,nodeIds));
        void flow.setViewport(getViewportForBounds(bounds,stage.current!.clientWidth,stage.current!.clientHeight,.08,1,.2),{duration:0});
      }else void flow.setCenter(bounds.x+bounds.width/2,bounds.y+bounds.height/2,{duration:0,zoom:Math.max(flow.getZoom(),.9)});
    },
  });
  const reset=()=>{setNodes(initialNodes);setOwner(owner);setEvents([]);setLastBounds(null);void flow.setViewport(initialViewport,{duration:0});};
  const switchOwner=(reload=false)=>{setOwner(reload?{...owner,loadEpoch:2}:{...owner,canvasId:'newer-canvas'});setNodes(initialNodes);void flow.setViewport({x:34,y:56,zoom:.5},{duration:0});};
  return <CanvasMotionProvider reduced><main className="fixture-stage">
    <nav aria-label="Synthetic controls">
      <button onClick={reset}>Reset</button>
      <button onClick={()=>setNodes(values=>values.filter(node=>node.id!=='draft'))}>Delete first</button>
      <button onClick={()=>setNodes(values=>values.filter(node=>node.id==='unrelated'))}>Delete all results</button>
      <button onClick={()=>switchOwner()}>Switch canvas</button>
      <button onClick={()=>switchOwner(true)}>Reload canvas</button>
      <button onClick={()=>locate(execution)}>Invoke old callback</button>
    </nav>
    <div ref={stage} className="fixture-flow"><ReactFlow nodes={nodes} edges={[]} onNodesChange={onNodesChange} defaultViewport={initialViewport} onViewportChange={setViewport} minZoom={.08} maxZoom={8} deleteKeyCode={null} /></div>
    <output id="evidence" data-ready={String(ready)} data-events={JSON.stringify(events)} data-selected={JSON.stringify(nodes.filter(node=>node.selected).map(node=>node.id))} data-viewport={JSON.stringify(viewport)} data-bounds={JSON.stringify(lastBounds)}>Synthetic data, real ReactFlow viewport/selection. No runtime requests.</output>
    <CanvasAgentPanel canvasName="Synthetic result navigation" snapshot={null} contextChips={[]} execution={execution}
      executionNodeIds={canvasAgentExecutionNodeIds(execution,currentOwner,nodes)} onLocateExecution={locate}
      busy={false} english onSend={()=>false} onApply={()=>false} onCancel={()=>{}} onLocate={()=>{}}
      onRemoveContext={()=>{}} onClose={()=>{}} />
  </main></CanvasMotionProvider>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><ReactFlowProvider><Fixture /></ReactFlowProvider></StrictMode>);
