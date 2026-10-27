import test from 'node:test';import assert from 'node:assert/strict';
import {validateCanvasAgentPlan,applyCanvasAgentPlan} from '../src/core/canvas/agent/plan.ts';
import {agentContextNodes,validateAgentContextCurrent} from '../src/core/canvas/agent/context.ts';
import {executeCanvasAgentPlan} from '../src/core/canvas/agent/execution.ts';
import type {CanvasAgentContext,CanvasAgentPlan} from '../src/core/canvas/agent/types.ts';
const nodes=[{id:'source',position:{x:0,y:0},data:{kind:'image',label:'Watch',refMediaUrl:'asset://watch'}}];
const context:CanvasAgentContext={version:1,canvasId:'canvas',canvasName:'Test',nodes:agentContextNodes(nodes,['source']),connections:[],generation:{imageModels:['image'],videoModels:['video'],imageReady:true,videoReady:true}};
const plan:CanvasAgentPlan={version:1,id:'plan',canvasId:'canvas',runId:'run',title:'Ad',summary:'Script to image to video',steps:[{id:'script',kind:'text',title:'脚本',content:'A silver watch in the mountains.',references:[]},{id:'frame',kind:'image',title:'第一镜',content:'Silver watch on rock',references:['source','script']},{id:'clip',kind:'video',title:'运镜',content:'Slow dolly in',references:['frame']}]};
const graph=()=>{let counter=0;return applyCanvasAgentPlan(plan,nodes,[],{createId:()=>`new-${++counter}`,origin:{x:400,y:100},makeNode:(s,id,position)=>({id,position,data:{kind:s.kind==='text'?'text':'generator',label:s.kind==='text'?s.content:s.title,generationPrompt:s.content}}),makeEdge:(s,t,id)=>({id,source:s.id,target:t.id})});};
test('bounded plan validates and retains script, image, video dependency order',()=>{assert.deepEqual(validateCanvasAgentPlan(plan,context,'run'),plan);});
test('forged canvas, unknown refs, forward refs and wrong edit target are rejected',()=>{
 for(const change of [{canvasId:'other'},{steps:[{...plan.steps[0],references:['clip']}]},{steps:[{...plan.steps[1],references:['outside']}]},{steps:[{...plan.steps[0],targetNodeId:'source'}]}])assert.throws(()=>validateCanvasAgentPlan({...plan,...change},context),/plan-invalid/);
});
test('graph commit is immutable, linked and preserves existing source',()=>{const before=JSON.stringify(nodes);const out=graph();assert.equal(out.nodes.length,4);assert.equal(out.edges.length,3);assert.equal(JSON.stringify(nodes),before);assert.equal(out.nodes[1].data.label,plan.steps[0].content);assert.equal(out.steps[2].kind,'video');assert.equal(out.edges[2].source,out.steps[1].nodeId);});
test('reapplying existing plan is rejected before changing nodes',()=>{const out=graph();assert.throws(()=>applyCanvasAgentPlan(plan,out.nodes,out.edges,{createId:()=>'',origin:{x:0,y:0},makeNode:()=>nodes[0],makeEdge:()=>({id:'',source:'',target:''})}),/plan-applied/);});
test('context revision ignores selection but detects layout and content edits',()=>{validateAgentContextCurrent(context,[{...nodes[0],selected:true}],'canvas');assert.throws(()=>validateAgentContextCurrent(context,[{...nodes[0],position:{x:8,y:9}}],'canvas'),/context-stale/);assert.throws(()=>validateAgentContextCurrent(context,[{...nodes[0],data:{...nodes[0].data,refMediaUrl:'asset://changed'}}],'canvas'),/context-stale/);assert.throws(()=>validateAgentContextCurrent(context,nodes,'other'),/canvas-changed/);});
test('execution submits actual tasks in dependency order with exact task IDs',async()=>{const out=graph(),submitted:string[]=[];let current='';const result=await executeCanvasAgentPlan(plan,out.steps,{signal:new AbortController().signal,assertCurrent:()=>{},submit:id=>{submitted.push(id);current=id;return 'task-'+id;},readTask:id=>({id:'task-'+id,status:current===id?'succeeded':'failed'}),cancel:()=>assert.fail('must not cancel'),onUpdate:()=>{},pollMs:1});assert.equal(result.status,'completed');assert.deepEqual(submitted,[out.steps[1].nodeId,out.steps[2].nodeId]);});
test('failed image stops video; no automatic paid retries',async()=>{const out=graph(),submitted:string[]=[];const result=await executeCanvasAgentPlan(plan,out.steps,{signal:new AbortController().signal,assertCurrent:()=>{},submit:id=>{submitted.push(id);return 'task';},readTask:()=>({id:'task',status:'failed',error:{message:'provider refused'}}),cancel:()=>{},onUpdate:()=>{}});assert.equal(result.status,'failed');assert.equal(submitted.length,1);assert.equal(result.steps[2].status,'cancelled');});
test('cancel stops only captured task, preserves completed text, never submits downstream video',async()=>{const out=graph(),controller=new AbortController(),cancelled:string[]=[];const result=await executeCanvasAgentPlan(plan,out.steps,{signal:controller.signal,assertCurrent:()=>{},submit:()=>{controller.abort();return 'only-task';},readTask:()=>({id:'only-task',status:'running'}),cancel:(id,task)=>cancelled.push(task+':'+id),onUpdate:()=>{}});assert.equal(result.status,'cancelled');assert.equal(result.steps[0].status,'succeeded');assert.equal(cancelled.length,1);});
test('edge role factory sees earlier new links, preventing duplicate first-frame slots',()=>{
 let seq=0;const counts:number[]=[];applyCanvasAgentPlan(plan,nodes,[],{createId:()=>`e-${++seq}`,origin:{x:0,y:0},makeNode:(step,id,position)=>({id,position,data:{kind:step.kind,label:step.title}}),makeEdge:(source,target,id,currentEdges)=>{counts.push(currentEdges.filter(edge=>edge.target===target.id).length);return {id,source:source.id,target:target.id};}});assert.deepEqual(counts,[0,1,0]);
});
test('media settings must be supported, and resolution requires a concrete aspect',()=>{
 const ctx={...context,generation:{...context.generation,imageOptions:{aspects:['auto','16:9'],resolutions:['2K'],qualities:['high'],durations:[]}}};
 const p={...plan,steps:[{...plan.steps[1],references:['source'],settings:{aspect:'16:9',resolution:'2K',quality:'high'}}]};assert.equal(validateCanvasAgentPlan(p,ctx).steps[0].settings?.resolution,'2K');
 assert.throws(()=>validateCanvasAgentPlan({...p,steps:[{...p.steps[0],settings:{aspect:'auto',resolution:'2K'}}]},ctx),/plan-invalid/);
 assert.throws(()=>validateCanvasAgentPlan({...p,steps:[{...p.steps[0],settings:{aspect:'99:1'}}]},ctx),/plan-invalid/);
});
test('creative settings and stored reference edits invalidate a queued request identity',()=>{
 for(const change of [{generationReferences:[{sourceNodeId:'other'}]},{generationInputOrder:['ref:2']},{generationCinematography:{shot:'closeup'}},{generationCreativeRecipe:{mode:'story'}},{generationSound:true},{generationCameraStrength:.5}])assert.throws(()=>validateAgentContextCurrent(context,[{...nodes[0],data:{...nodes[0].data,...change}}],'canvas'),/context-stale/);
});

test('Agent media edit resets inherited multi-output count to one budgeted job',()=>{
 const original={id:'image-original',position:{x:0,y:0},data:{kind:'generator',generationKind:'image',generationCount:4,label:'Old'}};
 const p={...plan,id:'edit-plan',steps:[{id:'edit',kind:'image' as const,title:'New',content:'Prompt',references:[],targetNodeId:original.id}]};
 const result=applyCanvasAgentPlan(p,[original],[],{createId:()=> 'new',origin:{x:0,y:0},makeNode:(_s,id,position)=>({id,position,data:{...original.data}}),makeEdge:(source,target,id)=>({id,source:source.id,target:target.id})});
 assert.equal(result.nodes[0].data.generationCount,1);assert.equal(original.data.generationCount,4);
});
