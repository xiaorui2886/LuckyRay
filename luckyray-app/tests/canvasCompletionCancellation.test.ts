import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {invokeCancellableAiCompletion} from '../src/core/services/aiCompletionTransport.ts';
import {executeCanvasGenerationTask} from '../src/core/canvas/generationRunner.ts';
import {createCanvasGenerationTask} from '../src/core/canvas/generationTasks.ts';
import {serializeCanvasPortableExport} from '../src/features/canvas/canvasExport.ts';
function harness() {
 const controller=new AbortController(), channel:any={onmessage:()=>{}}, calls:any[]=[];
 let resolve!:(v:any)=>void;
 const call:any=(command:string,args:any)=>{calls.push({command,args});return command==='ai_chat_cancel'?Promise.resolve():new Promise(r=>resolve=r)};
 return {controller,channel,calls,call,finish:(v:any)=>resolve(v)};
}
for(const early of [true,false]) test(`abort ${early?'before':'after'} native registration cancels once`,async()=>{
 const h=harness(); const result=invokeCancellableAiCompletion('canvas_text_generate',{profileId:'p'},h.controller.signal,h.call,h.channel);
 if(early)h.controller.abort();
 assert.equal(h.calls.length,1);h.channel.onmessage();if(!early)h.controller.abort();h.channel.onmessage();
 assert.equal(h.calls.length,2);assert.equal(h.calls[1].command,'ai_chat_cancel');assert.equal(h.calls[1].args.streamId,h.calls[0].args.cancellationId);
 h.finish({success:false,error_kind:'cancelled'});assert.deepEqual(await result,{success:false,error_kind:'cancelled'});
});
test('pre-aborted request never invokes; completion removes listener',async()=>{
 const h=harness();h.controller.abort();await assert.rejects(invokeCancellableAiCompletion('ai_chat_complete',{},h.controller.signal,h.call,h.channel),{name:'AbortError'});assert.equal(h.calls.length,0);
 const k=harness();const p=invokeCancellableAiCompletion('ai_chat_complete',{},k.controller.signal,k.call,k.channel);k.channel.onmessage();k.finish({success:true});await p;k.controller.abort();assert.equal(k.calls.length,1);
});
test('legacy callers without signal have unchanged arguments',async()=>{
 const h=harness();const args={request:{messages:[]}};const p=invokeCancellableAiCompletion('ai_chat_complete',args,undefined,h.call,h.channel);assert.equal(h.calls[0].args,args);h.finish('ok');assert.equal(await p,'ok');
});
test('cancelled in-flight completion cannot transition to succeeded or return late output',async()=>{
 const h=harness();const transitions:string[]=[];const task=createCanvasGenerationTask({id:'t',sourceNodeId:'n',resultNodeId:'n',createdAt:'now',request:{kind:'text',model:'fake',prompt:'synthetic',references:[]}});
 const p=executeCanvasGenerationTask({task,now:()=> 'later',isCancelled:()=>h.controller.signal.aborted,onTransition:t=>transitions.push(t.status),adapters:[{id:'fake',supports:()=>true,execute:async()=>{await invokeCancellableAiCompletion('ai_chat_complete',{},h.controller.signal,h.call,h.channel);return {ok:true,output:{kind:'text',text:'late'}};}}]});
 h.channel.onmessage();h.controller.abort();h.finish({success:true,content:'late'});const result=await p;assert.equal(result.outcome,'cancelled');assert.equal('output' in result,false);assert.deepEqual(transitions,['running']);
});
test('both real export handlers preserve history and produce identical JSON roundtrip',async()=>{
 const data={canvasId:'c',name:'synthetic',createdAt:'1',updatedAt:'2',nodes:[{id:'n',data:{generationTask:{id:'t'}}}],edges:[],viewport:{x:0,y:0,zoom:1},generationHistory:[{id:'h',taskId:'t',outputText:'result'}],agentReceipts:['private'],revision:9};
 const outputs:string[]=[];
 for(const [file,name,end] of [['src/CanvasSpike.tsx','handleExportCanvas','  // Focus mode'],['src/features/canvas/CanvasHomePage.tsx','exportCanvas','  const openStorageDir']]){
 const source=readFileSync(file,'utf8');const start=source.indexOf(`  const ${name} = useCallback(`);const block=source.slice(start,source.indexOf(end,start));
 const env:any={useCallback:(f:any)=>f,bridge:{loadCanvas:async()=>data},save:async()=>'/synthetic.json',writeTextFile:async(_:any,json:string)=>outputs.push(json),serializeCanvasPortableExport,exportingId:null,setMessage:()=>{},setExportingId:()=>{},setErrorMsg:(e:any)=>{throw Error(e)},t:(s:string)=>s};
 const js=ts.transpileModule(block,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const handler=Function(...Object.keys(env),`${js};return ${name};`)(...Object.values(env));await (name==='exportCanvas'?handler({id:'c',name:'synthetic'}):handler('c','synthetic'));
 }
 assert.equal(outputs.length,2);assert.equal(outputs[0],outputs[1]);const parsed=JSON.parse(outputs[0]);assert.deepEqual(parsed.generationHistory,data.generationHistory);assert.equal('agentReceipts' in parsed,false);assert.deepEqual(serializeCanvasPortableExport(parsed),parsed);
});

import {createCanvasTextGenerationAdapter} from '../src/core/canvas/textGenerationAdapter.ts';
import {canCancelCanvasGenerationTask,transitionCanvasGenerationTask} from '../src/core/canvas/generationTasks.ts';
for(const profile of [false,true])test(`real CanvasSpike execute/cancel wiring (${profile?'profile':'legacy'}) aborts and releases without result fill`,async()=>{
 const source=readFileSync('src/CanvasSpike.tsx','utf8');const updates:any[]=[];const released:string[]=[];let pending!:(value:any)=>void;let signal:AbortSignal|undefined;
 const complete=async(_:any,options:any)=>{signal=options.signal;return new Promise(r=>pending=r)};
 const env:any={useCallback:(f:any)=>f,createCanvasTextGenerationAdapter,executeCanvasGenerationTask,canCancelCanvasGenerationTask,transitionCanvasGenerationTask,
 runningGenerationTaskIdsRef:{current:new Set()},cancelledGenerationTaskIdsRef:{current:new Set()},textGenerationAbortControllersRef:{current:new Map()},generationTaskSnapshotsRef:{current:new Map()},generationTaskCanvasIdsRef:{current:new Map()},nodesRef:{current:[]},
 generationSchedulerRef:{current:{release:(id:string)=>released.push(id),backpressure:()=>{throw Error('unexpected failure')}}},
 applyGenerationTaskUpdate:async(task:any,output:any)=>updates.push({task,output}),bridge:{aiChatComplete:complete},completeCanvasProfileText:async(_:any,__:any,m:any,o:any)=>complete(m,o),
 commitHistory:()=>{},markDirty:()=>{},recordGenerationTask:()=>{},setNodes:()=>{},setSaveError:()=>{},setSaveStatus:()=>{}};
 function extract(name:string,end:string){const start=source.indexOf(`  const ${name} = useCallback(`);const block=source.slice(start,source.indexOf(end,start));const js=ts.transpileModule(block,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;return Function(...Object.keys(env),`${js};return ${name};`)(...Object.values(env))}
 const execute=extract('executeGenerationTask','  const submitGenerationFromNode');const cancel=extract('cancelGenerationTask','  const cancelGeneration =');
 const task=createCanvasGenerationTask({id:'task',sourceNodeId:'n',resultNodeId:'n',createdAt:'now',request:{kind:'text',model:'fake',prompt:'synthetic',references:[],...(profile?{textProfileId:'p',textProfileRevision:1}:{})}});
 const promise=execute(task);assert.ok(signal);assert.equal(signal.aborted,false);cancel(task,'n');assert.equal(signal.aborted,true);pending({success:true,content:'late result'});await promise;
 assert.deepEqual(released,['task']);assert.equal(env.textGenerationAbortControllersRef.current.size,0);assert.equal(env.runningGenerationTaskIdsRef.current.size,0);assert.equal(updates.some(u=>u.output),false);assert.equal(updates.some(u=>u.task.status==='succeeded'),false);
});
