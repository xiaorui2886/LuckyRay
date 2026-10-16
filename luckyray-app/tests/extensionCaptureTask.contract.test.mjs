import assert from "node:assert/strict";
import test from "node:test";
import "../browser-extension-prototype/extension-protocol.js";
import "../browser-extension-prototype/capture-task.js";

const protocol = globalThis.LuckyRayExtensionProtocol;
const copy = (value) => value == null ? value : structuredClone(value);
const asset = { id: "asset-1", name: "video.mp4", kind: "video" };
const transfer = (state = "completed") => ({
  transferId: "media-1-0000000000000001", state, bytesReceived: 128, totalBytes: 128,
  fileName: "video.mp4", mimeType: "video/mp4", skippedDuplicate: false,
  ...(state === "completed" ? { assetId: asset.id, assetName: asset.name, assetKind: asset.kind } : {}),
});
const input = () => ({
  kind: "video", sourceUrl: "https://public.example/video",
  request: { requestId: "popup:original", url: "https://public.example/a.mp4", fileName: "video.mp4" },
  noteRequest: { requestId: "popup:original", target: "existing", noteId: "note-1", binding: { activation: { vaultId: "qa", sourceEpoch: 7 } } },
});
function harness(stored = null, handler = null) {
  const writes = [], calls = [];
  const storage = { value: copy(stored) };
  const controller = globalThis.LuckyRayCaptureTask.create({
    protocol, read: async () => copy(storage.value),
    write: async (value) => { writes.push(copy(value)); storage.value = copy(value); },
    delay: async () => {},
    request: async (method, path, body) => {
      calls.push({ method, path, body: copy(body) });
      if (handler) return handler(method, path, body);
      if (path === "/api/notes/attach-material") return { ok: true, data: { noteId: "note-1" } };
      return { ok: true, data: transfer(path === "/api/media/transfers" ? "running" : "completed") };
    },
  });
  return { controller, storage, calls, writes };
}
async function settled(controller) {
  for (let poll = 0; poll < 100; poll++) {
    const { task } = await controller.status();
    if (task && !["starting", "transferring", "attaching"].includes(task.stage)) return task;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("capture task never settled");
}

test("accepted video continues without a popup observer and appends to frozen note once", async () => {
  const h = harness();
  const original = input();
  assert.equal((await h.controller.start(original)).ok, true);
  // The caller can disappear: no status message is needed to drive completion.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.storage.value.stage, "completed");
  const done = await settled(h.controller);
  assert.equal(done.asset.id, "asset-1");
  assert.equal(h.calls.filter((call) => call.path === "/api/media/transfers").length, 1);
  assert.deepEqual(h.calls.find((call) => call.path === "/api/notes/attach-material").body, { ...original.noteRequest, assetId: "asset-1" });
  await h.controller.status();
  assert.equal(h.calls.filter((call) => call.path === "/api/notes/attach-material").length, 1);
});

test("worker restart observes existing transfer and continues original note receipt without new download", async () => {
  const h = harness({ version: 1, id: "popup:original", kind: "video", stage: "transferring", transferId: "media-1-0000000000000001", noteRequest: input().noteRequest });
  assert.equal((await settled(h.controller)).stage, "completed");
  assert.equal(h.calls.filter((call) => call.path === "/api/media/transfers").length, 0);
  assert.equal(h.calls.filter((call) => call.path === "/api/notes/attach-material").length, 1);
});

test("interrupted append reuses the exact durable receipt identity", async () => {
  const original = input().noteRequest;
  let noteWrites = 1;
  const h = harness({ version: 1, id: "popup:original", kind: "video", stage: "attaching", asset, noteRequest: original }, async (method, path, body) => {
    assert.equal(path, "/api/notes/attach-material");
    assert.deepEqual(body, { ...original, assetId: asset.id });
    // Simulate the real receipt already persisted before the worker vanished.
    if (body.requestId !== "popup:original") noteWrites++;
    return { ok: true, data: { replayed: true } };
  });
  assert.equal((await settled(h.controller)).stage, "completed");
  assert.equal(noteWrites, 1);
});

test("lost start response is unknown and never silently creates another transfer", async () => {
  const h = harness({ version: 1, id: "popup:original", kind: "video", stage: "starting", noteRequest: input().noteRequest });
  assert.equal((await settled(h.controller)).stage, "uncertain");
  assert.equal((await h.controller.start(input())).code, "capture-task-pending");
  await h.controller.resume("popup:original");
  assert.equal(h.calls.length, 0);
  assert.equal((await h.controller.acknowledge("wrong-id")).ok, false);
  assert.equal((await h.controller.acknowledge("popup:original")).ok, true);
});

test("lost desktop job is unknown; a failed status read can only resume that job", async () => {
  let available = false;
  const h = harness({ version: 1, id: "popup:original", kind: "video", stage: "transferring", transferId: "media-1-0000000000000001" }, async (method, path) => {
    assert.equal(method, "GET");
    assert.equal(path, "/api/media/transfers/media-1-0000000000000001");
    return { ok: false, errorObject: { code: available ? "media-transfer-not-found" : "app-unavailable" } };
  });
  assert.equal((await settled(h.controller)).stage, "paused");
  available = true;
  await h.controller.resume("popup:original");
  assert.equal((await settled(h.controller)).stage, "uncertain");
  assert.equal(h.calls.length, 2);
});

test("a recorded note target failure preserves partial success without offering an ineffective retry", async () => {
  let attachCalls = 0;
  const h = harness(null, async (method, path) => {
    if (path === "/api/notes/attach-material") {
      attachCalls++;
      return { ok: false, errorObject: { code: "knowledge-document-conflict" } };
    }
    return { ok: true, data: transfer() };
  });
  await h.controller.start(input());
  assert.equal((await settled(h.controller)).stage, "partial");
  await h.controller.resume("popup:original");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await settled(h.controller)).stage, "partial");
  assert.equal(attachCalls, 1);
  assert.equal(h.storage.value.noteCheckAvailable, false);
  assert.equal(h.calls.filter((call) => call.path === "/api/media/transfers").length, 1);
});

test("site credentials are passed to the existing transfer but never persisted in the journal", async () => {
  const h = harness();
  const request = input();
  request.request.siteAuth = { cookies: [{ value: "fixture-private-cookie" }] };
  await h.controller.start(request);
  await settled(h.controller);
  assert.equal(h.calls[0].body.siteAuth.cookies[0].value, "fixture-private-cookie");
  assert.equal(JSON.stringify(h.writes).includes("fixture-private-cookie"), false);
});

test("failed journal persistence causes zero dispatch and concurrent clicks accept only one task", async () => {
  let dispatches = 0;
  const fail = globalThis.LuckyRayCaptureTask.create({ protocol, read: async () => null, write: async () => { throw Error("full"); }, request: async () => { dispatches++; } });
  await assert.rejects(fail.start(input()), /full/);
  assert.equal(dispatches, 0);
  const h = harness();
  const results = await Promise.all([h.controller.start(input()), h.controller.start(input())]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  await settled(h.controller);
  assert.equal(h.calls.filter((call) => call.path === "/api/media/transfers").length, 1);
});

test("image failure keeps safe network diagnostics and discards provider secrets", async () => {
  const h = harness(null, async () => ({ ok: false, errorObject: {
    error: { code: "adapter-request-failed", message: "private-provider-token", details: {
      reason: "network", category: "timeout", source: "popup", fingerprint: "abcdef123456", cookies: "private-cookie",
    } },
  } }));
  await h.controller.start({ ...input(), kind: "image" });
  const done = await settled(h.controller);
  assert.equal(done.stage, "failed");
  assert.match(protocol.formatMaterialImportFailure(done.importFailure, "image").message, /超时阶段/);
  assert.equal(done.importFailure.fingerprint, "abcdef123456");
  assert.equal(JSON.stringify(h.storage.value).includes("private-"), false);
});
