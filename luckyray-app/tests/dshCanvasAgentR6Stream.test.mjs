import * as receiptIo from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  advanceCanvasAgentActivity, createCanvasAgentService, validateCanvasGraphOperations, validateCanvasAgentPlan, validateCanvasAgentRequest, writeCanvasAgentReceipt,
} from "../src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/luckyray-dsh-canvas-agent.mjs";

const legacyConversation = id => `legacy-${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;

const context = () => ({ version: 1, canvasId: "canvas-test", canvasName: "Test canvas",
  nodes: [{ id: "source", kind: "text", title: "Source", text: "A short film about rain", editable: true, revision: "0123456789abcdef" }],
  connections: [], generation: { imageModels: ["image-model"], videoModels: ["video-model"], imageReady: true, videoReady: true } });
const request = (requestId = "request-one") => ({ op: "start", canvasId: "canvas-test", conversationId: legacyConversation("canvas-test"), requestId,
  prompt: "Create a storyboard", context: context() });
const proposal = () => ({ title: "Storyboard", summary: "A rain scene and a follow-up shot, awaiting approval.", steps: [
  { id: "new-text", kind: "text", title: "Script", content: "Rain on a quiet street.", references: ["source"] },
  { id: "new-image", kind: "image", title: "Establishing shot", content: "A cinematic rainy street at dusk.", references: ["new-text"] },
] });

async function eventually(service, canvasId = "canvas-test") {
  for (let attempts = 0; attempts < 200; attempts++) {
    const status = await service.dispatch({ op: "status", canvasId });
    // A terminal projection can precede the final durable save. Windows I/O
    // makes this boundary observable; rotation must wait for the active task.
    if (status.status !== "running" && !service.hasActiveRuns()) return status;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("Canvas Agent did not settle");
}

function fakeRuntime({ onPrompt, modalities = ["text"], resolveModel } = {}) {
  const calls = [], handles = [], saved = new Set();
  let currentModel = "model-one";
  const ctx = {
    sessionPersistence: {}, sessions: { flush: async () => true },
    agentDefaultModel: { currentSelection: () => ({ provider: "test", model: currentModel, reasoningEffort: "medium" }) },
    llm: { listProviders: () => [{id:"test",name:"Test"}],
      listModels: async provider => ["model-one","model-two"].map(id => ({provider,id,name:id,inputModalities:modalities})),
      resolveModelInfo: resolveModel ?? (async (provider, model) => ({ provider, id: model, inputModalities: modalities })) },
    attachments: { admitPromptContent: async parts => parts.map(part => part.type === "image"
      ? { type: "image", attachment: { attachmentId: "safe-attachment", mediaType: part.mediaType, width: 1, height: 1, bytes: 1 } } : part) },
  };
  const open = async (options, resume) => {
    const sessionId = resume ? options.resumeSessionId : options.sessionId;
    if (resume) assert.ok(saved.has(sessionId), "same official persisted identity must be resumed");
    saved.add(sessionId);
    const listeners = new Map(), tools = new Map(), scopeCalls = [];
    const emit = (name, ...args) => { for (const fn of listeners.get(name) ?? []) fn(...args); };
    let idle = Promise.resolve(), abort;
    const agent = { id: sessionId, session: { id: sessionId },
      followup(message) {
        calls.push({ options, message, tools, scopeCalls });
        abort = new AbortController();
        idle = (async () => {
          try {
            const exec = { signal: abort.signal, concludeTurn() {} };
            if (onPrompt) await onPrompt({ message, tools, exec, emit, agent });
            else {
              await tools.get("canvas_read_context").execute({}, exec);
              const result = await tools.get("canvas_propose_plan").execute(proposal(), exec);
              assert.equal(result.status, "proposed_not_executed");
            }
            emit("session/event", agent.session, { type: "turn/end", data: { reason: { kind: abort.signal.aborted ? "aborted" : "completed" } } });
          } catch (error) {
            emit("agent/error", { error });
            emit("session/event", agent.session, { type: "turn/end", data: { reason: { kind: abort.signal.aborted ? "aborted" : "error" } } });
          }
        })();
      },
      whenIdle: () => idle,
      cancel: () => abort?.abort(),
    };
    const agentCtx = { tools: {
      restrict: value => scopeCalls.push(["restrict", value]),
      presentAs: value => scopeCalls.push(["presentAs", value]),
      guard: value => scopeCalls.push(["guard", value]),
      register: definition => tools.set(definition.name, definition),
    }, systemPrompt: { section: value => scopeCalls.push(["section", value]) },
    on(name, listener) { listeners.set(name, [...listeners.get(name) ?? [], listener]); return () => {}; } };
    await options.setup(agentCtx, agent);
    const handle = { agent, dispose: async () => { agent.cancel(); await idle; } };
    handles.push(handle);
    return handle;
  };
  ctx.get = name => ctx[name];
  ctx.agents = { create: options => open(options, false), resume: options => open(options, true) };
  return { ctx, calls, handles, setModel: model => { currentModel = model; } };
}

async function fixture(t, options = {}) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "canvas-agent-test-"));
  const runtime = fakeRuntime(options);
  const service = createCanvasAgentService(runtime.ctx, { stateDirectory });
  t.after(async () => { await service.dispose(); await rm(stateDirectory, { recursive: true, force: true }); });
  return { ...runtime, service, stateDirectory };
}

async function waitFor(service, predicate) {
  for (let i = 0; i < 200; i++) {
    const state = await service.dispatch({ op: 'status', canvasId: 'canvas-test' });
    if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Expected runtime state did not arrive');
}
const autonomous = (id = 'autonomous-one', jobs = 2) => ({ ...request(id), execution: { mode: 'autonomous', allowGeneration: true, maxMediaJobs: jobs } });
const actionReply = (snapshot, overrides = {}) => ({ op: 'actionResult', canvasId: snapshot.canvasId, runId: snapshot.runId,
  actionId: snapshot.pendingAction.actionId, result: { status: 'completed', summary: 'Applied actual nodes', generatedJobs: 0, context: context(), ...overrides } });

// Match the official start/chunk/end and durable SessionSeq contracts, not an
// imagined token-per-message protocol. No provider request is made by this fixture.
test('R6 one stream accumulates 100 real deltas; duplicate start/chunks and wrong revisions cannot fragment or repeat it', async t => {
  let release; const held = new Promise(r => { release = r; });
  const {service} = await fixture(t,{onPrompt:async({emit,agent})=>{
    const send=frame=>emit('agent/assistant-stream',{frame});
    send({type:'start',attemptId:'attempt-1',revision:1,turn:1,step:1});
    for(let index=0;index<100;index++) {
      const f={type:'chunk',attemptId:'attempt-1',revision:index+2,index,chunk:{type:'reasoning-delta',text:'思'}};
      send(f); send(f);
      send({type:'start',attemptId:'attempt-1',revision:1,turn:1,step:1});
    }
    send({type:'start',attemptId:'stale-attempt',revision:0,turn:1,step:0});
    send({type:'chunk',attemptId:'attempt-1',revision:0,index:100,chunk:{type:'reasoning-delta',text:'BAD'}});
    await held;
    const event={seq:10,type:'assistant/message',data:{turn:1,step:1,message:{id:'official-message-1',content:[{type:'reasoning',text:'思'.repeat(100)},{type:'text',text:'完成'}]}}};
    emit('session/event',agent.session,event); emit('session/event',agent.session,event);
    send({type:'end',attemptId:'attempt-1',revision:102,index:100,outcome:{kind:'committed',eventType:'assistant/message',seq:10}});
  }});
  await service.dispatch(request());
  const live=await waitFor(service,s=>s.stream?.reasoningText?.length===100);
  assert.equal(live.messages.filter(m=>m.role==='assistant').length,0);
  assert.equal(live.stream.reasoningText,'思'.repeat(100)); assert.equal(live.stream.turnId,live.runId);
  release();const final=await eventually(service);const messages=final.messages.filter(m=>m.role==='assistant');
  assert.equal(messages.length,1);assert.equal(messages[0].turnId,final.runId);assert.equal(messages[0].attemptId,'attempt-1');
  assert.ok(messages[0].messageId);assert.equal(messages[0].reasoningText,'思'.repeat(100));assert.equal(messages[0].text,'完成');
});

test('R6 multiple genuine model steps retain separate content identities but share one user turn; same tool call replay is idempotent',async t=>{
 const {service}=await fixture(t,{onPrompt:async({emit,agent})=>{
  for(let step=1;step<=3;step++){
   emit('agent/assistant-stream',{frame:{type:'start',attemptId:`attempt-${step}`,revision:step,turn:1,step}});
   emit('session/event',agent.session,{seq:step*2,type:'assistant/message',data:{turn:1,step,message:{content:[{type:'reasoning',text:'可见推理'},{type:'text',text:step===3?'完成':'继续'}]}}});
   const call={seq:step*2+1,type:'tool/call',data:{callId:`call-${step}`,name:'canvas_read_context'}};
   emit('session/event',agent.session,call);emit('session/event',agent.session,call);
   emit('session/event',agent.session,{type:'tool/result',data:{message:{toolCallId:`call-${step}`,isError:step===2}}});
  }
 }});
 await service.dispatch(request());const final=await eventually(service);
 const messages=final.messages.filter(m=>m.role==='assistant');assert.equal(messages.length,3);
 assert.equal(new Set(messages.map(m=>m.messageId)).size,3);assert.equal(new Set(final.messages.map(m=>m.turnId)).size,1);
 assert.equal(final.tools.length,3);assert(final.tools.every(t=>t.turnId===final.runId));assert.equal(final.tools[1].status,'failed');
 assert.deepEqual(messages.map(m=>m.eventSeq),[2,4,6]);assert.deepEqual(final.tools.map(t=>t.eventSeq),[3,5,7]);
});

test('R6 successive user runs keep prior tool ownership and cold snapshot identity; no reasoning is synthesized',async t=>{
 let seq=1;
 const options={onPrompt:async({emit,agent})=>{
  emit('session/event',agent.session,{seq:seq++,type:'assistant/message',data:{message:{content:[{type:'text',text:'Plain answer'}]}}});
  emit('session/event',agent.session,{type:'tool/call',data:{callId:`call-${seq}`,name:'canvas_read_context'}});
  emit('session/event',agent.session,{type:'tool/result',data:{message:{toolCallId:`call-${seq}`,isError:false}}});
 }};
 const {service,stateDirectory}=await fixture(t,options);
 await service.dispatch(request('first'));const first=await eventually(service);
 await service.dispatch(request('second'));const second=await eventually(service);
 assert.notEqual(first.runId,second.runId);assert.equal(second.tools.length,2);assert.deepEqual(second.tools.map(t=>t.turnId),[first.runId,second.runId]);
 assert(second.messages.every(m=>!m.reasoningText));
 const cold=createCanvasAgentService(fakeRuntime().ctx,{stateDirectory});t.after(()=>cold.dispose());
 const loaded=await cold.dispatch({op:'status',canvasId:'canvas-test'});
 assert.deepEqual(loaded.messages,second.messages);assert.deepEqual(loaded.tools,second.tools);
});

test('R6 legacy fragments keep user boundaries and last-run tools during upgrade, never attach old tools to a new turn',async t=>{
 const {service,stateDirectory}=await fixture(t,{onPrompt:async({emit,agent})=>emit('session/event',agent.session,{seq:1,type:'assistant/message',data:{message:{content:[{type:'text',text:'New answer'}]}}})});
 const old={canvasId:'canvas-test',conversationId:legacyConversation('canvas-test'),sessionId:null,runId:'run-old',status:'completed',messages:[{role:'user',text:'First'},{role:'assistant',text:'First answer'},{role:'user',text:'Second'},{role:'assistant',text:'',reasoningText:'First fragment'},{role:'assistant',text:'',reasoningText:'Second fragment'},{role:'assistant',text:'Second answer'}],tools:[{callId:'old-call',name:'canvas_read_context',status:'completed',startedAt:1,endedAt:2}]};
 await writeFile(join(stateDirectory,`${createHash('sha256').update('canvas-test').digest('hex')}.json`),JSON.stringify({version:2,snapshot:old,requests:[]}));
 const loaded=await service.dispatch({op:'status',canvasId:'canvas-test'});
 assert.equal(loaded.messages.length,6);assert.equal(loaded.messages[2].turnId,'run-old');assert(loaded.messages.slice(2).every(m=>m.turnId==='run-old'));assert.equal(loaded.tools[0].turnId,'run-old');assert.notEqual(loaded.messages[0].turnId,'run-old');
 assert(loaded.messages.every(m=>m.createdAt===undefined),'upgrade must not invent historical timestamps');
 await service.dispatch(request('after-upgrade'));const final=await eventually(service);
 assert.notEqual(final.runId,'run-old');assert.equal(final.tools[0].turnId,'run-old');assert.equal(final.messages.at(-1).turnId,final.runId);
 assert.deepEqual(final.messages.slice(0,6).map(({turnId,...m})=>m),old.messages);
});

test('R6 current stream phase changes reasoning → text → tool/settled while keeping public reasoning content',async t=>{
 const releases=[];const gates=Array.from({length:3},()=>new Promise(resolve=>releases.push(resolve)));
 const {service}=await fixture(t,{onPrompt:async({emit,agent})=>{
  let revision=0; const send=frame=>emit('agent/assistant-stream',{frame:{attemptId:'phase-attempt',revision:++revision,...frame}});
  send({type:'start',turn:1,step:1});
  send({type:'chunk',index:0,chunk:{type:'reasoning-delta',text:'Visible analysis'}});await gates[0];
  send({type:'chunk',index:1,chunk:{type:'text-delta',text:'Visible answer'}});await gates[1];
  emit('session/event',agent.session,{seq:1,type:'assistant/message',data:{turn:1,step:1,message:{content:[{type:'reasoning',text:'Visible analysis'},{type:'text',text:'Visible answer'}]}}});
  emit('session/event',agent.session,{type:'tool/call',data:{callId:'phase-call',name:'canvas_read_context'}});await gates[2];
  send({type:'end',index:2,outcome:{kind:'committed',eventType:'assistant/message',seq:1}});
 }});
 await service.dispatch(request('phase-test'));
 const reasoning=await waitFor(service,s=>s.stream?.reasoningText==='Visible analysis');assert.equal(reasoning.stream.reasoning,true);assert.equal(reasoning.stream.reasoningDurationMs,0);assert.equal(reasoning.stream.reasoningActiveStartedAt,reasoning.stream.reasoningStartedAt);
 releases[0]();const writing=await waitFor(service,s=>s.stream?.text==='Visible answer');assert.equal(writing.stream.reasoning,false);assert.equal(writing.stream.status,'streaming');assert.equal(writing.stream.reasoningText,'Visible analysis');
 releases[1]();const tooling=await waitFor(service,s=>s.tools?.length===1);assert.equal(tooling.stream.reasoning,false);assert.equal(tooling.stream.status,'settled');assert.equal(tooling.stream.reasoningText,'Visible analysis');
 releases[2]();const final=await eventually(service);assert.equal(final.stream.reasoning,false);assert.equal(final.messages.at(-1).reasoningText,'Visible analysis');
});

test('R6 abandoned reasoning stream is interrupted, not shown as still thinking',async t=>{
 const {service}=await fixture(t,{onPrompt:async({emit})=>{
  let revision=0; for(const frame of [{type:'start',turn:1,step:1},{type:'chunk',index:0,chunk:{type:'reasoning-delta',text:'Visible prefix'}},{type:'end',index:1,outcome:{kind:'abandoned'}}])emit('agent/assistant-stream',{frame:{attemptId:'abandoned-attempt',revision:++revision,...frame}});
 }});
 await service.dispatch(request('abandoned'));const final=await eventually(service);assert.equal(final.stream.status,'interrupted');assert.equal(final.stream.reasoning,false);assert.equal(final.stream.reasoningText,'Visible prefix');assert.equal(final.messages.filter(m=>m.role==='assistant').length,0);
});

test('R7 reasoning timing uses actual delta intervals, excludes text pauses, and survives reload', async t => {
 const oldNow=Date.now;let now=1000;Date.now=()=>now;t.after(()=>{Date.now=oldNow;});
 const {service,stateDirectory,ctx}=await fixture(t,{onPrompt:async({emit,agent})=>{
  let revision=0; const send=frame=>emit('agent/assistant-stream',{frame:{attemptId:'timed-attempt',revision:++revision,...frame}});
  send({type:'start',turn:1,step:1});now=1200;send({type:'chunk',index:0,chunk:{type:'reasoning-delta',text:'First'}});
  now=1700;send({type:'chunk',index:1,chunk:{type:'text-delta',text:'Partial'}});
  now=5700;send({type:'chunk',index:2,chunk:{type:'reasoning-delta',text:' second'}});
  now=6000;send({type:'end',index:3,outcome:{kind:'committed'}});
  emit('session/event',agent.session,{seq:1,type:'assistant/message',data:{turn:1,step:1,message:{content:[{type:'reasoning',text:'First second'},{type:'text',text:'Done'}]}}});
 }});
 await service.dispatch(request('timing'));const result=await eventually(service);const m=result.messages.at(-1);
 assert.equal(m.reasoningStartedAt,1200);assert.equal(m.reasoningEndedAt,6000);assert.equal(m.reasoningDurationMs,800);
 assert.equal(result.stream.reasoningActiveStartedAt,undefined);assert.equal(result.stream.reasoningDurationMs,800);
 await service.dispose();const fresh=createCanvasAgentService(ctx,{stateDirectory});t.after(()=>fresh.dispose());
 const loaded=await fresh.dispatch({op:'status',canvasId:'canvas-test'});assert.deepEqual(loaded.messages.at(-1),m);
});

test('R7 assistant messages without public delta timing do not invent elapsed reasoning', async t => {
 const {service}=await fixture(t,{onPrompt:async({emit,agent})=>emit('session/event',agent.session,{seq:1,type:'assistant/message',data:{message:{content:[{type:'reasoning',text:'Published but untimed'},{type:'text',text:'Done'}]}}})});
 await service.dispatch(request('untimed'));const result=await eventually(service);
 assert.equal(result.messages.at(-1).reasoningDurationMs,undefined);assert.equal(result.messages.at(-1).reasoningStartedAt,undefined);
});

test('R7 validated tool labels use actual nodes and plans, and never attach ambiguous concurrent labels', async t => {
 const {service}=await fixture(t,{onPrompt:async({emit,agent,tools,exec})=>{
  const call=(callId,name)=>emit('session/event',agent.session,{type:'tool/call',data:{callId,name}});
  const done=callId=>emit('session/event',agent.session,{type:'tool/result',data:{message:{toolCallId:callId,isError:false}}});
  call('read-one','canvas_read_context');await tools.get('canvas_read_context').execute({nodeIds:['source']},exec);done('read-one');
  call('plan-one','canvas_propose_plan');await tools.get('canvas_propose_plan').execute(proposal(),exec);done('plan-one');
  call('concurrent-a','canvas_read_context');call('concurrent-b','canvas_read_context');await tools.get('canvas_read_context').execute({nodeIds:['source']},exec);done('concurrent-a');done('concurrent-b');
 }});
 await service.dispatch(request('titles'));const result=await eventually(service);
 assert.equal(result.tools[0].displayTitle,'查看「Source」');assert.equal(result.tools[0].displayTitleEn,'Read “Source”');
 assert.equal(result.tools[1].displayTitle,'整理方案「Storyboard」');assert.equal(result.tools[2].displayTitle,undefined);assert.equal(result.tools[3].displayTitle,undefined);
});

test('R7B cold status and archived resume discard unclosed reasoning times, not content or completed messages', async t => {
 const oldNow=Date.now;const now=Date.UTC(2026,9,21,2);Date.now=()=>now;t.after(()=>{Date.now=oldNow;});
 for (const mode of ['cold','resume']) for (const updatedAt of [Date.UTC(2026,9,20,23,59,59), undefined, now+86400000, 1]) {
  const {service,stateDirectory}=await fixture(t);
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const completed={role:'assistant',text:'Earlier answer',reasoningText:'Earlier public reasoning',reasoningStartedAt:10,reasoningEndedAt:30,reasoningDurationMs:20};
  const saved={version:2,requests:[],snapshot:{canvasId:'canvas-test',conversationId:mode==='cold'?legacyConversation('canvas-test'):'archived-test',sessionId:null,runId:'interrupted-run',status:'running',messages:[completed],activity:[{id:'phase-open',kind:'phase',label:'preparing',status:'running',startedAt:100},{id:'phase-done',kind:'phase',label:'waiting-model',status:'completed',startedAt:10,endedAt:30}],tools:[{callId:'tool-open',name:'canvas_read_context',status:'running',startedAt:200},{callId:'tool-done',name:'canvas_read_context',status:'completed',startedAt:20,endedAt:40}],updatedAt,
   stream:{attemptId:'open-attempt',turnId:'interrupted-run',startedAt:100,text:'Partial reply',reasoningText:'Public prefix',reasoning:true,status:'streaming',reasoningStartedAt:200,reasoningActiveStartedAt:500,reasoningDurationMs:100}}};
  let loaded;
  if(mode==='cold'){
   await writeFile(join(stateDirectory,`${hash('canvas-test')}.json`),JSON.stringify(saved));
   loaded=await service.dispatch({op:'status',canvasId:'canvas-test'});
  } else {
   const folder=join(stateDirectory,'conversations',hash('canvas-test'));await receiptIo.mkdir(folder,{recursive:true});
   await writeFile(join(folder,`${hash('archived-test')}.json`),JSON.stringify(saved));
   const current=await service.dispatch({op:'status',canvasId:'canvas-test'});
   loaded=await service.dispatch({op:'resumeConversation',requestId:'resume-test',canvasId:'canvas-test',conversationId:'archived-test',expectedConversationId:current.conversationId});
  }
  assert.equal(loaded.status,'cancelled');assert.equal(loaded.error,'canvas-agent-interrupted');
  assert.equal(loaded.stream.status,'interrupted');assert.equal(loaded.stream.reasoning,false);
  assert.equal(loaded.stream.reasoningText,'Public prefix');assert.equal(loaded.stream.text,'Partial reply');
  for(const field of ['reasoningStartedAt','reasoningEndedAt','reasoningDurationMs','reasoningActiveStartedAt']) assert.equal(loaded.stream[field],undefined,`${mode}: ${field}`);
  assert.deepEqual(loaded.messages[0],completed);
  for(const entries of [loaded.activity,loaded.tools]) {assert.equal(entries[0].status,'failed');assert.equal(entries[0].endedAt,undefined);assert.equal(entries[1].status,'completed');assert.equal(entries[1].endedAt-entries[1].startedAt,20);}
 }
});
