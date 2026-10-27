import * as receiptIo from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  advanceCanvasAgentActivity, createCanvasAgentService, validateCanvasAgentPlan, validateCanvasAgentRequest, writeCanvasAgentReceipt,
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

test("request and plan validators reject arbitrary paths/credentials, bad DAGs and unselected edits", () => {
  assert.equal(validateCanvasAgentRequest(request()).context.nodes[0].revision, "0123456789abcdef");
  assert.throws(() => validateCanvasAgentRequest({ ...request(), apiKey: "forbidden" }), /invalid-request/);
  const path = request(); path.context.nodes[0].path = "/etc/passwd";
  assert.throws(() => validateCanvasAgentRequest(path), /invalid-request/);
  const wrongRevision = request(); wrongRevision.context.nodes[0].revision = "invalid";
  assert.throws(() => validateCanvasAgentRequest(wrongRevision), /invalid-request/);
  for (const mutate of [
    plan => { plan.steps[0].references = ["new-image"]; },
    plan => { plan.steps[0].targetNodeId = "not-selected"; },
    plan => { plan.steps[1].targetNodeId = "source"; },
    plan => { plan.steps[0].id = "source"; },
    plan => { plan.steps[0].provider = "other-provider"; },
    plan => { plan.steps = Array.from({ length: 65 }, (_, i) => ({ ...plan.steps[0], id: `step-${i}` })); },
  ]) { const plan = proposal(); mutate(plan); assert.throws(() => validateCanvasAgentPlan(plan, context(), "run-one"), /invalid-plan/); }
  const editable = proposal(); editable.steps[0].targetNodeId = "source"; editable.steps[0].references = [];
  assert.equal(validateCanvasAgentPlan(editable, context(), "run-one").steps[0].targetNodeId, "source");
});

test("real service uses a scoped whitelist, complete persona, DAG proposal and same-session resume", async t => {
  const { service, calls, setModel } = await fixture(t);
  const started = await service.dispatch(request());
  assert.equal(started.status, "running");
  assert.equal(started.requestId, "request-one");
  const first = await eventually(service);
  assert.equal(first.status, "completed"); assert.equal(first.plan.steps.length, 2);
  assert.equal(first.plan.canvasId, "canvas-test"); assert.equal(first.plan.runId, first.runId);
  assert.deepEqual([...calls[0].tools.keys()], ["canvas_read_task_state", "canvas_read_context", "canvas_report_progress", "canvas_edit_graph", "canvas_read_creation", "canvas_edit_creation", "canvas_open_creation", "canvas_propose_plan", "canvas_apply_plan", "canvas_generate_plan"]);
  assert.deepEqual(calls[0].scopeCalls.find(([name]) => name === "restrict")[1], { allow: [] });
  assert.equal(calls[0].scopeCalls.find(([name]) => name === "presentAs")[1], "native");
  assert.equal(calls[0].scopeCalls.find(([name]) => name === "guard")[1]({ name: "bash" }), "Canvas Agent permits only its scoped canvas tools.");
  assert.equal(calls[0].scopeCalls.find(([name]) => name === "section")[1].complete, true);
  assert.equal(calls[0].scopeCalls.find(([name])=>name==='guard')[1]({name:'canvas_read_task_state'}),undefined);
  const taskTool=calls[0].tools.get('canvas_read_task_state'),taskExec={signal:new AbortController().signal};
  assert.equal((await taskTool.execute({},taskExec)).goal,request().prompt);
  await assert.rejects(taskTool.execute({path:'/private'},taskExec));
  setModel("model-two");
  await service.dispatch(request("request-two"));
  const second = await eventually(service);
  assert.equal(second.sessionId, first.sessionId); assert.equal(second.model, "model-two");
  assert.equal(calls[1].options.resumeSessionId, first.sessionId);
  assert.equal(calls[1].options.agentOptions.reasoningEffort, undefined, "unadvertised default effort must not reach a non-reasoning route");
  assert.equal(second.messages.filter(message => message.role === "user").length, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(second)) < 240 * 1024);
});

test("requestId retries never submit twice and changed same-ID inputs are refused", async t => {
  const { service, calls } = await fixture(t);
  await service.dispatch(request()); const completed = await eventually(service);
  assert.deepEqual(await service.dispatch(request()), completed); assert.equal(calls.length, 1);
  await assert.rejects(service.dispatch({ ...request(), prompt: "Changed" }), /request-conflict/);
  await service.dispatch(request("request-two")); await eventually(service);
  await assert.rejects(service.dispatch(request()), /request-already-used/);
  assert.equal(calls.length, 2);
});

test("cancel is run-bound and reaches cancelled only after the official agent drains", async t => {
  const { service } = await fixture(t, { onPrompt: async ({ exec }) => {
    await new Promise(resolve => exec.signal.addEventListener("abort", resolve, { once: true }));
  } });
  const running = await service.dispatch(request());
  while (!(await service.dispatch({ op: "status", canvasId: "canvas-test" })).sessionId) await new Promise(resolve => setTimeout(resolve, 1));
  await assert.rejects(service.dispatch({ op: "cancel", canvasId: "canvas-test", runId: "wrong-run" }), /run-conflict/);
  await service.dispatch({ op: "cancel", canvasId: "canvas-test", runId: running.runId });
  const stopped = await eventually(service); assert.equal(stopped.status, "cancelled"); assert.equal(stopped.plan, undefined);
});

test("slow model lookup returns immediately and can be cancelled before a prompt is submitted", async t => {
  const { service, calls } = await fixture(t, { resolveModel: async (_provider, _model, signal) => {
    await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  const before = Date.now(); const started = await service.dispatch(request());
  assert.ok(Date.now() - before < 1000);
  await service.dispatch({ op: "cancel", canvasId: "canvas-test", runId: started.runId });
  assert.equal((await eventually(service)).status, "cancelled"); assert.equal(calls.length, 0);
});

test("image bytes use official admission and never return through snapshots or UI state files", async t => {
  const { service, calls, stateDirectory } = await fixture(t, { modalities: ["text", "image"] });
  const withImage = request();
  withImage.context.nodes.push({ id: "image-source", kind: "image", title: "Image", text: "", editable: false,
    revision: "abcdef0123456789", image: { mimeType: "image/png", data: Buffer.from("synthetic-image-data").toString("base64") } });
  await service.dispatch(withImage); const completed = await eventually(service);
  assert.equal(completed.status, "completed");
  assert.ok(calls[0].message.content.some(part => part.type === "image" && part.attachment));
  assert.equal(completed.context.nodes[1].image, undefined);
  assert.equal(JSON.stringify(completed).includes(withImage.context.nodes[1].image.data), false);
  for (const filename of (await readdir(stateDirectory)).filter(name => name.endsWith(".json"))) assert.equal((await readFile(join(stateDirectory, filename), "utf8")).includes(withImage.context.nodes[1].image.data), false);
});

test("unsupported image routes and missing runtime fail visibly without a fake successful answer", async t => {
  const { service, calls } = await fixture(t);
  const withImage = request(); withImage.context.nodes[0] = { ...withImage.context.nodes[0], kind: "image",
    image: { mimeType: "image/png", data: "YQ==" } };
  await service.dispatch(withImage); const failed = await eventually(service);
  assert.equal(failed.status, "failed"); assert.equal(failed.error, "canvas-agent-images-unsupported");
  assert.equal(failed.plan, undefined); assert.equal(calls.length, 0);
  const stateDirectory = await mkdtemp(join(tmpdir(), "canvas-agent-missing-"));
  const missing = createCanvasAgentService({}, { stateDirectory });
  t.after(async () => { await missing.dispose(); await rm(stateDirectory, { recursive: true, force: true }); });
  await missing.dispatch(request());
  assert.equal((await eventually(missing)).error, "canvas-agent-runtime-unavailable");
});

test("restart retains session mapping, request identity and stale-plan comparison metadata", async t => {
  const { service, ctx, calls, stateDirectory } = await fixture(t);
  await service.dispatch(request()); const first = await eventually(service); await service.dispose();
  const restarted = createCanvasAgentService(ctx, { stateDirectory }); t.after(() => restarted.dispose());
  const saved = await restarted.dispatch({ op: "status", canvasId: "canvas-test" });
  assert.deepEqual(saved.context, first.context); assert.deepEqual(saved.plan, first.plan);
  await restarted.dispatch(request()); assert.equal(calls.length, 1);
  await restarted.dispatch(request("request-after-restart")); const second = await eventually(restarted);
  assert.equal(second.sessionId, first.sessionId); assert.equal(calls.length, 2);
});

test("different canvases cannot see each other's context or plan identity", async t => {
  const { service } = await fixture(t, { onPrompt: async ({ tools, exec }) => {
    const selected = await tools.get("canvas_read_context").execute({}, exec);
    const plan = proposal(); plan.steps[0].references = [selected.nodes[0].id];
    await tools.get("canvas_propose_plan").execute(plan, exec);
  } });
  const first = request(), second = request("other-request");
  second.canvasId = second.context.canvasId = "other-canvas"; second.conversationId = legacyConversation(second.canvasId); second.context.nodes[0].id = "private-other-source";
  await Promise.all([service.dispatch(first), service.dispatch(second)]);
  const [a, b] = await Promise.all([eventually(service), eventually(service, "other-canvas")]);
  assert.notEqual(a.sessionId, b.sessionId);
  assert.equal(a.plan.steps[0].references[0], "source"); assert.equal(b.plan.steps[0].references[0], "private-other-source");
  assert.equal(JSON.stringify(a).includes("private-other-source"), false);
});

test("persistence failures never strand a running snapshot or start a model call", async t => {
  const root = await mkdtemp(join(tmpdir(), "canvas-agent-bad-storage-"));
  const path = join(root, "not-a-directory"); await writeFile(path, "blocked");
  const { ctx, calls } = fakeRuntime(); const service = createCanvasAgentService(ctx, { stateDirectory: path });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  // POSIX readFile reports ENOTDIR here; Windows reports ENOENT and reaches
  // the start-save failure branch. Both must fail closed before any model call.
  const outcome = await service.dispatch(request()).catch(caught => ({ status: "failed", error: caught.code ?? caught.message }));
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error, "canvas-agent-storage-unavailable");
  assert.equal(service.hasActiveRuns(), false);
  assert.equal(calls.length, 0);
});

test("failed model errors are sanitized, no partial proposal is exposed as completed", async t => {
  const { service } = await fixture(t, { onPrompt: async ({ tools, exec }) => {
    await tools.get("canvas_propose_plan").execute(proposal(), exec);
    throw Object.assign(new Error("Bearer DO-NOT-LEAK-CREDENTIAL"), { code: "UNAUTHORIZED" });
  } });
  await service.dispatch(request()); const failed = await eventually(service);
  assert.equal(failed.status, "failed"); assert.equal(failed.error, "canvas-agent-auth-required");
  assert.equal(failed.plan, undefined); assert.equal(JSON.stringify(failed).includes("DO-NOT-LEAK"), false);
});

test("wire budgets and existing/edit target graph cycles are rejected; unready media may be drafted", () => {
  const oversized = request(); oversized.prompt = "中".repeat(48001);
  assert.throws(() => validateCanvasAgentRequest(oversized), /invalid-request/);
  const selected = context(); selected.generation.imageReady = false;
  assert.equal(validateCanvasAgentPlan(proposal(), selected, "run-draft").steps[1].kind, "image");
  selected.nodes.push({ ...selected.nodes[0], id: "downstream", editable: false });
  selected.connections = [{ source: "source", target: "downstream" }];
  const cycle = proposal(); cycle.steps[0].targetNodeId = "source"; cycle.steps[0].references = ["downstream"];
  assert.throws(() => validateCanvasAgentPlan(cycle, selected, "run-cycle"), /invalid-plan/);
  const posterior = proposal(); posterior.steps[1] = { ...posterior.steps[0], id: "later-edit", targetNodeId: "source", references: [] };
  assert.throws(() => validateCanvasAgentPlan(posterior, selected, "run-later"), /invalid-plan/);
});

test("generation settings are capability-bound, preserve supported options, and reject unknown or text settings", () => {
  const selected = context();
  selected.generation.imageOptions = { aspects: ["16:9", "1:1"], resolutions: ["1080p"], qualities: ["high"], durations: [] };
  selected.generation.videoOptions = { aspects: ["16:9"], resolutions: ["1080p"], qualities: ["standard"], durations: [5, 10] };
  const input = request(); input.context = selected;
  assert.deepEqual(validateCanvasAgentRequest(input).context.generation, selected.generation);
  const plan = proposal(); plan.steps[1].settings = { aspect: "16:9", resolution: "1080p", quality: "high" };
  plan.steps.push({ id: "new-video", kind: "video", title: "Moving shot", content: "Slow dolly toward the rain", references: ["new-image"], settings: { aspect: "16:9", resolution: "1080p", quality: "standard", duration: 5 } });
  const accepted = validateCanvasAgentPlan(plan, selected, "run-settings");
  assert.deepEqual(accepted.steps[1].settings, plan.steps[1].settings);
  assert.deepEqual(accepted.steps[2].settings, plan.steps[2].settings);
  for (const mutate of [
    item => { item.steps[0].settings = { aspect: "16:9" }; },
    item => { item.steps[1].settings.aspect = "9:16"; },
    item => { item.steps[1].settings.duration = 5; },
    item => { item.steps[1].settings.count = 4; },
    item => { item.steps[2].settings.duration = 7; },
    item => { item.steps[2].settings.duration = "5"; },
    item => { item.steps[2].settings.model = "invented"; },
  ]) { const invalid = structuredClone(plan); mutate(invalid); assert.throws(() => validateCanvasAgentPlan(invalid, selected, "run-invalid-settings"), /invalid-plan/); }
  assert.throws(() => validateCanvasAgentPlan(plan, context(), "run-no-capabilities"), /invalid-plan/);
  const tooMany = structuredClone(input); tooMany.context.generation.imageOptions.aspects = Array(33).fill("1:1");
  assert.throws(() => validateCanvasAgentRequest(tooMany), /invalid-request/);
});

test("active-run lifecycle includes admission and cancellation drain; fifth concurrent canvas is rejected", async t => {
  const { service, calls } = await fixture(t, { resolveModel: async (_provider, _model, signal) => {
    await new Promise((resolve, reject) => signal.addEventListener("abort", () => setTimeout(() => reject(signal.reason), 20), { once: true }));
  } });
  const starts = Array.from({ length: 4 }, (_, index) => {
    const input = request(`parallel-${index}`); input.canvasId = input.context.canvasId = `canvas-${index}`; input.conversationId = legacyConversation(input.canvasId); return input;
  });
  const pending = starts.map(input => service.dispatch(input));
  assert.equal(service.hasActiveRuns(), true, "pending admission is visible before start ACK");
  const admitted = await Promise.all(pending);
  const fifth = request("fifth"); fifth.canvasId = fifth.context.canvasId = "canvas-five"; fifth.conversationId = legacyConversation(fifth.canvasId);
  await assert.rejects(service.dispatch(fifth), /capacity/);
  for (const run of admitted) await service.dispatch({ op: "cancel", canvasId: run.canvasId, runId: run.runId });
  assert.equal(service.hasActiveRuns(), true, "cancellation cannot claim quiescence before provider admission drains");
  await Promise.all(admitted.map(run => eventually(service, run.canvasId)));
  for (let attempt = 0; attempt < 200 && service.hasActiveRuns(); attempt++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(service.hasActiveRuns(), false); assert.equal(calls.length, 0);
});

test("idle state eviction and bounded in-memory receipts cannot cause a duplicate paid submission", async t => {
  const { service, ctx, calls, stateDirectory } = await fixture(t);
  await service.dispatch(request()); const completed = await eventually(service);
  for (let index = 0; index < 40; index++) await service.dispatch({ op: "status", canvasId: `idle-canvas-${index}` });
  const restored = await service.dispatch({ op: "status", canvasId: "canvas-test" });
  assert.equal(restored.sessionId, completed.sessionId);
  await service.dispatch(request()); assert.equal(calls.length, 1);
  await service.dispose();
  for (const name of (await readdir(stateDirectory)).filter(name => name.endsWith(".json"))) {
    const path = join(stateDirectory, name), saved = JSON.parse(await readFile(path, "utf8"));
    saved.requests = []; await writeFile(path, JSON.stringify(saved));
  }
  const restarted = createCanvasAgentService(ctx, { stateDirectory }); t.after(() => restarted.dispose());
  await restarted.dispatch(request()); assert.equal(calls.length, 1, "durable receipt survives the bounded recent-request cache");
});

test("official DSH scoped agent executes only canvas tools and resumes its JSONL session", {
  skip: !process.env.DSH_CANVAS_TEST_NODE_MODULES, timeout: 30000,
}, async t => {
  const modules = process.env.DSH_CANVAS_TEST_NODE_MODULES;
  assert.equal(JSON.parse(await readFile(join(modules, "@deepseek-ai/dsh-agent/package.json"), "utf8")).version, "0.2.1-rc.2");
  const load = name => import(pathToFileURL(join(modules, "@deepseek-ai", name, "lib/index.js")).href);
  const { Context } = await load("cordis");
  const { LlmAdapter } = await load("dsh-llm");
  const stateDirectory = await mkdtemp(join(tmpdir(), "canvas-agent-official-"));
  const ctx = new Context(); let service; const requests = [];
  t.after(async () => { await service?.dispose(); await ctx.fiber.dispose(); await rm(stateDirectory, { recursive: true, force: true }); });
  for (const name of ["dsh-llm", "dsh-session", "dsh-session-projection", "dsh-agent", "dsh-system-prompt", "dsh-tools", "dsh-agent-loop"])
    await ctx.plugin((await load(name)).default, {});
  await ctx.plugin(await load("dsh-session-persistence-jsonl"), { root: join(stateDirectory, "official-sessions"), compression: "none" });
  await ctx.plugin((await load("dsh-attachment-local")).default, { dshHome: join(stateDirectory, "official-home") });
  ctx.provide("agentDefaultModel", { currentSelection: () => ({ provider: "canvas-synthetic", model: "test-model" }) });
  const officialRequest = requestId => {
    const input = request(requestId);
    input.context.generation.imageOptions = { aspects: ["16:9"], resolutions: ["1080p"], qualities: ["high"], durations: [] };
    input.context.generation.videoOptions = { aspects: ["16:9"], resolutions: ["1080p"], qualities: ["standard"], durations: [5] };
    return input;
  };
  const officialProposal = () => {
    const value = proposal();
    value.steps[1].settings = { aspect: "16:9", resolution: "1080p", quality: "high" };
    value.steps.push({ id: "new-video", kind: "video", title: "Moving rain", content: "A slow cinematic dolly through rain", references: ["new-image"],
      settings: { aspect: "16:9", resolution: "1080p", quality: "standard", duration: 5 } });
    return value;
  };
  let turn = 0, attackNext = false, hold = false;
  class Provider extends LlmAdapter {
    async listModels(provider) { return ["test-model", "alternate-model"].map(id => ({provider,id,name:id,inputModalities:["text","image"]})); }
    async resolveModel(provider, model) { return { provider, id: model, name: model, inputModalities: ["text", "image"], ...(model === "alternate-model" ? {reasoning:{efforts:[{id:"low",name:"Low"},{id:"high",name:"High"}]}} : {}) }; }
    async *stream(options) {
      requests.push(options);
      assert.deepEqual(options.tools.map(tool => tool.name).sort(), ["canvas_apply_plan", "canvas_edit_creation", "canvas_edit_graph", "canvas_generate_plan", "canvas_open_creation", "canvas_propose_plan", "canvas_read_context", "canvas_read_creation", "canvas_read_task_state", "canvas_report_progress"]);
      assert.equal(options.provider, "canvas-synthetic");
      if (hold) {
        await new Promise(resolve => options.signal.addEventListener("abort", resolve, { once: true }));
        return;
      }
      // The R5 official loop is no longer truncated after a proposal. Give the
      // synthetic provider a real stop turn after its two tool results.
      if (turn === 2) {
        turn = 0;
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "block-end", index: 0, block: { type: "text", text: "Synthetic plan reviewed; media not generated." } };
        yield { type: "finish", reason: { kind: "stop" } };
        return;
      }
      const name = attackNext ? "bash" : turn++ === 0 ? "canvas_read_context" : "canvas_propose_plan";
      if (attackNext) turn = 2;
      attackNext = false;
      const block = { type: "tool-call", id: `call-${requests.length}`, name, arguments: JSON.stringify(name === "canvas_propose_plan" ? officialProposal() : {}) };
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield { type: "block-end", index: 0, block };
      yield { type: "finish", reason: { kind: "tool-calls" } };
    }
  }
  ctx.llm.registerAdapter(["canvas-synthetic"], new Provider());
  // A global terminal tool exists, but the Canvas scoped view must hide it.
  let terminalCalls = 0;
  ctx.tools.register({ name: "bash", description: "Forbidden test terminal", parameters: { type: "object", properties: {} },
    output: { schema: { type: "object", properties: {} }, render: () => [] },
    async execute() { terminalCalls++; return {}; } });
  let ordinaryCalls = 0;
  class OrdinaryProvider extends LlmAdapter {
    async *stream(options) {
      ordinaryCalls++;
      assert.deepEqual(options.tools.map(tool => tool.name), ["bash"], "the ordinary LSH scope retains its original tools");
      assert.equal(JSON.stringify(options.messages).includes("Create a storyboard"), false);
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "Ordinary LSH reply" } };
      yield { type: "finish", reason: { kind: "stop" } };
    }
  }
  ctx.llm.registerAdapter(["ordinary-synthetic"], new OrdinaryProvider());
  const ordinary = await ctx.agents.create({ sessionId: "ordinary-lsh", agentOptions: { provider: "ordinary-synthetic", model: "ordinary-model" } });
  t.after(() => ordinary.dispose());
  service = createCanvasAgentService(ctx, { stateDirectory: join(stateDirectory, "canvas") });
  const imageRequest = officialRequest();
  imageRequest.modelSelection={provider:"canvas-synthetic",model:"alternate-model",reasoningEffort:"high"};
  imageRequest.context.nodes.push({ id: "video-poster", kind: "video", title: "Poster only", text: "", editable: false,
    revision: "abcdef0123456789", image: { mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==" } });
  await service.dispatch(imageRequest);
  ordinary.agent.followup({ id: "message-ordinary", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "Ordinary LSH prompt" }] });
  await ordinary.agent.whenIdle();
  const first = await eventually(service);
  assert.equal(ordinaryCalls, 1); assert.notEqual(first.sessionId, ordinary.agent.id);
  assert.equal(requests.some(call => JSON.stringify(call.messages).includes("Ordinary LSH prompt")), false, "Canvas never borrows another LSH session's turn or context");
  assert.equal(first.status, "completed", JSON.stringify(first)); assert.equal(first.plan.steps.length, 3);
  assert.ok(requests.length>0); assert.ok(requests.every(call=>call.reasoningEffort === "high"), "official Agent forwards the selected effort to every actual adapter stream request");
  assert.deepEqual(first.plan.steps[2].settings, { aspect: "16:9", resolution: "1080p", quality: "standard", duration: 5 });
  const { validateCanvasAgentPlan: validateUiPlan, applyCanvasAgentPlan } = await import("../src/core/canvas/agent/plan.ts");
  const validated = validateUiPlan(first.plan, first.context, first.runId);
  const originalNodes = first.context.nodes.map(node => ({ id: node.id, position: { x: 0, y: 0 }, data: { kind: node.kind, label: node.text } }));
  const before = JSON.stringify(originalNodes); let nextId = 0;
  const graph = applyCanvasAgentPlan(validated, originalNodes, [], {
    createId: () => `applied-${++nextId}`, origin: { x: 300, y: 100 },
    makeNode: (step, id, position) => ({ id, position, data: { kind: step.kind, label: step.kind === "text" ? step.content : step.title, generationPrompt: step.content,
      generationAspect: step.settings?.aspect, generationResolution: step.settings?.resolution,
      generationQuality: step.settings?.quality, generationDuration: step.settings?.duration } }),
    makeEdge: (source, target, id) => ({ id, source: source.id, target: target.id }),
  });
  assert.equal(graph.nodes.length, originalNodes.length + 3); assert.equal(graph.edges.length, 3);
  assert.equal(graph.edges[1].source, graph.steps[0].nodeId); assert.equal(graph.steps[1].status, "draft");
  const videoNode = graph.nodes.find(node => node.id === graph.steps[2].nodeId);
  assert.equal(videoNode.data.generationAspect, "16:9"); assert.equal(videoNode.data.generationDuration, 5);
  assert.equal(videoNode.data.generationResolution, "1080p"); assert.equal(videoNode.data.generationQuality, "standard");
  assert.equal(JSON.stringify(originalNodes), before, "the real official tool result passes the real UI validator and immutable graph builder; generation remains approval-gated");
  assert.equal(terminalCalls, 0); assert.equal(requests.length, 3);
  assert.ok(requests.every(call=>call.model==="alternate-model"), "explicit selection reaches actual official provider stream");
  const imageBlock = requests[0].messages.flatMap(message => message.content).find(block => block.type === "image");
  assert.ok(imageBlock?.attachment, "real official attachment admission produced a durable image block");
  assert.ok((await ctx.attachments.readImage(imageBlock.attachment)).data.length > 0);
  assert.equal(first.context.nodes[1].image, undefined);
  await service.dispatch(officialRequest("request-two")); const second = await eventually(service);
  assert.equal(second.status, "completed", JSON.stringify(second)); assert.equal(second.sessionId, first.sessionId);
  assert.equal(requests.length, 6); assert.equal(terminalCalls, 0);
  assert.ok(requests.slice(3).every(call=>call.model==="test-model"), "resume follows newly selected default, without leaking previous model");
  assert.ok(requests.slice(3).every(call=>call.reasoningEffort===undefined), "resume to an unsupported route omits prior effort in actual outgoing requests");
  const stored = await ctx.sessionPersistence.open(first.sessionId, "read");
  try {
    const log = await stored.read();
    assert.equal(log.events.filter(event => event.type === "turn/end").length, 2);
    assert.equal(log.events.filter(event => event.type === "tool/result" && JSON.stringify(event).includes("proposed_not_executed")).length, 2);
  } finally { await stored.close(); }
  attackNext = true;
  await service.dispatch(officialRequest("request-illegal-tool")); const protectedRun = await eventually(service);
  assert.equal(protectedRun.status, "completed", JSON.stringify(protectedRun)); assert.equal(terminalCalls, 0);
  const protectedLog = await ctx.sessionPersistence.open(first.sessionId, "read");
  try { assert.ok((await protectedLog.read()).events.some(event => event.type === "tool/result" && event.data.message.isError), "hallucinated bash call is rejected by the actual official runtime"); }
  finally { await protectedLog.close(); }
  hold = true;
  const count = requests.length;
  const running = await service.dispatch(officialRequest("request-cancel"));
  while (requests.length === count) await new Promise(resolve => setTimeout(resolve, 2));
  await service.dispatch({ op: "cancel", canvasId: "canvas-test", runId: running.runId });
  const cancelled = await eventually(service); assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.plan, undefined);
  const beforeArchive = await ctx.sessionPersistence.open(first.sessionId, "read");
  let previousLog; try { previousLog = await beforeArchive.read(); } finally { await beforeArchive.close(); }
  const countBeforeRotation = requests.length;
  const fresh = await service.dispatch({ op: "newConversation", canvasId: "canvas-test", requestId: "official-new-conversation", expectedConversationId: cancelled.conversationId });
  assert.notEqual(fresh.conversationId, cancelled.conversationId); assert.equal(fresh.sessionId, null);
  assert.equal(requests.length, countBeforeRotation, "new conversation must not submit a model turn");
  const preserved = await ctx.sessionPersistence.open(first.sessionId, "read");
  try { assert.deepEqual(await preserved.read(), previousLog, "official prior JSONL remains intact"); } finally { await preserved.close(); }
});


test("model catalog is read-only, bounded and only projects public configured model metadata", async t => {
  const {service,calls,ctx}=await fixture(t);
  ctx.llm.listModels=async provider=>[{provider,id:"model-one",name:"One",inputModalities:["text"],apiKey:"SECRET",baseUrl:"PRIVATE"},
    {provider,id:"image-only",name:"Media",inputModalities:["image"]}];
  const result=await service.dispatch({op:"models",canvasId:"canvas-test"});
  assert.equal(calls.length,0);assert.equal(result.sessionId,null);
  assert.deepEqual(result.models.available,[{provider:"test",model:"model-one",label:"Test · One",inputModalities:["text"]}]);
  assert.equal(result.models.defaultModel.model,"model-one");assert.equal(result.models.currentModel,null);
  assert.equal(/SECRET|PRIVATE|image-only/.test(JSON.stringify(result)),false);
});

test("explicit selection reaches official Agent create/resume options and idempotency includes the selection", async t => {
  const {service,calls}=await fixture(t);
  const chosen={...request(),modelSelection:{provider:"test",model:"model-two"}};
  await service.dispatch(chosen);const first=await eventually(service);
  assert.equal(first.status,"completed");assert.equal(first.models.currentModel.model,"model-two");
  assert.deepEqual(calls[0].options.agentOptions,{provider:"test",model:"model-two"});
  await service.dispatch(chosen);assert.equal(calls.length,1);
  await assert.rejects(service.dispatch({...chosen,modelSelection:{provider:"test",model:"model-one"}}),/request-conflict/);
  await service.dispatch({...chosen,requestId:"second-model",modelSelection:{provider:"test",model:"model-one"}});
  await eventually(service);
  assert.equal(calls[1].options.resumeSessionId,first.sessionId);
  assert.deepEqual(calls[1].options.agentOptions,{provider:"test",model:"model-one"});
});

test("stale or unadvertised choices never fall back to the LSH default or spend a model call", async t => {
  const {service,calls,ctx}=await fixture(t);
  await service.dispatch({op:"models",canvasId:"canvas-test"});
  ctx.llm.listModels=async provider=>[{provider,id:"model-one",name:"One"}];
  await service.dispatch({...request(),modelSelection:{provider:"test",model:"model-two"}});
  const failed=await eventually(service);
  assert.equal(failed.error,"canvas-agent-model-unavailable");assert.equal(calls.length,0);
  await service.dispatch({...request("unknown-provider"),modelSelection:{provider:"other",model:"model-one"}});
  assert.equal((await eventually(service)).error,"canvas-agent-model-unavailable");assert.equal(calls.length,0);
  for(const modelSelection of [{provider:"test",model:"model-one",apiKey:"SECRET"},{provider:"test",model:""}])
    assert.throws(()=>validateCanvasAgentRequest({...request(),modelSelection}),/invalid-request/);
});

test("cancelling during slow catalog discovery drains without opening an Agent", async t => {
  const {service,calls,ctx}=await fixture(t);
  let release;ctx.llm.listModels=()=>new Promise(resolve=>{release=resolve;});
  const started=await service.dispatch({...request(),modelSelection:{provider:"test",model:"model-two"}});
  while(!release)await new Promise(resolve=>setTimeout(resolve,1));
  await service.dispatch({op:"cancel",canvasId:"canvas-test",runId:started.runId});
  assert.equal((await eventually(service)).status,"cancelled");assert.equal(calls.length,0);
  release([]);
});


test("reasoning is exact-route adapter metadata and explicit effort reaches create/resume", async t => {
  const reasoning={efforts:[{id:"low",name:"Low"},{id:"max",name:"Maximum",description:"More reasoning"}],defaultEffort:"low"};
  const {service,calls}=await fixture(t,{resolveModel:async(provider,model)=>({provider,id:model,...(model==='model-one'?{reasoning}:{})})});
  const catalog=await service.dispatch({op:"models",canvasId:"canvas-test"});
  assert.deepEqual(catalog.models.available[0].reasoning,reasoning);
  assert.equal(catalog.models.available[1].reasoning,undefined);
  const choice={provider:"test",model:"model-one",reasoningEffort:"max"};
  await service.dispatch({...request(),modelSelection:choice});assert.equal((await eventually(service)).status,'completed');
  assert.deepEqual(calls[0].options.agentOptions,choice);
  await service.dispatch({...request('resume-strength'),modelSelection:{...choice,reasoningEffort:'low'}});
  assert.equal((await eventually(service)).status,'completed');assert.equal(calls[1].options.agentOptions.reasoningEffort,'low');
  for(const modelSelection of [{...choice,reasoningEffort:'made-up'},{...choice,model:'model-two'}]){
    await service.dispatch({...request('bad-'+modelSelection.model),modelSelection});
    assert.equal((await eventually(service)).error,'canvas-agent-reasoning-unsupported');
  }
  assert.equal(calls.length,2,'unsupported selections fail before Agent/model calls');
  await service.dispatch({...request('no-strength'),modelSelection:{provider:'test',model:'model-two'}});
  assert.equal((await eventually(service)).status,'completed');
  assert.equal(Object.hasOwn(calls[2].options.agentOptions,'reasoningEffort'),false);
});


test("optional metadata failures leave all catalog routes selectable",async t=>{
  const {service,ctx}=await fixture(t,{resolveModel:async(provider,model)=>{
    if(model==='model-one')throw Error('metadata unavailable');
    return {provider,id:model,reasoning:{efforts:[{id:'high',name:'High'}]}};
  }});
  const result=await service.dispatch({op:'models',canvasId:'canvas-test'});
  assert.equal(result.models.available.length,2);
  assert.equal(result.models.available[0].reasoning,undefined);
  assert.equal(result.models.available[1].reasoning.efforts[0].id,'high');
});

test("slow optional metadata is cancelled and bounded while healthy routes retain strengths",async t=>{
  let active=0,peak=0,aborted=0,calls=0;
  const {service,ctx}=await fixture(t,{resolveModel:async(provider,model,signal)=>{
    calls++;active++;peak=Math.max(peak,active);
    if(model==='slow')return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{active--;aborted++;reject(Error('aborted'));},{once:true}));
    await new Promise(resolve=>setTimeout(resolve,5));active--;
    return {provider,id:model,reasoning:{efforts:[{id:'high',name:'High'}]}};
  }});
  ctx.llm.listModels=async provider=>['slow',...Array.from({length:25},(_,i)=>'healthy-'+i)].map(id=>({provider,id,name:id}));
  const began=Date.now();const result=await service.dispatch({op:'models',canvasId:'canvas-test'});
  assert.equal(result.models.available.length,26);assert.equal(result.models.available[0].reasoning,undefined);
  assert.ok(result.models.available.slice(1).every(e=>e.reasoning.efforts[0].id==='high'));
  assert.ok(Date.now()-began<3000);assert.ok(peak<=4);assert.equal(active,0);assert.equal(aborted,1);assert.equal(calls,26);
});

test("non-cooperative metadata cannot start an unbounded background queue",async t=>{
  let calls=0;const signals=[];
  const {service,ctx}=await fixture(t,{resolveModel:async(_p,_m,signal)=>{calls++;signals.push(signal);return new Promise(()=>{});}});
  ctx.llm.listModels=async provider=>Array.from({length:26},(_,i)=>({provider,id:'route-'+i}));
  const result=await service.dispatch({op:'models',canvasId:'canvas-test'});
  assert.equal(result.models.available.length,26);assert.ok(result.models.available.every(e=>e.reasoning===undefined));
  assert.equal(calls,4);assert.ok(signals.every(s=>s.aborted));
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(calls,4);
  await service.dispatch({op:'models',canvasId:'canvas-test'});assert.equal(calls,4, 'repeated refresh cannot accumulate orphan metadata lookups');
});

test("large optional reasoning catalogs stay within aggregate metadata budget",async t=>{
  const {service,ctx}=await fixture(t,{resolveModel:async(provider,model)=>({provider,id:model,reasoning:{efforts:Array.from({length:32},(_,i)=>({id:'level-'+i,name:'Level '+i,description:'d'.repeat(640)}))}})});
  ctx.llm.listModels=async provider=>Array.from({length:100},(_,i)=>({provider,id:'route-'+i}));
  const result=await service.dispatch({op:'models',canvasId:'canvas-test'});
  assert.equal(result.models.available.length,100);
  assert.ok(result.models.available.reduce((n,e)=>n+(e.reasoning?Buffer.byteLength(JSON.stringify(e.reasoning)):0),0)<=64*1024);
  assert.ok(Buffer.byteLength(JSON.stringify(result))<240*1024);
});

test("metadata pool stops scheduling at its total budget",async t=>{
  let calls=0,active=0;
  const {service,ctx}=await fixture(t,{resolveModel:(provider,model,signal)=>new Promise((resolve,reject)=>{
    calls++;active++;let finished=false;
    const done=()=>{if(finished)return;finished=true;active--;signal.removeEventListener('abort',abort);resolve({provider,id:model,reasoning:{efforts:[{id:'high',name:'High'}]}});};
    const timer=setTimeout(done,650);
    const abort=()=>{if(finished)return;finished=true;clearTimeout(timer);active--;reject(Error('aborted'));};
    signal.addEventListener('abort',abort,{once:true});
  })});
  ctx.llm.listModels=async provider=>Array.from({length:26},(_,i)=>({provider,id:'route-'+i}));
  const began=Date.now(),result=await service.dispatch({op:'models',canvasId:'canvas-test'});
  assert.equal(result.models.available.length,26);assert.ok(calls<26);assert.equal(active,0);
  assert.ok(Date.now()-began<3500,'total optional metadata budget must not approach outer10s timeout');
  const stopped=calls;await new Promise(resolve=>setTimeout(resolve,20));assert.equal(calls,stopped);
});


test("malformed optional effort entries never hide healthy catalog routes",async t=>{
  const {service}=await fixture(t,{resolveModel:async(provider,model)=>({provider,id:model,reasoning:{efforts:model==='model-one'?[null]:[{id:'high',name:'High'}]}})});
  const result=await service.dispatch({op:'models',canvasId:'canvas-test'});
  assert.equal(result.models.available.length,2);
  assert.equal(result.models.available[0].reasoning,undefined);
  assert.equal(result.models.available[1].reasoning.efforts[0].id,'high');
  await service.dispatch({...request('malformed-effort'),modelSelection:{provider:'test',model:'model-one',reasoningEffort:'high'}});
  assert.equal((await eventually(service)).error,'canvas-agent-reasoning-unsupported');
});

test("new conversation rotates identity without submitting a model turn or deleting prior history", async t => {
  const { service, calls, stateDirectory } = await fixture(t);
  await service.dispatch(request()); const old = await eventually(service);
  const reset = { op: "newConversation", canvasId: "canvas-test", requestId: "rotation-one", expectedConversationId: old.conversationId };
  const next = await service.dispatch(reset);
  assert.notEqual(next.conversationId, old.conversationId);
  assert.equal(next.sessionId, null); assert.equal(next.runId, null); assert.equal(next.status, "idle");
  assert.equal(next.requestId, reset.requestId); assert.deepEqual(next.messages, []); assert.deepEqual(next.activity, []);
  assert.equal(calls.length, 1, "rotation is storage only, not a dummy paid turn");
  assert.deepEqual(await service.dispatch(reset), next, "lost rotation ACK reuses the same conversation");
  const archiveDir = join(stateDirectory, "conversations", createHash("sha256").update("canvas-test").digest("hex"));
  const archives = await readdir(archiveDir); assert.equal(archives.length, 1);
  const archived = JSON.parse(await readFile(join(archiveDir, archives[0]), "utf8"));
  const {taskContext,...archivedPublic}=archived.snapshot; assert.equal(taskContext.goal,request().prompt); assert.deepEqual(archivedPublic, old); assert.ok(archived.requests.some(item => item.requestId === "request-one"));
  await assert.rejects(service.dispatch(request("late-old-start")), /conversation-conflict/);
  await assert.rejects(service.dispatch({ ...request(), conversationId: next.conversationId }), /request-conflict/);
  assert.equal(calls.length, 1);
  await service.dispatch({ ...request("first-new"), conversationId: next.conversationId });
  const done = await eventually(service); assert.notEqual(done.sessionId, old.sessionId);
  assert.equal(calls[1].options.resumeSessionId, undefined); assert.equal(calls.length, 2);
  const later = await service.dispatch({ ...reset, requestId: "rotation-two", expectedConversationId: next.conversationId });
  await assert.rejects(service.dispatch(reset), /conversation-conflict/);
  assert.equal((await service.dispatch({ op: "status", canvasId: "canvas-test" })).conversationId, later.conversationId);
});

test("rotation survives restart and cannot rotate while a model run is active", async t => {
  const { service, calls, ctx, stateDirectory } = await fixture(t, { onPrompt: async ({ exec }) => {
    await new Promise(resolve => exec.signal.addEventListener("abort", resolve, { once: true }));
  } });
  const run = await service.dispatch(request());
  const reset = { op: "newConversation", canvasId: "canvas-test", requestId: "rotation-after-stop", expectedConversationId: run.conversationId };
  await assert.rejects(service.dispatch(reset), /canvas-agent-busy/);
  await service.dispatch({ op: "cancel", canvasId: "canvas-test", runId: run.runId });
  await eventually(service); const next = await service.dispatch(reset); const count = calls.length;
  await service.dispose();
  const restarted = createCanvasAgentService(ctx, { stateDirectory }); t.after(() => restarted.dispose());
  assert.deepEqual(await restarted.dispatch(reset), next);
  assert.equal(calls.length, count);
  await assert.rejects(restarted.dispatch({ ...reset, expectedConversationId: "different" }), /request-conflict/);
});

test("failed rotation storage keeps the original active identity and can retry the same receipt", async t => {
  const { service, stateDirectory, calls } = await fixture(t);
  await service.dispatch(request()); const old = await eventually(service);
  await writeFile(join(stateDirectory, "conversations"), "blocked");
  const reset = { op: "newConversation", canvasId: "canvas-test", requestId: "rotation-storage", expectedConversationId: old.conversationId };
  await assert.rejects(service.dispatch(reset), /storage-unavailable/);
  assert.deepEqual(await service.dispatch({ op: "status", canvasId: "canvas-test" }), old);
  await rm(join(stateDirectory, "conversations"));
  const next = await service.dispatch(reset); assert.notEqual(next.conversationId, old.conversationId);
  assert.deepEqual(await service.dispatch(reset), next); assert.equal(calls.length, 1);
});

test("legacy persisted snapshots acquire a deterministic conversation identity without losing their transcript", async t => {
  const { service, ctx, stateDirectory } = await fixture(t);
  await service.dispatch(request()); const old = await eventually(service); await service.dispose();
  const path = join(stateDirectory, `${createHash("sha256").update("canvas-test").digest("hex")}.json`);
  const saved = JSON.parse(await readFile(path, "utf8")); saved.version = 1;
  delete saved.snapshot.conversationId; delete saved.snapshot.activity;
  await writeFile(path, JSON.stringify(saved));
  const restored = createCanvasAgentService(ctx, { stateDirectory }); t.after(() => restored.dispose());
  const next = await restored.dispatch({ op: "status", canvasId: "canvas-test" });
  assert.equal(next.conversationId, legacyConversation("canvas-test")); assert.equal(next.sessionId, old.sessionId);
  assert.deepEqual(next.messages, old.messages); assert.deepEqual(next.activity, []);
});

test("activity reports actual bounded preparation, scoped tools and terminal finalization only", async t => {
  const { service } = await fixture(t);
  await service.dispatch(request()); const result = await eventually(service);
  assert.equal(result.status, "completed"); assert.ok(result.activity.length <= 24);
  for (const label of ["preparing", "resolving-model", "opening-session", "waiting-model", "reading-context", "proposing-plan", "finalizing"])
    assert.ok(result.activity.some(entry => entry.label === label), label);
  assert.ok(result.activity.every(entry => entry.status === "completed" && Number.isSafeInteger(entry.startedAt) && entry.endedAt >= entry.startedAt));
  assert.ok(result.activity.filter(entry => entry.kind === "tool").every(entry => ["reading-context", "proposing-plan"].includes(entry.label)));
  assert.equal(/reasoning|arguments|apiKey|Bearer/.test(JSON.stringify(result.activity)), false);
});

test("slow catalog is single-flight, settles before transport timeout and leaves status and rotation available", async t => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "canvas-catalog-budget-"));
  const { ctx, calls } = fakeRuntime(); let release, lookups = 0;
  ctx.llm.listModels = () => { lookups++; return new Promise(resolve => { release = resolve; }); };
  const service = createCanvasAgentService(ctx, { stateDirectory, catalogTimeoutMs: 35 });
  t.after(async () => { release?.([]); await service.dispose(); await rm(stateDirectory, { recursive: true, force: true }); });
  const before = Date.now();
  const reads = Array.from({ length: 8 }, () => service.dispatch({ op: "models", canvasId: "canvas-test" }));
  assert.ok((await Promise.allSettled(reads)).every(result => result.status === "rejected" && /model-unavailable/.test(result.reason.message)));
  assert.ok(Date.now() - before < 1000); assert.equal(lookups, 1);
  await assert.rejects(service.dispatch({ op: "models", canvasId: "canvas-test" }), /model-unavailable/);
  assert.equal(lookups, 1, "a non-cooperative outstanding read cannot spawn more lookup workers");
  const status = await service.dispatch({ op: "status", canvasId: "canvas-test" }); assert.equal(status.status, "idle");
  const next = await service.dispatch({ op: "newConversation", canvasId: "canvas-test", requestId: "catalog-rotation", expectedConversationId: status.conversationId });
  assert.notEqual(next.conversationId, status.conversationId); assert.equal(calls.length, 0);
  release([]); await new Promise(resolve => setTimeout(resolve, 5));
  ctx.llm.listModels = async provider => [{ provider, id: "model-one" }];
  assert.equal((await service.dispatch({ op: "models", canvasId: "canvas-test" })).models.available.length, 1);
});

test("partial receipt writes never publish corrupt identities and retries preserve no-overwrite semantics", async t => {
  const directory = await mkdtemp(join(tmpdir(), "canvas-receipt-atomic-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "receipt.json"), record = { requestId: "rotation-1", conversationId: "conversation-1" };
  const failingIo = { ...receiptIo, async open(...args) {
    const file = await receiptIo.open(...args);
    return { async writeFile() { await file.writeFile('{"requestId":'); throw Object.assign(Error("synthetic ENOSPC"), { code: "ENOSPC" }); },
      sync: () => file.sync(), close: () => file.close() };
  } };
  await assert.rejects(writeCanvasAgentReceipt(path, record, failingIo), { code: "ENOSPC" });
  await assert.rejects(readFile(path), { code: "ENOENT" }); assert.deepEqual(await readdir(directory), []);
  await writeCanvasAgentReceipt(path, record);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), record);
  await assert.rejects(writeCanvasAgentReceipt(path, { ...record, conversationId: "different" }), { code: "EEXIST" });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), record); assert.deepEqual(await readdir(directory), ["receipt.json"]);
});

test("phase transitions and stop cannot falsely complete a still-running scoped tool", () => {
  const snapshot = { activity: [] };
  const waiting = advanceCanvasAgentActivity(snapshot, "waiting-model");
  const tool = advanceCanvasAgentActivity(snapshot, "reading-context", "tool");
  assert.equal(waiting.status, "completed", "waiting phase ended when the actual tool began, not model success");
  const next = advanceCanvasAgentActivity(snapshot, "waiting-model");
  assert.equal(tool.status, "running"); assert.equal(tool.endedAt, undefined);
  advanceCanvasAgentActivity(snapshot, "stopping");
  assert.equal(next.status, "failed"); assert.equal(tool.status, "running", "only tool settlement or terminal drain can close its entry");
});

test("a model picker joining start discovery upgrades the shared lookup to reasoning metadata", async t => {
  const reasoning = { efforts: [{ id: "high", name: "High" }] };
  const { service, ctx, calls } = await fixture(t, { resolveModel: async (provider, model) => ({ provider, id: model, reasoning }) });
  let release, lookups = 0;
  ctx.llm.listModels = provider => { lookups++; return new Promise(resolve => { release = () => resolve([{ provider, id: "model-one" }]); }); };
  await service.dispatch(request());
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  const models = service.dispatch({ op: "models", canvasId: "canvas-test" });
  await new Promise(resolve => setTimeout(resolve, 1)); release();
  assert.deepEqual((await models).models.available[0].reasoning, reasoning);
  assert.equal((await eventually(service)).status, "completed"); assert.equal(lookups, 1); assert.equal(calls.length, 1);
});

test('LSH failure messages survive auth, rate limit, missing model and runtime errors without changing stable codes', async t => {
  for (const [code, message, stable] of [
    ['AUTHENTICATION_FAILED', 'Authentication failed: invalid credentials.', 'canvas-agent-auth-required'],
    ['RATE_LIMIT', 'Rate limit exceeded. Please try again later.', 'canvas-agent-rate-limit'],
    ['MODEL_NOT_FOUND', 'Model example-model was not found.', 'canvas-agent-model-unavailable'],
    ['RUNTIME', 'The model stream ended unexpectedly.', 'canvas-agent-model-failed'],
  ]) {
    await t.test(code, async t => {
      const { service, stateDirectory, ctx } = await fixture(t, { onPrompt: async () => { throw Object.assign(new Error(message), { code }); } });
      await service.dispatch(request());
      const result = await eventually(service);
      assert.equal(result.status, 'failed'); assert.equal(result.error, stable);
      assert.deepEqual(result.errorDetail, { message });
      await service.dispose();
      const restored = createCanvasAgentService(ctx, { stateDirectory });
      t.after(() => restored.dispose());
      assert.deepEqual((await restored.dispatch({ op: 'status', canvasId: 'canvas-test' })).errorDetail, { message });
    });
  }
});

test('unknown failures have truthful stable fallback, never guessed cause', async t => {
  const { service } = await fixture(t, { onPrompt: async () => { throw { code: 'UNKNOWN', response: { body: 'secret' } }; } });
  await service.dispatch(request());
  const result = await eventually(service);
  assert.equal(result.error, 'canvas-agent-model-failed'); assert.equal(result.errorDetail, undefined);
});

test('preparation failures preserve LSH reason and private prompt is redacted', async t => {
  const { service } = await fixture(t, { resolveModel: async () => { throw new Error('Request rejected: Create a storyboard'); } });
  await service.dispatch(request());
  const result = await eventually(service);
  assert.equal(result.error, 'canvas-agent-runtime-unavailable');
  assert.deepEqual(result.errorDetail, {message: 'Request rejected: [redacted]'});
});

test('late error callbacks cannot contaminate a newer run and new runs clear old detail', async t => {
  let oldEmit, next;
  const { service } = await fixture(t, { onPrompt: async ({emit}) => {
    if (!oldEmit) { oldEmit = emit; throw new Error('First run failed.'); }
    await new Promise(resolve => { next = resolve; });
  } });
  await service.dispatch(request()); await eventually(service);
  await service.dispatch(request('request-two'));
  while (!next) await new Promise(resolve => setTimeout(resolve, 2));
  oldEmit('agent/error', { error: new Error('Stale failure.') });
  const running = await service.dispatch({op:'status',canvasId:'canvas-test'});
  assert.equal(running.errorDetail, undefined);
  next(); const result = await eventually(service);
  assert.equal(result.status, 'completed'); assert.equal(result.error, undefined); assert.equal(result.errorDetail, undefined);
});

test('cancelled run never exposes a late LSH failure as an error', async t => {
  let emitError;
  const { service } = await fixture(t, { onPrompt: async ({emit,exec}) => {
    emitError = () => emit('agent/error', { error: new Error('Late provider failure.') });
    await new Promise(resolve => exec.signal.addEventListener('abort', resolve, {once:true}));
    emitError();
  } });
  const started = await service.dispatch(request());
  while (!emitError) await new Promise(resolve => setTimeout(resolve, 2));
  await service.dispatch({op:'cancel',canvasId:'canvas-test',runId:started.runId});
  const result = await eventually(service);
  assert.equal(result.status, 'cancelled'); assert.equal(result.error, undefined); assert.equal(result.errorDetail, undefined);
});

test('malformed detail is rejected at both persisted snapshot restore boundaries', async t => {
  const { service, ctx, stateDirectory } = await fixture(t, { onPrompt: async () => { throw new Error('Model request failed.'); } });
  await service.dispatch(request()); const failed = await eventually(service);
  const next = await service.dispatch({op:'newConversation',canvasId:'canvas-test',requestId:'error-rotation',expectedConversationId:failed.conversationId});
  const hash = value => createHash('sha256').update(value).digest('hex');
  const archivePath = join(stateDirectory,'conversations',hash('canvas-test'),`${hash(failed.conversationId)}.json`);
  const archive = JSON.parse(await readFile(archivePath,'utf8'));
  archive.snapshot.errorDetail.rawBody = 'private diagnostics';
  await writeFile(archivePath,JSON.stringify(archive));
  await assert.rejects(service.dispatch({op:'resumeConversation',canvasId:'canvas-test',requestId:'resume-bad-detail',expectedConversationId:next.conversationId,conversationId:failed.conversationId}), /storage-unavailable/);
  await service.dispose();
  const currentPath = join(stateDirectory,`${hash('canvas-test')}.json`);
  await writeFile(currentPath,JSON.stringify(archive));
  const restored = createCanvasAgentService(ctx,{stateDirectory}); t.after(()=>restored.dispose());
  await assert.rejects(restored.dispatch({op:'status',canvasId:'canvas-test'}), /storage-unavailable/);
});

test('installed DSH LlmError public fields preserve known classes without reading private diagnostics',
  {skip:!process.env.DSH_CANVAS_TEST_NODE_MODULES}, async t => {
  const {LlmError}=await import(pathToFileURL(join(process.env.DSH_CANVAS_TEST_NODE_MODULES,'@deepseek-ai/dsh-llm/lib/index.js')).href);
  for(const [code,message,stable,detail] of [
    ['RATE_LIMIT','Too many model requests.','canvas-agent-rate-limit',{message:'Too many model requests.'}],
    ['QUOTA','provider account private detail','canvas-agent-quota-exceeded',undefined],
    ['ACCOUNT_QUOTA','provider account private detail','canvas-agent-quota-exceeded',undefined],
    ['AUTH','provider credential private detail','canvas-agent-auth-required',undefined],
    ['ACCOUNT_SIGN_IN_REQUIRED','provider login private detail','canvas-agent-account-sign-in-required',undefined],
    ['CONTEXT_WINDOW_EXCEEDED','The request exceeds the model context.','canvas-agent-model-context-limit',{message:'The request exceeds the model context.'}],
    ['EMPTY_RESPONSE','No model content returned.','canvas-agent-empty-response',{message:'No model content returned.'}],
  ]) await t.test(code,async t=>{
    const caught=new LlmError(message,code,{status:429,requestId:'synthetic-request',cause:{headers:{authorization:'private'},body:'private'}});
    assert.equal(caught.message,message);assert.equal(caught.failure.message,message);
    const {service}=await fixture(t,{onPrompt:async()=>{throw caught;}});
    await service.dispatch(request());const result=await eventually(service);
    assert.equal(result.status,'failed');assert.equal(result.error,stable);assert.deepEqual(result.errorDetail,detail);
    assert.ok(!String(JSON.stringify(result.errorDetail)).includes('authorization'));
  });
});

test('verified LSH turn/end error.message survives without a live agent/error event',async t=>{
  const {service}=await fixture(t,{onPrompt:async({emit,agent})=>{
    emit('session/event',agent.session,{type:'turn/end',data:{reason:{kind:'error',error:{message:'The model stream ended unexpectedly.',code:'UNKNOWN',status:503,requestId:'synthetic-terminal'}}}});
  }});
  await service.dispatch(request());const result=await eventually(service);
  assert.equal(result.status,'failed');assert.equal(result.error,'canvas-agent-model-failed');
  assert.deepEqual(result.errorDetail,{message:'The model stream ended unexpectedly.'});
});

test('captured Gemini malformed operation shapes stay rejected before dispatch while official typed shapes remain valid',async t=>{
 const {service,calls}=await fixture(t,{onPrompt:async({tools,exec})=>{
  const creative=tools.get('canvas_edit_creation'),graph=tools.get('canvas_edit_graph');
  // Preserve the internal batch/Director contract and graph declaration hashes.
  // Only the model-facing creative root changes for provider compatibility.
  const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const {CREATION_SCHEMAS}=await import('../src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/luckyray-dsh-canvas-creation-schema.mjs');
  assert.equal(hash(CREATION_SCHEMAS.edit),'02214001a2cc17cf05d0dd3097b46e72c7beefd852f00a758ea503b7585229ad');
  assert.equal(creative.parameters.type,'object');assert.equal(Object.hasOwn(creative.parameters,'oneOf'),false);
  assert.deepEqual(creative.parameters.properties.operation,CREATION_SCHEMAS.edit.oneOf[0].properties.operation);
  assert.deepEqual(creative.parameters.properties.operations,CREATION_SCHEMAS.edit.oneOf[1].properties.operations);
  assert.equal(hash(graph.parameters),'d3e52503e5362d813d70cea7420fe185046267a6ae91bc90836caf80b9586401');
  for(const operation of [{},{title:'Synthetic',type:'storyboard'},{action:'create',title:'Synthetic'},{kind:'storyboard',title:'Synthetic'},{scope:'storyboards'},{createStoryboard:{}},{create_storyboard:{}},{CreateStoryboard:{}}])
   await assert.rejects(creative.execute({expectedRevision:'0123456789abcdef',operation},exec),error=>error.code==='canvas-agent-creation-invalid');
  for(const operation of [{},{type:'create'}])await assert.rejects(graph.execute({operations:[operation]},exec),error=>error.code==='canvas-agent-invalid-plan');
 }});
 await service.dispatch({...request(),execution:{mode:'autonomous',allowGeneration:false,maxMediaJobs:0}});
 const result=await eventually(service);assert.equal(result.status,'completed');assert.equal(result.pendingAction,undefined);
 assert.equal(calls.length,1);assert.equal(result.execution.reservedMediaJobs,0);
});

