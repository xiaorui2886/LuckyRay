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
const autonomous = (id = 'autonomous-one', jobs = 2) => ({ ...request(id), execution: { mode: 'autonomous', allowGeneration: jobs>0, maxMediaJobs: jobs } });
const actionReply = (snapshot, overrides = {}) => ({ op: 'actionResult', canvasId: snapshot.canvasId, runId: snapshot.runId,
  actionId: snapshot.pendingAction.actionId, result: { status: 'completed', summary: 'Applied actual nodes', generatedJobs: 0, context: context(), ...overrides } });


// Test-only DSH runtime: registrations, service dispatch, receipts and render are
// production code. No provider/model inference or real media generation runs.
import {validateCanvasAgentResult as carrierResult} from '../src-tauri/dsh-host/luckyray-dsh-host.mjs';
const revision='0123456789abcdef';
const visualContext=()=>({...context(),snapshotRevision:revision,nodes:[{...context().nodes[0],kind:'image',image:{mimeType:'image/png',data:Buffer.from('fixture pixels').toString('base64')}}]});
const nativeResult=()=>({status:'completed',summary:'Native structure read',generatedJobs:0,creation:{version:1,revision,scope:'overview',offset:0,total:0,items:[],completion:'read'}});
async function drive(service,start,makeResult){
 let state=await service.dispatch(start);const seen=new Set();
 for(let i=0;i<300;i++){
  carrierResult(Buffer.from(JSON.stringify(state)).toString('base64url'),'canvas-test');
  assert.equal(Object.hasOwn(state,'taskContext'),false,'durable aid is not public protocol');
  if(state.pendingAction&&!seen.has(state.pendingAction.actionId)){
   const action=state.pendingAction;seen.add(action.actionId);
   await service.dispatch({op:'actionResult',canvasId:state.canvasId,runId:state.runId,actionId:action.actionId,result:makeResult(action)});
  }
  if(state.status!=='running'&&!service.hasActiveRuns())return state;
  await new Promise(r=>setTimeout(r,5));state=await service.dispatch({op:'status',canvasId:'canvas-test'});
 }
 assert.fail('Fixture did not settle');
}
test('registered tools: explicit image rereads are full; native receipts never repeat cached graph or pixels',async t=>{
 const outputs=[];let taskState;const {service}=await fixture(t,{modalities:['text','image'],onPrompt:async({tools,exec})=>{
  for(let i=0;i<2;i++)outputs.push(await tools.get('canvas_read_context').execute({nodeIds:['source'],readMode:'full'},exec));
  outputs.push(await tools.get('canvas_read_creation').execute({scope:'overview'},exec));
  taskState=await tools.get('canvas_read_task_state').execute({},exec);
  for(const output of outputs.slice(0,2)){
   assert.equal(output.context.mode,'full');assert.equal(output.context.nodes.length,1);
   assert.deepEqual(output.context.imageCoverage.attachedNodeIds,['source']);
   assert.equal(tools.get('canvas_read_context').output.render({},output).filter(p=>p.type==='image').length,1);
  }
  assert.deepEqual(outputs[2],nativeResult());
  assert.equal(tools.get('canvas_read_creation').output.render({},outputs[2]).filter(p=>p.type==='image').length,0);
 }});
 const terminal=await drive(service,autonomous('registered-tools',0),a=>a.kind==='readContext'?{status:'completed',summary:'Read image',generatedJobs:0,context:visualContext()}:nativeResult());
 assert.equal(terminal.status,'completed',terminal.error);assert.equal(outputs.length,3);assert.equal(taskState.receipts.length,3);
 assert.equal(taskState.goal,'Create a storyboard');assert.equal(taskState.receipts.at(-1).completion,'read');
 const oldNative={...nativeResult(),context:outputs[1].context,imageContents:outputs[1].imageContents};
 t.diagnostic(JSON.stringify({fixture:'actual-registered-native-tool-result',currentJsonBytes:Buffer.byteLength(JSON.stringify(outputs[2])),reconstructedCachedAppendBytes:Buffer.byteLength(JSON.stringify(oldNative)),currentNativeImages:0,reconstructedNativeImages:1,toolRoundTrips:3,interpretation:'Offline registered-tool/render fixture; no actual tokens, latency, provider quality, or active delta claim.'}));
});
test('registered read: image admission failure never claims attached pixels; later reread retries admission',async t=>{
 const outputs=[];let admissions=0;const f=await fixture(t,{modalities:['text','image'],onPrompt:async({tools,exec})=>{
  for(let i=0;i<2;i++)outputs.push(await tools.get('canvas_read_context').execute({nodeIds:['source']},exec));
  assert.deepEqual(outputs[0].context.imageCoverage.attachedNodeIds,[]);assert.equal(outputs[0].context.nodes[0].imageAttached,undefined);
  assert.equal(outputs[0].context.nodes[0].imageUnavailable,true);
  assert.equal(tools.get('canvas_read_context').output.render({},outputs[0]).filter(p=>p.type==='image').length,0);
  assert.equal(tools.get('canvas_read_context').output.render({},outputs[1]).filter(p=>p.type==='image').length,1);
 }});
 const admit=f.ctx.attachments.admitPromptContent;f.ctx.attachments.admitPromptContent=async p=>{if(++admissions===1)throw Error('fixture admission failure');return admit(p);};
 const terminal=await drive(f.service,autonomous('admission-retry',0),()=>({status:'completed',summary:'Read image',generatedJobs:0,context:visualContext()}));
 assert.equal(terminal.status,'completed',terminal.error);assert.equal(admissions,2);assert.equal(outputs.length,2);
});
test('registered task state survives actual service resume without replacing official session or prior receipt semantics',async t=>{
 let turn=0;const states=[];const f=await fixture(t,{onPrompt:async({tools,exec})=>{
  if(turn++===0)await tools.get('canvas_read_creation').execute({scope:'overview'},exec);
  states.push(await tools.get('canvas_read_task_state').execute({},exec));
 }});
 const first=await drive(f.service,autonomous('resume-first',0),()=>nativeResult());assert.equal(first.status,'completed',first.error);
 const next={...autonomous('resume-second',0),prompt:'Continue, preserving the no-generation constraint'};
 const second=await drive(f.service,next,()=>nativeResult());assert.equal(second.status,'completed',second.error);
 assert.equal(second.sessionId,first.sessionId);assert.equal(f.calls.length,2);assert.equal(f.calls[1].options.resumeSessionId,first.sessionId);
 assert.equal(states[1].goal,next.prompt);assert.equal(states[1].receipts.length,1);assert.equal(states[1].receipts[0].completion,'read');
 assert.match(states[1].notice,/not permission/);
});
test('registered resumed task receipts preserve awaiting-user and applied-unconfirmed distinctly',async t=>{
 for(const completion of ['awaiting-user','applied-unconfirmed'])await t.test(completion,async st=>{
  let turn=0,recovered;const f=await fixture(st,{onPrompt:async({tools,exec})=>{
   if(turn++===0){
    if(completion==='awaiting-user')await tools.get('canvas_open_creation').execute({expectedRevision:revision,panel:'delivery'},exec);
    else await tools.get('canvas_edit_creation').execute({expectedRevision:revision,operation:{op:'storyboard.create',name:'Draft',nodeIds:[]}},exec);
   }else recovered=await tools.get('canvas_read_task_state').execute({},exec);
  }});
  const status=completion==='applied-unconfirmed'?'failed':'completed';
  const receipt={...nativeResult(),status,summary:'Observed creation outcome',creation:{...nativeResult().creation,completion}};
  const first=await drive(f.service,autonomous('receipt-first',0),()=>receipt);
  assert.equal(first.status,status,first.error);
  const next=await drive(f.service,{...autonomous('receipt-next',0),prompt:'Inspect prior result without retrying'},()=>assert.fail('No new action authorized'));
  assert.equal(next.status,'completed',next.error);
  assert.equal(recovered.receipts.length,1);assert.equal(recovered.receipts[0].status,status);assert.equal(recovered.receipts[0].completion,completion);
 });
});
test('actual renderer readContext branch rejects unknown target before selection can return unrelated fill',async()=>{
 const source=await readFile(new URL('../src/CanvasSpike.tsx',import.meta.url),'utf8');
 const start=source.indexOf("    if(action.kind==='readContext') {");
 const end=source.indexOf("    if(action.kind==='editGraph') {",start);
 assert.ok(start>=0&&end>start);
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 const execute=new AsyncFunction('action','signal','nodesRef','edgesRef','agentGraphRevision','selectTaskContext','getCanvasAgentContext','agentContextWorkingSet',source.slice(start,end));
 const forbidden=()=>assert.fail('Unknown target must not become unrelated selection/context');
 await assert.rejects(()=>execute({kind:'readContext',nodeIds:['missing'],readMode:'target'},new AbortController().signal,{current:[{id:'unrelated'}]},{current:[]},()=>revision,forbidden,forbidden,forbidden),/canvas-agent-context-stale/);
});
