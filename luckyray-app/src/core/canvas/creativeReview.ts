import type { CanvasGenerationHistoryEntry } from './generationHistory';
import { canConnectCanvasNodes, getCanvasNodeCapabilities, type CanvasNodeCapabilityData } from './nodeCapabilities';
import { resolveCanvasEdgeSemanticData, type CanvasSemanticEdge, type CanvasEdgeSemanticData } from './edgeSemantics';

/** Derived views of existing history/graph. No provider, credential or storage calls. */
export type ReviewImage = { key:string; entry:CanvasGenerationHistoryEntry; index:number; url:string };
export function reviewImages(history:readonly CanvasGenerationHistoryEntry[]):ReviewImage[] {
 return history.flatMap(entry=>entry.kind==='image' && entry.status==='succeeded'
  ? (entry.outputMediaItems?.length ? entry.outputMediaItems : entry.outputMediaUrl ? [{url:entry.outputMediaUrl}] : [])
   .flatMap((item,index)=>typeof item.url==='string' && !!item.url.trim() ? [{key:JSON.stringify([entry.id,index]),entry,index,url:item.url}] : []) : []);
}
export function comparisonParameters(entry:CanvasGenerationHistoryEntry):Array<[string,string]> {
 const request=entry.request;
 // Explicit allowlist: never expose profile IDs, credentials, signed media URLs or raw response JSON.
 return [['prompt',entry.prompt||''],['model',entry.model||''],['aspect',request.aspect||''],
  ['quality',request.quality||''],['resolution',request.resolution||''],['count',String(request.count??1)],
  ['references',String(request.references?.length??0)]];
}
export type ReferencePackKind='character'|'product'|'style';
export type ReferencePackTag={version:1;kind:ReferencePackKind};
export type PackNode={id:string;parentId?:string;data:CanvasNodeCapabilityData & {
 label?:string;payload?:string;refMediaUrl?:string|null;resultMediaUrl?:string|null;
 refThumbnailUrl?:string|null;resultThumbnailUrl?:string|null;refSummary?:string;result?:string;
 referencePack?:ReferencePackTag;generationReferences?:readonly {id:string}[];
}};
export function isReferencePack(node:PackNode):boolean {
 return node.data.kind==='group' && node.data.referencePack?.version===1
  && ['character','product','style'].includes(node.data.referencePack.kind);
}
export function packMembers<T extends PackNode>(nodes:readonly T[],groupId:string):T[] {
 return nodes.filter(node=>node.parentId===groupId);
}
export function usablePackMember(node:PackNode):boolean {
 if(node.data.kind==='group')return false;
 const kind=getCanvasNodeCapabilities(node.data).contentKind;
 if(kind==='image'||kind==='video')return !!(node.data.refMediaUrl||node.data.resultMediaUrl);
 if(kind==='note')return !!node.data.payload;
 return !!(node.data.result||node.data.label)?.trim();
}
export type PackConnection={source:string;target:string;data:CanvasEdgeSemanticData};
export type PackApplyError='missing-pack'|'empty-pack'|'invalid-target'|'missing-content'|'too-many-inputs';
export function planReferencePack(nodes:readonly PackNode[],edges:readonly CanvasSemanticEdge[],groupId:string,targetId:string):
 {ok:true;edges:PackConnection[]}|{ok:false;error:PackApplyError} {
 const group=nodes.find(node=>node.id===groupId), target=nodes.find(node=>node.id===targetId);
 if(!group||!isReferencePack(group))return {ok:false,error:'missing-pack'};
 const members=packMembers(nodes,groupId);
 if(!members.length)return {ok:false,error:'empty-pack'};
 if(!target||target.data.kind!=='generator'||members.some(node=>node.id===target.id))return {ok:false,error:'invalid-target'};
 if(members.some(node=>!usablePackMember(node)||!canConnectCanvasNodes(node.data,target.data)))return {ok:false,error:'missing-content'};
 const incoming=edges.filter(edge=>edge.target===targetId);
 const stored=target.data.generationReferences||[];
 const additions=members.filter(node=>!incoming.some(edge=>edge.source===node.id)
  && !stored.some(ref=>ref.id===`node:${node.id}`||ref.id.startsWith(`node:${node.id}:`)||!!node.data.payload&&(ref.id===node.data.payload||ref.id.startsWith(`asset:${node.data.payload}:`))));
 // Match current composer capacity, atomically: never silently truncate a pack or evict a first/last frame.
 if(incoming.length+stored.length+additions.length>4)return {ok:false,error:'too-many-inputs'};
 const planned:PackConnection[]=[];
 for(const source of additions){
  const semantics=resolveCanvasEdgeSemanticData(source.data,target.data,targetId,[...edges,...planned]);
  // Reference packs carry identity/style context, not an implicit video first/last-frame decision.
  const content=getCanvasNodeCapabilities(source.data).contentKind;
  semantics.role=content==='text'||content==='note'?'promptContext':content==='video'?'videoReference':'reference';
  planned.push({source:source.id,target:targetId,data:semantics});
 }
 return {ok:true,edges:planned};
}
