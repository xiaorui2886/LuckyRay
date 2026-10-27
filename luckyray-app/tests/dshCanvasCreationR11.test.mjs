import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
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
test('R11 read/edit/open traverses real adapter pending-action receipts, not fake completion',async t=>{
 const seen=[];
 const {service,calls}=await fixture(t,{onPrompt:async({tools,exec})=>{
   assert.equal(tools.size,10);
   assert.ok(tools.has('canvas_read_task_state'));
   seen.push(await tools.get('canvas_read_creation').execute({scope:'overview'},exec));
   seen.push(await tools.get('canvas_edit_creation').execute({expectedRevision:'0123456789abcdef',operation:{op:'storyboard.create',name:'Test'}},exec));
   seen.push(await tools.get('canvas_open_creation').execute({expectedRevision:'0123456789abcdef',panel:'storyboardExport',objectId:'board-1'},exec));
   await assert.rejects(tools.get('canvas_read_creation').execute({scope:'overview'},exec),/awaiting-user/);
 }});
 await service.dispatch({...autonomous(),execution:{mode:'autonomous',allowGeneration:false,maxMediaJobs:0}});
 for(const [kind,completion] of [['readCreation','read'],['editCreation','applied'],['openCreation','awaiting-user']]){
  const state=await waitFor(service,s=>s.pendingAction?.kind===kind);
  assert.deepEqual(validateCanvasAgentResult(encode(state),'canvas-test'),state);
  const reply=actionReply(state,{creation:creation(completion)});
  assert.deepEqual(validateAdapterRequest(reply),reply);assert.deepEqual(validateCarrierRequest(reply),reply);
  if(kind==='openCreation'){
    await assert.rejects(service.dispatch(actionReply(state,{creation:creation('applied')})),/action-conflict/);
    assert.equal((await service.dispatch({op:'status',canvasId:'canvas-test'})).pendingAction.actionId,state.pendingAction.actionId);
  }
  await service.dispatch(reply);
  await service.dispatch(reply); // replay resolves the identical receipt without a second operation
 }
 const settled=await eventually(service);assert.equal(settled.status,'completed');
 assert.equal(seen.length,3);assert.deepEqual(seen.map(v=>v.creation.completion),['read','applied','awaiting-user']);
 const guard=calls[0].scopeCalls.find(([name])=>name==='guard')[1];
 assert.match(guard({name:'canvas_generate_plan'}),/User action is pending/);
});
test('R11 creation mutations remain forbidden in planning mode',async t=>{
 const {service}=await fixture(t,{onPrompt:async({tools,exec})=>{
   await assert.rejects(tools.get('canvas_edit_creation').execute({expectedRevision:'0123456789abcdef',operation:{op:'storyboard.create',name:'x'}},exec),/unauthorized/);
   await assert.rejects(tools.get('canvas_open_creation').execute({expectedRevision:'0123456789abcdef',panel:'delivery'},exec),/unauthorized/);
 }});
 await service.dispatch(request());assert.equal((await eventually(service)).status,'completed');
});
test('R11 invalid creation requests reject unexpected paths, malformed IDs, wrong panel transforms and unsigned pages',()=>{
 const bad=[['open',{panel:'delivery'}],['read',{scope:'review',offset:32}],['read',{scope:'shots',objectId:'../foreign'}],['edit',{operation:{op:'storyboard.create',name:'x'}}],['edit',{expectedRevision:'0123456789abcdef',operation:{op:'template.instantiate',templateId:'custom-path'}}],['edit',{expectedRevision:'0123456789abcdef',operation:{op:'referencePack.update',packId:'pack'}}],['open',{expectedRevision:'0123456789abcdef',panel:'delivery',path:'/tmp/private'}],['open',{expectedRevision:'0123456789abcdef',panel:'delivery',imageEdit:{turns:0,flipX:false,flipY:false,crop:{x:0,y:0,width:1,height:1},width:100,height:100}}]];
 for(const [kind,value] of bad)assert.throws(()=>validateCanvasCreationPayload(value,kind));
});
test('R11 carrier rejects cross-kind creative fields and fake generation bits before renderer',()=>{
 const state={canvasId:'canvas-test',conversationId:'conversation-1',sessionId:null,runId:'run-1',status:'running',messages:[],context:context(),pendingAction:{actionId:'action-1',runId:'run-1',kind:'editCreation',context:context(),creationEdit:{expectedRevision:'0123456789abcdef',operation:{op:'storyboard.create',name:'Test'}},execution:{mode:'autonomous',allowGeneration:false,maxMediaJobs:0}}};
 assert.deepEqual(validateCanvasAgentResult(encode(state),'canvas-test'),state);
 for(const patch of [{generate:false},{creationQuery:{scope:'overview'}},{execution:{mode:'plan',allowGeneration:false,maxMediaJobs:0}},{creationEdit:{operation:{op:'storyboard.create',name:'x'}}},{kind:'readContext'}])assert.throws(()=>validateCanvasAgentResult(encode({...state,pendingAction:{...state.pendingAction,...patch}}),'canvas-test'));
});
test('R11 an applied-but-unconfirmed edit blocks retries and never claims persistence',async t=>{
 let observed;
 const {service,calls}=await fixture(t,{onPrompt:async({tools,exec})=>{
  try { await tools.get('canvas_edit_creation').execute({expectedRevision:'0123456789abcdef',operation:{op:'storyboard.create',name:'Test'}},exec); } catch(error) { observed=JSON.parse(error.message.slice(error.message.indexOf(': ')+2)); }
  await assert.rejects(tools.get('canvas_read_creation').execute({scope:'overview'},exec),/awaiting-user/);
 }});
 await service.dispatch(autonomous());
 const state=await waitFor(service,s=>s.pendingAction?.kind==='editCreation');
 const snapshot=creation('applied-unconfirmed');
 assert.throws(()=>service.dispatch(actionReply(state,{creation:snapshot})),/action-conflict/);
 const reply=actionReply(state,{status:'failed',summary:'Draft changed but saving is unconfirmed. Inspect the canvas before continuing.',creation:snapshot});
 assert.deepEqual(validateCarrierRequest(reply),reply);
 await service.dispatch(reply);await eventually(service);
 assert.equal(observed.status,'failed');assert.equal(observed.completion,'applied-unconfirmed');assert.equal(observed.retry,'stop-await-user');
 assert.match(calls[0].scopeCalls.find(([name])=>name==='guard')[1]({name:'canvas_edit_creation'}),/User action is pending/);
});
test('R11 native adapter validates scoped full-script reads without exposing all boards',()=>{
 assert.deepEqual(validateCanvasCreationPayload({scope:'scriptText',objectId:'board-1'},'read'),{scope:'scriptText',objectId:'board-1'});
 assert.throws(()=>validateCanvasCreationPayload({scope:'scriptText'},'read'));
 assert.throws(()=>validateCanvasCreationPayload({scope:'scriptText',objectId:'board-1',offset:32},'read'));
});

for(const [kind,args,summary] of [
 ['readCreation',{scope:'shots',objectId:'board-1'},'canvas-agent-creation-missing-board'],
 ['openCreation',{expectedRevision:'0123456789abcdef',panel:'delivery'},'canvas-agent-creation-select-media'],
])test('business failure throws and projects as tool error: '+kind,async t=>{
 let caught;
 const {service}=await fixture(t,{onPrompt:async({tools,exec,emit,agent})=>{
  const name=kind==='readCreation'?'canvas_read_creation':'canvas_open_creation';
  emit('session/event',agent.session,{type:'tool/call',data:{callId:'test-call',name}});
  try {await tools.get(name).execute(args,exec);}catch(e){caught=e;}
  emit('session/event',agent.session,{type:'tool/result',data:{message:{toolCallId:'test-call',isError:!!caught}}});
 }});
 await service.dispatch(autonomous());
 const state=await waitFor(service,s=>s.pendingAction?.kind===kind);
 await service.dispatch(actionReply(state,{status:'failed',summary}));
 const done=await eventually(service);
 assert.equal(caught.code,summary);assert.match(caught.message,/"status":"failed"/);
 assert.equal(done.tools[0].status,'failed');
});

test('restoring old snapshot corrects only exact known business failures',async t=>{
 const {service,stateDirectory}=await fixture(t);
 const stored={version:2,requests:[],snapshot:{canvasId:'canvas-test',conversationId:legacyConversation('canvas-test'),sessionId:null,runId:null,status:'completed',messages:[],tools:[
 {callId:'call-1',name:'canvas_read_creation',status:'completed',summary:'canvas-agent-creation-missing-board',startedAt:1,endedAt:2},
 {callId:'call-2',name:'canvas_open_creation',status:'completed',summary:'Panel prepared; awaiting-user',startedAt:3,endedAt:4}
 ]}};
 await writeFile(join(stateDirectory,createHash('sha256').update('canvas-test').digest('hex')+'.json'),JSON.stringify(stored));
 const state=await service.dispatch({op:'status',canvasId:'canvas-test'});
 assert.deepEqual(state.tools.map(t=>t.status),['failed','completed']);
});
