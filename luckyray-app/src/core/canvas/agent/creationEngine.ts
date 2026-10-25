import { storyboardAppendY, storyboardBounds } from '../storyboardLayout';
import { isReferencePack, packMembers, planReferencePack, usablePackMember, type PackNode } from '../creativeReview';
import { builtinWorkflows, instantiateWorkflow, type CaptureNode } from '../workflowTemplates';
import { defaultShot, isStoryboard, storyboardShots, validShot, patchStoryboardShot, patchStoryboardPrompt, buildStoryboardPrompt, canBeShot, SHOT_LIMIT, type StoryboardNode } from '../storyboard';
import { parseStoryboardScript } from '../storyboardScript';
import { reusableStoryboardDraft } from '../storyboardImport';
import { duplicateStoryboardData } from '../storyboardDuplicate';
import { storyboardCandidates, adoptStoryboardCandidate, clearStoryboardChoice } from '../storyboardCandidates';
import { buildStoryboardDeliveryPlan } from '../storyboardDelivery';
import { IMAGE_CREATIVE_ACTIONS, CREATIVE_RECIPE_OPTION_CHOICES, normalizeCreativeRecipe } from '../imageCreativeActions';
import { CINEMATOGRAPHY_OPTIONS, normalizeCinematographySettings } from '../cinematography';
import { normalizeCanvasNodeCapabilityData, getCanvasNodeContentKind } from '../nodeCapabilities';
import { canvasNodeSize, attachCanvasNodesToGroup } from '../canvasArrangement';
import { buildHistoryDraft, historyHasResult } from '../generationIteration';
import type { CanvasGenerationHistoryEntry } from '../generationHistory';
import { createCanvasReferencePlan, duplicatesConnectedReference, referenceSourceId, type ReferenceValue } from '../referencePlan';
import { resolvePinnedFocusReference } from '../focusReference';
import { normalizeCanvasEdgeSemantics, type CanvasEdgeSemanticData } from '../edgeSemantics';
import { validateCreationRead, validateCreationEdit, validateCreationResult } from './creationContract';
import type { CreationReadQuery, CreationReadResult, CreationItem, CreationEditRequest, CreationShotFields } from './creationTypes';

export type CreationNode = CaptureNode & StoryboardNode & PackNode & { type?: string; extent?: 'parent'; selected?: boolean; dragHandle?: string };
export type CreationEdge = { id: string; source: string; target: string; data?: CanvasEdgeSemanticData | null; [key: string]: unknown };
export type CreationState<N extends CreationNode=CreationNode,E extends CreationEdge=CreationEdge> = { canvasId: string; nodes: readonly N[]; edges: readonly E[]; history: readonly CanvasGenerationHistoryEntry[]; noteReferenceIncludeTitle?:boolean };
export type CreationPorts = { createId:()=>string; origin:{x:number;y:number}; english?:boolean; now?:()=>string; noteReferenceIncludeTitle?:boolean };
function fail(code='invalid'): never {throw Error(`canvas-agent-creation-${code}`);}
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
const name=(value:unknown)=>{if(typeof value!=='string'||!value.trim()||value.trim().length>60)fail();return (value as string).trim();};
const unique=(values:readonly string[])=>{if(!Array.isArray(values)||new Set(values).size!==values.length||values.some(v=>!id(v))||values.length>256)fail();return [...values];};
const str=(v:unknown,max=4000)=>typeof v==='string'?v.slice(0,max):'';
const hash=(text:string)=>{let h=0xcbf29ce484222325n;for(let i=0;i<text.length;i++)h=BigInt.asUintN(64,(h^BigInt(text.charCodeAt(i)))*0x100000001b3n);return h.toString(16).padStart(16,'0');};
/** Opaque optimistic identity. Raw private media addresses never leave this module. */
export function creationRevision(state:CreationState):string {
 const dataKeys=['kind','label','labelIsCustom','payload','refKind','refMediaUrl','refThumbnailUrl','refSummary','refContextText','refUpdatedAt','result','resultKind','resultMediaUrl','resultThumbnailUrl','resultMediaItems','generationKind','generationPrompt','generationModel','generationAspect','generationQuality','generationResolution','generationDuration','generationCount','generationSound','generationCameraStrength','generationReferences','generationInputOrder','generationCinematography','generationCreativeRecipe','generationTask','sourceGenerationTaskId','sourceGenerationHistoryId','sourceGenerationMediaUrl','referencePack','storyboard','storyboardShot','groupMemberCount'];
 return hash(JSON.stringify([state.canvasId,state.noteReferenceIncludeTitle===true,state.nodes.map(n=>[n.id,n.position,n.parentId,n.style?.width,n.style?.height,dataKeys.map(k=>n.data[k])]),state.edges.map(e=>[e.id,e.source,e.target,e.data]),state.history]));
}
const TEMPLATE_IDS=['builtin-0','builtin-1','builtin-2','builtin-3'];
const fields=(values:Record<string,unknown>)=>Object.entries(values).filter(([,v])=>v!==undefined).map(([name,value])=>({name,value:str(typeof value==='string'?value:JSON.stringify(value))}));
const item=(id:string,kind:string,title:string,description='',extra:Partial<CreationItem>={}):CreationItem=>({id,kind,title:str(title,160),description:str(description),...extra});
/** Preserve original UTF-16 text exactly without splitting a valid surrogate pair. */
const scriptChunks=(text:string):string[]=>{
 const chunks:string[]=[];
 for(let start=0;start<text.length;){let end=Math.min(start+4000,text.length);if(end<text.length&&text.charCodeAt(end-1)>=0xd800&&text.charCodeAt(end-1)<=0xdbff&&text.charCodeAt(end)>=0xdc00&&text.charCodeAt(end)<=0xdfff)end--;chunks.push(text.slice(start,end));start=end;}
 return chunks;
};
const historyMedia=(e:CanvasGenerationHistoryEntry)=>e.outputMediaItems?.length?e.outputMediaItems:e.outputMediaUrl?[{url:e.outputMediaUrl,thumbnailUrl:e.outputThumbnailUrl}]:[];
/** Bounded safe projection; disclose overflow instead of emitting truncated JSON. */
const incomingReferenceFields=(state:CreationState,node:CreationNode)=>{
 const incoming=normalizeCanvasEdgeSemantics(state.nodes,state.edges).filter(e=>e.target===node.id&&e.data?.relation!=='derivation');
 const projected: {sourceId:string;targetId:string;role:string;order:number}[]=[];
 for(const edge of incoming){
  if(!id(edge.source)||!id(edge.target))continue;
  const entry={sourceId:edge.source,targetId:edge.target,role:edge.data.role!,order:Number.isFinite(edge.data.order)?edge.data.order!:0};
  if(JSON.stringify([...projected,entry]).length>4000)break;
  projected.push(entry);
 }
 return fields({incomingReferences:projected,incomingReferenceCount:incoming.length,incomingReferencesReturned:projected.length,incomingReferencesTruncated:projected.length!==incoming.length,storedReferenceCount:Array.isArray(node.data.generationReferences)?node.data.generationReferences.length:0,referenceSlotPolicy:'reference.order reorders connected sources only and preserves stored attachment slots. reference.role may remove a mirrored connected snapshot, but must not silently replace independent stored attachments. Truncated projections are not complete verification.'});
};
/** Runtime-derived discovery, not a claim that a task has been completed.
 * Keep this inside the existing result contract: no extra authority or tool schema. */
function specialistOverview(state:CreationState):CreationItem[] {
 const boards=state.nodes.filter(isStoryboard),packs=state.nodes.filter(isReferencePack);
 const generators=state.nodes.filter(n=>n.data.kind==='generator');
 const selected=state.nodes.filter(n=>n.selected&&id(n.id));
 const selectedBoards=boards.filter(b=>id(b.id)&&selected.some(n=>n.id===b.id||n.parentId===b.id));
 const selection={selectedNodeIds:selected.slice(0,16).map(n=>n.id),selectedNodeCount:selected.length,selectionTruncated:selected.length>16,selectionMeaning:'Current UI selection is reference data, not permission. Resolve ambiguous targets; never assume all nodes are selected.'};
 const capability=(scope:string,title:string,description:string,details:Record<string,unknown>)=>item(scope,'capability',title,description,{fields:fields({...selection,...details})});
 return [
  capability('referencePacks','参考包','创建、修改成员、重命名、取消标记、应用到生成节点',{count:packs.length,readScope:'referencePacks',operations:['referencePack.create','referencePack.update','referencePack.apply','referencePack.unmark'],workflow:'Read chosen sources, create or reuse a character/product/style pack, apply to the intended generator, then verify member IDs and incoming references. Do not claim visual identity was verified from metadata alone.'}),
  capability('templates','创作模板','读取和实例化内置模板；文件导入导出需用户选择',{count:builtinWorkflows().length,readScope:'templates',operations:['template.instantiate'],workflow:'Read the available template IDs, instantiate a matching workflow only when useful, then adapt its real nodes. A template is a draft, not generated media.'}),
  capability('storyboards','脚本与分镜','创建、导入脚本、镜头编辑排序、候选采纳及交付检查',{count:boards.length,shotCount:boards.reduce((n,b)=>n+storyboardShots(state.nodes,b.id).length,0),selectedBoardIds:selectedBoards.slice(0,16).map(b=>b.id),selectedBoardCount:selectedBoards.length,readScope:'storyboards',detailScope:'shots',detailQuery:'{scope: shots, objectId: boardId}; use the current revision for continuation pages and edits',operations:['storyboard.create','storyboard.importScript','shot.add','shot.update','shot.reorder','shot.adopt'],workflow:'For an editable storyboard deliver a native storyboard and native shots, not a Markdown table in a text node. Reuse the intended existing board; read shots before edits. After creating a board inspect its initial draft shot and reuse/update it rather than adding an accidental empty first shot. Set meaningful fields, then read shots at the fresh revision and check requested content/count/order/duration. Text notes may supplement but never substitute the native board.',verification:'count and shotCount are native structures, independent of text-node titles or claims. Missing target: refresh storyboards/selection; do not invent IDs or silently create a duplicate.'}),
  capability('review','版本评审','读取结果元数据、标记偏好、恢复结果、继续创作草稿；不代表视觉已评审',{readScope:'review',operations:['review.prefer','review.restore','review.continue'],workflow:'Inspect actual candidates, distinguish metadata from viewed image evidence, apply the chosen candidate and read back. Text describing an image is not proof of visual quality.'}),
  capability('directions','创作配方与摄影','修改已有生成卡的配方、摄影和运镜；不自动提交生成',{count:generators.length,readScope:'directions',operations:['generator.recipe','generator.cinematography','reference.role','reference.order'],workflow:'Read advertised recipe/options and target generator references. Set supported composition/camera/reference roles on the real generator. Read back the intended changes. Generation is separate and still requires the current run permission and budget.'}),
  capability('delivery','导出与图像工具','检查交付就绪；导出路径和像素编辑需明确用户交互，不算已完成',{readScope:'delivery',workflow:'Verify real storyboard readiness, missing candidates and total duration. Open the required handoff only when ready. awaiting-user is not an exported file; applied-unconfirmed is not saved success.'}),
 ];
}
/** Bounded projections expose identifiers and editable creative content, never local paths or media URLs. */
export function readCreation(state:CreationState,query:CreationReadQuery):CreationReadResult {
 query=validateCreationRead(query);
 const revision=creationRevision(state);
 if(query.expectedRevision&&query.expectedRevision!==revision)throw Error('canvas-agent-context-stale');
 const offset=query.offset??0;if(!Number.isSafeInteger(offset)||offset<0)fail();
 if(offset>0&&!query.expectedRevision)throw Error('canvas-agent-context-stale');
 let items:CreationItem[]=[];
 const {nodes,history}=state;
 if(query.scope==='overview') items=specialistOverview(state);
 else if(query.scope==='referencePacks') items=nodes.filter(isReferencePack).filter(n=>!query.objectId||n.id===query.objectId).map(n=>item(n.id,'referencePack',str(n.data.label),n.data.referencePack!.kind,{memberIds:packMembers(nodes,n.id).slice(0,256).map(m=>m.id),fields:fields({memberCount:packMembers(nodes,n.id).length,packKind:n.data.referencePack!.kind,usable:packMembers(nodes,n.id).every(usablePackMember)})}));
 else if(query.scope==='templates') items=builtinWorkflows().map((t,i)=>item(TEMPLATE_IDS[i],'template',t.name,t.description,{fields:fields({nodes:t.nodes.length,edges:t.edges.length,mediaPlaceholders:t.nodes.filter(n=>n.kind==='image'||n.kind==='video').length})})).filter(n=>!query.objectId||n.id===query.objectId);
 else if(query.scope==='storyboards') items=nodes.filter(isStoryboard).filter(n=>!query.objectId||n.id===query.objectId).map(n=>item(n.id,'storyboard',str(n.data.label),'',{memberIds:storyboardShots(nodes,n.id).slice(0,256).map(s=>s.id),fields:fields({shotCount:storyboardShots(nodes,n.id).length,sourceScript:n.data.storyboard?.sourceScript,sourceScriptTruncated:(n.data.storyboard?.sourceScript?.length??0)>4000})}));
 else if(query.scope==='scriptText') {
  const board=nodes.find(n=>n.id===query.objectId&&isStoryboard(n));if(!board)fail('missing-board');
  items=scriptChunks(board.data.storyboard?.sourceScript??'').map((text,index)=>item(`script-${hash(`${revision}:${board.id}:${index}`)}`,'scriptChunk',`Script part ${index+1}`,'',{fields:fields({text})}));
 }
 else if(query.scope==='shots') {
  const board=nodes.find(n=>n.id===query.objectId&&isStoryboard(n));if(!board)fail('missing-board');
  items=storyboardShots(nodes,board.id).map(n=>{
   const s=n.data.storyboardShot!,c=storyboardCandidates(nodes,history,board.id,n.id);
   return item(n.id,'shot',s.title||str(n.data.label),'',{fields:fields({order:s.order,title:s.title,description:s.description,action:s.action,dialogue:s.dialogue,lighting:s.lighting,sound:s.sound,cameraMovement:s.cameraMovement,framing:s.framing,durationSeconds:s.durationSeconds,prompt:n.data.generationPrompt,chosen:!!s.chosenResult,active:c.activeTaskIds.length,candidates:c.candidates.map((v,index)=>({index,kind:v.kind,source:v.source,selectable:v.selectable,taskId:v.taskId,historyId:v.historyId}))})});
  });
 }
 else if(query.scope==='review') items=history.filter(h=>(state.noteReferenceIncludeTitle||!h.request.references.some(r=>r.kind==='note'&&r.label!=='笔记正文'))&&(!query.objectId||h.id===query.objectId)).map(h=>item(h.id,'result',`${h.kind} · ${h.model}`,h.prompt,{memberIds:[h.sourceNodeId,h.resultNodeId].filter((v,i,a)=>id(v)&&a.indexOf(v)===i),fields:fields({status:h.status,model:h.model,aspect:h.aspect,quality:h.quality,resolution:h.resolution,duration:h.duration,mediaCount:historyMedia(h).length,preferredImageIndexes:h.preferredImageIndexes||[],outputText:h.kind==='text'?h.outputText:undefined})}));
 else if(query.scope==='directions') {
  if(query.objectId){const n=nodes.find(n=>n.id===query.objectId);if(!n||n.data.kind!=='generator')fail('missing-generator');items=[item(n.id,'generator',str(n.data.label),'',{fields:[...fields({recipe:normalizeCreativeRecipe(n.data.generationCreativeRecipe),cinematography:normalizeCinematographySettings(n.data.generationCinematography),prompt:n.data.generationPrompt}),...incomingReferenceFields(state,n)]})];}
  else items=[...IMAGE_CREATIVE_ACTIONS.map(a=>item(a.id,'recipe',a.label,a.description,{fields:fields({requiresImage:a.requiresImage,defaults:a.defaults,options:Object.fromEntries(a.options.map(k=>[k,CREATIVE_RECIPE_OPTION_CHOICES[k]]))})})),...Object.entries(CINEMATOGRAPHY_OPTIONS).map(([key,v])=>item(key,'cinematography',key,'',{fields:fields({options:v})}))];
 }
 else if(query.scope==='delivery') {
  const boards=nodes.filter(isStoryboard).filter(n=>!query.objectId||n.id===query.objectId);
  items=boards.map(n=>{const p=buildStoryboardDeliveryPlan(nodes,n.id);return item(n.id,'delivery',p.title,'Metadata readiness only; media bytes have not been read or exported.',{fields:fields({shots:p.shots.length,totalDurationSeconds:p.totalDurationSeconds,canExport:p.canExport,unconfirmedShotIds:p.unconfirmedShotIds,unreadyShotIds:p.unreadyShotIds,overflow:p.overflow})});});
 } else fail();
 if(query.objectId&&items.length===0&&query.scope!=='review'&&query.scope!=='scriptText')fail('missing-object');
 const page:CreationItem[]=[];let bytes=0;
 for(const candidate of items.slice(offset,offset+32)){const size=new TextEncoder().encode(JSON.stringify(candidate)).length;if(bytes+size>120*1024)break;page.push(candidate);bytes+=size;}
 const nextOffset=offset+page.length<items.length?offset+page.length:undefined;
 return validateCreationResult({version:1,revision,scope:query.scope,offset,total:items.length,...(nextOffset!==undefined?{nextOffset}:{}),items:page,completion:'read',notice:query.scope==='scriptText'?'Exact script chunks in source order; concatenate fields.text without separators. offset and total count chunks. Use expectedRevision when paging.': 'Fields are capped at 4000 characters; pages at 32 items / 120 KiB. No media bytes or private URLs are included. Use expectedRevision when paging.'});
}

/** One validated operation produces a new graph. Caller commits it once with undo and persistence. */
export function applyCreation<N extends CreationNode,E extends CreationEdge>(state:CreationState<N,E>,request:CreationEditRequest,ports:CreationPorts):{nodes:N[];edges:E[];history:CanvasGenerationHistoryEntry[];affectedIds:string[];summary:string} {
 request=validateCreationEdit(request);
 if(!/^[a-f0-9]{16}$/.test(request.expectedRevision)||request.expectedRevision!==creationRevision(state))throw Error('canvas-agent-context-stale');
 if(!ports.origin||![ports.origin.x,ports.origin.y].every(v=>Number.isFinite(v)&&Math.abs(v)<=1e6))fail();
 let nodes=state.nodes.map(n=>({...n,position:{...n.position},data:{...n.data}} as N)),edges=state.edges.map(e=>({...e,data:e.data?{...e.data}:e.data} as E)),history=[...state.history];
 const changed=new Set<string>(),used=new Set([...nodes.map(n=>n.id),...edges.map(e=>e.id)]);
 const allocate=()=>{const v=ports.createId();if(!id(v)||used.has(v))fail('id-collision');used.add(v);return v;};
 const get=(nodeId:string)=>{const n=nodes.find(n=>n.id===nodeId);if(!n)fail('missing-node');return n!;};
 const busy=(n:N)=>{if(['queued','running'].includes(n.data.generationTask?.status||''))throw Error('canvas-agent-node-busy');};
 const touch=(nodeId:string,patch:Partial<CreationNode['data']>)=>{const n=get(nodeId);busy(n);nodes=nodes.map(v=>v.id===nodeId?{...v,data:{...v.data,...patch}}:v);changed.add(nodeId);};
 const board=(v:string)=>{const n=get(v);if(!isStoryboard(n))fail('missing-board');return n;};
 const shot=(b:string,s:string)=>{board(b);const n=storyboardShots(nodes,b).find(n=>n.id===s);if(!n)fail('missing-shot');busy(n!);return n!;};
 const selected=(ids:readonly string[])=>unique(ids).map(get);
 const absolute=(n:N)=>{let x=n.position.x,y=n.position.y,parent=n.parentId;const seen=new Set([n.id]);while(parent){if(seen.has(parent))fail('group-cycle');seen.add(parent);const p=get(parent);x+=p.position.x;y+=p.position.y;parent=p.parentId;}return {x,y};};
 const reaches=(from:string,to:string)=>{const pending=[from],seen=new Set<string>();while(pending.length){const current=pending.pop()!;if(current===to)return true;if(seen.has(current))continue;seen.add(current);edges.filter(e=>e.source===current&&e.data?.relation!=='derivation').forEach(e=>pending.push(e.target));}return false;};
 const addGroup=(label:string,members:N[],tag:Partial<CreationNode['data']>)=>{
  if(members.some(n=>n.parentId||n.data.kind==='group'))fail('invalid-members');members.forEach(busy);
  const gid=allocate(),x=members.length?Math.min(...members.map(n=>n.position.x))-42:ports.origin.x,y=members.length?Math.min(...members.map(n=>n.position.y))-58:ports.origin.y;
  const width=members.length?Math.max(540,...members.map(n=>n.position.x+canvasNodeSize(n).width-x+42)):540;
  const height=members.length?Math.max(700,...members.map(n=>n.position.y+canvasNodeSize(n).height-y+202)):700;
  const g={id:gid,type:'group',position:{x,y},style:{width,height},dragHandle:'.canvas-group-drag-handle',data:normalizeCanvasNodeCapabilityData({kind:'group',label,...tag,groupMemberCount:members.length})} as unknown as N;
  nodes=attachCanvasNodesToGroup(nodes,{id:gid,label,position:{x,y},width,height,memberIds:members.map(n=>n.id)},g);changed.add(gid);members.forEach(n=>changed.add(n.id));return g;
 };
 const fitBoard=(bid:string)=>{const b=board(bid),members=nodes.filter(n=>n.parentId===bid);const bounds=storyboardBounds(members);const width=Math.max(bounds.width,canvasNodeSize(b).width);const height=Math.max(bounds.height,canvasNodeSize(b).height);nodes=nodes.map(n=>n.id===bid?{...n,style:{...n.style,width,height},data:{...n.data,groupMemberCount:members.length}}:n);changed.add(bid);};
 const newShot=(bid:string,kind:'image'|'video',input:CreationShotFields,order?:number)=>{
  board(bid);const shots=storyboardShots(nodes,bid);if(shots.length>=SHOT_LIMIT)fail('shot-limit');
  const meta={...defaultShot(order??(shots.length?Math.max(...shots.map(n=>n.data.storyboardShot!.order))+1:0)),...input};if(!validShot(meta))fail('invalid-shot');
  const y=storyboardAppendY(nodes.filter(n=>n.parentId===bid));
  const n={id:allocate(),type:'spike',dragHandle:'.canvas-node-drag-handle',parentId:bid,extent:'parent',position:{x:42,y},data:normalizeCanvasNodeCapabilityData({kind:'generator',label:meta.title||(ports.english?`Shot ${shots.length+1}`:`镜头 ${shots.length+1}`),generationKind:kind,generationAspect:'16:9',storyboardShot:meta,generationPrompt:buildStoryboardPrompt({id:'draft',data:{kind:'generator',generationKind:kind,storyboardShot:meta}},ports.english)})} as unknown as N;
  nodes.push(n);changed.add(n.id);fitBoard(bid);return n;
 };
 const op=request.operation;
 switch(op.op){
 case 'referencePack.create':{
  const label=name(op.name),members=selected(op.nodeIds);if(!['character','product','style'].includes(op.packKind)||!members.length)fail();
  if(members.length===1&&members[0].data.kind==='group'){
   const g=members[0];if(isStoryboard(g)||!packMembers(nodes,g.id).length||!packMembers(nodes,g.id).every(usablePackMember))fail('invalid-members');touch(g.id,{label,referencePack:{version:1,kind:op.packKind}});
  }else{if(!members.every(usablePackMember))fail('missing-content');addGroup(label,members,{referencePack:{version:1,kind:op.packKind}});}
  break;
 }
 case 'referencePack.update':{
  const g=get(op.packId);if(!isReferencePack(g))fail('missing-pack');busy(g);
  if(op.name!==undefined)touch(g.id,{label:name(op.name)});
  if(op.packKind!==undefined){if(!['character','product','style'].includes(op.packKind))fail();touch(g.id,{referencePack:{version:1,kind:op.packKind}});}
  if(op.nodeIds!==undefined){
   const members=selected(op.nodeIds);if(!members.length||members.some(n=>n.data.kind==='group'||(n.parentId&&n.parentId!==g.id)||!usablePackMember(n)))fail('invalid-members');members.forEach(busy);
   const memberIds=new Set(members.map(n=>n.id)),groupPosition=absolute(g);
   nodes=nodes.map(n=>{if(n.parentId===g.id&&!memberIds.has(n.id)){busy(n);changed.add(n.id);const {parentId,extent,...rest}=n;return {...rest,position:{x:groupPosition.x+n.position.x,y:groupPosition.y+n.position.y}} as N;}
    if(memberIds.has(n.id)&&!n.parentId){changed.add(n.id);return {...n,parentId:g.id,extent:'parent',position:{x:n.position.x-groupPosition.x,y:n.position.y-groupPosition.y}};}
    return n;});
   const children=nodes.filter(n=>n.parentId===g.id);children.forEach(n=>changed.add(n.id));if(children.some(n=>n.position.x<0||n.position.y<0)){
    const dx=Math.min(0,...children.map(n=>n.position.x-42)),dy=Math.min(0,...children.map(n=>n.position.y-58));
    nodes=nodes.map(n=>n.id===g.id?{...n,position:{x:n.position.x+dx,y:n.position.y+dy}}:n.parentId===g.id?{...n,position:{x:n.position.x-dx,y:n.position.y-dy}}:n);
   }
   const current=get(g.id),newMembers=nodes.filter(n=>n.parentId===g.id);
   nodes=nodes.map(n=>n.id===g.id?{...n,style:{...n.style,width:Math.max(canvasNodeSize(current).width,...newMembers.map(v=>v.position.x+canvasNodeSize(v).width+42)),height:Math.max(canvasNodeSize(current).height,...newMembers.map(v=>v.position.y+canvasNodeSize(v).height+58))},data:{...n.data,groupMemberCount:newMembers.length}}:n);changed.add(g.id);
  }
  break;
 }
 case 'referencePack.unmark':{const n=get(op.packId);if(!isReferencePack(n))fail('missing-pack');touch(n.id,{referencePack:undefined});break;}
 case 'referencePack.apply':{
  busy(get(op.targetId));const plan=planReferencePack(nodes,edges,op.packId,op.targetId);if(!plan.ok)fail(plan.error);
  if(plan.edges.some(e=>reaches(e.target,e.source)))fail('reference-cycle');
  edges.push(...plan.edges.map(e=>({...e,id:allocate(),animated:false} as unknown as E)));changed.add(op.targetId);break;
 }
 case 'template.instantiate':{
  const index=TEMPLATE_IDS.indexOf(op.templateId);if(index<0)fail('missing-template');
  const draft=instantiateWorkflow(builtinWorkflows(ports.english)[index],ports.origin,allocate,[...nodes.map(n=>n.id),...edges.map(e=>e.id)]);
  nodes.push(...draft.nodes as N[]);edges.push(...draft.edges as unknown as E[]);draft.nodes.forEach(n=>changed.add(n.id));break;
 }
 case 'storyboard.create':{
  const label=name(op.name),members=selected(op.nodeIds||[]);if(members.length>SHOT_LIMIT)fail('shot-limit');
  let g:N;
  if(members.length===1&&members[0].data.kind==='group'){
   g=members[0];const children=nodes.filter(n=>n.parentId===g.id);if(isStoryboard(g)||isReferencePack(g)||!children.length||children.length>SHOT_LIMIT||children.some(n=>!canBeShot(n)||(n.data.storyboardShot&&!validShot(n.data.storyboardShot))))fail('invalid-members');children.forEach(busy);touch(g.id,{label,storyboard:{version:1},groupMemberCount:children.length});children.forEach((n,index)=>touch(n.id,{storyboardShot:{...defaultShot(index),...(validShot(n.data.storyboardShot)?n.data.storyboardShot:{}),order:index}}));fitBoard(g.id);
  }else{
   if(members.some(n=>!canBeShot(n)))fail('invalid-members');g=addGroup(label,members,{storyboard:{version:1}});members.forEach((n,index)=>touch(n.id,{storyboardShot:{...defaultShot(index),...(validShot(n.data.storyboardShot)?n.data.storyboardShot:{}),order:index}}));if(!members.length){newShot(g.id,'image',{});const bounds=storyboardBounds(nodes.filter(n=>n.parentId===g.id));nodes=nodes.map(n=>n.id===g.id?{...n,style:{...n.style,...bounds}}:n);}
  }break;
 }
 case 'storyboard.rename':{board(op.boardId);touch(op.boardId,{label:name(op.name)});break;}
 case 'storyboard.unmark':{board(op.boardId);touch(op.boardId,{storyboard:undefined});break;}
 case 'storyboard.importScript':{
  board(op.boardId);const reuse=reusableStoryboardDraft(nodes,edges,op.boardId),existing=storyboardShots(nodes,op.boardId);
  const parsed=parseStoryboardScript(op.sourceText,SHOT_LIMIT-existing.length+(reuse?1:0));
  parsed.shots.forEach((s,index)=>{if(index===0&&reuse){shot(op.boardId,reuse);const meta={...defaultShot(0),...s};touch(reuse,{storyboardShot:meta,generationPrompt:buildStoryboardPrompt({id:reuse,data:{kind:'generator',generationKind:'image',storyboardShot:meta}},ports.english)});}else newShot(op.boardId,'image',s);});
  const b=board(op.boardId);touch(b.id,{storyboard:{...b.data.storyboard!,sourceScript:op.sourceText}});fitBoard(op.boardId);break;
 }
 case 'shot.add':{if(!['image','video'].includes(op.kind))fail();newShot(op.boardId,op.kind,op.fields);break;}
 case 'shot.update':{shot(op.boardId,op.shotId);nodes=patchStoryboardShot(nodes,op.boardId,op.shotId,op.fields);if(op.prompt!==undefined)nodes=patchStoryboardPrompt(nodes,op.boardId,op.shotId,op.prompt);changed.add(op.shotId);fitBoard(op.boardId);break;}
 case 'shot.duplicate':{
  const original=shot(op.boardId,op.shotId),shots=storyboardShots(nodes,op.boardId);if(shots.length>=SHOT_LIMIT)fail('shot-limit');
  const incoming=edges.filter(e=>e.target===original.id&&e.source!==original.id&&e.data?.relation!=='derivation');
  const mapping=new Map(incoming.map(e=>[e.id,allocate()])),index=shots.findIndex(n=>n.id===original.id)+1,nid=allocate();
  shots.forEach((n,i)=>touch(n.id,{storyboardShot:{...n.data.storyboardShot!,order:i<index?i:i+1}}));
  const y=storyboardAppendY(nodes.filter(n=>n.parentId===op.boardId));
  const duplicate={...original,id:nid,selected:false,position:{x:42,y},data:duplicateStoryboardData(original.data,index,mapping)};
  nodes.push(duplicate);edges.push(...incoming.map(e=>({...e,id:mapping.get(e.id)!,target:nid,selected:false})));changed.add(nid);fitBoard(op.boardId);break;
 }
 case 'shot.detach':{
  const n=shot(op.boardId,op.shotId),b=board(op.boardId),position=absolute(b);nodes=nodes.map(v=>{if(v.id!==n.id)return v;const {parentId,extent,...rest}=v;return {...rest,position:{x:position.x+v.position.x,y:position.y+v.position.y}} as N;});changed.add(n.id);fitBoard(b.id);break;
 }
 case 'shot.reorder':{
  const shots=storyboardShots(nodes,op.boardId),ids=unique(op.shotIds);board(op.boardId);if(ids.length!==shots.length||ids.some(i=>!shots.some(n=>n.id===i)))fail('invalid-order');shots.forEach(busy);ids.forEach((nid,index)=>touch(nid,{storyboardShot:{...get(nid).data.storyboardShot!,order:index}}));break;
 }
 case 'shot.adopt':{
  shot(op.boardId,op.shotId);const candidate=storyboardCandidates(nodes,history,op.boardId,op.shotId).candidates[op.candidateIndex];if(!Number.isInteger(op.candidateIndex)||op.candidateIndex<0||!candidate?.selectable)fail('invalid-candidate');
  nodes=adoptStoryboardCandidate(nodes,history,op.boardId,op.shotId,candidate.key,ports.now?.()||new Date().toISOString());changed.add(op.shotId);break;
 }
 case 'shot.clearChoice':{shot(op.boardId,op.shotId);nodes=clearStoryboardChoice(nodes,op.boardId,op.shotId);changed.add(op.shotId);break;}
 case 'generator.recipe':{
  const n=get(op.nodeId);if(n.data.kind!=='generator'||getCanvasNodeContentKind(n.data)!=='image')fail('invalid-generator');const recipe=op.recipe===null?undefined:normalizeCreativeRecipe(op.recipe);if(op.recipe!==null&&!recipe)fail('invalid-recipe');touch(n.id,{generationCreativeRecipe:recipe||undefined});break;
 }
 case 'generator.cinematography':{
  const n=get(op.nodeId);if(n.data.kind!=='generator')fail('invalid-generator');const normalized=normalizeCinematographySettings(op.settings);
  if(Object.keys(op.settings).some(k=>!(k in normalized))||Object.entries(op.settings).some(([k,v])=>(normalized as unknown as Record<string,unknown>)[k]!==v)||op.settings.version!==1)fail('invalid-directions');touch(n.id,{generationCinematography:normalized});break;
 }
 case 'reference.role':{
  const from=get(op.sourceId),to=get(op.targetId);if(to.data.kind!=='generator')fail('invalid-target');busy(to);const e=edges.find(e=>e.source===from.id&&e.target===to.id&&e.data?.relation!=='derivation');if(!e)fail('missing-reference');
  const kind=getCanvasNodeContentKind(from.data),role=op.role;
  if(!['generic','reference','promptContext','firstFrame','lastFrame','videoReference'].includes(role))fail();
  if((role==='firstFrame'||role==='lastFrame')&&(kind!=='image'||to.data.generationKind!=='video'))fail('invalid-reference-role');
  if(role==='promptContext'&&!['text','note'].includes(kind))fail('invalid-reference-role');
  if(role==='videoReference'&&kind!=='video')fail('invalid-reference-role');
  const baseReference=(n:N):ReferenceValue=>({id:n.data.payload||`node:${n.id}`,sourceNodeId:n.id,label:n.data.label||'',kind:getCanvasNodeContentKind(n.data),mediaUrl:n.data.refMediaUrl||n.data.resultMediaUrl});
  const connected=edges.filter(v=>v.target===to.id&&v.data?.relation!=='derivation').map(v=>{const source=get(v.source);return {edgeId:v.id,sourceNodeId:v.source,role:v.data?.role||'generic' as const,reference:resolvePinnedFocusReference(source,baseReference(source),v.data?.referenceMediaUrl)};});
  const stored=(Array.isArray(to.data.generationReferences)?to.data.generationReferences:[]) as ReferenceValue[];
  const resolved=stored.map(r=>{const sourceId=referenceSourceId(r),source=sourceId?nodes.find(n=>n.id===sourceId):undefined;return source?{...baseReference(source),id:r.id,mentionKey:r.mentionKey,role:r.role}:r;});
  if((role==='firstFrame'||role==='lastFrame')&&createCanvasReferencePlan(to.data.generationKind||'image',connected,resolved).some(v=>v.edgeId!==e.id&&v.role===role))fail('duplicate-frame');
  const oldInput=connected.find(v=>v.edgeId===e.id)!;
  if(Array.isArray(to.data.generationReferences))touch(to.id,{generationReferences:stored.filter(r=>!duplicatesConnectedReference(r,oldInput))});
  edges=edges.map(v=>v.id===e.id?{...v,data:{...v.data,semanticsVersion:1,role}} as E:v);changed.add(to.id);break;
 }
 case 'reference.order':{
  const target=get(op.targetId);busy(target);const incoming=edges.filter(e=>e.target===target.id&&e.data?.relation!=='derivation');const ids=unique(op.sourceIds);
  const oldOrder=Array.isArray(target.data.generationInputOrder)?target.data.generationInputOrder.filter((v):v is string=>typeof v==='string'):[];
  if(ids.length!==incoming.length||ids.some(i=>!incoming.some(e=>e.source===i)))fail('invalid-order');
  const orderedIds=ids.map(i=>incoming.find(e=>e.source===i)!.id);let slot=0;const order=oldOrder.map(key=>incoming.some(e=>e.id===key)?orderedIds[slot++]:key);order.push(...orderedIds.slice(slot));
  edges=edges.map(e=>e.target===target.id&&e.data?.relation!=='derivation'?{...e,data:{...e.data,semanticsVersion:1,order:ids.indexOf(e.source)}} as E:e);touch(target.id,{generationInputOrder:order});break;
 }
 case 'review.prefer':{
  const entry=history.find(h=>h.id===op.historyId);if(!entry||entry.kind!=='image'||!historyHasResult(entry)||!Number.isInteger(op.mediaIndex)||op.mediaIndex<0||!historyMedia(entry)[op.mediaIndex])fail('invalid-result');
  const chosen=new Set(entry.preferredImageIndexes||[]);if(op.preferred)chosen.add(op.mediaIndex);else chosen.delete(op.mediaIndex);
  history=history.map(h=>h.id===entry.id?{...h,preferredImageIndexes:[...chosen].sort((a,b)=>a-b)}:h);if(nodes.some(n=>n.id===entry.resultNodeId))changed.add(entry.resultNodeId);break;
 }
 case 'review.restore':case 'review.continue':{
  const entry=history.find(h=>h.id===op.historyId);if(!entry||!historyHasResult(entry))fail('invalid-result');
  if(!ports.noteReferenceIncludeTitle&&entry.request.references.some(r=>r.kind==='note'&&r.label!=='笔记正文'))fail('note-title-policy');
  if(!Number.isInteger(op.mediaIndex)||op.mediaIndex<0||(entry.kind==='text'?op.mediaIndex!==0:!historyMedia(entry)[op.mediaIndex]))fail('invalid-result');
  const draft=buildHistoryDraft(entry,op.op==='review.restore'?'parameters':'result',op.mediaIndex);if(!draft)fail('invalid-result');
  const media=historyMedia(entry),m=media[op.mediaIndex];let data:CreationNode['data']={...draft,label:entry.kind==='text'?entry.outputText||'':ports.english?'Restored result':'历史结果'};
  if(op.op==='review.restore')data={...data,resultKind:entry.kind,resultMediaUrl:m?.url,resultMediaItems:entry.kind==='image'?media.map(v=>({...v})):undefined,resultThumbnailUrl:m?.thumbnailUrl,refMediaUrl:m?.url,refThumbnailUrl:m?.thumbnailUrl||m?.url,sourceGenerationTaskId:entry.taskId,sourceGenerationHistoryId:entry.id,sourceGenerationMediaUrl:m?.url,refUpdatedAt:entry.updatedAt};
  const n={id:allocate(),type:'spike',position:{...ports.origin},dragHandle:entry.kind==='text'?undefined:'.canvas-node-drag-handle',data:normalizeCanvasNodeCapabilityData(data)} as N;nodes.push(n);changed.add(n.id);break;
 }
 default: fail('unsupported-operation');
 }
 const labels:Record<string,string>={'referencePack.create':'创建参考包','referencePack.update':'更新参考包','referencePack.unmark':'取消参考包标记','referencePack.apply':'应用参考包','template.instantiate':'添加创作模板','storyboard.create':'创建脚本与分镜','storyboard.rename':'重命名脚本与分镜','storyboard.unmark':'取消分镜标记','storyboard.importScript':'导入剧本','shot.add':'添加镜头','shot.update':'更新镜头','shot.duplicate':'复制镜头','shot.detach':'移出镜头','shot.reorder':'调整镜头顺序','shot.adopt':'采纳镜头成品','shot.clearChoice':'清除成品选择','generator.recipe':'更新创作配方','generator.cinematography':'更新摄影与运镜','reference.role':'更新参考用途','reference.order':'调整参考顺序','review.prefer':'更新成品偏好','review.restore':'恢复历史成品副本','review.continue':'创建继续创作草稿'};
 return {nodes,edges,history,affectedIds:[...changed],summary:ports.english?`Applied ${op.op}; ${changed.size} canvas objects affected. No media jobs submitted. Export/file operations were not performed.`:`已${labels[op.op]}，涉及 ${changed.size} 个画布对象。未发起生成，也未写入外部文件。`};
}
