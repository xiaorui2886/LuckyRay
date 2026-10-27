import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCanvasAgentRequest,validateCanvasAgentResult,DSH_HOST_MAX_FRAME_BYTES,CANVAS_AGENT_MAX_JSON_BYTES,CANVAS_AGENT_MAX_ENCODED_BYTES} from '../src-tauri/dsh-host/luckyray-dsh-host.mjs';
const context=()=>({version:1,canvasId:'canvas-1',canvasName:'Canvas',nodes:[],connections:[],generation:{imageModels:[],videoModels:[],imageReady:false,videoReady:false}});
const policy=()=>({mode:'autonomous',allowGeneration:false,maxMediaJobs:0});
const start=()=>({op:'start',canvasId:'canvas-1',conversationId:'conversation-1',requestId:'request-1',prompt:'Create a scene',context:context(),execution:policy()});
const snapshot=()=>({canvasId:'canvas-1',conversationId:'conversation-1',sessionId:'session-1',runId:'run-1',status:'running',messages:[]});
const encode=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
const validate=v=>validateCanvasAgentResult(encode(v),'canvas-1');
const plan=()=>({version:1,id:'plan-1',canvasId:'canvas-1',runId:'run-1',title:'Scene',summary:'',steps:[{id:'step-1',kind:'text',title:'Script',content:'Hello',references:[]}]});
test('R5 transport carries bounded autonomous execution and history ops without generic tools',()=>{
 for(const r of [start(),{op:'history',canvasId:'canvas-1'},{op:'resumeConversation',canvasId:'canvas-1',requestId:'request-2',expectedConversationId:'conversation-1',conversationId:'conversation-2'}]) assert.equal(validateCanvasAgentRequest(r),r);
 for(const e of [{...policy(),mode:'shell'},{...policy(),allowGeneration:true},{...policy(),maxMediaJobs:1001},{mode:'plan',allowGeneration:true,maxMediaJobs:1},{...policy(),permission:'all'}]) assert.throws(()=>validateCanvasAgentRequest({...start(),execution:e}));
 assert.throws(()=>validateCanvasAgentRequest({...start(),context:{...context(),canvasId:'other'}}));
 assert.throws(()=>validateCanvasAgentRequest({op:'resumeConversation',canvasId:'canvas-1',conversationId:'../other',requestId:'x',expectedConversationId:'y'}));
});
test('R5 action receipt is scoped, strictly typed and bounded',()=>{
 const r={op:'actionResult',canvasId:'canvas-1',runId:'run-1',actionId:'action-1',result:{status:'completed',summary:'Created node',generatedJobs:0,context:context(),nodes:[{id:'node-1',status:'completed'}]}};
 assert.equal(validateCanvasAgentRequest(r),r);
 for(const patch of [{context:{...context(),canvasId:'other'}},{generatedJobs:-1},{nodes:[{id:'node-1',status:'queued'}]},{summary:'x'.repeat(8001)},{token:'secret'}])assert.throws(()=>validateCanvasAgentRequest({...r,result:{...r.result,...patch}}));
});
test('R5 visible model streaming and tools/history survive native snapshot projection',()=>{
 const s={...snapshot(),messages:[{role:'assistant',text:'Answer',reasoningText:'Provider-visible reasoning'}],stream:{attemptId:'attempt-1',text:'Streaming',status:'streaming',reasoning:true,reasoningText:'Provider stream'},tools:[{callId:'call-1',name:'canvas_apply_plan',status:'completed',startedAt:1,endedAt:2,summary:'Done'}],progress:[{id:'progress-1',summary:'Composing scene',createdAt:1}],conversations:[{conversationId:'conversation-1',sessionId:'session-1',title:'Scene',updatedAt:1,messageCount:2}]};
 assert.deepEqual(validate(s),s);
 for(const patch of [{stream:{...s.stream,status:'raw'}},{stream:{...s.stream,hiddenChain:'forbidden'}},{tools:[{...s.tools[0],endedAt:0}]},{conversations:[{...s.conversations[0],canvasId:'foreign'}]}])assert.throws(()=>validate({...s,...patch}));
});
test('pending actions require exact runtime canvas/run and frozen authorization for writes',()=>{
 const a={actionId:'action-1',runId:'run-1',kind:'applyPlan',plan:plan(),context:context(),execution:policy(),generate:false};
 assert.deepEqual(validate({...snapshot(),pendingAction:a}).pendingAction,a);
 for(const patch of [{runId:'foreign'},{plan:{...plan(),canvasId:'foreign'}},{context:{...context(),canvasId:'foreign'}},{execution:undefined},{context:undefined},{command:'shell'}])assert.throws(()=>validate({...snapshot(),pendingAction:{...a,...patch}}));
 assert.doesNotThrow(()=>validate({...snapshot(),pendingAction:{actionId:'read-1',runId:'run-1',kind:'readContext',nodeIds:['node-1']}}));
});
test('R5 batches expand bounded transport rather than total agent work caps',()=>{
 assert.equal(CANVAS_AGENT_MAX_JSON_BYTES,2*1024*1024);assert(DSH_HOST_MAX_FRAME_BYTES>CANVAS_AGENT_MAX_ENCODED_BYTES);
 const c=context(); c.nodes=Array.from({length:256},(_,i)=>({id:`node-${i}`,kind:'text',title:'Node',text:'small',editable:true,revision:'0123456789abcdef'}));
 assert.doesNotThrow(()=>validateCanvasAgentRequest({...start(),context:c,prompt:'a'.repeat(48000)}));
 assert.throws(()=>validateCanvasAgentRequest({...start(),context:{...c,nodes:[...c.nodes,{...c.nodes[0],id:'node-257'}]}}));
 assert.throws(()=>validateCanvasAgentRequest({...start(),context:{...c,nodes:[...c.nodes,{...c.nodes[0]}]}}));
 assert.throws(()=>validateCanvasAgentRequest({...start(),context:{...context(),nodes:[{...c.nodes[0],image:{mimeType:'image/png',data:Buffer.alloc(128*1024+1).toString('base64')}}]}}));
});

test('actionResult accepts bounded visual context inbound but snapshots never leak image bytes',()=>{
 const c=context();c.nodes=[{id:'image-1',kind:'image',title:'Reference',text:'',editable:true,revision:'0123456789abcdef',image:{mimeType:'image/png',data:Buffer.from([137,80,78,71]).toString('base64')}}];
 assert.doesNotThrow(()=>validateCanvasAgentRequest({op:'actionResult',canvasId:'canvas-1',runId:'run-1',actionId:'action-1',result:{status:'completed',summary:'Visual reference',generatedJobs:0,context:c}}));
 assert.throws(()=>validate({...snapshot(),context:c}));
});
test('editGraph is a scoped bounded geometry/link protocol, never deletion or arbitrary execution',()=>{
 const action={actionId:'edit-1',runId:'run-1',kind:'editGraph',context:context(),execution:policy(),operations:[{op:'move',nodeId:'node-1',x:0,y:-10},{op:'connect',source:'node-1',target:'node-2'},{op:'disconnect',source:'node-2',target:'node-3'},{op:'arrange',nodeIds:['node-1','node-2'],layout:'grid'}]};
 assert.doesNotThrow(()=>validate({...snapshot(),pendingAction:action}));
 for(const op of [{op:'delete',nodeId:'node-1'},{op:'move',nodeId:'node-1',x:1e7,y:0},{op:'connect',source:'node-1',target:'node-1'},{op:'arrange',nodeIds:['node-1','node-1'],layout:'grid'},{op:'arrange',nodeIds:['node-1'],layout:'shell'}])assert.throws(()=>validate({...snapshot(),pendingAction:{...action,operations:[op]}}));
 assert.throws(()=>validate({...snapshot(),pendingAction:{...action,generate:true}}));
 assert.throws(()=>validate({...snapshot(),pendingAction:{...action,execution:{mode:'plan',allowGeneration:false,maxMediaJobs:0}}}));
});
test('shared boundary corpus is accepted by both carrier and official-runtime adapter validators',async()=>{
 const {validateCanvasAgentRequest:runtimeValidate}=await import('../src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/luckyray-dsh-canvas-agent.mjs');
 const c=context();c.canvasName='名'.repeat(256);c.nodes=[{id:'node-1',title:'名'.repeat(256),kind:'image',text:'Content',editable:true,revision:'0123456789abcdef',layout:{x:1e7,y:-1e7,parentId:'group-1'},image:{mimeType:'image/png',data:Buffer.from([137,80,78,71]).toString('base64')}}];
 const corpus=[{...start(),context:c,prompt:'你'.repeat(48000)},{...start(),execution:{mode:'autonomous',allowGeneration:true,maxMediaJobs:1000}},{op:'actionResult',canvasId:'canvas-1',runId:'run-1',actionId:'action-1',result:{status:'completed',summary:'Read visible graph',generatedJobs:0,context:c,nodes:[{id:'node-1',status:'completed',summary:'ok'}]}}];
 for(const request of corpus){assert.doesNotThrow(()=>validateCanvasAgentRequest(request));assert.doesNotThrow(()=>runtimeValidate(request));}
 const noImages={...c,nodes:c.nodes.map(({image,...node})=>node)};
 assert.doesNotThrow(()=>validate({...snapshot(),context:noImages}));
 for(const layout of [{x:1e7+1,y:0},{x:0,y:0,parentId:'../other'},{x:0,y:0,command:'shell'}])assert.throws(()=>validateCanvasAgentRequest({...start(),context:{...c,nodes:[{...c.nodes[0],layout}]}}));
});
