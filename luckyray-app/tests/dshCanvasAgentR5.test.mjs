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

test('official live text and provider-visible reasoning are projected, final settlement has no duplicate assistant', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const { service } = await fixture(t, { onPrompt: async ({ emit, agent }) => {
    emit('agent/assistant-stream', { frame: { type: 'start', attemptId: 'attempt-1' } });
    emit('agent/assistant-stream', { frame: { type: 'chunk', attemptId: 'attempt-1', chunk: { type: 'reasoning-delta', text: 'Provider-visible reasoning' } } });
    emit('agent/assistant-stream', { frame: { type: 'chunk', attemptId: 'attempt-1', chunk: { type: 'text-delta', text: 'Hello' } } });
    await held;
    emit('session/event', agent.session, { type: 'assistant/message', data: { message: { content: [
      { type: 'text', text: 'Hello world' }, { type: 'reasoning', text: 'Provider-visible reasoning' }] } } });
    emit('agent/assistant-stream', { frame: { type: 'end', attemptId: 'attempt-1', outcome: { kind: 'committed' } } });
  } });
  await service.dispatch(request());
  const live = await waitFor(service, s => s.stream?.text === 'Hello');
  assert.equal(live.stream.status, 'streaming'); assert.equal(live.stream.reasoningText, 'Provider-visible reasoning');
  release(); const final = await eventually(service);
  assert.equal(final.stream.status, 'settled'); assert.equal(final.messages.filter(m => m.role === 'assistant').length, 1);
  assert.equal(final.messages.at(-1).text, 'Hello world');
  assert.equal(final.messages.at(-1).reasoningText, 'Provider-visible reasoning');
});

test('autonomous tool waits for actual executor, returns receipt to model, and refreshes context', async t => {
  const outcomes = [];
  const { service } = await fixture(t, { onPrompt: async ({ tools, exec }) => {
    outcomes.push(await tools.get('canvas_read_context').execute({ nodeIds: ['source'] }, exec));
    outcomes.push(await tools.get('canvas_apply_plan').execute(proposal(), exec));
    await tools.get('canvas_report_progress').execute({ summary: 'Verified the created storyboard nodes.' }, exec);
  } });
  await service.dispatch(autonomous());
  const reading = await waitFor(service, s => s.pendingAction?.kind === 'readContext');
  assert.deepEqual(reading.pendingAction.nodeIds, ['source']);
  await service.dispatch(actionReply(reading));
  const applying = await waitFor(service, s => s.pendingAction?.kind === 'applyPlan');
  assert.equal(applying.pendingAction.generate, false);
  assert.equal(applying.pendingAction.execution.mode, 'autonomous');
  assert.equal(applying.pendingAction.context.nodes[0].revision, '0123456789abcdef');
  const response = actionReply(applying, { nodes: [{ id: 'created-node', status: 'completed' }] });
  await service.dispatch(response); await service.dispatch(response);
  const final = await eventually(service);
  assert.equal(final.status, 'completed'); assert.equal(outcomes.length, 2);
  assert.equal(outcomes[1].nodes[0].id, 'created-node');
  assert.equal(final.progress[0].summary, 'Verified the created storyboard nodes.');
  await assert.rejects(service.dispatch({ ...response, result: { ...response.result, summary: 'Changed' } }), /action-conflict/);
});

test('media budget is reserved before dispatch, failed generation cannot silently retry', async t => {
  let rejected;
  const { service } = await fixture(t, { onPrompt: async ({ tools, exec }) => {
    const generate = tools.get('canvas_generate_plan');
    // Existing ToolCompat throws real failed business results; catch that first
    // failure so this test still verifies the subsequent retry stays denied.
    await assert.rejects(generate.execute(proposal(), exec), {code:'canvas-agent-action-failed'});
    try { await generate.execute(proposal(), exec); } catch (error) { rejected = error.code; }
  } });
  await service.dispatch(autonomous('media-reservation', 2));
  const pending = await waitFor(service, s => s.pendingAction?.generate);
  assert.equal(pending.execution.reservedMediaJobs, 1);
  await service.dispatch(actionReply(pending, { status: 'failed', summary: 'Provider outcome unknown', generatedJobs: 1 }));
  const final = await eventually(service);
  assert.equal(rejected, 'canvas-agent-generation-unauthorized');
  assert.equal(final.execution.reservedMediaJobs, 1);
});

test('generation denies insufficient budget and plan mode denies execution', async t => {
  const errors = [];
  const { service } = await fixture(t, { onPrompt: async ({ tools, exec }) => {
    for (const name of ['canvas_apply_plan', 'canvas_generate_plan']) {
      try { await tools.get(name).execute(proposal(), exec); } catch (error) { errors.push(error.code); }
    }
  } });
  await service.dispatch(request()); await eventually(service);
  assert.deepEqual(errors, ['canvas-agent-execution-unauthorized', 'canvas-agent-execution-unauthorized']);
  const limited = await fixture(t, { onPrompt: async ({ tools, exec }) => {
    await assert.rejects(tools.get('canvas_generate_plan').execute(proposal(), exec), /media-budget/);
  } });
  await limited.service.dispatch(autonomous('zero', 0));
  const end = await eventually(limited.service); assert.equal(end.pendingAction, undefined);
});

test('cancel aborts pending action and rejects stale executor acknowledgement', async t => {
  const { service } = await fixture(t, { onPrompt: async ({ tools, exec }) => tools.get('canvas_generate_plan').execute(proposal(), exec) });
  await service.dispatch(autonomous());
  const pending = await waitFor(service, s => !!s.pendingAction);
  await service.dispatch({ op: 'cancel', canvasId: pending.canvasId, runId: pending.runId });
  const final = await eventually(service); assert.equal(final.status, 'cancelled'); assert.equal(final.pendingAction, undefined);
  await assert.rejects(service.dispatch(actionReply(pending)), /action-conflict/);
});

test('history switches actual persisted sessions and continues original session, not snapshot replay', async t => {
  const { service, calls } = await fixture(t);
  await service.dispatch(request()); const first = await eventually(service);
  const fresh = await service.dispatch({ op: 'newConversation', canvasId: first.canvasId, requestId: 'new-conversation', expectedConversationId: first.conversationId });
  await service.dispatch({ ...request('second-conversation'), conversationId: fresh.conversationId }); await eventually(service);
  const list = await service.dispatch({ op: 'history', canvasId: first.canvasId });
  assert.equal(list.conversations.length, 2); assert.ok(list.conversations.some(c => c.sessionId === first.sessionId));
  const restored = await service.dispatch({ op: 'resumeConversation', canvasId: first.canvasId, requestId: 'restore-first', expectedConversationId: fresh.conversationId, conversationId: first.conversationId });
  assert.equal(restored.sessionId, first.sessionId);
  await service.dispatch({ ...request('continue-first'), conversationId: restored.conversationId }); await eventually(service);
  assert.equal(calls.at(-1).options.resumeSessionId, first.sessionId);
});

test('real tool call/result lifecycle uses official ToolResultMessage.toolCallId', async t => {
  const { service } = await fixture(t, { onPrompt: async ({ emit, agent }) => {
    emit('session/event', agent.session, { type: 'tool/call', data: { callId: 'call-1', name: 'canvas_read_context' } });
    emit('session/event', agent.session, { type: 'tool/result', data: { message: { toolCallId: 'call-1', isError: true } } });
  } });
  await service.dispatch(request()); const final = await eventually(service);
  assert.equal(final.tools[0].status, 'failed'); assert.ok(final.tools[0].endedAt >= final.tools[0].startedAt);
});

test('48k-character prompt budget does not penalize Chinese UTF-8', () => {
  assert.equal(validateCanvasAgentRequest({ ...request(), prompt: '中'.repeat(48000) }).prompt.length, 48000);
  assert.throws(() => validateCanvasAgentRequest({ ...request(), prompt: 'a'.repeat(48001) }), /invalid-request/);
});

test('live canvas images are admitted and rendered as real model image blocks, never base64 snapshot JSON', async t => {
  let rendered;
  const { service } = await fixture(t, { modalities: ['text', 'image'], onPrompt: async ({ tools, exec }) => {
    const tool = tools.get('canvas_read_context');
    const result = await tool.execute({ offset: 256, expectedRevision:'0123456789abcdef' }, exec);
    rendered = tool.output.render({}, result);
  } });
  await service.dispatch(autonomous('visual-read'));
  const pending = await waitFor(service, s => s.pendingAction?.kind === 'readContext');
  assert.equal(pending.pendingAction.offset, 256);
  const imageContext = context(); imageContext.snapshotRevision='0123456789abcdef'; imageContext.nodes.push({ id: 'image-new', kind: 'image', title: 'Rendered result', text: '', editable: true,
    revision: '0123456789abcdef', image: { mimeType: 'image/png', data: Buffer.from('sample').toString('base64') } });
  await service.dispatch(actionReply(pending, { context: imageContext, summary: 'Returned nodes 256–257 of 258; request offset 258 for next page.' }));
  const final = await eventually(service);
  assert.equal(rendered.filter(block => block.type === 'image').length, 1);
  assert.equal(rendered.find(block => block.type === 'image').attachment.attachmentId, 'safe-attachment');
  assert.equal(JSON.stringify(final).includes(Buffer.from('sample').toString('base64')), false);
  assert.equal(rendered[0].text.includes('imageContents'), false);
});

test('identical successful generation intent returns the original receipt without reserving another job', async t => {
  const outcomes = [];
  const { service } = await fixture(t, { onPrompt: async ({ tools, exec }) => {
    outcomes.push(await tools.get('canvas_generate_plan').execute(proposal(), exec));
    outcomes.push(await tools.get('canvas_generate_plan').execute(proposal(), exec));
  } });
  await service.dispatch(autonomous('same-intent', 2));
  const pending = await waitFor(service, s => s.pendingAction?.generate);
  await service.dispatch(actionReply(pending, { generatedJobs: 1 }));
  const final = await eventually(service);
  assert.equal(final.execution.reservedMediaJobs, 1); assert.equal(outcomes[1].duplicate, true);
});

test('ACK retry completes the pending tool after receipt succeeds but snapshot save fails', async t => {
  let receipts = 0;
  const { service, stateDirectory } = await fixture(t, { onPrompt: async ({ tools, exec }) => {
    await tools.get('canvas_apply_plan').execute(proposal(), exec); receipts++;
  } });
  await service.dispatch(autonomous('ack-recovery'));
  const pending = await waitFor(service, s => !!s.pendingAction);
  const activePath = join(stateDirectory, `${createHash('sha256').update('canvas-test').digest('hex')}.json`);
  await receiptIo.unlink(activePath); await receiptIo.mkdir(activePath);
  const response = actionReply(pending);
  await assert.rejects(service.dispatch(response));
  assert.equal(receipts, 0);
  await receiptIo.rmdir(activePath);
  await service.dispatch(response);
  const final = await eventually(service);
  assert.equal(final.status, 'completed'); assert.equal(receipts, 1); assert.equal(final.pendingAction, undefined);
  await service.dispatch(response); assert.equal(receipts, 1);
});

test('graph editing awaits actual scoped executor and invalid targets/cycles are rejected', async t => {
  let outcome;
  const { service } = await fixture(t, { onPrompt: async ({ tools, exec }) => {
    const tool = tools.get('canvas_edit_graph');
    await assert.rejects(tool.execute({ operations: [{ op: 'move', nodeId: 'not-in-context', x: 0, y: 0 }] }, exec), /invalid-plan/);
    await assert.rejects(tool.execute({ operations: [{ op: 'move', nodeId: 'source', x: Infinity, y: 0 }] }, exec), /invalid-plan/);
    outcome = await tool.execute({ operations: [{ op: 'move', nodeId: 'source', x: 100, y: -50 }, { op: 'arrange', nodeIds: ['source'], layout: 'grid' }] }, exec);
  } });
  await service.dispatch(autonomous('edit-graph'));
  const pending = await waitFor(service, s => s.pendingAction?.kind === 'editGraph');
  assert.equal(pending.pendingAction.operations.length, 2);
  assert.equal(pending.pendingAction.context.nodes[0].id, 'source');
  assert.equal(pending.pendingAction.execution.mode, 'autonomous');
  await service.dispatch(actionReply(pending, { summary: 'Moved and arranged source.' }));
  assert.equal((await eventually(service)).status, 'completed');
  assert.equal(outcome.summary, 'Moved and arranged source.');
});


test('graph DAG validation rejects introduced cycles and permits disconnect before reconnect', () => {
  const value = context(); value.nodes.push({ ...value.nodes[0], id: 'second' }); value.connections = [{source:'source',target:'second'}];
  assert.throws(() => validateCanvasGraphOperations([{op:'connect',source:'second',target:'source'}], value), /invalid-plan/);
  assert.equal(validateCanvasGraphOperations([{op:'disconnect',source:'source',target:'second'},{op:'connect',source:'second',target:'source'}], value).length, 2);
});

test('R6 read requests carry the known working set and require stable paging revision', async t => {
  let result;
  const {service}=await fixture(t,{onPrompt:async({tools,exec})=>{
    const read=tools.get('canvas_read_context');
    await assert.rejects(read.execute({offset:256},exec),/context-unavailable/);
    result=await read.execute({offset:256,expectedRevision:'0123456789abcdef'},exec);
  }});
  await service.dispatch(autonomous('r6-pages'));
  const pending=await waitFor(service,s=>s.pendingAction?.kind==='readContext');
  assert.equal(pending.pendingAction.context.nodes[0].id,'source');
  assert.equal(pending.pendingAction.expectedRevision,'0123456789abcdef');
  await assert.rejects(service.dispatch(actionReply(pending,{context:{...context(),snapshotRevision:'fedcba9876543210'}})),/context-stale/);
  assert.equal((await service.dispatch({op:'status',canvasId:'canvas-test'})).pendingAction.actionId,pending.pendingAction.actionId);
  await service.dispatch(actionReply(pending,{context:{...context(),snapshotRevision:'0123456789abcdef'}}));
  assert.equal((await eventually(service)).status,'completed');assert.equal(result.context.snapshotRevision,'0123456789abcdef');
});

test('R6 refreshed receipt preserves second known target and never resurrects deleted links', async t => {
  let secondEdited=false;
  const {service}=await fixture(t,{onPrompt:async({tools,exec})=>{
    await tools.get('canvas_apply_plan').execute({title:'Edit A',summary:'Update first node',steps:[{id:'edit-a',kind:'text',title:'A',content:'Updated',targetNodeId:'source',references:[]}]},exec);
    await tools.get('canvas_edit_graph').execute({operations:[{op:'move',nodeId:'second',x:10,y:20}]},exec);
    secondEdited=true;
  }});
  const initial=autonomous('r6-working-set');initial.context.nodes.push({...initial.context.nodes[0],id:'second'});initial.context.connections=[{source:'source',target:'second'}];
  await service.dispatch(initial);
  const applying=await waitFor(service,s=>s.pendingAction?.kind==='applyPlan');
  const refreshed=structuredClone(initial.context);refreshed.snapshotRevision='0123456789abcdef';refreshed.nodes[0].revision='fedcba9876543210';refreshed.connections=[];
  await service.dispatch(actionReply(applying,{context:refreshed}));
  const moving=await waitFor(service,s=>s.pendingAction?.kind==='editGraph');
  assert.equal(moving.pendingAction.context.nodes.length,2);assert.deepEqual(moving.pendingAction.context.connections,[]);
  assert.equal(moving.pendingAction.operations[0].nodeId,'second');
  await service.dispatch(actionReply(moving,{context:refreshed}));
  assert.equal((await eventually(service)).status,'completed');assert.equal(secondEdited,true);
});
