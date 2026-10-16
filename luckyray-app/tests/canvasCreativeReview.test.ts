import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewImages,comparisonParameters,isReferencePack,planReferencePack,usablePackMember,packMembers,type PackNode} from '../src/core/canvas/creativeReview';
import {normalizeGenerationHistory,upsertGenerationHistory,generationTaskFromHistory,type CanvasGenerationHistoryEntry} from '../src/core/canvas/generationHistory';
import {sanitizeCanvasNodesForPersistence} from '../src/features/canvas/canvasPersistence';
import {createCanvasGroupDraft,attachCanvasNodesToGroup,ungroupCanvasNodes} from '../src/core/canvas/canvasArrangement';
import {createCanvasHistorySnapshot} from '../src/features/canvas/canvasHistory';
const history:CanvasGenerationHistoryEntry={version:4,id:'h1',taskId:'t1',sourceNodeId:'s1',resultNodeId:'r1',kind:'image',status:'succeeded',attempt:1,request:{kind:'image',prompt:'draft',model:'test',references:[]},prompt:'draft',model:'test',createdAt:'2026-10-09T00:00:00Z',updatedAt:'2026-10-09T00:00:00Z',outputMediaUrl:'asset://image.png'};
const group:PackNode={id:'g',data:{kind:'group',label:'主角',referencePack:{version:1,kind:'character'}}};
const picture:PackNode={id:'p',parentId:'g',data:{kind:'image',label:'正面',refMediaUrl:'asset://a.png',payload:'asset-id'}};
const note:PackNode={id:'n',parentId:'g',data:{kind:'noteRef',label:'设定',payload:'note-id',refSummary:'短摘要'}};
const target:PackNode={id:'t',data:{kind:'generator',generationKind:'image',label:'生成'}};
const nodes=[group,picture,note,target];
test('completed images only, batch images have independent stable keys',()=>{
 const items=reviewImages([history,{...history,id:'failed',status:'failed'},{...history,id:'video',kind:'video'},{...history,id:'batch',outputMediaItems:[{url:'one'},{url:''},{url:'three'}]}]);
 assert.equal(items.length,3);assert.deepEqual(items.map(i=>i.index),[0,0,2]);assert.equal(new Set(items.map(i=>i.key)).size,3);
});
test('comparison metadata is allowlisted and never exposes profile IDs or URLs',()=>{
 const rows=comparisonParameters({...history,request:{...history.request,mediaProfileId:'secret-id',mediaProfileRevision:9,references:[{id:'a',kind:'image',role:'reference',label:'ref',mediaUrl:'https://signed.invalid/?token=x'}]}});
 assert.equal(JSON.stringify(rows).includes('secret-id'),false);assert.equal(JSON.stringify(rows).includes('token='),false);assert.equal(rows.find(r=>r[0]==='references')?.[1],'1');
});
test('picks survive reload, duplicated or malformed indexes normalized',()=>{
 assert.deepEqual(normalizeGenerationHistory([{...history,preferredImageIndexes:[0,0,-1,1,'0',null]}])[0].preferredImageIndexes,[0]);
 assert.equal(normalizeGenerationHistory([{...history,preferredImageIndexes:{0:true}}])[0].preferredImageIndexes,undefined);
});
test('task telemetry update preserves user picks',()=>{
 const picked={...history,preferredImageIndexes:[0]};
 assert.deepEqual(upsertGenerationHistory([picked],generationTaskFromHistory(picked))[0].preferredImageIndexes,[0]);
});
test('reference tag is scoped to real group and supported version/category',()=>{
 assert.ok(isReferencePack(group));assert.equal(isReferencePack({...group,data:{...group.data,kind:'text'}}),false);
 assert.equal(isReferencePack({...group,data:{...group.data,referencePack:{version:2,kind:'character'} as any}}),false);
});
test('pack applies live edges in original member order, no content or credentials copied',()=>{
 const before=JSON.stringify(nodes);const result=planReferencePack(nodes,[],'g','t');assert.ok(result.ok);
 assert.deepEqual(result.edges.map(e=>[e.source,e.target,e.data?.role]),[['p','t','reference'],['n','t','promptContext']]);
 assert.equal(JSON.stringify(nodes),before);assert.equal(JSON.stringify(result).includes('asset://'),false);
});
test('idempotent reapply makes no new edges',()=>{
 const first=planReferencePack(nodes,[],'g','t');assert.ok(first.ok);
 const second=planReferencePack(nodes,first.edges,'g','t');assert.ok(second.ok);assert.deepEqual(second.edges,[]);
});
test('stored node reference is deduplicated',()=>{
 const result=planReferencePack([...nodes.slice(0,3),{...target,data:{...target.data,generationReferences:[{id:'node:p:reference'}]}}],[],'g','t');
 assert.ok(result.ok);assert.deepEqual(result.edges.map(e=>e.source),['n']);
});
test('full input capacity rejects atomically; first/last frames not evicted',()=>{
 const edges=[{source:'one',target:'t',data:{role:'firstFrame' as const}},{source:'two',target:'t',data:{role:'lastFrame' as const}},{source:'three',target:'t'}];
 const before=JSON.stringify(edges);assert.deepEqual(planReferencePack(nodes,edges,'g','t'),{ok:false,error:'too-many-inputs'});assert.equal(JSON.stringify(edges),before);
});
test('video pack images stay references rather than implicitly replacing frame roles',()=>{
 const result=planReferencePack([...nodes.slice(0,3),{...target,data:{...target.data,generationKind:'video'}}],[],'g','t');assert.ok(result.ok);assert.equal(result.edges[0].data?.role,'reference');
});
test('missing, empty, invalid target and self-containing target all fail closed',()=>{
 assert.deepEqual(planReferencePack(nodes,[],'missing','t'),{ok:false,error:'missing-pack'});
 assert.deepEqual(planReferencePack([group,target],[],'g','t'),{ok:false,error:'empty-pack'});
 assert.deepEqual(planReferencePack(nodes,[],'g','p'),{ok:false,error:'invalid-target'});
 assert.deepEqual(planReferencePack([...nodes.slice(0,3),{...target,parentId:'g'}],[],'g','t'),{ok:false,error:'invalid-target'});
});
test('unavailable member and nested group block complete apply instead of silent drop',()=>{
 assert.deepEqual(planReferencePack([...nodes,{id:'missing',parentId:'g',data:{kind:'image'}}],[],'g','t'),{ok:false,error:'missing-content'});
 assert.deepEqual(planReferencePack([...nodes,{...group,id:'nested',parentId:'g'}],[],'g','t'),{ok:false,error:'missing-content'});
});
test('live group membership resolves deletion, new members and text edits',()=>{
 assert.equal(packMembers(nodes,'g').length,2);
 const changed=[...nodes.filter(n=>n.id!=='p'),{id:'text',parentId:'g',data:{kind:'text' as const,label:'new instructions'}}];
 const result=planReferencePack(changed,[],'g','t');assert.ok(result.ok);assert.deepEqual(result.edges.map(e=>e.source),['n','text']);
});
test('empty text, empty image and note without identity are unusable',()=>{
 for(const data of [{kind:'text',label:' '},{kind:'image',_emptyMedia:true},{kind:'noteRef',label:'pretend'}])assert.equal(usablePackMember({id:'x',data:data as any}),false);
});
test('pack survives canonical persistence, group/ungroup preserve absolute positions',()=>{
 const resources=[picture,note].map((n,i)=>({...n,parentId:undefined,position:{x:i*350,y:70},selected:true}));
 const draft=createCanvasGroupDraft(resources,['p','n'],'g','主角')!;assert.ok(draft);
 const fullGroup={...group,position:draft.position};
 const grouped=attachCanvasNodesToGroup(resources,draft,fullGroup);
 const stored=JSON.parse(JSON.stringify(sanitizeCanvasNodesForPersistence(grouped)));
 assert.ok(isReferencePack(stored[0]));assert.equal(stored[1].selected,undefined);
 const restored=ungroupCanvasNodes(stored,['g']);assert.deepEqual(restored.map(n=>n.position),resources.map(n=>n.position));
});
test('existing history snapshot includes picks and pack tag, with no separate store',()=>{
 const result=createCanvasHistorySnapshot({canvasId:'canvas',nodes:[{...group,position:{x:0,y:0}}],edges:[],generationHistory:[{...history,preferredImageIndexes:[0]}]});
 assert.deepEqual(result.generationHistory[0].preferredImageIndexes,[0]);assert.ok(isReferencePack(result.nodes[0] as any));
});
