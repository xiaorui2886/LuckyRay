import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  RESOURCE_OPERATIONS,
  createChildResourceRouter,
  createFdResourceBridge,
  createResourceToolDefinitions,
  signResourceFrame,
} from "../src-tauri/dsh-host/luckyray-dsh-resource-tools/index.mjs";

function fixture(mode = "read-only") {
  const state = { mode, workspaceRoot: mode === "workspace-write" ? "C:\\workspace" : "" };
  const events = [
    { seq: 0, type: "sandbox/mode", data: { mode } },
    { seq: 1, type: "tool/call", data: { callId: "call-1", name: "luckyray_knowledge_list" } },
  ];
  const session = { id: "session-owned", firstLiveSeq: 0, events };
  const agent = { id: session.id, session };
  const calls = [];
  const policies = [];
  const listeners = new Map();
  const ctx = {
    on(name, callback) {
      const callbacks = listeners.get(name) ?? [];
      callbacks.push(callback);
      listeners.set(name, callbacks);
      return () => {};
    },
    sandboxPolicy: {
      resolve: () => ({ mode: state.mode, workspaceRoot: state.workspaceRoot }),
    },
    approval: {
      config: { policy: "ask" },
      overrideOf: () => "ask",
      request: async () => "allowed-once",
    },
    fs: {
      resolve: async (path) => ({ targetKey: path, displayPath: path }),
      stat: async () => ({ type: "file", version: "v1" }),
      contains: () => true,
      processPath: (target) => target.targetKey,
    },
  };
  const bridge = {
    syncPolicy: async (policy) => policies.push(policy),
    call: async (call) => { calls.push(call); return { items: [] }; },
  };
  const emit = (name, ...args) => {
    for (const callback of listeners.get(name) ?? []) callback(...args);
  };
  return { ctx, bridge, session, agent, calls, policies, state, emit };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

test("resource inventory is complete, unique, and access-classified", () => {
  const ids = RESOURCE_OPERATIONS.map(([id]) => id);
  assert.equal(ids.length, 62);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(new Set(RESOURCE_OPERATIONS.map(([, access]) => access)),
    new Set(["read", "write", "destructive", "full"]));
  for (const required of [
    "luckyray_knowledge_source_register",
    "luckyray_knowledge_delete",
    "luckyray_materials_wide_import",
    "luckyray_materials_asset_delete",
    "luckyray_materials_retry_pending",
    "luckyray_web_search",
    "luckyray_web_fetch",
    "luckyray_browser_open",
    "luckyray_browser_read",
    "luckyray_browser_extract",
  ]) assert.equal(ids.includes(required), true, required);
  const definitions = createResourceToolDefinitions(fixture().ctx, fixture().bridge);
  assert.equal(definitions.length, 62);
  for (const definition of definitions) {
    assert.equal(definition.parameters.type, "object", definition.name);
    assert.equal(definition.parameters.additionalProperties, false, definition.name);
  }
  const search = definitions.find((definition) => definition.name === "luckyray_web_search");
  assert.deepEqual(search.parameters.required, ["query"]);
  assert.equal(search.parameters.properties.query.maxLength, 1024);
  assert.equal(search.parameters.properties.limit.maximum, 8);
  const fetch = definitions.find((definition) => definition.name === "luckyray_web_fetch");
  assert.deepEqual(fetch.parameters.required, ["fetchRef"]);
  assert.equal(fetch.parameters.properties.fetchRef.pattern, "^wref-[0-9a-f]{64}$");
  const open = definitions.find((definition) => definition.name === "luckyray_browser_open");
  assert.deepEqual(open.parameters.required, ["navigationRef"]);
  assert.equal(open.parameters.properties.navigationRef.pattern, "^nav-[A-Za-z0-9]{48}$");
  const read = definitions.find((definition) => definition.name === "luckyray_browser_read");
  assert.deepEqual(read.parameters.required, ["browserRef"]);
  assert.equal(read.parameters.properties.browserRef.pattern, "^browser-[A-Za-z0-9]{48}$");
  const extract = definitions.find((definition) => definition.name === "luckyray_browser_extract");
  assert.deepEqual(extract.parameters.required, ["browserRef", "kind"]);
  assert.deepEqual(extract.parameters.properties.kind.enum,
    ["main", "article", "headings", "links", "table"]);
  assert.equal(extract.parameters.properties.index.maximum, 15);
});

test("official filesystem authority gates workspace paths while Full Access strips model path authority", async () => {
  const owned = fixture("workspace-write");
  owned.ctx.fs.contains = () => false;
  owned.session.events.push({
    seq: 2,
    type: "tool/call",
    data: { callId: "call-import", name: "luckyray_materials_import_path" },
  });
  const imported = createResourceToolDefinitions(owned.ctx, owned.bridge)
    .find((definition) => definition.name === "luckyray_materials_import_path");
  const exec = {
    agent: owned.agent,
    callId: "call-import",
    rootCallId: "call-import",
    signal: new AbortController().signal,
  };
  await assert.rejects(
    imported.execute({ path: "C:\\outside\\asset.png" }, exec),
    /dsh-resource-path-out-of-scope/u,
  );
  assert.equal(owned.calls.length, 0);

  owned.state.mode = "danger-full-access";
  owned.state.workspaceRoot = "";
  await imported.execute({
    path: "C:\\outside\\asset.png",
    options: { storageMode: "managed", managedLibraryDir: "C:\\forged" },
  }, exec);
  assert.equal(owned.calls.length, 1);
  assert.equal(owned.calls[0].args.authorizedPath, "C:\\outside\\asset.png");
  assert.equal("path" in owned.calls[0].args, false);
  assert.equal("managedLibraryDir" in owned.calls[0].args.options, false);
});

test("official destructive approval denial and policy narrowing both stop before Backend delivery", async () => {
  const owned = fixture("workspace-write");
  owned.session.events.push({
    seq: 2,
    type: "tool/call",
    data: { callId: "call-delete", name: "luckyray_knowledge_delete" },
  });
  owned.ctx.approval.request = async () => "rejected";
  const deleted = createResourceToolDefinitions(owned.ctx, owned.bridge)
    .find((definition) => definition.name === "luckyray_knowledge_delete");
  await assert.rejects(deleted.execute({ resourceRef: "rr-".concat("0".repeat(36)) }, {
    agent: owned.agent,
    callId: "call-delete",
    rootCallId: "call-delete",
    signal: new AbortController().signal,
  }), /dsh-resource-approval-denied/u);
  assert.equal(owned.calls.length, 0);

  owned.state.mode = "read-only";
  await assert.rejects(deleted.execute({ resourceRef: "rr-".concat("0".repeat(36)) }, {
    agent: owned.agent,
    callId: "call-delete",
    rootCallId: "call-delete",
    signal: new AbortController().signal,
  }), /dsh-resource-policy-denied/u);
  assert.equal(owned.calls.length, 0);
});

test("an official downgrade queued before resource admission wins with effect0", async () => {
  const owned = fixture("workspace-write");
  const approval = deferred();
  owned.ctx.approval.request = () => approval.promise;
  const deleted = createResourceToolDefinitions(owned.ctx, owned.bridge)
    .find((definition) => definition.name === "luckyray_knowledge_delete");
  const executing = deleted.execute({ resourceRef: "rr-".concat("0".repeat(36)) }, {
    agent: owned.agent,
    callId: "delete-downgrade-first",
    rootCallId: "delete-downgrade-first",
    signal: new AbortController().signal,
  });
  await Promise.resolve();
  owned.state.mode = "read-only";
  owned.state.workspaceRoot = "";
  const event = { seq: 2, type: "sandbox/mode", data: { mode: "read-only" } };
  owned.session.events.push(event);
  owned.emit("session/event", owned.session, event);
  approval.resolve("allowed-once");
  await assert.rejects(executing, /dsh-resource-policy-(changed|denied)/u);
  assert.equal(owned.calls.length, 0);
  assert.equal(owned.policies.at(-1)?.mode, "read-only");
});

test("Workspace Write never rejects destructive effects while Full Access never remains complete", async () => {
  const workspace = fixture("workspace-write");
  workspace.ctx.approval.overrideOf = () => "never";
  workspace.ctx.approval.config.policy = "never";
  workspace.ctx.approval.request = async () => {
    throw new Error("approval must not be called for never");
  };
  const workspaceDelete = createResourceToolDefinitions(workspace.ctx, workspace.bridge)
    .find((definition) => definition.name === "luckyray_knowledge_delete");
  await assert.rejects(workspaceDelete.execute({ resourceRef: "rr-".concat("0".repeat(36)) }, {
    agent: workspace.agent,
    callId: "workspace-never-delete",
    rootCallId: "workspace-never-delete",
    signal: new AbortController().signal,
  }), /dsh-resource-approval-denied/u);
  assert.equal(workspace.calls.length, 0);

  const full = fixture("danger-full-access");
  full.ctx.approval.overrideOf = () => "never";
  full.ctx.approval.config.policy = "never";
  const fullDelete = createResourceToolDefinitions(full.ctx, full.bridge)
    .find((definition) => definition.name === "luckyray_knowledge_delete");
  await fullDelete.execute({ resourceRef: "rr-".concat("0".repeat(36)) }, {
    agent: full.agent,
    callId: "full-never-delete",
    rootCallId: "full-never-delete",
    signal: new AbortController().signal,
  });
  assert.equal(full.calls.length, 1);
  assert.equal(full.calls[0].mode, "danger-full-access");
  assert.equal(full.calls[0].approval, "not-required");
});

test("siblings and children always project their own official Session policy", async () => {
  const owned = fixture("read-only");
  const child = fixture("workspace-write");
  child.session.id = "session-child";
  child.agent.id = child.session.id;
  child.session.events[1] = {
    seq: 1,
    type: "tool/call",
    data: { callId: "child-create", name: "luckyray_knowledge_create" },
  };
  const create = createResourceToolDefinitions(child.ctx, child.bridge)
    .find((definition) => definition.name === "luckyray_knowledge_create");
  await create.execute({ title: "Child", content: "own authority" }, {
    agent: child.agent,
    callId: "child-create",
    rootCallId: "child-create",
    signal: new AbortController().signal,
    parent: owned.agent,
  });
  assert.equal(child.calls[0].sessionId, "session-child");
  assert.equal(child.calls[0].mode, "workspace-write");
  assert.equal(owned.calls.length, 0);
});

test("a parent Full Access session cannot lend mutation authority to a Read Only child", async () => {
  const parent = fixture("danger-full-access");
  const child = fixture("read-only");
  child.session.id = "session-child-read-only";
  child.agent.id = child.session.id;
  const create = createResourceToolDefinitions(child.ctx, child.bridge)
    .find((definition) => definition.name === "luckyray_knowledge_create");
  await assert.rejects(create.execute({ title: "Denied", content: "write0" }, {
    agent: child.agent,
    callId: "child-denied",
    rootCallId: "child-denied",
    signal: new AbortController().signal,
    parent: parent.agent,
  }), /dsh-resource-policy-denied/u);
  assert.equal(child.calls.length, 0);
  assert.equal(parent.calls.length, 0);
});

test("a mutation admitted before permission narrowing returns its exact committed settlement", async () => {
  const owned = fixture("workspace-write");
  const settlement = deferred();
  owned.bridge.call = async (call) => {
    owned.calls.push(call);
    return settlement.promise;
  };
  const create = createResourceToolDefinitions(owned.ctx, owned.bridge)
    .find((definition) => definition.name === "luckyray_knowledge_create");
  const executing = create.execute({ title: "Committed", content: "body" }, {
    agent: owned.agent,
    callId: "create-before-narrowing",
    rootCallId: "create-before-narrowing",
    signal: new AbortController().signal,
  });
  while (owned.calls.length === 0) await Promise.resolve();
  owned.state.mode = "read-only";
  owned.state.workspaceRoot = "";
  const event = { seq: 2, type: "sandbox/mode", data: { mode: "read-only" } };
  owned.session.events.push(event);
  owned.emit("session/event", owned.session, event);
  assert.deepEqual(owned.policies.map((policy) => policy.mode), ["workspace-write"]);
  settlement.resolve({ committed: true, resourceRef: "rr-".concat("1".repeat(36)) });
  const result = await executing;
  assert.equal(result.committed, true);
  assert.equal(owned.calls.length, 1);
  await Promise.resolve();
  assert.equal(owned.policies.at(-1)?.mode, "read-only");
});

test("markerless maintenance success preserves no-retry settlement across later caller cancellation", async () => {
  const owned = fixture("danger-full-access");
  const settlement = deferred();
  owned.bridge.call = async (call, signal) => {
    owned.calls.push(call);
    assert.equal(signal, undefined, "an admitted effect drains independently of caller cancellation");
    return settlement.promise;
  };
  const retried = createResourceToolDefinitions(owned.ctx, owned.bridge)
    .find((definition) => definition.name === "luckyray_materials_retry_pending");
  assert.equal(retried.timeoutMs, undefined, "resource bridge does not advertise an unhonored 60s deadline");
  const controller = new AbortController();
  const contexts = [];
  const executing = retried.execute({}, {
    agent: owned.agent,
    callId: "retry-pending-cancel-after-success",
    rootCallId: "retry-pending-cancel-after-success",
    signal: controller.signal,
    deferContext: (context) => contexts.push(context),
  });
  while (owned.calls.length === 0) await Promise.resolve();
  settlement.resolve({ retried: 3, remaining: 0 });
  controller.abort();
  const result = await executing;
  assert.deepEqual(result, { retried: 3, remaining: 0 });
  assert.equal(owned.calls.length, 1);
  assert.equal(contexts.length, 1);
  assert.match(contexts[0].content[0].text, /completed/u);
  assert.match(contexts[0].content[0].text, /do not retry/iu);
  assert.match(contexts[0].content[0].text, /luckyray_materials_retry_pending/u);
});

test("successful Read operation never receives mutation settlement context", async () => {
  const owned = fixture("read-only");
  const contexts = [];
  const listed = createResourceToolDefinitions(owned.ctx, owned.bridge)
    .find((definition) => definition.name === "luckyray_knowledge_list");
  assert.deepEqual(await listed.execute({}, {
    agent: owned.agent,
    callId: "call-1",
    rootCallId: "call-1",
    signal: new AbortController().signal,
    deferContext: (context) => contexts.push(context),
  }), { items: [] });
  assert.equal(contexts.length, 0);
});

test("caller cancellation observed before admission produces effect0", async () => {
  const owned = fixture("workspace-write");
  const created = createResourceToolDefinitions(owned.ctx, owned.bridge)
    .find((definition) => definition.name === "luckyray_knowledge_create");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(created.execute({ title: "Cancelled", content: "write0" }, {
    agent: owned.agent,
    callId: "create-cancel-before-admit",
    rootCallId: "create-cancel-before-admit",
    signal: controller.signal,
    deferContext() {},
  }), /dsh-resource-cancelled/u);
  assert.equal(owned.calls.length, 0);
});

test("official Stop cancels read delivery and turn end advances the existing authority fence", async () => {
  const owned = fixture("read-only");
  const controller = new AbortController();
  let observedSignal;
  owned.bridge.call = (call, signal) => {
    owned.calls.push(call);
    observedSignal = signal;
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("dsh-resource-cancelled");
        error.code = "dsh-resource-cancelled";
        reject(error);
      }, { once: true });
    });
  };
  const opened = createResourceToolDefinitions(owned.ctx, owned.bridge)
    .find((definition) => definition.name === "luckyray_browser_open");
  const executing = opened.execute({ navigationRef: "nav-".concat("A".repeat(48)) }, {
    agent: owned.agent,
    callId: "browser-open-cancelled",
    rootCallId: "browser-open-cancelled",
    signal: controller.signal,
  });
  while (owned.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
  const terminal = {
    seq: 2,
    type: "turn/end",
    data: { turn: 0, reason: { kind: "aborted", reason: { kind: "user" } } },
  };
  owned.session.events.push(terminal);
  owned.emit("session/event", owned.session, terminal);
  controller.abort();
  await assert.rejects(executing, /dsh-resource-cancelled/u);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observedSignal, controller.signal);
  assert.equal(owned.policies.at(-1)?.policySeq, terminal.seq);
});

test("read-only executes Knowledge reads from the exact official Agent session and denies mutation before bridge call", async () => {
  const owned = fixture("read-only");
  const definitions = createResourceToolDefinitions(owned.ctx, owned.bridge);
  const list = definitions.find((definition) => definition.name === "luckyray_knowledge_list");
  const created = definitions.find((definition) => definition.name === "luckyray_knowledge_create");
  const exec = {
    agent: owned.agent,
    callId: "call-1",
    rootCallId: "call-1",
    signal: new AbortController().signal,
  };
  assert.deepEqual(await list.execute({}, exec), { items: [] });
  assert.equal(owned.calls.length, 1);
  assert.equal(owned.calls[0].sessionId, "session-owned");
  assert.equal(owned.calls[0].mode, "read-only");
  assert.equal(owned.policies.length, 1);

  owned.session.events.push({
    seq: 2,
    type: "tool/call",
    data: { callId: "call-2", name: "luckyray_knowledge_create" },
  });
  await assert.rejects(
    created.execute({ title: "Denied" }, { ...exec, callId: "call-2", rootCallId: "call-2" }),
    /dsh-resource-policy-denied/u,
  );
  assert.equal(owned.calls.length, 1, "denied mutations never reach Backend");
});

test("resource tools require a trustworthy local Agent and never fall back to a parent session", async () => {
  const owned = fixture("workspace-write");
  const list = createResourceToolDefinitions(owned.ctx, owned.bridge)
    .find((definition) => definition.name === "luckyray_knowledge_list");
  await assert.rejects(
    list.execute({}, {
      callId: "call-1",
      rootCallId: "call-1",
      signal: new AbortController().signal,
      parent: Symbol("opaque-parent"),
    }),
    /dsh-resource-agent-required/u,
  );
  assert.equal(owned.calls.length, 0);
});

test("child resource pipe authenticates exact sequence and forwards only decoded private payload", async () => {
  const request = new PassThrough();
  const response = new PassThrough();
  const secret = "a".repeat(64);
  const observed = [];
  const router = createChildResourceRouter({
    authority: { protocol: 1, generation: 4, secret },
    request,
    response,
    forward: async (type, payload) => {
      observed.push([type, payload]);
      return { accepted: true };
    },
  });
  const encoded = Buffer.from(JSON.stringify({ sessionId: "session-child" }), "utf8").toString("base64url");
  const unsigned = {
    type: "policy", protocol: 1, generation: 4, seq: 1,
    requestId: "resource-4-1", payload: encoded,
  };
  const responseLine = new Promise((resolveLine) => response.once("data", (chunk) => resolveLine(chunk.toString("utf8"))));
  request.write(`${JSON.stringify({ ...unsigned, mac: signResourceFrame(secret, "plugin", unsigned) })}\n`);
  const frame = JSON.parse(await responseLine);
  assert.deepEqual(observed, [["policy", { sessionId: "session-child" }]]);
  assert.equal(frame.type, "result");
  assert.equal(frame.seq, 1);
  assert.equal(frame.requestId, "resource-4-1");
  assert.equal(frame.mac, signResourceFrame(secret, "host", { ...frame, mac: undefined }));
  router.close();
});

test("large valid resource results are chunked without invalidating the private child channel", async () => {
  const pluginToHost = new PassThrough();
  const hostToPlugin = new PassThrough();
  const authority = { protocol: 1, generation: 9, secret: "b".repeat(64) };
  let invalidated = 0;
  let call = 0;
  const router = createChildResourceRouter({
    authority,
    request: pluginToHost,
    response: hostToPlugin,
    forward: async () => {
      call += 1;
      return call === 1 ? { body: "x".repeat(320 * 1024) } : { channelStillAlive: true };
    },
    onInvalid: () => { invalidated += 1; },
  });
  const bridge = createFdResourceBridge({
    authority,
    request: pluginToHost,
    response: hostToPlugin,
  });
  const large = await bridge.call({ operation: "large-read" });
  assert.equal(large.body.length, 320 * 1024);
  assert.deepEqual(await bridge.call({ operation: "second-read" }), { channelStillAlive: true });
  assert.equal(invalidated, 0);
  router.close();
});

test("an aborted read rejects promptly while its late result leaves the private channel reusable", async () => {
  const pluginToHost = new PassThrough();
  const hostToPlugin = new PassThrough();
  const authority = { protocol: 1, generation: 12, secret: "d".repeat(64) };
  const first = deferred();
  let forwarded = 0;
  let invalidated = 0;
  const router = createChildResourceRouter({
    authority,
    request: pluginToHost,
    response: hostToPlugin,
    forward: async () => {
      forwarded += 1;
      return forwarded === 1 ? first.promise : { channelStillAlive: true };
    },
    onInvalid: () => { invalidated += 1; },
  });
  const bridge = createFdResourceBridge({ authority, request: pluginToHost, response: hostToPlugin });
  const controller = new AbortController();
  const cancelled = bridge.call({ operation: "cancelled-read" }, controller.signal);
  while (forwarded === 0) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(cancelled, /dsh-resource-cancelled/u);
  first.resolve({ arrivedAfterStop: true });
  assert.deepEqual(await bridge.call({ operation: "after-cancelled-read" }), { channelStillAlive: true });
  assert.equal(invalidated, 0);
  router.close();
});

test("resource result ceiling is an explicit per-call error and keeps the child channel reusable", async () => {
  const pluginToHost = new PassThrough();
  const hostToPlugin = new PassThrough();
  const authority = { protocol: 1, generation: 10, secret: "c".repeat(64) };
  let invalidated = 0;
  let call = 0;
  const router = createChildResourceRouter({
    authority,
    request: pluginToHost,
    response: hostToPlugin,
    forward: async () => {
      call += 1;
      return call === 1 ? { body: "x".repeat(8 * 1024 * 1024) } : { recovered: true };
    },
    onInvalid: () => { invalidated += 1; },
  });
  const bridge = createFdResourceBridge({ authority, request: pluginToHost, response: hostToPlugin });
  await assert.rejects(bridge.call({ operation: "bounded-read" }), /dsh-resource-result-too-large/u);
  assert.deepEqual(await bridge.call({ operation: "after-bounded-read" }), { recovered: true });
  assert.equal(invalidated, 0);
  router.close();
});

test("a closed resource channel rejects later knowledge and material calls without writing", async () => {
  const request = new PassThrough();
  const response = new PassThrough();
  const authority = { protocol: 1, generation: 15, secret: "e".repeat(64) };
  let writes = 0;
  request.on("data", () => { writes += 1; });
  const bridge = createFdResourceBridge({ authority, request, response });
  response.end();
  await new Promise((resolve) => setImmediate(resolve));
  for (const operation of ["luckyray_knowledge_list", "luckyray_materials_search"]) {
    const result = await Promise.race([
      bridge.call({ operation, args: { query: "fixture" } }).catch((error) => error.code),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 100)),
    ]);
    assert.equal(result, "dsh-resource-channel-closed");
  }
  assert.equal(writes, 0);
});

test("malformed authenticated result rejects the affected call and fences the channel", async () => {
  const request = new PassThrough();
  const response = new PassThrough();
  const authority = { protocol: 1, generation: 16, secret: "f".repeat(64) };
  const bridge = createFdResourceBridge({ authority, request, response });
  request.once("data", (line) => {
    const sent = JSON.parse(line.toString("utf8"));
    const frame = {
      type: "result", protocol: 1, generation: 16, seq: 1,
      requestId: sent.requestId, payload: Buffer.from("invalid JSON").toString("base64url"),
    };
    response.write(`${JSON.stringify({ ...frame, mac: signResourceFrame(authority.secret, "host", frame) })}\n`);
  });
  const result = await Promise.race([
    bridge.call({ operation: "luckyray_materials_list" }).catch((error) => error.code),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 100)),
  ]);
  assert.equal(result, "dsh-resource-frame-invalid");
  await assert.rejects(bridge.call({ operation: "luckyray_knowledge_list" }), /dsh-resource-channel-closed/u);
  request.destroy();
  response.destroy();
});

test("an oversized unsent request does not consume the authenticated channel sequence", async () => {
  const request = new PassThrough();
  const response = new PassThrough();
  const authority = { protocol: 1, generation: 17, secret: "a".repeat(64) };
  let invalidated = 0;
  const router = createChildResourceRouter({
    authority, request, response,
    forward: async (_type, payload) => ({ operation: payload.operation }),
    onInvalid: () => { invalidated += 1; response.end(); },
  });
  const bridge = createFdResourceBridge({ authority, request, response });
  await assert.rejects(bridge.call({ body: "x".repeat(256 * 1024) }), /dsh-resource-frame-too-large/u);
  assert.deepEqual(await bridge.call({ operation: "luckyray_materials_list" }), {
    operation: "luckyray_materials_list",
  });
  assert.equal(invalidated, 0);
  router.close();
});

test("a failed request stream settles all pending calls and never replays a mutation", async () => {
  const request = new PassThrough();
  const response = new PassThrough();
  const authority = { protocol: 1, generation: 18, secret: "b".repeat(64) };
  const sent = [];
  request.on("data", (line) => { sent.push(JSON.parse(line.toString("utf8"))); });
  const bridge = createFdResourceBridge({ authority, request, response });
  const first = bridge.call({ operation: "luckyray_knowledge_create" });
  const second = bridge.call({ operation: "luckyray_materials_list" });
  const settled = Promise.allSettled([first, second]);
  request.destroy(new Error("synthetic pipe failure"));
  for (const result of await settled) {
    assert.equal(result.status, "rejected");
    assert.equal(result.reason.code, "dsh-resource-channel-closed");
  }
  await assert.rejects(bridge.call({ operation: "luckyray_knowledge_create" }), /dsh-resource-channel-closed/u);
  assert.equal(sent.length, 2, "no automatic mutation retry or channel reuse");
  response.destroy();
});

test("knowledge admission can be cancelled during policy sync and the next material call remains usable", async () => {
  const owned = fixture();
  const request = new PassThrough();
  const response = new PassThrough();
  const authority = { protocol: 1, generation: 19, secret: "c".repeat(64) };
  const policy = deferred();
  const waiting = deferred();
  let policies = 0;
  const calls = [];
  const router = createChildResourceRouter({
    authority, request, response,
    forward: async (type, payload) => {
      if (type === "policy") {
        policies += 1;
        if (policies === 1) { waiting.resolve(); await policy.promise; }
        return { accepted: true };
      }
      calls.push(payload);
      return { items: [{ resourceRef: "rr-".concat("1".repeat(36)), name: "Fixture material" }] };
    },
  });
  const bridge = createFdResourceBridge({ authority, request, response });
  const definitions = createResourceToolDefinitions(owned.ctx, bridge);
  const controller = new AbortController();
  const read = definitions.find((definition) => definition.name === "luckyray_knowledge_list");
  const executing = read.execute({}, { agent: owned.agent, callId: "read-cancelled", signal: controller.signal });
  await waiting.promise;
  controller.abort();
  const result = await Promise.race([
    executing.catch((error) => error.code),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 100)),
  ]);
  assert.equal(result, "dsh-resource-cancelled");
  policy.resolve();
  const material = definitions.find((definition) => definition.name === "luckyray_materials_search");
  const found = await material.execute({ query: "fixture", limit: 5 }, {
    agent: owned.agent, callId: "search-after-cancel", signal: new AbortController().signal,
  });
  assert.equal(found.items[0].name, "Fixture material");
  assert.equal(calls.length, 1, "cancelled knowledge call never reaches the backend");
  assert.equal(calls[0].operation, "luckyray_materials_search");
  assert.equal(calls[0].sessionId, owned.session.id);
  assert.equal(calls[0].mode, "read-only");
  assert.deepEqual(calls[0].args, { query: "fixture", limit: 5 });
  router.close();
});

test("knowledge and material tool errors survive the authenticated bridge without fallback or implicit retry", async () => {
  const owned = fixture();
  const request = new PassThrough();
  const response = new PassThrough();
  const authority = { protocol: 1, generation: 20, secret: "d".repeat(64) };
  const calls = [];
  owned.ctx.fs.resolve = async () => { throw new Error("No filesystem fallback is permitted"); };
  const router = createChildResourceRouter({
    authority, request, response,
    forward: async (type, payload) => {
      if (type === "policy") return { accepted: true };
      calls.push(payload);
      if (payload.operation === "luckyray_knowledge_read") {
        throw Object.assign(new Error("stale fixture root"), { code: "dsh-resource-identity-stale" });
      }
      if (payload.operation === "luckyray_materials_get") {
        throw Object.assign(new Error("expired fixture ref"), { code: "dsh-resource-ref-invalid" });
      }
      return { items: [] };
    },
  });
  const definitions = createResourceToolDefinitions(owned.ctx, createFdResourceBridge({ authority, request, response }));
  for (const [name, code] of [
    ["luckyray_knowledge_read", "dsh-resource-identity-stale"],
    ["luckyray_materials_get", "dsh-resource-ref-invalid"],
  ]) {
    const tool = definitions.find((definition) => definition.name === name);
    await assert.rejects(tool.execute({ resourceRef: "rr-".concat("1".repeat(36)) }, {
      agent: owned.agent, callId: name, signal: new AbortController().signal,
    }), (error) => error.code === code);
  }
  const search = definitions.find((definition) => definition.name === "luckyray_knowledge_search");
  assert.deepEqual(await search.execute({ query: "fixture" }, {
    agent: owned.agent, callId: "fresh-discovery", signal: new AbortController().signal,
  }), { items: [] });
  assert.equal(calls.length, 3);
  router.close();
});
