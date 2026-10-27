import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createCanvasAgentService,validateCanvasCreationPayload,validateCanvasAgentRequest as validateAdapterRequest} from '../src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/luckyray-dsh-canvas-agent.mjs';
import {validateCanvasAgentResult,validateCanvasAgentRequest as validateCarrierRequest} from '../src-tauri/dsh-host/luckyray-dsh-host.mjs';
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


const creation=(completion='read')=>({version:1,revision:'0123456789abcdef',scope:'overview',offset:0,total:0,items:[],completion});
const encode=v=>Buffer.from(JSON.stringify(v)).toString('base64url');

import {applyCreation,creationRevision,readCreation} from '../src/core/canvas/agent/creationEngine.ts';
import {prepareCreationHandoff} from '../src/core/canvas/agent/creationHandoff.ts';
test('audit actual engine through adapter receipts',async t=>{
 let graph={canvasId:'canvas-test',nodes:[],edges:[],history:[]},next=0;
 const {service}=await fixture(t,{onPrompt:async({tools,exec})=>{
  const read=await tools.get('canvas_read_creation').execute({scope:'overview'},exec);
  const edit=await tools.get('canvas_edit_creation').execute({expectedRevision:read.creation.revision,operation:{op:'storyboard.create',name:'Audit board'}},exec);
  assert.equal(graph.nodes.length,2);
  const board=graph.nodes.find(n=>n.data.storyboard).id;
  await tools.get('canvas_open_creation').execute({expectedRevision:edit.creation.revision,panel:'storyboardExport',objectId:board},exec);
 }});
 await service.dispatch({...autonomous(),execution:{mode:'autonomous',allowGeneration:false,maxMediaJobs:0}});
 for(const kind of ['readCreation','editCreation','openCreation']){
  const snap=await waitFor(service,s=>s.pendingAction?.kind===kind);const a=snap.pendingAction;let result;
  if(kind==='readCreation')result=readCreation(graph,a.creationQuery);
  if(kind==='editCreation'){const r=applyCreation(graph,a.creationEdit,{createId:()=>`audit-${++next}`,origin:{x:0,y:0}});graph={...graph,...r};result={...readCreation(graph,{scope:'overview'}),completion:'applied'};}
  if(kind==='openCreation'){const handoff=prepareCreationHandoff(graph,a.creationOpen);assert.equal(handoff.completion,'awaiting-user');result={...readCreation(graph,{scope:'overview'}),completion:'awaiting-user'};}
  const reply=actionReply(snap,{creation:result});validateAdapterRequest(reply);validateCarrierRequest(reply);await service.dispatch(reply);
 }
 assert.equal((await eventually(service)).status,'completed');
});

import {completeCreationMutation} from '../src/core/canvas/agent/creationCommit.ts';
test('applied but persistence-unconfirmed stops even a fresh creative tool call',async t=>{
 let graph={canvasId:'canvas-test',nodes:[],edges:[],history:[]},next=0;
 const {service,calls}=await fixture(t,{onPrompt:async({tools,exec})=>{
  const read=await tools.get('canvas_read_creation').execute({scope:'overview'},exec);
  const args={expectedRevision:read.creation.revision,operation:{op:'storyboard.create',name:'Only once'}};
  await assert.rejects(tools.get('canvas_edit_creation').execute(args,exec),error=>{
   assert.equal(error.code,'canvas-agent-action-failed');assert.match(error.message,/applied-unconfirmed/);assert.match(error.message,/stop-await-user/);return true;
  });
  await assert.rejects(tools.get('canvas_edit_creation').execute({...args,expectedRevision:creationRevision(graph)},exec),/awaiting-user/);
  await assert.rejects(tools.get('canvas_open_creation').execute({expectedRevision:creationRevision(graph),panel:'templateImport'},exec),/awaiting-user/);
 }});
 await service.dispatch({...autonomous(),execution:{mode:'autonomous',allowGeneration:false,maxMediaJobs:0}});
 const read=await waitFor(service,s=>s.pendingAction?.kind==='readCreation');
 await service.dispatch(actionReply(read,{creation:readCreation(graph,read.pendingAction.creationQuery)}));
 const snap=await waitFor(service,s=>s.pendingAction?.kind==='editCreation');
 const r=applyCreation(graph,snap.pendingAction.creationEdit,{createId:()=>`uncertain-${++next}`,origin:{x:0,y:0}});graph={...graph,...r};
 let refreshed=false;
 const receipt=await completeCreationMutation({applied:readCreation(graph,{scope:'overview'}),summary:r.summary,affectedIds:r.affectedIds,assertCurrent:()=>{},persist:async()=>{throw Error('simulated disk failure')},readAfter:async()=>{refreshed=true;return {creation:readCreation(graph,{scope:'overview'}),context:context()}}});
 assert.equal(refreshed,false);assert.equal(receipt.creation.completion,'applied-unconfirmed');assert.match(receipt.summary,/Do not repeat/);
 const reply={op:'actionResult',canvasId:snap.canvasId,runId:snap.runId,actionId:snap.pendingAction.actionId,result:receipt};
 validateAdapterRequest(reply);validateCarrierRequest(reply);await service.dispatch(reply);await service.dispatch(reply);
 assert.equal((await eventually(service)).status,'completed');assert.equal(graph.nodes.length,2);assert.equal(next,2);
 const guard=calls[0].scopeCalls.find(([name])=>name==='guard')[1];assert.match(guard({name:'canvas_edit_creation'}),/User action is pending/);
});
test('post-save refresh or canvas-epoch failure remains unconfirmed; large receipt stays bounded',async()=>{
 const graph={canvasId:'canvas-test',nodes:[],edges:[],history:[]};
 const applied=readCreation(graph,{scope:'overview'});
 for(const phase of ['refresh','epoch']){
  let persisted=false,checks=0;
  const result=await completeCreationMutation({applied,summary:'Applied',affectedIds:['new'],assertCurrent:()=>{if(phase==='epoch'&&++checks===2)throw Error('canvas changed')},persist:async()=>{persisted=true},readAfter:async()=>{throw Error('context refresh failed')}});
  assert.equal(persisted,true);assert.equal(result.status,'failed');assert.equal(result.creation.completion,'applied-unconfirmed');assert.equal(result.context,undefined);
 }
 const result=await completeCreationMutation({applied,summary:'Applied',affectedIds:Array.from({length:300},(_,i)=>`node-${i}`),assertCurrent:()=>{},persist:async()=>{},readAfter:async()=>({creation:applied,context:context()})});
 assert.equal(result.status,'completed');assert.equal(result.nodes.length,256);assert.match(result.summary,/first 256/);
});
