import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCanvasAgentRequest,validateCanvasAgentResult} from '../src-tauri/dsh-host/luckyray-dsh-host.mjs';
const context={version:1,canvasId:'canvas-1',canvasName:'Canvas',snapshotRevision:'0123456789abcdef',nodes:[],connections:[],generation:{imageModels:[],videoModels:[],imageReady:false,videoReady:false}};
const snapshot=()=>({canvasId:'canvas-1',conversationId:'conversation-1',sessionId:'session-1',runId:'run-2',status:'running',messages:[{role:'assistant',text:'Earlier answer',reasoningText:'Public reasoning',turnId:'run-1',messageId:'message-1',attemptId:'attempt-1',createdAt:1,eventSeq:2}],stream:{attemptId:'attempt-2',turnId:'run-2',startedAt:5,text:'Current output',status:'streaming',reasoning:false},tools:[{callId:'call-1',turnId:'run-1',name:'canvas_read_context',status:'completed',startedAt:1,eventSeq:3,endedAt:3}],context,pendingAction:{actionId:'action-2',runId:'run-2',kind:'readContext',offset:256,expectedRevision:context.snapshotRevision,context}});
const validate=s=>validateCanvasAgentResult(Buffer.from(JSON.stringify(s)).toString('base64url'),'canvas-1');
test('R6 carrier preserves bounded turn, message and attempt identity and explicit context revision',()=>{
 const s=snapshot();assert.deepEqual(validate(s),s);
 assert.doesNotThrow(()=>validateCanvasAgentRequest({op:'start',canvasId:'canvas-1',conversationId:'conversation-1',requestId:'request-1',prompt:'Read',context}));
 for(const key of ['turnId','messageId','attemptId'])assert.throws(()=>validate({...s,messages:[{...s.messages[0],[key]:'../private'}]}));
 for(const eventSeq of [-1,1.5,Number.MAX_SAFE_INTEGER+1,'3']){assert.throws(()=>validate({...s,messages:[{...s.messages[0],eventSeq}]}));assert.throws(()=>validate({...s,tools:[{...s.tools[0],eventSeq}]}));}
 for(const createdAt of [-1,1.2,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>validate({...s,messages:[{...s.messages[0],createdAt}]}));
 for(const field of ['message','stream','tool']){
  const bad=structuredClone(s);if(field==='message')bad.messages[0].hiddenChain='secret';if(field==='stream')bad.stream.hiddenChain='secret';if(field==='tool')bad.tools[0].arguments='secret';assert.throws(()=>validate(bad));
 }
 assert.throws(()=>validate({...s,stream:{...s.stream,turnId:'run-other'}}));
 for(const revision of ['abc','0123456789ABCDEF',12]){
  assert.throws(()=>validate({...s,context:{...context,snapshotRevision:revision}}));
  assert.throws(()=>validate({...s,pendingAction:{...s.pendingAction,expectedRevision:revision}}));
 }
});
test('R6 new metadata remains optional for original R4/R5 transcripts',()=>{
 const s=snapshot();s.messages=[{role:'user',text:'Old question'},{role:'assistant',text:'',reasoningText:'Old visible fragment'}];delete s.stream;delete s.tools;delete s.context;delete s.pendingAction;
 assert.deepEqual(validate(s),s);
});

test('R7 host accepts truthful optional reasoning intervals and bilingual operation titles only',()=>{
 const s=snapshot();Object.assign(s.messages[0],{reasoningStartedAt:100,reasoningEndedAt:800,reasoningDurationMs:500});
 Object.assign(s.stream,{reasoningStartedAt:900,reasoningDurationMs:100,reasoningActiveStartedAt:1100});
 Object.assign(s.tools[0],{displayTitle:'编辑「节点」',displayTitleEn:'Edit “Node”'});assert.deepEqual(validate(s),s);
 for(const field of ['messages','stream'])for(const bad of [{reasoningStartedAt:-1},{reasoningStartedAt:100,reasoningEndedAt:10},{reasoningDurationMs:1.5}]) {
  const v=structuredClone(s);Object.assign(field==='messages'?v.messages[0]:v.stream,bad);assert.throws(()=>validate(v));
 }
 const bad=structuredClone(s);bad.messages[0].reasoningActiveStartedAt=120;assert.throws(()=>validate(bad));
 const big=structuredClone(s);big.tools[0].displayTitle='x'.repeat(241);assert.throws(()=>validate(big));
});
