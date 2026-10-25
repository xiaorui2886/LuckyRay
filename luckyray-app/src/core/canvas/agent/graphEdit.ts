import type {CanvasAgentContext,CanvasAgentGraphOperation} from './types';
export type {CanvasAgentGraphOperation} from './types';
import {validateAgentContextCurrent} from './context';
type GraphNode={id:string;position:{x:number;y:number};parentId?:string;width?:number;height?:number;style?:{width?:unknown;height?:unknown};data:Record<string,unknown>};
type GraphEdge={id:string;source:string;target:string};
const fail=()=>{throw Error('canvas-agent-graph-edit-invalid');};
const coordinate=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=1_000_000;
/** Pure transaction: any failure leaves the input graph untouched. No deletion or media submission. */
export function editCanvasAgentGraph<N extends GraphNode,E extends GraphEdge>(
 context:CanvasAgentContext,nodes:readonly N[],edges:readonly E[],operations:readonly CanvasAgentGraphOperation[],
 options:{canvasId:string;createId:()=>string;makeEdge:(source:N,target:N,id:string,edges:E[],nodes:N[])=>E},
):{nodes:N[];edges:E[];changedIds:string[]} {
 validateAgentContextCurrent(context,nodes,options.canvasId);
 if(!Array.isArray(operations)||!operations.length||operations.length>64)fail();
 const allowed=new Set(context.nodes.map(node=>node.id));
 const signature=(value:readonly {source:string;target:string}[])=>JSON.stringify(value.filter(edge=>allowed.has(edge.source)&&allowed.has(edge.target)).map(edge=>`${edge.source}\u0000${edge.target}`).sort());
 if(signature(context.connections)!==signature(edges))throw Error('canvas-agent-context-stale');
 const nextNodes=nodes.map(node=>({...node,position:{...node.position}} as N));let nextEdges=[...edges];
 const byId=new Map(nextNodes.map(node=>[node.id,node]));const changed=new Set<string>();
 const get=(id:string)=>{const node=byId.get(id);if(!allowed.has(id)||!node)throw Error('canvas-agent-context-stale');return node;};
 const move=(id:string,x:number,y:number)=>{const node=get(id);if(node.parentId||!coordinate(x)||!coordinate(y))fail();node.position={x,y};changed.add(id);};
 const reaches=(from:string,to:string)=>{const todo=[from],seen=new Set<string>();while(todo.length){const id=todo.pop()!;if(id===to)return true;if(seen.has(id))continue;seen.add(id);for(const edge of nextEdges)if(edge.source===id)todo.push(edge.target);}return false;};
 for(const operation of operations){
  if(!operation||typeof operation!=='object')fail();
  if(operation.op==='move'){move(operation.nodeId,operation.x,operation.y);continue;}
  if(operation.op==='connect'||operation.op==='disconnect'){
   const source=get(operation.source),target=get(operation.target);
   if(source.id===target.id)fail();
   if(operation.op==='disconnect')nextEdges=nextEdges.filter(edge=>!(edge.source===source.id&&edge.target===target.id));
   else if(!nextEdges.some(edge=>edge.source===source.id&&edge.target===target.id)){
    if(reaches(target.id,source.id))throw Error('canvas-agent-plan-cycle');
    const id=options.createId();if(nextEdges.some(edge=>edge.id===id))throw Error('canvas-agent-id-collision');
    nextEdges.push(options.makeEdge(source,target,id,nextEdges,nextNodes));
   }
   changed.add(source.id);changed.add(target.id);continue;
  }
  if(operation.op==='arrange'){
   if(!Array.isArray(operation.nodeIds)||!operation.nodeIds.length||operation.nodeIds.length>256||!['grid','horizontal','vertical'].includes(operation.layout))fail();
   const selected=[...new Set(operation.nodeIds)].map(get);
   if(selected.some(node=>node.parentId||!coordinate(node.position.x)||!coordinate(node.position.y)))fail();
   const dimension=(node:N,key:'width'|'height')=>{const value=Number(node[key]??node.style?.[key]);return Number.isFinite(value)&&value>0?Math.min(value,10000):320;};
   const width=Math.max(...selected.map(node=>dimension(node,'width')))+80;
   const height=Math.max(...selected.map(node=>dimension(node,'height')))+80;
   const origin={x:Math.min(...selected.map(node=>node.position.x)),y:Math.min(...selected.map(node=>node.position.y))};
   const columns=operation.layout==='horizontal'?selected.length:operation.layout==='vertical'?1:Math.ceil(Math.sqrt(selected.length));
   selected.forEach((node,index)=>move(node.id,origin.x+(index%columns)*width,origin.y+Math.floor(index/columns)*height));continue;
  }
  fail();
 }
 return {nodes:nextNodes,edges:nextEdges,changedIds:[...changed]};
}
