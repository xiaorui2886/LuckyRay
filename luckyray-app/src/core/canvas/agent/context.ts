import type { CanvasAgentContextNode, CanvasAgentContext } from './types';
import { canvasLibraryDisplayText } from '../libraryPicker';

type Node = {id:string;position?:{x:number;y:number};parentId?:string;style?:{width?:unknown;height?:unknown};data:Record<string,unknown>};
export function agentNodeKind(node:Node):CanvasAgentContextNode['kind'] {
  const d=node.data;
  if(d.kind==='noteRef')return 'note';
  if(d.kind==='group')return 'group';
  if(d.refKind==='video'||d.kind==='video'||d.generationKind==='video'||d.resultKind==='video')return 'video';
  if(d.kind==='image'||(d.kind==='generator'&&!d.generationKind)||d.generationKind==='image'||d.resultKind==='image'||d.refKind==='image')return 'image';
  return 'text';
}
const string=(value:unknown)=>typeof value==='string'?value:'';
/** Stable paging/read identity; includes order, content, geometry and all links. */
export function agentGraphRevision(nodes:readonly Node[],edges:readonly {source:string;target:string;data?:unknown}[]):string {
  const value=JSON.stringify([nodes.map(node=>[node.id,agentNodeRevision(node)]),edges.map(edge=>[edge.source,edge.target,edge.data]).sort()]);
  let h=0xcbf29ce484222325n;for(let i=0;i<value.length;i++)h=BigInt.asUintN(64,(h^BigInt(value.charCodeAt(i)))*0x100000001b3n);
  return h.toString(16).padStart(16,'0');
}
/** Fresh bounded reconciliation, never merge old node content or old edges.
 * Requested IDs win over retained IDs; removed retained nodes are forgotten.
 * Overflow deliberately evicts the oldest retained tail and must be reread.
 */
export function agentContextWorkingSet(nodes:readonly Node[],requestedIds:readonly string[],previousIds:readonly string[]=[]):string[] {
  if(requestedIds.length>256)throw Error('canvas-agent-context-limit');
  const live=new Set(nodes.map(node=>node.id));
  for(const id of requestedIds)if(!live.has(id))throw Error('canvas-agent-context-stale');
  return [...new Set([...requestedIds,...previousIds.filter(id=>live.has(id))])].slice(0,256);
}
export function agentNodeMedia(node:Node):string {
  const d=node.data,first=Array.isArray(d.resultMediaItems)?d.resultMediaItems[0] as {url?:string;thumbnailUrl?:string}|undefined:undefined;
  return agentNodeKind(node)==='video'?string(d.resultThumbnailUrl||d.refThumbnailUrl):string(first?.thumbnailUrl||first?.url||d.resultThumbnailUrl||d.resultMediaUrl||d.refThumbnailUrl||d.refMediaUrl);
}
/** Optimistic content identity, not an authentication/signature mechanism. Excludes view/selection state. */
export function agentNodeRevision(node:Node):string {
  const d=node.data;
  const text=JSON.stringify([node.position,node.parentId,node.style?.width,node.style?.height,d.referencePack,d.storyboard,d.storyboardShot,d.kind,d.label,d.labelIsCustom,d.generationPrompt,d.result,d.refSummary,d.refContextText,d.refUpdatedAt,d.payload,d.refMediaUrl,d.refThumbnailUrl,d.resultMediaUrl,d.resultMediaItems,d.generationKind,d.generationModel,d.generationAspect,d.generationQuality,d.generationResolution,d.generationDuration,d.generationCount,d.generationReferences,d.generationInputOrder,d.generationCinematography,d.generationCreativeRecipe,d.generationSound,d.generationCameraStrength,d.directorDocument,d.directorShotSource]);
  let h=0xcbf29ce484222325n;for(let i=0;i<text.length;i++)h=BigInt.asUintN(64,(h^BigInt(text.charCodeAt(i)))*0x100000001b3n);
  return h.toString(16).padStart(16,'0');
}
export function agentContextNodes(nodes:readonly Node[],ids:readonly string[],textOffset=0):CanvasAgentContextNode[] {
  if(!Number.isSafeInteger(textOffset)||textOffset<0||textOffset>100000000)throw new Error('canvas-agent-context-limit');
  if(ids.length>256)throw new Error('canvas-agent-context-limit');
  const byId=new Map(nodes.map(node=>[node.id,node]));
  return [...new Set(ids)].map(id=>{
    const node=byId.get(id);if(!node)throw new Error('canvas-agent-context-stale');
    const d=node.data,kind=agentNodeKind(node);
    const source=canvasLibraryDisplayText(string(d.generationPrompt||d.refContextText||d.refSummary||d.result||(kind==='text'?d.label:'')));
    let start=Math.min(textOffset,source.length),end=Math.min(start+24000,source.length);
    if(end<source.length&&source.charCodeAt(end-1)>=0xd800&&source.charCodeAt(end-1)<=0xdbff&&source.charCodeAt(end)>=0xdc00&&source.charCodeAt(end)<=0xdfff)end--;
    const text=source.slice(start,end);
    return {id,title:string(d.label).slice(0,160)||kind,kind,text,...(start>0||end<source.length?{textTruncated:true}:{}),textRange:{start,end,total:source.length},editable:['text','generator','image','video','aiPrompt'].includes(string(d.kind)),revision:agentNodeRevision(node),...(node.position&&Number.isFinite(node.position.x)&&Number.isFinite(node.position.y)?{layout:{x:node.position.x,y:node.position.y,...(node.parentId?{parentId:node.parentId}:{})}}:{})};
  });
}
export function validateAgentContextCurrent(context:CanvasAgentContext,nodes:readonly Node[],canvasId:string):void {
  if(context.canvasId!==canvasId)throw new Error('canvas-agent-canvas-changed');
  const byId=new Map(nodes.map(node=>[node.id,node]));
  for(const item of context.nodes){const node=byId.get(item.id);if(!node||agentNodeRevision(node)!==item.revision)throw new Error('canvas-agent-context-stale');}
}

