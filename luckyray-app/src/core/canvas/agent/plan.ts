import type { CanvasAgentContext,CanvasAgentPlan,CanvasAgentPlanStep,CanvasAgentExecutionStep,CanvasAgentMediaSettings } from './types';
const record=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('canvas-agent-plan-invalid');return value as Record<string,unknown>;};
const text=(value:unknown,max:number,empty=false)=>{if(typeof value!=='string'||value.length>max||(!empty&&!value.trim())||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))throw Error('canvas-agent-plan-invalid');return value;};
/** Revalidate across the native boundary. A model cannot choose functions, paths, providers or deletion actions. */
export function validateCanvasAgentPlan(value:unknown,context:CanvasAgentContext,runId?:string|null):CanvasAgentPlan {
  const r=record(value);if(r.version!==1||r.canvasId!==context.canvasId||(runId&&r.runId!==runId)||!Array.isArray(r.steps)||r.steps.length<1||r.steps.length>64)throw Error('canvas-agent-plan-invalid');
  const sources=new Map(context.nodes.map(n=>[n.id,n])),available=new Set(sources.keys()),stepIds=new Set<string>(),targets=new Set<string>();
  const steps=r.steps.map(value=>{
    const raw=record(value),id=text(raw.id,80),kind=raw.kind;
    if(!/^[a-zA-Z0-9_-]+$/.test(id)||available.has(id)||stepIds.has(id)||!['text','image','video'].includes(String(kind)))throw Error('canvas-agent-plan-invalid');
    const title=text(raw.title,160),content=text(raw.content,16000);
    if(!Array.isArray(raw.references)||raw.references.length>256||raw.references.some(ref=>typeof ref!=='string'||!available.has(ref)))throw Error('canvas-agent-plan-invalid');
    const references=[...new Set(raw.references as string[])];let targetNodeId:string|undefined;
    if(raw.targetNodeId!==undefined){targetNodeId=text(raw.targetNodeId,160);const target=sources.get(targetNodeId);if(!target?.editable||targets.has(targetNodeId)||references.includes(targetNodeId)||target.kind!==kind)throw Error('canvas-agent-plan-invalid');targets.add(targetNodeId);}
    let settings:CanvasAgentMediaSettings|undefined;
    if(raw.settings!==undefined){
      const requested=record(raw.settings),options=kind==='image'?context.generation.imageOptions:kind==='video'?context.generation.videoOptions:undefined;
      if(!options||Object.keys(requested).some(key=>!['aspect','resolution','quality','duration'].includes(key)))throw Error('canvas-agent-plan-invalid');
      if(requested.resolution!==undefined&&(!requested.aspect||requested.aspect==='auto'))throw Error('canvas-agent-plan-invalid');
      settings={};for(const [key,values] of [['aspect',options.aspects],['resolution',options.resolutions],['quality',options.qualities],['duration',options.durations]] as const){
        if(requested[key]!==undefined){if(!(values as readonly unknown[]).includes(requested[key]))throw Error('canvas-agent-plan-invalid');Object.assign(settings,{[key]:requested[key]});}
      }
    }
    stepIds.add(id);available.add(id);
    return {id,kind:kind as CanvasAgentPlanStep['kind'],title,content,references,...(targetNodeId?{targetNodeId}:{}),...(settings?{settings}:{})};
  });
  return {version:1,id:text(r.id,160),runId:text(r.runId,160),canvasId:context.canvasId,title:text(r.title,160),summary:text(r.summary,2000,true),steps};
}
export type AgentGraphNode = {id:string;position:{x:number;y:number};data:Record<string,unknown>;[key:string]:unknown};
export type AgentGraphEdge = {id:string;source:string;target:string;[key:string]:unknown};
export function applyCanvasAgentPlan<N extends AgentGraphNode,E extends AgentGraphEdge>(plan:CanvasAgentPlan,nodes:readonly N[],edges:readonly E[],options:{createId:()=>string;origin:{x:number;y:number};makeNode:(step:CanvasAgentPlanStep,id:string,position:{x:number;y:number})=>N;makeEdge:(source:N,target:N,id:string,currentEdges:E[],currentNodes:N[])=>E}):{nodes:N[];edges:E[];steps:CanvasAgentExecutionStep[]} {
  if(nodes.some(n=>(n.data.canvasAgentOrigin as {planId?:string}|undefined)?.planId===plan.id))throw Error('canvas-agent-plan-applied');
  const ids=new Map<string,string>(),existing=new Map(nodes.map(node=>[node.id,node]));
  const allNodes=nodes.map(node=>({...node,selected:false} as N)),allEdges=[...edges],execution:CanvasAgentExecutionStep[]=[];
  const editing=new Set(plan.steps.flatMap(step=>step.targetNodeId?[step.targetNodeId]:[]));
  // Reject graph cycles against real existing edges before any commit, including links into edited nodes.
  const graph=new Map<string,string[]>();for(const edge of edges){graph.set(edge.source,[...(graph.get(edge.source)||[]),edge.target]);}
  const reaches=(from:string,to:string)=>{const todo=[from],seen=new Set<string>();while(todo.length){const id=todo.pop()!;if(id===to)return true;if(seen.has(id))continue;seen.add(id);todo.push(...(graph.get(id)||[]));}return false;};
  for(let index=0;index<plan.steps.length;index++){
    const step=plan.steps[index],id=step.targetNodeId||options.createId();
    if(!step.targetNodeId&&existing.has(id))throw Error('canvas-agent-id-collision');
    const original=step.targetNodeId?existing.get(step.targetNodeId):null;
    if(step.targetNodeId&&!original)throw Error('canvas-agent-context-stale');
    if(original){const task=original.data.generationTask as {status?:string}|undefined;if(task?.status==='running'||task?.status==='queued')throw Error('canvas-agent-node-busy');}
    const fresh=options.makeNode(step,id,{x:options.origin.x+(index%3)*600,y:options.origin.y+Math.floor(index/3)*540});
    const marker={planId:plan.id,stepId:step.id,runId:plan.runId};
    const node=original?{...original,data:{...original.data,...(step.kind==='text'?{label:step.content}:{generationPrompt:step.content,label:step.title,labelIsCustom:true,generationCount:1,...(step.settings?.aspect?{generationAspect:step.settings.aspect}:{}),...(step.settings?.resolution?{generationResolution:step.settings.resolution}:{}),...(step.settings?.quality?{generationQuality:step.settings.quality}:{}),...(step.settings?.duration!==undefined?{generationDuration:step.settings.duration}:{})}),canvasAgentOrigin:marker}} as N:{...fresh,data:{...fresh.data,canvasAgentOrigin:marker}} as N;
    if(original){allNodes[allNodes.findIndex(n=>n.id===id)]=node;}else allNodes.push(node);
    existing.set(id,node);ids.set(step.id,id);
    for(const sourceId of step.references){const source=existing.get(ids.get(sourceId)||sourceId);if(!source)throw Error('canvas-agent-context-stale');if(source.id===id||reaches(id,source.id))throw Error('canvas-agent-plan-cycle');if(allEdges.some(e=>e.source===source.id&&e.target===id))continue;allEdges.push(options.makeEdge(source,node,options.createId(),allEdges,allNodes));graph.set(source.id,[...(graph.get(source.id)||[]),id]);}
    execution.push({id:step.id,nodeId:id,title:step.title,kind:step.kind,status:'draft'});
  }
  // Later edits of sources must not introduce implicit backwards execution dependencies.
  for(let i=0;i<plan.steps.length;i++)for(const reference of plan.steps[i].references){if(editing.has(reference)&&plan.steps.findIndex(s=>s.targetNodeId===reference)>i)throw Error('canvas-agent-plan-cycle');}
  return {nodes:allNodes,edges:allEdges,steps:execution};
}
