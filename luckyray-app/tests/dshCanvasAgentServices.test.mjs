import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createCanvasAgentService } from "../src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/luckyray-dsh-canvas-agent.mjs";

// Deliberately no provider, credentials, network, real profile or model call.
// Sibling Cordis services are available through get(), not raw ctx properties.
function fixture() {
  const calls = { creates: 0, resolves: 0, flushes: 0, disposed: 0, allowed: null };
  const create = async options => {
    calls.creates++;
    const handlers = new Map();
    const agent = {
      id: options.sessionId ?? options.resumeSessionId, session: {},
      followup() {
        handlers.get("session/event")?.(null, { type: "assistant/message", data: { message: { content: [{ type: "text", text: "Synthetic service-boundary reply" }] } } });
        handlers.get("session/event")?.(null, { type: "turn/end", data: { reason: { kind: "completed" } } });
      },
      async whenIdle() {}, cancel() {},
    };
    await options.setup({
      tools: { restrict(value) { calls.allowed = value; }, presentAs() {}, guard() {}, register() {} },
      systemPrompt: { section() {} }, on(name, handler) { handlers.set(name, handler); },
    }, agent);
    return { agent, async dispose() { calls.disposed++; } };
  };
  const services = {
    agents: { create, resume: create },
    sessions: { async flush() { calls.flushes++; } },
    sessionPersistence: { async flush() {} },
    agentDefaultModel: { currentSelection() { return { provider: "synthetic", model: "boundary-only" }; } },
    llm: { listProviders: () => [{id:"synthetic",name:"Synthetic"}], async listModels(provider) {return [{provider,id:"boundary-only",name:"Boundary"}];}, async resolveModelInfo(provider, model) { calls.resolves++; return { provider, id: model }; } },
  };
  return { calls, services };
}
const legacyConversation = id => `legacy-${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;

const request = () => ({ op: "start", canvasId: "canvas-services", conversationId: legacyConversation("canvas-services"), requestId: "request-services", prompt: "Synthetic boundary check", context: {
  version: 1, canvasId: "canvas-services", canvasName: "Synthetic services", nodes: [], connections: [],
  generation: { imageModels: [], videoModels: [], imageReady: false, videoReady: false },
} });
async function exercise(ctx, calls) {
  const directory = await mkdtemp(join(tmpdir(), "luckyray-agent-services-"));
  const service = createCanvasAgentService(ctx, { stateDirectory: directory });
  try {
    await service.dispatch(request());
    for (let i = 0; i < 100 && service.hasActiveRuns(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    const result = await service.dispatch({ op: "status", canvasId: "canvas-services" });
    assert.equal(result.status, "completed", result.error);
    assert.equal(result.messages.at(-1).text, "Synthetic service-boundary reply");
    assert.equal(calls.creates, 1);
    assert.equal(calls.resolves, 1);
    assert.equal(calls.flushes, 1);
    assert.equal(calls.disposed, 1);
    assert.deepEqual(calls.allowed, { allow: [] }, "planning tools remain the only explicit additions");
    await service.dispatch(request());
    assert.equal(calls.creates, 1, "successful identity retry cannot create a second model turn");
  } finally {
    await service.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

test("Agent resolves optional host services through the explicit Cordis lookup boundary", async () => {
  const { calls, services } = fixture();
  const ctx = new Proxy({ get(name) { return services[name]; } }, {
    get(target, key, receiver) {
      if (Object.hasOwn(services, key)) throw new Error(`cannot get property ${String(key)} without inject`);
      return Reflect.get(target, key, receiver);
    },
  });
  await exercise(ctx, calls);
});

test("missing required runtime service fails closed before resolving a model or creating an Agent", async () => {
  const { calls, services } = fixture();
  delete services.sessions;
  const directory = await mkdtemp(join(tmpdir(), "luckyray-agent-services-missing-"));
  const service = createCanvasAgentService({ get(name) { return services[name]; } }, { stateDirectory: directory });
  try {
    await service.dispatch(request());
    for (let i = 0; i < 100 && service.hasActiveRuns(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    const result = await service.dispatch({ op: "status", canvasId: "canvas-services" });
    assert.equal(result.status, "failed");
    assert.equal(result.error, "canvas-agent-runtime-unavailable");
    assert.equal(calls.creates, 0);
    assert.equal(calls.resolves, 0);
  } finally {
    await service.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("official 0.2.1 Cordis sibling-service context exercises the same boundary", {
  skip: process.env.DSH_M1_RUNTIME_ROOT ? false : "requires official DSH runtime fixture",
}, async () => {
  const { Context } = await import(pathToFileURL(join(process.env.DSH_M1_RUNTIME_ROOT, "host/node_modules/@deepseek-ai/cordis/lib/index.js")).href);
  const root = new Context();
  const { calls, services } = fixture();
  let provideReady;
  const ready = new Promise(resolve => { provideReady = resolve; });
  root.plugin({ apply(ctx) { for (const [name, value] of Object.entries(services)) ctx.provide(name, value); provideReady(); } });
  await ready;
  let consumeReady;
  const consumed = new Promise(resolve => { consumeReady = resolve; });
  root.plugin({ apply(ctx) { consumeReady(ctx); } });
  const ctx = await consumed;
  try {
    assert.throws(() => ctx.agents, /without inject/, "matches the real carrier's undeclared sibling access");
    assert.equal(typeof ctx.get("agents").create, "function");
    await exercise(ctx, calls);
  } finally { await root.fiber.dispose(); }
});
