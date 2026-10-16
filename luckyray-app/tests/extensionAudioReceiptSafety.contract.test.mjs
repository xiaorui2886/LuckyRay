import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import vm from "node:vm";
import "../browser-extension-prototype/extension-protocol.js";
import "../browser-extension-prototype/media-import-contract.js";
import "../browser-extension-prototype/capture-task.js";

const protocol = globalThis.LuckyRayExtensionProtocol, media = globalThis.LuckyRayMediaImport;
const id = "media-1-0000000000000001", otherId = "media-2-0000000000000002", requestId = "popup:safety:original";
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const input = (kind = "audio", explicit = false, action = requestId) => ({ kind, request: { requestId: action,
  url: "https://fixture.test/tone.wav", fileName: "tone.wav", ...(explicit ? { libraryId: "lib-fixture" } : {}) } });
const snapshot = (state = "completed", transferId = id, kind = "audio") => ({ transferId, state, bytesReceived: 16044,
  totalBytes: 16044, fileName: "tone.wav", mimeType: "audio/wav", assetId: "fixture-asset", assetName: "tone.wav", assetKind: kind, skippedDuplicate: false });
const receipt = (kind = "audio") => ({ consumerVersion: 1, libraryId: "lib-fixture", requestId,
  assetId: "fixture-asset", assetName: "tone.wav", asset: { id: "fixture-asset", name: "tone.wav", kind },
  disposition: "imported", organization: { state: "applied" }, atomic: false });
const bind = (value, explicit, kind = "audio") => ({ ...value, ...(explicit ? { libraryId: "lib-fixture", requestId,
  ...(value.state === "completed" ? { receipt: receipt(kind) } : {}) } : {}) });
function harness(handler, saved = null) {
  let stored = structuredClone(saved); const calls = [], writes = [];
  const controller = globalThis.LuckyRayCaptureTask.create({ protocol, media, read: async () => structuredClone(stored),
    write: async task => { stored = structuredClone(task); writes.push(structuredClone(task)); }, delay: async () => {},
    request: async (method, path, body) => { calls.push({ method, path, body }); return handler(method, path, body); } });
  return { controller, calls, writes, stored: () => structuredClone(stored) };
}
async function until(check) { for (let i = 0; i < 60; i++) { await tick(); if (check()) return; } assert.fail("condition never reached"); }
async function settled(h) { await until(() => h.stored() && !["starting", "transferring", "checking", "attaching"].includes(h.stored().stage)); return h.stored(); }

async function popup() {
  const nodes = new Map();
  const node = key => { if (!nodes.has(key)) { const classes = new Set(); nodes.set(key, { style: {}, textContent: "", value: "", hidden: false,
    classList: { toggle: (name, on) => on ? classes.add(name) : classes.delete(name), remove: name => classes.delete(name), contains: name => classes.has(name) } }); } return nodes.get(key); };
  const sandbox = { LuckyRayExtensionProtocol: protocol, LuckyRayMediaImport: media,
    document: { getElementById: node, addEventListener() {}, documentElement: {} }, location: { search: "" }, URLSearchParams,
    setTimeout: () => 0, clearTimeout() {} };
  vm.createContext(sandbox);
  vm.runInContext(await fs.readFile(new URL("../browser-extension-prototype/popup.js", import.meta.url), "utf8"), sandbox);
  vm.runInContext("renderSubmitState = () => {};", sandbox);
  return { sandbox, node, render: task => { sandbox.testTask = structuredClone(task); return vm.runInContext("renderCaptureTask(testTask)", sandbox); } };
}
function completedTask(explicit = false) {
  return { version: 1, id: requestId, kind: "audio", stage: "completed", disposition: "imported", transferId: id,
    asset: { id: "fixture-asset", name: "tone.wav", kind: "audio" }, transfer: snapshot(),
    ...(explicit ? { mediaIdentity: { libraryId: "lib-fixture", requestId, operation: "video" }, receipt: receipt() } : {}) };
}
const success = /已入库|已存在|无需重复保存|已保存/;
const invalidAssets = [null, { id: "" }, { id: "bad/id", kind: "audio" }, { id: "fixture-asset", kind: "video" },
  { id: "fixture-asset", kind: "image" }, { id: "fixture-asset" }];
for (const explicit of [false, true]) test(`popup task, toast and progress share the audio receipt gate (${explicit ? "library" : "legacy"})`, async () => {
  for (const asset of invalidAssets) for (const stage of ["uncertain", "completed", "partial", "attaching"]) {
    const ui = await popup(), task = { ...completedTask(explicit), stage, asset };
    ui.render(task);
    assert.doesNotMatch(ui.node("lr-capture-task-label").textContent, success);
    assert.doesNotMatch(ui.node("lr-transfer-progress-label").textContent, success);
    assert.notEqual(ui.node("lr-transfer-progress-fill").style.width, "100%");
    ui.sandbox.sendMessage = async () => ({ ok: true, task });
    await vm.runInContext("observeCaptureTask(testTask.id)", ui.sandbox);
    assert.doesNotMatch(ui.node("lr-toast").textContent, success);
    assert.equal(ui.node("lr-toast").classList.contains("error"), true);
  }
});
test("valid audio and duplicate/partial receipts still render truthful success; invalid library identity cannot", async () => {
  const ui = await popup();
  for (const explicit of [false, true]) {
    const task = completedTask(explicit); ui.render(task);
    assert.equal(ui.node("lr-capture-task-label").textContent, "音频已入库");
    assert.equal(ui.node("lr-transfer-progress-label").textContent, "已入库");
    task.disposition = "duplicate"; task.transfer.skippedDuplicate = true;
    if (task.receipt) { task.receipt.disposition = "duplicate"; task.receipt.organization.state = "preserved"; }
    ui.render(task); assert.match(ui.node("lr-transfer-progress-label").textContent, /已存在/);
    task.stage = "partial"; task.organizationPartial = true; ui.render(task);
    assert.match(ui.node("lr-capture-task-label").textContent, /未全部整理完成/);
  }
  const invalid = completedTask(true); invalid.receipt.requestId = "popup:another"; ui.render(invalid);
  assert.doesNotMatch(ui.node("lr-transfer-progress-label").textContent, success);
  assert.doesNotMatch(ui.node("lr-capture-task-label").textContent, success);
});
test("new, cleared and acknowledged task views clear an earlier success progress strip", async () => {
  const ui = await popup();
  for (const task of [null, { ...completedTask(), acknowledged: true }, { version: 1, id: "popup:new", kind: "audio", stage: "starting" }]) {
    ui.render(completedTask()); ui.render(task);
    assert.equal(ui.node("lr-transfer-progress").style.display, "none");
    assert.doesNotMatch(ui.node("lr-transfer-progress-label").textContent, success);
  }
});

for (const kind of ["audio", "video"]) for (const explicit of [false, true])
  test(`GET progress rejects another transfer without replacing the accepted snapshot (${kind}, ${explicit ? "library" : "legacy"})`, async () => {
    for (const state of ["queued", "running", "completed", "failed", "cancelled"]) {
      const h = harness(async method => ({ ok: true, data: bind(snapshot(method === "POST" ? "running" : state, method === "POST" ? id : otherId, kind), explicit, kind) }));
      await h.controller.start(input(kind, explicit)); const task = await settled(h);
      assert.equal(task.stage, "uncertain"); assert.equal(task.errorCode, "media-transfer-identity");
      assert.equal(task.transferId, id); assert.equal(task.transfer.transferId, id); assert.equal(task.asset, undefined);
    }
  });
test("receipt recovery cannot rebind a known transfer to another transfer ID", async () => {
  const saved = { version: 1, id: requestId, kind: "audio", stage: "paused", transferId: id,
    mediaIdentity: { libraryId: "lib-fixture", requestId, operation: "video" } };
  const h = harness(async () => ({ ok: true, data: { receiptLookupVersion: 1, libraryId: "lib-fixture", requestId,
    state: "pending", transfer: bind(snapshot("running", otherId), true) } }), saved);
  await h.controller.resume(requestId); const task = await settled(h);
  assert.equal(task.stage, "uncertain"); assert.equal(task.transferId, id);
  assert.equal(h.calls.some(call => call.method === "GET"), false);
});
for (const late of ["completed", "error", "throw"]) test(`confirmed cancellation ignores a late GET ${late} result`, async () => {
  const pending = deferred(); let queried = false;
  const h = harness(async (method, path) => {
    if (path.endsWith("/cancel")) return { ok: true, data: snapshot("cancelled") };
    if (method === "POST") return { ok: true, data: snapshot("running") };
    queried = true; return pending.promise;
  });
  await h.controller.start(input()); await until(() => queried);
  const cancelled = await h.controller.cancel(requestId);
  // Release even on the RED run so the synthetic request never stays pending.
  if (late === "throw") pending.reject(Error("late transport failure"));
  else pending.resolve(late === "error" ? { ok: false, errorObject: { code: "app-unavailable" } } : { ok: true, data: snapshot() });
  for (let i = 0; i < 8; i++) await tick();
  assert.equal(cancelled.ok, true); assert.equal(cancelled.task.stage, "failed");
  assert.equal(h.stored().stage, "failed"); assert.equal(h.stored().transfer.state, "cancelled"); assert.equal(h.stored().asset, undefined);
});
test("a late old GET cannot change the replacement task or release its running owner", async () => {
  const old = deferred(), next = deferred(); let queries = 0;
  const h = harness(async (method, path, body) => {
    if (path.endsWith("/cancel")) return { ok: true, data: snapshot("cancelled") };
    if (method === "POST") return { ok: true, data: snapshot("running", body.requestId === requestId ? id : otherId) };
    queries++; return path.endsWith(otherId) ? next.promise : old.promise;
  });
  await h.controller.start(input()); await until(() => queries === 1);
  await h.controller.cancel(requestId);
  const acknowledged = await h.controller.acknowledge(requestId), accepted = await h.controller.start(input("audio", false, "popup:safety:new"));
  if (!accepted.ok) { old.resolve({ ok: true, data: snapshot() }); next.resolve({ ok: true, data: snapshot("completed", otherId) }); }
  assert.equal(acknowledged.ok, true); assert.equal(accepted.ok, true);
  await until(() => queries === 2); old.resolve({ ok: true, data: snapshot() }); for (let i = 0; i < 8; i++) await tick();
  assert.equal(h.stored().id, "popup:safety:new"); assert.equal(h.stored().stage, "transferring"); assert.equal(h.stored().asset, undefined);
  assert.equal((await h.controller.start(input("audio", false, "popup:safety:third"))).ok, false);
  next.resolve({ ok: true, data: snapshot("completed", otherId) }); assert.equal((await settled(h)).stage, "completed");
});
test("a late cancel response cannot overwrite a receipt already validated by GET", async () => {
  const pending = deferred(), cancelling = deferred(); let queried = false, cancelSent = false;
  const h = harness(async (method, path) => {
    if (path.endsWith("/cancel")) { cancelSent = true; return cancelling.promise; }
    if (method === "POST") return { ok: true, data: snapshot("running") };
    queried = true; return pending.promise;
  });
  await h.controller.start(input()); await until(() => queried);
  const attempt = h.controller.cancel(requestId); await until(() => cancelSent);
  pending.resolve({ ok: true, data: snapshot() }); await settled(h);
  cancelling.resolve({ ok: true, data: snapshot("cancelled") }); assert.equal((await attempt).ok, false);
  assert.equal(h.stored().stage, "completed"); assert.equal(h.stored().asset.kind, "audio");
});
test("failed cancellation leaves the original GET and its valid receipt usable", async () => {
  const pending = deferred(); let queried = false;
  const h = harness(async (method, path) => {
    if (path.endsWith("/cancel")) return { ok: false, errorObject: { code: "app-unavailable" } };
    if (method === "POST") return { ok: true, data: snapshot("running") };
    queried = true; return pending.promise;
  });
  await h.controller.start(input()); await until(() => queried); assert.equal((await h.controller.cancel(requestId)).ok, false);
  pending.resolve({ ok: true, data: snapshot() }); assert.equal((await settled(h)).stage, "completed");
});

for (const late of ["completed", "throw"]) test(`unconfirmed cancellation discards the earlier GET ${late} and polls the original transfer again`, async () => {
  const old = deferred(), next = deferred(); let queries = 0;
  const h = harness(async (method, path) => {
    if (path.endsWith("/cancel")) return { ok: true, data: snapshot("cancelling") };
    if (method === "POST") return { ok: true, data: snapshot("running") };
    queries++; return queries === 1 ? old.promise : next.promise;
  });
  await h.controller.start(input()); await until(() => queries === 1);
  assert.equal((await h.controller.cancel(requestId)).task.stage, "transferring");
  if (late === "throw") old.reject(Error("obsolete query failure")); else old.resolve({ ok: true, data: snapshot() });
  await until(() => queries === 2);
  assert.equal(h.stored().stage, "transferring"); assert.equal(h.stored().transfer.state, "cancelling"); assert.equal(h.stored().asset, undefined);
  next.resolve({ ok: true, data: snapshot("cancelled") }); assert.equal((await settled(h)).stage, "failed");
  assert(h.calls.filter(call => call.method === "GET").every(call => call.path.endsWith(id)));
});

test("a current query error after unconfirmed cancellation remains explicit uncertainty", async () => {
  const old = deferred(); let queries = 0;
  const h = harness(async (method, path) => {
    if (path.endsWith("/cancel")) return { ok: true, data: snapshot("cancelling") };
    if (method === "POST") return { ok: true, data: snapshot("running") };
    queries++; if (queries === 1) return old.promise;
    throw Error("current query failed");
  });
  await h.controller.start(input()); await until(() => queries === 1); await h.controller.cancel(requestId);
  old.resolve({ ok: true, data: snapshot() }); const task = await settled(h);
  assert.equal(task.stage, "uncertain"); assert.equal(task.errorCode, "capture-commit-uncertain"); assert.equal(task.asset, undefined);
});

test("library success wording uses the verified receipt disposition, not an inconsistent task flag", async () => {
  const ui = await popup(), task = completedTask(true); task.disposition = "duplicate"; ui.render(task);
  assert.equal(ui.node("lr-capture-task-label").textContent, "音频已入库");
  assert.equal(ui.node("lr-transfer-progress-label").textContent, "已入库");
});

for (const explicit of [false, true]) test(`raw audio identifiers and types cannot be sanitized into a valid receipt (${explicit ? "library" : "legacy"})`, async () => {
  for (const bad of [{ id: "fixture-asset\n", kind: "audio" }, { id: "a".repeat(161), kind: "audio" },
    { id: 42, kind: "audio" }, { id: "fixture-asset", kind: "audio\n" }]) {
    const h = harness(async method => {
      const value = bind(snapshot(method === "POST" ? "running" : "completed"), explicit);
      if (method !== "POST") {
        value.assetId = bad.id; value.assetKind = bad.kind;
        if (value.receipt) { value.receipt.assetId = bad.id; value.receipt.asset.id = bad.id; value.receipt.asset.kind = bad.kind; }
      }
      return { ok: true, data: value };
    });
    await h.controller.start(input("audio", explicit)); const task = await settled(h);
    assert.equal(task.stage, "uncertain"); assert.equal(task.asset, undefined); assert.equal(task.transfer.state, "running");
  }
});
