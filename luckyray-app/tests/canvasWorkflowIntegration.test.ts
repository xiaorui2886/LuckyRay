import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {builtinWorkflows,captureWorkflow,instantiateWorkflow,WorkflowError} from '../src/core/canvas/workflowTemplates';
import {createCanvasHistorySnapshot} from '../src/features/canvas/canvasHistory';
const source=readFileSync('src/CanvasSpike.tsx','utf8');
const start=source.indexOf('  const insertWorkflow = useCallback('),end=source.indexOf('  const createReferencePack = useCallback(',start);
assert.ok(start>0&&end>start);
const body=transformSync(source.slice(start,end),{loader:'ts',target:'es2022'}).code;
function fixture(){
 let id=0,dirty=0;const snapshots:any[]=[],writes:any[]=[];
 const context:any={loadingCanvas:false,currentCanvasId:'canvas-a',currentCanvasIdRef:{current:'canvas-a'},selectedNodeIds:['existing'],
  nodesRef:{current:[{id:'existing',position:{x:0,y:0},selected:true,data:{kind:'text',label:'preserve me'}}]},edgesRef:{current:[]},
  getViewportCreatePosition:()=>({x:100,y:200}),genId:()=>`fresh${++id}`,captureWorkflow,instantiateWorkflow,WorkflowError,useCallback:(fn:any)=>fn,
  commitHistory:()=>snapshots.push(createCanvasHistorySnapshot({canvasId:context.currentCanvasIdRef.current,nodes:context.nodesRef.current,edges:context.edgesRef.current,generationHistory:[]})),
  markDirty:()=>dirty++,setNodes:()=>{},setEdges:()=>{},setSelectedNodeIds:(ids:string[])=>{context.selectedNodeIds=ids;},
  save:async()=>'/selected/workflow.json',writeTextFile:async(path:string,bytes:string)=>{writes.push({path,bytes});}};
 const actions=new Function('context',`with(context){${body};return {insertWorkflow,exportWorkflow};}`)(context);
 return {context,actions,snapshots,writes,dirty:()=>dirty};
}
test('production insert is one undo/dirty transaction with existing graph preserved',()=>{
 const f=fixture(),before=structuredClone(f.context.nodesRef.current);f.actions.insertWorkflow(builtinWorkflows()[1]);
 assert.equal(f.dirty(),1);assert.equal(f.snapshots.length,1);assert.deepEqual(f.snapshots[0].nodes,before.map(({selected,...n}:any)=>n));
 assert.equal(f.context.nodesRef.current.length,4);assert.equal(f.context.edgesRef.current.length,2);assert.equal(f.context.nodesRef.current[0].data.label,'preserve me');
 assert.equal(f.context.nodesRef.current[0].selected,false);assert.equal(f.context.selectedNodeIds.length,3);
 assert.ok(f.context.nodesRef.current.every((n:any)=>!n.data.generationTask&&!n.data.generationModel));
});
test('invalid import and changed/loading canvas leave refs/history untouched',()=>{
 const f=fixture(),before=JSON.stringify(f.context.nodesRef.current);assert.throws(()=>f.actions.insertWorkflow({}));
 f.context.currentCanvasIdRef.current='canvas-b';assert.throws(()=>f.actions.insertWorkflow(builtinWorkflows()[1]),/canvas-changed/);
 f.context.currentCanvasIdRef.current='canvas-a';f.context.loadingCanvas=true;assert.throws(()=>f.actions.insertWorkflow(builtinWorkflows()[1]),/canvas-changed/);
 assert.equal(f.dirty(),0);assert.equal(f.snapshots.length,0);assert.equal(JSON.stringify(f.context.nodesRef.current),before);
});
test('production export writes only captured declarative template and does not dirty canvas',async()=>{
 const f=fixture();const result=await f.actions.exportWorkflow('mine');assert.equal(result.cancelled,false);assert.equal(f.writes.length,1);
 const saved=JSON.parse(f.writes[0].bytes);assert.equal(saved.name,'mine');assert.equal(saved.nodes[0].label,'preserve me');assert.equal(f.dirty(),0);
});
test('save cancel, dialog failure and canvas switch before disk write do not mutate',async()=>{
 const f=fixture();f.context.save=async()=>null;assert.equal((await f.actions.exportWorkflow('x')).cancelled,true);assert.equal(f.writes.length,0);
 f.context.save=async()=>{throw new Error('dialog failed');};await assert.rejects(()=>f.actions.exportWorkflow('x'),/dialog failed/);
 f.context.save=async()=>{f.context.currentCanvasIdRef.current='canvas-b';return '/x.json';};await assert.rejects(()=>f.actions.exportWorkflow('x'),/canvas-changed/);
 assert.equal(f.writes.length,0);assert.equal(f.dirty(),0);
});
test('export file write failure propagates without success receipt or graph edits',async()=>{
 const f=fixture();f.context.writeTextFile=async()=>{throw new Error('disk full');};await assert.rejects(()=>f.actions.exportWorkflow('x'),/disk full/);assert.equal(f.dirty(),0);
});
