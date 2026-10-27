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
  const service = createCanvasAgentService(runtime.ctx, { stateDirectory, onReasoningDiagnostic: options.onReasoningDiagnostic });
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

// Contract fixtures follow published @deepseek-ai/dsh-agent-loop 0.2.1-rc.2
// AssistantStreamAttempt: revision increments on EVERY frame, durable append
// precedes end, committed outcome identifies eventType + seq. Synthetic content;
// these are adapter tests, not provider/native execution evidence.
function streamEmitter(emit, attemptId = 'session-attempt:1', startRevision = 0, turn = 1, step = 1) {
 let revision = startRevision, index = 0;
 const frame = value => { const f = { attemptId, revision: ++revision, ...value }; emit('agent/assistant-stream', { frame:f }); return f; };
 frame({type:'start',turn,step});
 return { chunk: chunk => frame({type:'chunk',index:index++,time:1000+index,chunk}),
  end: (seq, eventType='assistant/message') => frame({type:'end',index,outcome:seq === null ? {kind:'abandoned'} : {kind:'committed',eventType,seq}}) };
}
const messageEvent = (seq, content, extra={}) => ({seq,type:'assistant/message',data:{turn:1,step:1,message:{content},...extra}});
const assistants = snapshot => snapshot.messages.filter(m=>m.role==='assistant');

test('R14 real monotonically increasing frame revisions deliver live deltas and preserve missing durable reasoning on exact commit',async t=>{
 let release;const gate=new Promise(r=>release=r);let diagnostics=[];
 const {service,stateDirectory,ctx}=await fixture(t,{onReasoningDiagnostic:d=>diagnostics.push(d),onPrompt:async({emit,agent})=>{
  const stream=streamEmitter(emit);const f=stream.chunk({type:'reasoning-delta',text:'Public thought'});
  emit('agent/assistant-stream',{frame:f}); // replay must not double it
  stream.chunk({type:'text-delta',text:'Answer'});await gate;
  emit('session/event',agent.session,messageEvent(10,[{type:'text',text:'Answer'}]));
  stream.end(10);
 }});
 await service.dispatch(request());const live=await waitFor(service,s=>s.stream?.text==='Answer');
 assert.equal(live.stream.reasoningText,'Public thought');release();const final=await eventually(service);
 assert.equal(assistants(final).length,1);assert.equal(assistants(final)[0].reasoningText,'Public thought');
 assert.equal(assistants(final)[0].attemptId,'session-attempt:1');
 const end=diagnostics.find(d=>d.stage==='stream-end');assert.equal(end.reasoningChars,14);assert.equal(end.preservedChars,14);
 assert(!JSON.stringify(diagnostics).includes('Public thought'));assert(!JSON.stringify(diagnostics).includes('Answer'));
 assert(diagnostics.every(d=>Object.values(d).every(v=>['string','number','boolean'].includes(typeof v))));
 const saved=await Promise.all((await readdir(stateDirectory)).filter(f=>f.endsWith('.json')).map(f=>readFile(join(stateDirectory,f),'utf8')));
 assert(saved.every(s=>!s.includes('stream-end')&&!s.includes('reasoningChunks')));
 await service.dispose();const cold=createCanvasAgentService(ctx,{stateDirectory});t.after(()=>cold.dispose());
 const loaded=await cold.dispatch({op:'status',canvasId:'canvas-test'});assert.deepEqual(loaded.messages,final.messages);
});

test('R14 durable blocks win over differing embedded and live reasoning, replay does not duplicate',async t=>{
 const {service}=await fixture(t,{onPrompt:async({emit,agent})=>{
  const stream=streamEmitter(emit);stream.chunk({type:'reasoning-delta',text:'Live prefix'});
  const event=messageEvent(1,[{type:'reasoning',text:'Canonical public explanation'},{type:'text',text:'Answer'}],{stream:[{type:'reasoning-chunks',texts:['Embedded different']}]});
  emit('session/event',agent.session,event);stream.end(1);emit('session/event',agent.session,event);
 }});
 await service.dispatch(request());const final=await eventually(service);
 assert.equal(assistants(final).length,1);assert.equal(assistants(final)[0].reasoningText,'Canonical public explanation');
});

test('R14 same-event compact public reasoning survives without live delivery and excludes answer/tool/replay state',async t=>{
 const {service}=await fixture(t,{onPrompt:async({emit,agent})=>emit('session/event',agent.session,messageEvent(1,[{type:'text',text:'Answer'}],{stream:[
  {type:'text-chunks',texts:['Not reasoning']},{type:'reasoning-chunks',time0:100,index:0,dt:[0,2],texts:['Public ','reasoning']},
  {type:'tool-call-chunks',args:['SECRET TOOL ARGS']},{type:'chunk',chunk:{type:'finish',replayState:{reasoning:'HIDDEN'}}}
 ]}))});
 await service.dispatch(request());const final=await eventually(service);
 assert.equal(assistants(final)[0].reasoningText,'Public reasoning');assert.equal(assistants(final)[0].reasoningStartedAt,undefined);
 assert(!JSON.stringify(final).includes('HIDDEN'));assert(!JSON.stringify(final).includes('SECRET TOOL ARGS'));
});

test('R14 no public reasoning never infers reasoning from answer or tool events',async t=>{
 const {service}=await fixture(t,{onPrompt:async({emit,agent})=>{
  const stream=streamEmitter(emit);stream.chunk({type:'text-delta',text:'I will think about this'});
  emit('session/event',agent.session,messageEvent(1,[{type:'text',text:'I will think about this'}]));stream.end(1);
 }});
 await service.dispatch(request());const final=await eventually(service);assert.equal(assistants(final)[0].reasoningText,undefined);
});

for(const mismatch of ['seq','turn','step','session'])test(`R14 ${mismatch} mismatch cannot associate a live reasoning prefix`,async t=>{
 const {service}=await fixture(t,{onPrompt:async({emit,agent})=>{
  const stream=streamEmitter(emit);stream.chunk({type:'reasoning-delta',text:'Must not attach'});
  emit('session/event',mismatch==='session'?{id:'another-session'}:agent.session,messageEvent(4,[{type:'text',text:'Answer'}],mismatch==='turn'?{turn:2}:mismatch==='step'?{step:2}:{}));
  stream.end(mismatch==='seq'?5:4);
 }});
 await service.dispatch(request());const final=await eventually(service);assert(assistants(final).every(m=>!m.reasoningText));
});

test('R14 failed/retried attempt does not become assistant message or leak into next sample',async t=>{
 const {service}=await fixture(t,{onPrompt:async({emit,agent})=>{
  const failed=streamEmitter(emit,'retry:1');failed.chunk({type:'reasoning-delta',text:'Failed prefix'});
  emit('session/event',agent.session,{seq:1,type:'assistant/attempt',data:{turn:1,step:1,stream:[]}});failed.end(1,'assistant/attempt');
  const next=streamEmitter(emit,'retry:2',10);next.chunk({type:'text-delta',text:'Good answer'});
  emit('session/event',agent.session,messageEvent(2,[{type:'text',text:'Good answer'}]));next.end(2);
 }});
 await service.dispatch(request());const final=await eventually(service);assert.equal(assistants(final).length,1);assert.equal(assistants(final)[0].reasoningText,undefined);
});

test('R14 interrupted committed message retains public prefix without marking it as a completed live stream',async t=>{
 const {service}=await fixture(t,{onPrompt:async({emit,agent})=>{
  const stream=streamEmitter(emit);stream.chunk({type:'reasoning-delta',text:'Partial public prefix'});
  emit('session/event',agent.session,messageEvent(1,[],{interrupted:true}));stream.end(1);
 }});
 await service.dispatch(request());const final=await eventually(service);assert.equal(assistants(final)[0].reasoningText,'Partial public prefix');assert.equal(final.stream.status,'interrupted');
});

test('R14 abandoned stream remains interrupted, and later stray deltas/end cannot fabricate durable history',async t=>{
 const {service}=await fixture(t,{onPrompt:async({emit})=>{
  const stream=streamEmitter(emit);stream.chunk({type:'reasoning-delta',text:'Visible abandoned prefix'});stream.end(null);
  stream.chunk({type:'reasoning-delta',text:'BAD late data'});stream.end(1);
 }});
 await service.dispatch(request());const final=await eventually(service);assert.equal(assistants(final).length,0);assert.equal(final.stream.reasoningText,'Visible abandoned prefix');assert.equal(final.stream.status,'interrupted');
});

test('R14 exact commit retains bounded reasoning prefix and multiple steps remain distinct',async t=>{
 const {service}=await fixture(t,{onPrompt:async({emit,agent})=>{
  for(let step=1;step<=3;step++){
   const stream=streamEmitter(emit,`sample:${step}`,step*100,1,step);stream.chunk({type:'reasoning-delta',text:String(step).repeat(65000)});
   emit('session/event',agent.session,messageEvent(step,[{type:'text',text:`Answer ${step}`}],{step}));stream.end(step);
  }
 }});
 await service.dispatch(request());const final=await eventually(service);assert.equal(assistants(final).length,3);
 for(let i=0;i<3;i++)assert.equal(assistants(final)[i].reasoningText,String(i+1).repeat(64000));
});

test('R14 diagnostics observer failures cannot break message processing',async t=>{
 const {service}=await fixture(t,{onReasoningDiagnostic:()=>{throw Error('observer failed')},onPrompt:async({emit,agent})=>{
  const stream=streamEmitter(emit);stream.chunk({type:'reasoning-delta',text:'Public'});
  emit('session/event',agent.session,messageEvent(1,[{type:'text',text:'Done'}]));stream.end(1);
 }});
 await service.dispatch(request());const final=await eventually(service);assert.equal(final.status,'completed');assert.equal(assistants(final)[0].reasoningText,'Public');
});

test('R14 replays frames actually produced by published DSH AssistantStreamAttempt and assembler offline',async t=>{
 const official=JSON.parse(await readFile(new URL('./fixtures/dsh-0.2.1-rc.2-assistant-stream.json',import.meta.url),'utf8'));
 assert.deepEqual(official.events.filter(e=>e.kind==='frame').map(e=>e.frame.revision),[1,2,3,4]);
 const {service}=await fixture(t,{onPrompt:async({emit,agent})=>{
  for(const entry of official.events)entry.kind==='frame'?emit('agent/assistant-stream',{frame:entry.frame}):emit('session/event',agent.session,entry.event);
 }});
 await service.dispatch(request());const final=await eventually(service);assert.equal(final.stream.text,'Fixture answer.');assert.equal(final.stream.reasoningText,'Public fixture reasoning.');
 assert.equal(assistants(final)[0].reasoningText,'Public fixture reasoning.');
});

test('R14 cancel preserves only exact interrupted committed public prefix',async t=>{
 const {service}=await fixture(t,{onPrompt:async({emit,agent,exec})=>{
  const stream=streamEmitter(emit);stream.chunk({type:'reasoning-delta',text:'Cancelled prefix'});
  await new Promise(resolve=>exec.signal.addEventListener('abort',resolve,{once:true}));
  emit('session/event',agent.session,messageEvent(1,[],{interrupted:true}));stream.end(1);
 }});
 await service.dispatch(request());const live=await waitFor(service,s=>s.stream?.reasoningText==='Cancelled prefix');
 await service.dispatch({op:'cancel',canvasId:'canvas-test',runId:live.runId});const final=await eventually(service);
 assert.equal(final.status,'cancelled');assert.equal(assistants(final)[0].reasoningText,'Cancelled prefix');assert.equal(final.stream.status,'interrupted');
});

test('R14 resumed run reuses official attemptId safely and ignores old setup events',async t=>{
 let count=0,oldEmit,oldAgent;
 const {service}=await fixture(t,{onPrompt:async({emit,agent})=>{
  count++;
  const stream=streamEmitter(emit,'same-session:1',0,count,1);
  if(count===1){oldEmit=emit;oldAgent=agent;stream.chunk({type:'reasoning-delta',text:'First reasoning'});}
  else {oldEmit('session/event',oldAgent.session,messageEvent(99,[{type:'reasoning',text:'Old late leak'}]));stream.chunk({type:'reasoning-delta',text:'Second reasoning'});}
  emit('session/event',agent.session,messageEvent(count,[{type:'text',text:`Answer ${count}`}],{turn:count}));stream.end(count);
 }});
 await service.dispatch(request('first'));const first=await eventually(service);
 await service.dispatch(request('second'));const second=await eventually(service);
 assert.equal(assistants(second).length,2);assert.deepEqual(assistants(second).map(m=>m.reasoningText),['First reasoning','Second reasoning']);
 assert.deepEqual(assistants(second).map(m=>m.turnId),[first.runId,second.runId]);
});

test('R14 delayed end cannot resurrect a durable message evicted by transcript bounds',async t=>{
 const {service}=await fixture(t,{onPrompt:async({emit,agent})=>{
  const stream=streamEmitter(emit);stream.chunk({type:'reasoning-delta',text:'Trimmed reasoning'});
  emit('session/event',agent.session,messageEvent(1,[{type:'text',text:'Trimmed answer'}]));
  for(let seq=2;seq<8;seq++)emit('session/event',agent.session,messageEvent(seq,[{type:'text',text:String(seq).repeat(64000)}],{step:seq}));
  stream.end(1);
 }});
 await service.dispatch(request());const final=await eventually(service);
 assert(!final.messages.some(m=>m.text==='Trimmed answer'||m.reasoningText==='Trimmed reasoning'));
 assert(final.messages.reduce((n,m)=>n+m.text.length+(m.reasoningText?.length??0),0)<=256000);
});

test('R14 concurrent canvases cannot mix equal attempt IDs or committed sequence numbers',async t=>{
 let ordinal=0,release;const gate=new Promise(resolve=>release=resolve);
 const {service}=await fixture(t,{onPrompt:async({emit,agent})=>{
  const n=++ordinal,stream=streamEmitter(emit,'shared-attempt:1');stream.chunk({type:'reasoning-delta',text:`Public ${n}`});await gate;
  emit('session/event',agent.session,messageEvent(1,[{type:'text',text:`Answer ${n}`} ]));stream.end(1);
 }});
 const other={...request('other'),canvasId:'canvas-other',conversationId:legacyConversation('canvas-other'),context:{...context(),canvasId:'canvas-other'}};
 await Promise.all([service.dispatch(request()),service.dispatch(other)]);release();
 const snapshots=await Promise.all([eventually(service),eventually(service,'canvas-other')]);
 assert.deepEqual(new Set(snapshots.flatMap(s=>assistants(s).map(m=>m.reasoningText))),new Set(['Public 1','Public 2']));
 for(const s of snapshots)assert.equal(assistants(s).length,1);
});
