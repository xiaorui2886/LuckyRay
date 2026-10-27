import test from 'node:test';
import assert from 'node:assert/strict';
import {executeCanvasAgentPlan} from '../src/core/canvas/agent/execution.ts';
import type {CanvasAgentExecution,CanvasAgentPlan,CanvasAgentExecutionStep} from '../src/core/canvas/agent/types.ts';
const plan:CanvasAgentPlan={version:1,id:'p',canvasId:'c',runId:'r',title:'Test',summary:'',steps:[{id:'s1',kind:'image',title:'Image',content:'test',references:[]},{id:'s2',kind:'video',title:'Video',content:'test',references:['s1']}]};
const steps:CanvasAgentExecutionStep[]=plan.steps.map(s=>({id:s.id,nodeId:'n'+s.id,title:s.title,kind:s.kind,status:'draft'}));
test('feedback promise waits for real task completion and chains media jobs sequentially',async()=>{
 const controller=new AbortController();let submitted:string[]=[];let phase:'running'|'succeeded'='running';let settled=false;
 const pending=executeCanvasAgentPlan(plan,steps,{signal:controller.signal,assertCurrent(){},submit(id){submitted.push(id);return id;},readTask(id){return {id,status:phase};},cancel(){throw Error('unexpected cancel');},onUpdate(){},pollMs:1}).then(v=>{settled=true;return v;});
 await new Promise(r=>setTimeout(r,5));assert.equal(settled,false);assert.deepEqual(submitted,['ns1']);
 phase='succeeded';assert.equal((await pending).status,'completed');assert.deepEqual(submitted,['ns1','ns2']);
});
test('stop cancels current supported job and never submits remaining dependency',async()=>{
 const controller=new AbortController();const submitted:string[]=[],cancelled:string[]=[];
 const pending=executeCanvasAgentPlan(plan,steps,{signal:controller.signal,assertCurrent(){},submit(id){submitted.push(id);return id;},readTask(id){return {id,status:'running'};},cancel(id){cancelled.push(id);},onUpdate(){},pollMs:1});
 controller.abort();assert.equal((await pending).status,'cancelled');assert.deepEqual(submitted,['ns1']);assert.deepEqual(cancelled,['ns1']);
});
test('provider failure is returned and never retried or advanced',async()=>{
 let count=0;let last:CanvasAgentExecution|undefined;
 const execution=await executeCanvasAgentPlan(plan,steps,{signal:new AbortController().signal,assertCurrent(){},submit(){count++;return 'task';},readTask(){return {id:'task',status:'failed',error:{message:'provider rejected'}};},cancel(){},onUpdate(value){last=value;},pollMs:1});
 assert.equal(execution.status,'failed');assert.equal(count,1);assert.equal(last?.steps[1].status,'cancelled');
});
