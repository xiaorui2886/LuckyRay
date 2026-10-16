import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve("vite/package.json"))("esbuild");
const bundle = await esbuild.build({
  entryPoints: [fileURLToPath(new URL("../src/core/extensions/runtime.ts", import.meta.url))],
  bundle: true, format: "esm", write: false,
  plugins: [{ name: "controlled-transport", setup(b) { b.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: "transport", namespace: "fixture" })); b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const invoke=(...a)=>globalThis.fixtureInvoke(...a)" })); } }],
});
const { runPlugin, PluginRunError, isPreExecutionRefusal } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

/** Scripted broker: each poll returns the next message; dispatch answers from the table. */
function broker(messages, answers) {
  const ops = [];
  let cursor = 0;
  globalThis.fixtureInvoke = async (_, { request }) => {
    const req = JSON.parse(request);
    ops.push(req.op);
    if (req.op === "start") return { token: "t" };
    if (req.op === "poll") return messages[cursor++];
    if (req.op === "dispatch") return { response: answers.shift() };
    return {};
  };
  return ops;
}
const scope = (extra = {}) => ({ materialIds: [], canvasIds: [], knowledge: null, writes: true, exportPath: null, theme: {}, ...extra });

test("committed write responses become outcomes carrying the host value; reads and errors do not", async () => {
  const note = { documentRef: { vaultId: "v", relativePath: "notes/a.md" }, title: "A", content: "", revision: "1" };
  const ops = broker([
    { kind: "call", request: { method: "materials.list", params: {} } },
    { kind: "call", request: { method: "knowledge.create", params: { title: "A", content: "" } } },
    { kind: "call", request: { method: "materials.tags", params: { id: "m", revision: "1", tags: ["x"] } } },
    { kind: "result", result: { ok: true, value: { title: "done" } }, receipts: [{ method: "knowledge.create", committed: true }] },
  ], [{ value: [] }, { value: note }, { error: "plugin-write-confirmation-required" }]);
  const logs = [];
  const result = await runPlugin("p", scope(), {}, new AbortController().signal, m => logs.push(m));
  assert.deepEqual(result.ui, { title: "done" });
  assert.deepEqual(result.outcomes, [{ call: 2, method: "knowledge.create", value: note, exportPath: null }]);
  assert.equal(result.receipts.length, 1);
  assert.ok(logs.includes("plugin-write-confirmation-required"));
  assert.equal(ops.filter(op => op === "dispatch").length, 3);
  assert.ok(ops.includes("close"));
});

test("canvas.export outcome carries the host-chosen destination from the scope", async () => {
  broker([
    { kind: "call", request: { method: "canvas.export", params: { id: "c", digest: "d" } } },
    { kind: "result", result: { ok: true, value: { title: "exported" } }, receipts: [{ method: "canvas.export", committed: true }] },
  ], [{ value: { format: "svg", bytes: 10, nodes: 1, edges: 0 } }]);
  const result = await runPlugin("p", scope({ canvasIds: ["c"], exportPath: "C:/out/c.svg" }), {}, new AbortController().signal, () => {});
  assert.deepEqual(result.outcomes, [{ call: 1, method: "canvas.export", value: { format: "svg", bytes: 10, nodes: 1, edges: 0 }, exportPath: "C:/out/c.svg" }]);
});

test("a failed run rejects with the host error code and dispatches nothing further", async () => {
  const ops = broker([{ kind: "result", result: { ok: false, error: "plugin-worker-ended" } }], []);
  await assert.rejects(runPlugin("p", scope(), {}, new AbortController().signal, () => {}), /plugin-worker-ended/);
  assert.equal(ops.includes("dispatch"), false);
});

// ---- R2: host-confirmed progress must survive plugin/UI/transport failure and cancellation ----
const TAGS = { id: "m1", name: "Asset", tagIds: ["blue"], revision: "r2" };
const rejectsWith = async (promise, code) => { const error = await promise.then(() => null, e => e); assert.ok(error instanceof PluginRunError, "PluginRunError expected"); assert.equal(error.code, code); return error; };

test("R2/central-1: write confirmed, then the plugin throws — the error still carries the confirmed outcome", async () => {
  broker([
    { kind: "call", request: { method: "materials.tags", params: { id: "m1", revision: "r1", tags: ["blue"] } } },
    { kind: "result", result: { ok: false, error: "Error: after-write-failed" }, receipts: [{ method: "materials.tags", committed: true }] },
  ], [{ value: TAGS }]);
  const error = await rejectsWith(runPlugin("p", scope({ materialIds: ["m1"] }), {}, new AbortController().signal, () => {}), "Error: after-write-failed");
  assert.deepEqual(error.outcomes, [{ call: 1, method: "materials.tags", value: TAGS, exportPath: null }]);
  assert.deepEqual(error.unconfirmed, []);
});

test("R2/central-2: write confirmed, then invalid UI — outcome preserved, code plugin-ui-invalid", async () => {
  broker([
    { kind: "call", request: { method: "materials.tags", params: { id: "m1", revision: "r1", tags: ["blue"] } } },
    { kind: "result", result: { ok: true, value: { title: 99 } }, receipts: [{ method: "materials.tags", committed: true }] },
  ], [{ value: TAGS }]);
  const error = await rejectsWith(runPlugin("p", scope({ materialIds: ["m1"] }), {}, new AbortController().signal, () => {}), "plugin-ui-invalid");
  assert.equal(error.outcomes.length, 1);
});

test("R2: dispatch transport failure leaves the write unconfirmed (not confirmed, not refused)", async () => {
  const ops = broker([{ kind: "call", request: { method: "materials.tags", params: { id: "m1", revision: "r1", tags: ["blue"] } } }], []);
  globalThis.fixtureInvoke = ((inner) => async (cmd, args) => { const req = JSON.parse(args.request); if (req.op === "dispatch") throw new Error("ipc-broken"); return inner(cmd, args); })(globalThis.fixtureInvoke);
  const seen = [];
  const error = await rejectsWith(runPlugin("p", scope({ materialIds: ["m1"] }), {}, new AbortController().signal, () => {}, p => seen.push(p)), "ipc-broken");
  assert.deepEqual(error.unconfirmed, [{ call: 1, method: "materials.tags", target: "m1" }]);
  assert.deepEqual(error.outcomes, []);
  assert.deepEqual(error.failures, [{ call: 1, method: "materials.tags", code: "ipc-broken", kind: "unknown" }]);
  assert.ok(seen.some(p => p.unconfirmed.length === 1), "progress published the pending write before dispatch");
  assert.ok(ops.includes("close"));
});

test("R2: a lease refusal thrown by dispatch means the write never ran — refused, not unconfirmed", async () => {
  broker([{ kind: "call", request: { method: "materials.tags", params: { id: "m1", revision: "r1", tags: ["blue"] } } }], []);
  globalThis.fixtureInvoke = ((inner) => async (cmd, args) => { const req = JSON.parse(args.request); if (req.op === "dispatch") throw new Error("plugin-retired"); return inner(cmd, args); })(globalThis.fixtureInvoke);
  const error = await rejectsWith(runPlugin("p", scope({ materialIds: ["m1"] }), {}, new AbortController().signal, () => {}), "plugin-retired");
  assert.deepEqual(error.unconfirmed, []);
  assert.deepEqual(error.failures, [{ call: 1, method: "materials.tags", code: "plugin-retired", kind: "refused" }]);
});

test("R2: native deliveryError after a committed write keeps the outcome and ends the run with that code", async () => {
  let polls = 0;
  globalThis.fixtureInvoke = async (_, { request }) => {
    const req = JSON.parse(request);
    if (req.op === "start") return { token: "t" };
    if (req.op === "poll") return polls++ === 0 ? { kind: "call", request: { method: "materials.tags", params: { id: "m1", revision: "r1", tags: ["blue"] } } } : { kind: "pending" };
    if (req.op === "dispatch") return { response: { value: TAGS }, deliveryError: "plugin-retired" };
    return {};
  };
  const error = await rejectsWith(runPlugin("p", scope({ materialIds: ["m1"] }), {}, new AbortController().signal, () => {}), "plugin-retired");
  assert.deepEqual(error.outcomes, [{ call: 1, method: "materials.tags", value: TAGS, exportPath: null }]);
  assert.deepEqual(error.unconfirmed, []);
});

test("R2: cancellation after a confirmed write reports plugin-cancelled with the outcome kept", async () => {
  const controller = new AbortController();
  let polls = 0;
  globalThis.fixtureInvoke = async (_, { request }) => {
    const req = JSON.parse(request);
    if (req.op === "start") return { token: "t" };
    if (req.op === "poll") { if (polls++ === 0) return { kind: "call", request: { method: "materials.tags", params: { id: "m1", revision: "r1", tags: ["blue"] } } }; controller.abort(); return { kind: "pending" }; }
    if (req.op === "dispatch") return { response: { value: TAGS } };
    return {};
  };
  const error = await rejectsWith(runPlugin("p", scope({ materialIds: ["m1"] }), {}, controller.signal, () => {}), "plugin-cancelled");
  assert.equal(error.outcomes.length, 1);
});

test("R2: pre-execution refusal codes come from the native table; unknown codes are not treated as refusals", () => {
  for (const code of ["plugin-retired", "plugin-write-confirmation-required", "plugin-revision-conflict", "plugin-host-veto", "plugin-permission-denied", "knowledge-name-conflict", "knowledge-invalid-title"]) {
    assert.equal(isPreExecutionRefusal(code), true, code);
    if (code.startsWith("knowledge-")) assert.equal(isPreExecutionRefusal(JSON.stringify({ code, message: "x" })), true, code + " (JSON-shaped, as the native domain serialises it)");
  }
  for (const code of ["plugin-export-write-failed", "plugin-worker-failed", "ipc-broken", "Error: boom"]) assert.equal(isPreExecutionRefusal(code), false, code);
});

test("R2: a knowledge write without an active source is vetoed before execution — never unconfirmed", async () => {
  const controller = new AbortController();
  let polls = 0, vetoSeen = null;
  globalThis.fixtureInvoke = async (_, { request }) => {
    const req = JSON.parse(request);
    if (req.op === "start") return { token: "t" };
    if (req.op === "poll") { if (polls++ === 0) return { kind: "call", request: { method: "knowledge.create", params: { title: "A", content: "" } } }; controller.abort(); return { kind: "pending" }; }
    if (req.op === "dispatch") { vetoSeen = req.veto; return { response: { error: "plugin-host-veto" } }; }
    return {};
  };
  const error = await rejectsWith(runPlugin("p", scope(), {}, controller.signal, () => {}), "plugin-cancelled");
  assert.equal(vetoSeen, "source-changed");
  assert.deepEqual(error.unconfirmed, []);
  assert.deepEqual(error.failures, [{ call: 1, method: "knowledge.create", code: "plugin-host-veto", kind: "refused" }]);
});

test("R2/close-R1: runtime classifies each failure once — refused only for the native pre-execution table, otherwise unknown", async () => {
  let polls = 0;
  globalThis.fixtureInvoke = async (_, { request }) => {
    const req = JSON.parse(request);
    if (req.op === "start") return { token: "t" };
    if (req.op === "poll") return [
      { kind: "call", request: { method: "materials.tags", params: { id: "m1", revision: "r1", tags: ["a"] } } },
      { kind: "call", request: { method: "materials.tags", params: { id: "m2", revision: "r1", tags: ["b"] } } },
      { kind: "call", request: { method: "materials.tags", params: { id: "m3", revision: "r1", tags: ["c"] } } },
      { kind: "result", result: { ok: true, value: { title: "mixed" } }, receipts: [] },
    ][polls++];
    if (req.op === "dispatch") return [{ response: { value: TAGS } }, { response: { error: "plugin-export-write-failed" } }, { response: { error: "plugin-permission-denied" } }][req.veto ? 99 : (globalThis.__d = (globalThis.__d || 0) + 1) - 1];
    return {};
  };
  globalThis.__d = 0;
  const result = await runPlugin("p", scope({ materialIds: ["m1", "m2", "m3"] }), {}, new AbortController().signal, () => {});
  assert.deepEqual(result.outcomes.map(o => o.call), [1], "m1 confirmed");
  assert.deepEqual(result.unconfirmed, [{ call: 2, method: "materials.tags", target: "m2" }], "m2 unknown stays unconfirmed");
  assert.deepEqual(result.failures, [
    { call: 2, method: "materials.tags", code: "plugin-export-write-failed", kind: "unknown" },
    { call: 3, method: "materials.tags", code: "plugin-permission-denied", kind: "refused" },
  ], "each call keeps its own classification; nothing is merged by method");
});
