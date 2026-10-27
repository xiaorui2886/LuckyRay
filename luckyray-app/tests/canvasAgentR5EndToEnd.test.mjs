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


// Bundle the real TypeScript boundary and pure canvas executors, not copies of validators.
import {createRequire} from 'node:module';
import {decodeCanvasAgentPayload,validateCanvasAgentRequest as carrierRequest,validateCanvasAgentResult as carrierResult} from '../src-tauri/dsh-host/luckyray-dsh-host.mjs';
const require=createRequire(import.meta.url);
// Use Vite's existing locked dependency under pnpm; do not require an
// untracked top-level hoist or install another production dependency.
const {buildSync}=createRequire(require.resolve('vite'))('esbuild');
const bundle=buildSync({stdin:{contents:`export {projectCanvasAgentSnapshot} from './src/core/services/canvasAgent'; export {agentContextNodes} from './src/core/canvas/agent/context'; export {applyCanvasAgentPlan} from './src/core/canvas/agent/plan'; export {editCanvasAgentGraph} from './src/core/canvas/agent/graphEdit'; export {executeCanvasAgentPlan} from './src/core/canvas/agent/execution'; export {createCanvasActionLedger} from './src/core/canvas/agent/actionLedger';`,resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'cjs',packages:'external'});
const loaded={exports:{}};new Function('module','exports','require',bundle.outputFiles[0].text)(loaded,loaded.exports,require);
const {projectCanvasAgentSnapshot,agentContextNodes,applyCanvasAgentPlan,editCanvasAgentGraph,executeCanvasAgentPlan,createCanvasActionLedger}=loaded.exports;
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const rendererSnapshot=value=>projectCanvasAgentSnapshot(carrierResult(encode(value),'canvas-test'),'canvas-test');
const requestAcrossCarrier=value=>carrierRequest(decodeCanvasAgentPayload(encode(value)));

test('runtime → carrier → TS projection → real canvas transaction → carrier → runtime completes visual, generation and graph feedback',async t=>{
 let nodes=[{id:'source',position:{x:0,y:0},data:{kind:'image',label:'Visual reference',refMediaUrl:'fixture:image'}}],edges=[];
 let created=0,submitted=0;const taskStates=new Map();
 const graphContext=(images=false)=>({...context(),canvasName:'布局'.repeat(100),nodes:agentContextNodes(nodes,nodes.map(n=>n.id)).map(n=>images&&n.kind==='image'?{...n,image:{mimeType:'image/png',data:Buffer.from('fixture-image').toString('base64')}}:n),connections:edges.map(({source,target})=>({source,target}))});
 const outcomes=[];
 const {service}=await fixture(t,{modalities:['text','image'],onPrompt:async({tools,exec})=>{
  const read=await tools.get('canvas_read_context').execute({nodeIds:['source']},exec);outcomes.push(read);
  assert.ok(tools.get('canvas_read_context').output.render({},read).some(block=>block.type==='image'),'image must become a true model content block');
  outcomes.push(await tools.get('canvas_apply_plan').execute({title:'Script',summary:'Draft script',steps:[{id:'script',kind:'text',title:'Script',content:'Rainy city scene',references:['source']}]},exec));
  const scriptId=outcomes.at(-1).nodes[0].id;
  outcomes.push(await tools.get('canvas_generate_plan').execute({title:'Image',summary:'Generate one image',steps:[{id:'image',kind:'image',title:'City image',content:'Rainy city scene',references:[scriptId]}]},exec));
  const imageId=outcomes.at(-1).nodes[0].id;
  outcomes.push(await tools.get('canvas_edit_graph').execute({operations:[{op:'move',nodeId:imageId,x:900,y:300}]},exec));
 }});
 const ledger=createCanvasActionLedger();const executed=new Set();
 let snapshot=rendererSnapshot(await service.dispatch(requestAcrossCarrier({...autonomous('whole-stack',1),context:graphContext()})));
 for(let i=0;i<300 && (snapshot.status==='running'||service.hasActiveRuns());i++){
  const action=snapshot.pendingAction;
  if(action&&!executed.has(action.actionId)){
   executed.add(action.actionId);
   const result=await ledger.run(action,async()=>{
    if(action.kind==='readContext')return {status:'completed',summary:'Read visual canvas',context:graphContext(true),generatedJobs:0};
    if(action.kind==='editGraph'){const next=editCanvasAgentGraph(action.context,nodes,edges,action.operations,{canvasId:'canvas-test',createId:()=>`edge-${++created}`,makeEdge:(source,target,id)=>({id,source:source.id,target:target.id})});nodes=next.nodes;edges=next.edges;return {status:'completed',summary:'Moved node',context:graphContext(),generatedJobs:0};}
    const next=applyCanvasAgentPlan(action.plan,nodes,edges,{createId:()=>`node-${++created}`,origin:{x:400,y:0},makeNode:(step,id,position)=>({id,position,data:{kind:step.kind==='text'?'text':'generator',label:step.content,generationKind:step.kind,generationCount:1}}),makeEdge:(source,target,id)=>({id,source:source.id,target:target.id})});nodes=next.nodes;edges=next.edges;
    let jobs=0;
    if(action.generate){await executeCanvasAgentPlan(action.plan,next.steps,{signal:new AbortController().signal,assertCurrent:()=>{},submit:id=>{submitted++;jobs++;taskStates.set(id,{id:`task-${submitted}`,status:'succeeded'});return `task-${submitted}`;},readTask:id=>taskStates.get(id),cancel:()=>assert.fail('successful mock job should not cancel'),onUpdate:()=>{}});}
    return {status:'completed',summary:'Actual transaction completed',context:graphContext(true),generatedJobs:jobs,nodes:next.steps.map(s=>({id:s.nodeId,status:'completed'}))};
   });
   const reply=requestAcrossCarrier({op:'actionResult',canvasId:snapshot.canvasId,runId:snapshot.runId,actionId:action.actionId,result});
   rendererSnapshot(await service.dispatch(reply));
   // Lost acknowledgement replay traverses every codec but cannot repeat execution.
   rendererSnapshot(await service.dispatch(requestAcrossCarrier(reply)));
  }
  await new Promise(resolve=>setTimeout(resolve,5));snapshot=rendererSnapshot(await service.dispatch(requestAcrossCarrier({op:'status',canvasId:'canvas-test'})));
 }
 assert.equal(snapshot.status,'completed',snapshot.error);assert.equal(outcomes.length,4);assert.equal(submitted,1);assert.equal(executed.size,4);assert.equal(ledger.reserved(snapshot.runId),1);
 assert.deepEqual(nodes.at(-1).position,{x:900,y:300});assert.equal(nodes.length,3);assert.equal(edges.length,2);assert.equal(JSON.stringify(snapshot).includes(Buffer.from('fixture-image').toString('base64')),false);
});

test('history over one UI page stays codec-valid without deleting archived real session identities',async t=>{
 const {service,stateDirectory}=await fixture(t);let current=await service.dispatch({op:'status',canvasId:'canvas-test'});
 const first=current.conversationId;
 for(let index=0;index<260;index++)current=await service.dispatch(requestAcrossCarrier({op:'newConversation',canvasId:'canvas-test',requestId:`rotate-${index}`,expectedConversationId:current.conversationId}));
 const history=rendererSnapshot(await service.dispatch(requestAcrossCarrier({op:'history',canvasId:'canvas-test'})));
 assert.equal(history.conversations.length,256);
 const folder=join(stateDirectory,'conversations',createHash('sha256').update('canvas-test').digest('hex'));
 assert.equal((await readdir(folder)).filter(name=>name.endsWith('.json')).length,260,'older history is not deleted by the UI page budget');
 const resumed=rendererSnapshot(await service.dispatch(requestAcrossCarrier({op:'resumeConversation',canvasId:'canvas-test',requestId:'resume-archive',expectedConversationId:current.conversationId,conversationId:first})));
 assert.equal(resumed.conversationId,first);
});
