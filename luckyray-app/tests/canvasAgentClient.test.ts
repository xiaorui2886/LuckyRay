import {projectCanvasAgentErrorDetail} from '../src/core/canvas/agent/wire.ts';
import test from 'node:test';import assert from 'node:assert/strict';
import {createCanvasAgentClient,projectCanvasAgentSnapshot,CANVAS_AGENT_RPC_BYTES,canvasAgentErrorMessage} from '../src/core/services/canvasAgent.ts';
const context={version:1,canvasId:'canvas',canvasName:'Test',nodes:[],connections:[],generation:{imageModels:[],videoModels:[],imageReady:false,videoReady:false}};
const base={canvasId:'canvas',conversationId:'conversation-1',sessionId:null,runId:null,status:'idle',messages:[]};
test('projects only declared safe fields, rejecting identity and context mismatches',()=>{
 assert.deepEqual(projectCanvasAgentSnapshot({...base,secret:'mustnotescape'},'canvas'),base);
 for(const value of [{...base,canvasId:'other'},{...base,sessionId:'../bad'},{...base,requestId:{}},{...base,context:{...context,canvasId:'other'}},{...base,messages:[{role:'tool',text:'hidden'}]}])assert.throws(()=>projectCanvasAgentSnapshot(value,'canvas'));
});
test('validates plans before a component can access malformed fields',()=>{
 for(const plan of [{steps:null},{steps:[{}]},{version:1,id:'p',runId:'r',canvasId:'canvas',title:'T',summary:'S',steps:[{id:'s',kind:'text',title:'X',content:'Y',references:['outside']}]}])assert.throws(()=>projectCanvasAgentSnapshot({...base,runId:'r',context,plan},'canvas'));
 const plan={version:1,id:'p',runId:'r',canvasId:'canvas',title:'T',summary:'S',steps:[{id:'s',kind:'text',title:'X',content:'Y',references:[]}]};
 assert.deepEqual(projectCanvasAgentSnapshot({...base,runId:'r',context,plan},'canvas').plan,plan);
});
test('never lets images or unexpected error data return in status context',()=>{
 const node={id:'n',title:'T',kind:'image',text:'',editable:true,revision:'0123456789abcdef',image:{mimeType:'image/png',data:'secret'}};
 assert.throws(()=>projectCanvasAgentSnapshot({...base,context:{...context,nodes:[node]}},'canvas'));
 assert.throws(()=>projectCanvasAgentSnapshot({...base,error:'Bearer private'},'canvas'));
});
test('client enforces RPC byte and UTF8 prompt budget before invoking host',async()=>{
 let calls=0;const client=createCanvasAgentClient((async()=>{calls++;return base;}) as any);
 await assert.rejects(client.dispatch({op:'start',conversationId:'conversation-1',canvasId:'canvas',requestId:'r',prompt:'字'.repeat(48001),context:context as any}),/prompt-limit/);
 await assert.rejects(client.dispatch({op:'start',conversationId:'conversation-1',canvasId:'canvas',requestId:'r',prompt:'ok',context:{...context,canvasName:'x'.repeat(CANVAS_AGENT_RPC_BYTES)} as any}),/context-limit/);
 assert.equal(calls,0);await client.dispatch({op:'status',canvasId:'canvas'});assert.equal(calls,1);
});
test('catalog projection drops private metadata and rejects malformed selections',()=>{
 const models={available:[{provider:'lsh',model:'text',label:'LSH · text',inputModalities:['text'],apiKey:'SECRET'}],defaultModel:{provider:'lsh',model:'text',reasoningEffort:'medium',token:'SECRET'},currentModel:null};
 const safe=projectCanvasAgentSnapshot({...base,models},'canvas');
 assert.equal(JSON.stringify(safe).includes('SECRET'),false);
 for(const bad of [{...models,currentModel:{}},{...models,available:[{...models.available[0],inputModalities:['credentials']}]},{...models,defaultModel:{provider:'lsh',model:'text',reasoningEffort:42}}])assert.throws(()=>projectCanvasAgentSnapshot({...base,models:bad},'canvas'));
});
test('client forwards exact model selection through the real native start envelope',async()=>{
 let received:any;const client=createCanvasAgentClient((async(command:any,args:any)=>{received={command,args};return base;})as any);
 const request={op:'start' as const,conversationId:'conversation-1',canvasId:'canvas',requestId:'r',prompt:'Plan',context:context as any,modelSelection:{provider:'lsh',model:'chosen'}};
 await client.dispatch(request);assert.deepEqual(received,{command:'canvas_agent_dispatch',args:{request}});
});

test('projects advertised reasoning safely and rejects malformed capabilities',()=>{
 const reasoning={efforts:[{id:'max',name:'Maximum',description:'More thought',apiKey:'SECRET'}],defaultEffort:'max'};
 const models={available:[{provider:'p',model:'m',label:'Model',inputModalities:['text'],reasoning}],defaultModel:null,currentModel:null};
 assert.equal(JSON.stringify(projectCanvasAgentSnapshot({...base,models},'canvas')).includes('SECRET'),false);
 for(const bad of [{efforts:[]},{efforts:[{id:'x',name:'X'}],defaultEffort:'unknown'},{efforts:[{id:'x',name:'X'},{id:'x',name:'X'}]}])
  assert.throws(()=>projectCanvasAgentSnapshot({...base,models:{...models,available:[{...models.available[0],reasoning:bad}]}},'canvas'));
});

test('bounded activity drops private metadata and rejects forged lifecycle fields',()=>{
 const activity=[{id:'a',kind:'tool',label:'reading-context',status:'completed',startedAt:10,endedAt:20,arguments:{secret:'PRIVATE'}}];
 assert.equal(JSON.stringify(projectCanvasAgentSnapshot({...base,activity},'canvas')).includes('PRIVATE'),false);
 for(const a of [[{...activity[0],label:'arbitrary-thinking'}],[{...activity[0],endedAt:1}],[...activity,...activity],Array(25).fill(activity[0])])assert.throws(()=>projectCanvasAgentSnapshot({...base,activity:a},'canvas'));
 assert.throws(()=>projectCanvasAgentSnapshot({...base,conversationId:undefined},'canvas'));
});
test('renderer host lane serializes RPCs and rejects stale queued mutations before invoke',async()=>{
 let release:()=>void=()=>{},calls=0;const gate=new Promise<void>(resolve=>{release=resolve;});
 const client=createCanvasAgentClient((async()=>{calls++;if(calls===1)await gate;return base;})as any);
 const first=client.dispatch({op:'status',canvasId:'canvas'});
 const queued=client.dispatch({op:'newConversation',canvasId:'canvas',requestId:'r',expectedConversationId:'conversation-1'},()=>false);
 release();await first;await assert.rejects(queued,/canvas-changed/);assert.equal(calls,1);
});

test('R5 projects public streamed reasoning and rejects foreign or malformed execution actions',()=>{
 const stream={attemptId:'attempt-1',text:'Visible response',reasoningText:'Model-returned visible reasoning',reasoning:true,status:'streaming'};
 const safe=projectCanvasAgentSnapshot({...base,status:'running',runId:'run-1',stream,tools:[{callId:'tool-1',name:'canvas_read_context',status:'running',startedAt:1}],progress:[{id:'progress-1',summary:'Inspecting canvas',createdAt:1}]},'canvas');
 assert.deepEqual(safe.stream,stream);
 const pendingAction={actionId:'action-1',runId:'run-1',kind:'readContext',offset:256};
 assert.equal(projectCanvasAgentSnapshot({...base,status:'running',runId:'run-1',pendingAction},'canvas').pendingAction?.offset,256);
 for(const bad of [{...pendingAction,runId:'foreign'},{...pendingAction,offset:-1},{...pendingAction,kind:'shell'}, {...pendingAction,kind:'applyPlan'}])assert.throws(()=>projectCanvasAgentSnapshot({...base,status:'running',runId:'run-1',pendingAction:bad},'canvas'));
 assert.throws(()=>projectCanvasAgentSnapshot({...base,stream:{...stream,reasoningText:{secret:1}}},'canvas'));
});
test('R5 accepts long tasks within batch budgets and preserves explicit generation authority',async()=>{
 let received:any;const client=createCanvasAgentClient((async(_cmd:any,args:any)=>{received=args.request;return base;}) as any);
 const execution={mode:'autonomous' as const,allowGeneration:true,maxMediaJobs:3};
 await client.dispatch({op:'start',conversationId:'conversation-1',canvasId:'canvas',requestId:'r',prompt:'字'.repeat(10000),context:context as any,execution});
 assert.deepEqual(received.execution,execution);
});

test('R6 projection preserves scoped identities/timestamps and revision, rejecting private fields',()=>{
 const message={role:'assistant',text:'Answer',turnId:'run-1',messageId:'message-1',attemptId:'attempt-1',createdAt:10,eventSeq:2};
 const stream={turnId:'run-2',attemptId:'attempt-2',startedAt:20,text:'Next answer',status:'streaming',reasoning:false};
 const tool={turnId:'run-1',callId:'call-1',name:'canvas_read_context',startedAt:10,eventSeq:3,endedAt:11,status:'completed'};
 const value={...base,runId:'run-2',status:'running',messages:[message],stream,tools:[tool],context:{...context,snapshotRevision:'0123456789abcdef'}};
 const safe=projectCanvasAgentSnapshot(value,'canvas');assert.deepEqual(safe.messages,[message]);assert.deepEqual(safe.stream,stream);assert.deepEqual(safe.tools,[tool]);assert.equal(safe.context?.snapshotRevision,'0123456789abcdef');
 for(const patch of [{messages:[{...message,eventSeq:-1}]},{tools:[{...tool,eventSeq:1.5}]},{messages:[{...message,hiddenChain:'private'}]},{messages:[{...message,createdAt:-1}]},{messages:[{...message,turnId:'../bad'}]},{stream:{...stream,turnId:'run-other'}},{context:{...context,snapshotRevision:'bad'}}])assert.throws(()=>projectCanvasAgentSnapshot({...value,...patch},'canvas'));
});

test('R7 optional reasoning timing and tool titles validate and project without breaking legacy snapshots',()=>{
 const message={role:'assistant',text:'Answer',reasoningText:'Public',reasoningStartedAt:100,reasoningEndedAt:800,reasoningDurationMs:500};
 const stream={attemptId:'a',turnId:'r',text:'',status:'streaming',reasoning:true,reasoningText:'Public',reasoningStartedAt:100,reasoningDurationMs:200,reasoningActiveStartedAt:700};
 const tool={callId:'c',name:'canvas_apply_plan',status:'completed',startedAt:100,endedAt:200,displayTitle:'编辑「节点」',displayTitleEn:'Edit “Node”'};
 const value={...base,runId:'r',messages:[message],stream,tools:[tool]};
 const safe=projectCanvasAgentSnapshot(value,'canvas');assert.deepEqual(safe.messages[0],message);assert.deepEqual(safe.stream,stream);assert.deepEqual(safe.tools?.[0],tool);
 assert.deepEqual(projectCanvasAgentSnapshot({...base,messages:[{role:'assistant',text:'Old',reasoningText:'Old public'}]},'canvas').messages,[{role:'assistant',text:'Old',reasoningText:'Old public'}]);
 for(const bad of [{reasoningStartedAt:-1},{reasoningStartedAt:100,reasoningEndedAt:50},{reasoningDurationMs:10},{reasoningStartedAt:100,reasoningDurationMs:1.2},{reasoningStartedAt:100,reasoningActiveStartedAt:50}]) {
  assert.throws(()=>projectCanvasAgentSnapshot({...value,stream:{...stream,reasoningStartedAt:undefined,reasoningDurationMs:undefined,reasoningActiveStartedAt:undefined,...bad}},'canvas'));
 }
 assert.throws(()=>projectCanvasAgentSnapshot({...value,tools:[{...tool,displayTitle:'x'.repeat(241)}]},'canvas'));
 assert.throws(()=>projectCanvasAgentSnapshot({...value,messages:[{...message,reasoningActiveStartedAt:100}]},'canvas'));
});

test('R7B uncertain start and recovered predecessor use receipt-specific guidance, never disconnected advice',()=>{
 for(const code of ['canvas-agent-start-unconfirmed','canvas-agent-start-recovered','canvas-agent-previous-request-recovered']){
  assert.doesNotMatch(canvasAgentErrorMessage(code),/未连接|LSH|暂不可用/);
  assert.doesNotMatch(canvasAgentErrorMessage(code,true),/unavailable|LSH|Reconnect/);
 }
 assert.match(canvasAgentErrorMessage('canvas-agent-intent-fingerprint-failed'),/尚未发送/);
 assert.match(canvasAgentErrorMessage('canvas-agent-start-unconfirmed'),/阻止重复/);
 assert.match(canvasAgentErrorMessage('canvas-agent-previous-request-recovered'),/新草稿已保留/);
});

test('LSH failure detail is bounded public text tied only to a failed snapshot',()=>{
 const failed={...base,status:'failed',error:'canvas-agent-unavailable',errorDetail:{message:'模型调用失败：余额不足，请检查 LSH 配置。'}};
 assert.deepEqual(projectCanvasAgentSnapshot(failed,'canvas').errorDetail,failed.errorDetail);
 for(const errorDetail of [null,[],{}, {message:''},{message:'   '},{message:42},{message:'x'.repeat(2001)},{message:'字'.repeat(667)},{message:'bad\u0000message'},{message:'bad\rmessage'},{message:'bad\u0085message'},{message:'bad\u202emessage'},{message:'bad\u061cmessage'},{message:'message',stack:'private'}])
  assert.throws(()=>projectCanvasAgentSnapshot({...failed,errorDetail},'canvas'),/response-invalid/);
 for(const status of ['idle','running','completed','cancelled'])assert.throws(()=>projectCanvasAgentSnapshot({...failed,status},'canvas'),/response-invalid/);
 assert.throws(()=>projectCanvasAgentSnapshot({...failed,error:undefined},'canvas'),/response-invalid/);
 assert.equal(projectCanvasAgentSnapshot({...failed,errorDetail:undefined},'canvas').errorDetail,undefined,'legacy snapshots remain compatible');
});

 test('error detail direct projector and snapshot boundary both reject CR but allow LF/TAB',()=>{
  assert.throws(()=>projectCanvasAgentErrorDetail({message:'failure\rreason'}),/response-invalid/);
  const errorDetail={message:'failure\nreason\tmore'};
  assert.deepEqual(projectCanvasAgentErrorDetail(errorDetail),errorDetail);
  assert.deepEqual(projectCanvasAgentSnapshot({...base,status:'failed',error:'canvas-agent-model-failed',errorDetail},'canvas').errorDetail,errorDetail);
 });

test('verified LSH stable error classes do not collapse quota, rate limit and empty response into global unavailability',()=>{
 for(const code of ['canvas-agent-quota-exceeded','canvas-agent-rate-limit','canvas-agent-model-context-limit','canvas-agent-empty-response','canvas-agent-account-sign-in-required']){
  for(const english of [false,true])assert.doesNotMatch(canvasAgentErrorMessage(code,english),/Agent.*unavailable|Agent 暂不可用/);
 }
 assert.match(canvasAgentErrorMessage('canvas-agent-quota-exceeded'),/额度/);
 assert.match(canvasAgentErrorMessage('canvas-agent-rate-limit'),/速率/);
 assert.match(canvasAgentErrorMessage('canvas-agent-empty-response'),/原因未知/);
});
