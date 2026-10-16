import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {isReferencePack,packMembers,usablePackMember,planReferencePack} from '../src/core/canvas/creativeReview';
import {createCanvasGroupDraft,attachCanvasNodesToGroup} from '../src/core/canvas/canvasArrangement';
import {normalizeCanvasNodeCapabilityData} from '../src/core/canvas/nodeCapabilities';
import {createCanvasHistorySnapshot} from '../src/features/canvas/canvasHistory';
const source=readFileSync('src/CanvasSpike.tsx','utf8');
const start=source.indexOf('  const createReferencePack = useCallback('),end=source.indexOf('  const focusSearchResult = useCallback(',start);
assert.ok(start>0&&end>start,'exact production callback block must exist');
const body=transformSync(source.slice(start,end),{loader:'ts',target:'es2022'}).code;
function fixture(){
 let id=0,dirty=0;const snapshots:any[]=[];
 const nodes=[{id:'a',position:{x:10,y:20},data:{kind:'image',refMediaUrl:'asset://a',label:'图'}},{id:'b',position:{x:400,y:20},data:{kind:'text',label:'品牌规范'}},{id:'t',position:{x:800,y:20},data:{kind:'generator',generationKind:'image',label:'目标'}}];
 const context:any={nodesRef:{current:nodes},edgesRef:{current:[]},generationHistoryRef:{current:[{id:'h',kind:'image',status:'succeeded',outputMediaItems:[{url:'a'},{url:'b'}]}]},currentCanvasIdRef:{current:'c'},selectedNodeIds:['a','b'],loadingCanvas:false,
 isReferencePack,packMembers,usablePackMember,planReferencePack,createCanvasGroupDraft,attachCanvasNodesToGroup,normalizeCanvasNodeCapabilityData,
 genId:()=>`n${++id}`,genEdgeId:()=>`e${++id}`,useCallback:(f:any)=>f,
 commitHistory:()=>snapshots.push(createCanvasHistorySnapshot({canvasId:'c',nodes:context.nodesRef.current,edges:context.edgesRef.current,generationHistory:context.generationHistoryRef.current})),markDirty:()=>dirty++,setNodes:(v:any)=>{},setEdges:(v:any)=>{},setSelectedNodeIds:(v:any)=>{context.selectedNodeIds=v;},setGenerationHistory:(v:any)=>{}};
 const actions=new Function('context',`with(context){${body};return {createReferencePack,editReferencePack,applyReferencePack,pickReviewImage};}`)(context);
 return {context,actions,snapshots,dirty:()=>dirty};
}
test('production pack creation uses one undo step, preserves resources and positions',()=>{
 const f=fixture(),before=structuredClone(f.context.nodesRef.current);
 assert.equal(f.actions.createReferencePack(' 主角 ','character'),null);assert.equal(f.dirty(),1);assert.equal(f.snapshots.length,1);
 const [group,...members]=f.context.nodesRef.current;assert.ok(isReferencePack(group));assert.equal(group.data.label,'主角');
 for(const member of members.filter((n:any)=>n.parentId)){const original=before.find(n=>n.id===member.id)!;assert.equal(member.position.x+group.position.x,original.position.x);assert.deepEqual(member.data,original.data);}
 assert.deepEqual(f.snapshots[0].nodes,before);
});
test('production applying same pack twice is idempotent, one durable mutation',()=>{
 const f=fixture();f.actions.createReferencePack('产品','product');const id=f.context.nodesRef.current[0].id;
 assert.equal(f.actions.applyReferencePack(id,'t'),null);assert.equal(f.dirty(),2);assert.equal(f.context.edgesRef.current.length,2);
 assert.equal(f.actions.applyReferencePack(id,'t'),null);assert.equal(f.dirty(),2);assert.equal(f.snapshots.length,2);
});
test('relabel/unmark preserve members and edges and undo snapshots',()=>{
 const f=fixture();f.actions.createReferencePack('产品','product');const id=f.context.nodesRef.current[0].id;f.actions.applyReferencePack(id,'t');
 const before=structuredClone(f.context.edgesRef.current);f.actions.editReferencePack(id,'新产品');assert.equal(f.context.nodesRef.current[0].data.label,'新产品');
 f.actions.editReferencePack(id);assert.equal(isReferencePack(f.context.nodesRef.current[0]),false);assert.equal(f.context.nodesRef.current.length,4);assert.deepEqual(f.context.edgesRef.current,before);assert.ok(isReferencePack(f.snapshots.at(-1).nodes[0]));
});
test('invalid grouping, missing content and loading do not dirty or mutate',()=>{
 const f=fixture();f.context.selectedNodeIds=['a'];assert.equal(f.actions.createReferencePack('单图','style'),'invalid-selection');assert.equal(f.dirty(),0);
 f.context.loadingCanvas=true;assert.equal(f.actions.createReferencePack('组','style'),'invalid-selection');assert.equal(f.actions.applyReferencePack('g','t'),'invalid-target');f.actions.pickReviewImage('h',0);assert.equal(f.dirty(),0);
});
test('favorite selection is exact per-image, reversible and in shared undo history',()=>{
 const f=fixture();f.actions.pickReviewImage('h',1);assert.deepEqual(f.context.generationHistoryRef.current[0].preferredImageIndexes,[1]);assert.equal(f.dirty(),1);
 f.actions.pickReviewImage('h',1);assert.deepEqual(f.context.generationHistoryRef.current[0].preferredImageIndexes,[]);assert.deepEqual(f.snapshots[1].generationHistory[0].preferredImageIndexes,[1]);
 f.actions.pickReviewImage('h',9);assert.equal(f.dirty(),2);
});
test('canvas identity fences dialogs and close does not submit tasks',()=>{
 assert.match(source,/creativePanel\.canvasId===currentCanvasId && !loadingCanvas/);
 assert.match(source,/setCreativePanel\(null\);\s+setCurrentCanvasId\(c.canvasId\)/);
 assert.doesNotMatch(body,/submitGeneration|fetch\(|invoke\(|localStorage/);
});
