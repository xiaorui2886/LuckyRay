// [BROWSER-EXT][M1-S2] Quick Collect Compact Popup — RED contract (Issue #18).
//
// RED evidence: the popup currently renders the full configuration surface by
// default and no Quick Collect view-model / explicit-commit gate exists.
// These assertions target the Quick Collect pure-functions that the GREEN
// implementation must add to extension-protocol.js (view-model, type/target
// label policy, target completeness, submit gate). The RED run fails because
// those functions do not exist yet.
//
// Contract under test (Issue #18 §7 / §D):
//   1. advanced options collapsed by default;
//   2. auto capture type is the existing choosePopupCaptureType() result;
//   3. target summary derives from buildCaptureTargetPolicy().defaultTarget —
//      no second destination truth;
//   4. submit gate: disconnected / not-ready / incomplete target forbid
//      submit; complete state allows it;
//   5. one valid submit executes the write exactly once (action gate);
//   6. view functions are pure (no chrome/storage/document access);
//   7. popup.js never persists web content / credentials / Quick Collect
//      state to chrome.storage.local/sync.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const PROTOCOL_URL = new URL("../browser-extension-prototype/extension-protocol.js", import.meta.url);
const POPUP_URL = new URL("../browser-extension-prototype/popup.js", import.meta.url);

async function loadProtocol() {
  const source = await readFile(PROTOCOL_URL, "utf8");
  const sandbox = { URL, setTimeout, clearTimeout };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: "extension-protocol.js" });
  return sandbox.LuckyRayExtensionProtocol;
}

test("Quick Collect default view state: advanced options collapsed (RED: API missing)", async () => {
  const protocol = await loadProtocol();
  assert.equal(
    typeof protocol.quickCollectDefaultViewState,
    "function",
    "quickCollectDefaultViewState must exist (RED: not implemented yet)",
  );
  const view = protocol.quickCollectDefaultViewState();
  assert.equal(view.advancedCollapsed, true, "advanced options must be collapsed by default");
  assert.ok(Object.isFrozen(view), "view state must be immutable");
});

test("Quick Collect capture type labels cover every choosePopupCaptureType output", async () => {
  const protocol = await loadProtocol();
  assert.equal(typeof protocol.quickCollectTypeLabel, "function", "quickCollectTypeLabel must exist (RED)");
  const snapshots = [
    { selection: "选中的文字", url: "https://example.com/a" },
    { videoUrl: "https://example.com/v.mp4", url: "https://example.com/v" },
    { contextImageUrl: "https://example.com/i.png", url: "https://example.com/i" },
    { url: "https://example.com/plain" },
  ];
  for (const snapshot of snapshots) {
    const type = protocol.choosePopupCaptureType(snapshot);
    assert.ok(
      protocol.quickCollectTypeLabel(type),
      `auto capture type "${type}" must have a Quick Collect label`,
    );
  }
  assert.equal(protocol.quickCollectTypeLabel("image"), "图片");
  assert.equal(protocol.quickCollectTypeLabel("video"), "视频");
  assert.equal(protocol.quickCollectTypeLabel("text"), "正文");
  assert.equal(protocol.quickCollectTypeLabel("link"), "链接");
  assert.equal(protocol.quickCollectTypeLabel("bogus"), "", "unknown type must have no label");
});

test("target summary derives from buildCaptureTargetPolicy().defaultTarget (single destination truth)", async () => {
  const protocol = await loadProtocol();
  assert.equal(typeof protocol.quickCollectTargetLabel, "function", "quickCollectTargetLabel must exist (RED)");
  const expectations = [
    ["asset:root", "素材库根目录"],
    ["asset:pick", "指定素材文件夹"],
    ["asset:newFolder", "新建素材文件夹"],
    ["note:insertCurrent", "当前笔记光标处"],
    ["note:recent", "指定最近笔记"],
    ["note:search", "搜索并追加到笔记"],
    ["note:new", "新建笔记"],
    ["collection:queue", "收集箱兜底"],
  ];
  for (const [target, label] of expectations) {
    assert.equal(protocol.quickCollectTargetLabel(target), label, `label for ${target}`);
  }
  assert.equal(protocol.quickCollectTargetLabel("bogus"), "", "unknown target must have no label");

  const mediaPolicy = protocol.buildCaptureTargetPolicy("image", {});
  assert.equal(mediaPolicy.defaultTarget, "asset:root");
  assert.equal(protocol.quickCollectTargetLabel(mediaPolicy.defaultTarget), "素材库根目录");

  const notePolicy = protocol.buildCaptureTargetPolicy("text", { hasCurrentNote: true });
  assert.equal(notePolicy.defaultTarget, "note:insertCurrent");
  assert.equal(protocol.quickCollectTargetLabel(notePolicy.defaultTarget), "当前笔记光标处");

  const fallbackPolicy = protocol.buildCaptureTargetPolicy("text", { hasCurrentNote: false, hasRecentNotes: false });
  assert.equal(fallbackPolicy.defaultTarget, "note:new");
  assert.equal(protocol.quickCollectTargetLabel(fallbackPolicy.defaultTarget), "新建笔记");
});

test("incomplete targets must not be treated as submittable (completeness predicate)", async () => {
  const protocol = await loadProtocol();
  assert.equal(typeof protocol.quickCollectTargetComplete, "function", "quickCollectTargetComplete must exist (RED)");
  assert.equal(protocol.quickCollectTargetComplete("asset:root", {}), true);
  assert.equal(protocol.quickCollectTargetComplete("asset:newFolder", {}), true);
  assert.equal(protocol.quickCollectTargetComplete("note:insertCurrent", {}), true);
  assert.equal(protocol.quickCollectTargetComplete("note:new", {}), true);
  assert.equal(protocol.quickCollectTargetComplete("collection:queue", {}), true);
  assert.equal(protocol.quickCollectTargetComplete("asset:pick", {}), false, "asset:pick without folder is incomplete");
  assert.equal(protocol.quickCollectTargetComplete("asset:pick", { selectedFolderId: "f1" }), true);
  assert.equal(protocol.quickCollectTargetComplete("note:recent", {}), false, "note:recent without note is incomplete");
  assert.equal(protocol.quickCollectTargetComplete("note:recent", { selectedNoteId: "n1" }), true);
  assert.equal(
    protocol.quickCollectTargetComplete("note:search", { selectedNoteId: "n1" }),
    false,
    "note:search without a fresh query-bound selection must be incomplete (FIX-1 P1: stale selectedNoteId must not pass)",
  );
  assert.equal(
    protocol.quickCollectTargetComplete("note:search", { selectedNoteId: "n1", searchSelectionMatchesQuery: true }),
    true,
    "note:search with a fresh query-bound selection is complete",
  );
  assert.equal(
    protocol.quickCollectTargetComplete("note:search", { selectedNoteId: "n1", searchSelectionMatchesQuery: false }),
    false,
    "note:search with a stale query-bound selection is incomplete",
  );
  assert.equal(protocol.quickCollectTargetComplete("bogus", {}), false, "unknown target is incomplete");
});

test("mode isolation: a note selected in one target mode must not authorize another mode (FIX-1 P1)", async () => {
  const protocol = await loadProtocol();
  // The same note id is a valid recent-mode selection but must NOT authorize
  // a search-mode commit when the search selection is not query-fresh.
  assert.equal(protocol.quickCollectTargetComplete("note:recent", { selectedNoteId: "n1" }), true);
  assert.equal(
    protocol.quickCollectTargetComplete("note:search", { selectedNoteId: "n1" }),
    false,
    "a recent-mode note id must not make note:search complete",
  );
  const ready = { port: 37420, readiness: { ready: true, code: "ready" } };
  assert.equal(
    protocol.quickCollectSubmitGate({ ...ready, target: "note:search", selection: { selectedNoteId: "n1" } }).canSubmit,
    false,
    "stale search selection must keep the submit gate disabled",
  );
  assert.equal(
    protocol.quickCollectSubmitGate({
      ...ready,
      target: "note:search",
      selection: { selectedNoteId: "n1", searchSelectionMatchesQuery: true },
    }).canSubmit,
    true,
    "fresh search selection must enable the submit gate",
  );
  assert.equal(
    protocol.quickCollectSubmitGate({ ...ready, target: "note:recent", selection: { selectedNoteId: "n1" } }).canSubmit,
    true,
    "visible recent selection must enable the submit gate",
  );
});

test("submit gate: disconnected / not-ready / incomplete forbid submit; complete allows it", async () => {
  const protocol = await loadProtocol();
  assert.equal(typeof protocol.quickCollectSubmitGate, "function", "quickCollectSubmitGate must exist (RED)");
  const complete = { port: 37420, readiness: { ready: true, code: "ready" }, target: "asset:root", selection: {} };
  const ready = protocol.quickCollectSubmitGate(complete);
  // Spread into the host realm: vm-sandbox objects have a different Object
  // prototype, which deepStrictEqual would otherwise treat as a mismatch.
  assert.deepEqual({ ...ready }, { canSubmit: true, reason: "" }, "connected + ready + complete target must allow submit");

  const disconnected = protocol.quickCollectSubmitGate({ ...complete, port: null });
  assert.equal(disconnected.canSubmit, false, "disconnected must forbid submit");
  assert.match(disconnected.reason, /未连接/);

  const reload = protocol.quickCollectSubmitGate({
    ...complete,
    readiness: { ready: false, code: "reload-required" },
  });
  assert.equal(reload.canSubmit, false, "reload-required must forbid submit");
  assert.match(reload.reason, /应用插件更新/);

  const noContent = protocol.quickCollectSubmitGate({
    ...complete,
    readiness: { ready: false, code: "no-readable-content" },
  });
  assert.equal(noContent.canSubmit, false, "no-readable-content must forbid submit");

  const incomplete = protocol.quickCollectSubmitGate({ ...complete, target: "asset:pick", selection: {} });
  assert.equal(incomplete.canSubmit, false, "incomplete target must forbid submit");
  assert.match(incomplete.reason, /保存位置/);

  const completed = protocol.quickCollectSubmitGate({
    ...complete,
    target: "asset:pick",
    selection: { selectedFolderId: "f1" },
  });
  assert.equal(completed.canSubmit, true, "completed pick target must allow submit");
});

test("one valid submit executes the write exactly once (action gate dedupe)", async () => {
  const protocol = await loadProtocol();
  const gate = protocol.createActionGate();
  const intent = protocol.createMaterialImportIntent({
    mediaType: "image",
    url: "https://example.com/i.png",
    actionId: "popup:qc:test",
    requestId: "popup:qc:test",
    kind: "image",
    storageMode: "managed",
    mode: "asset:root",
    captureSource: "popup",
  });
  assert.ok(intent, "material import intent must build");
  let calls = 0;
  const operation = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { ok: true };
  };
  const results = await Promise.all([
    gate.run(intent, operation),
    gate.run(intent, operation),
  ]);
  assert.equal(calls, 1, "two concurrent submissions of the same intent must write exactly once");
  assert.ok(results.every((result) => result.ok), "both submissions must observe the same result");
});

test("Quick Collect view functions are pure (no chrome/storage/document access)", async () => {
  const protocol = await loadProtocol();
  // The vm sandbox exposes no chrome/storage/document — any impurity throws.
  assert.deepEqual({ ...protocol.quickCollectDefaultViewState() }, { advancedCollapsed: true });
  assert.equal(protocol.quickCollectTypeLabel("text"), "正文");
  assert.equal(protocol.quickCollectTargetLabel("asset:root"), "素材库根目录");
  assert.equal(protocol.quickCollectTargetComplete("note:recent", { selectedNoteId: "n1" }), true);
  assert.equal(protocol.quickCollectSubmitGate({ port: 1, readiness: { ready: true }, target: "asset:root" }).canSubmit, true);
});

test("popup.js must not persist web content / credentials / Quick Collect state to chrome.storage.local/sync", async () => {
  const source = await readFile(POPUP_URL, "utf8");
  assert.ok(
    !/chrome\.storage\.(local|sync)/.test(source),
    "popup.js must never touch chrome.storage.local/sync (page content, credentials, Quick Collect state)",
  );
});

// ---------------------------------------------------------------------------
// [BROWSER-EXT][EXT-R1-R1] P1-2 / P2-1 repair contracts, driven through the
// REAL popup.js in the popup sandbox (no copied logic):
//   P1-2: prefill is an expectation, never final authority. doMedia() must
//   commit the fresh content-side revalidated descriptor identity; stale,
//   expired, replaced or missing fresh identity means zero POST + prefill
//   cleared + visible reason. The prefillUrl || latestUrl pattern is gone.
//   P2-1: selectionRequiresPick participates in the same visible gate as the
//   final write gate.

import { loadPopupSandbox } from "./lib/content-script-sandbox.mjs";

const STALE = "https://page.test/stale-prefill.png";
const FRESH = "https://page.test/current-fresh.png";
const PAGE = {
  title: "Fixture page",
  url: "https://page.test/article",
  sourceUrl: "https://page.test/article",
  captureProtocolVersion: 2,
  contentKind: "summary",
  selection: "",
  content: "",
};

function popupFixture(mediaResponse) {
  return async (message) => {
    if (message?.type === "luckyray-popup-get-port") return { port: 37420 };
    if (message?.type === "luckyray-popup-get-page") return { ...PAGE };
    if (message?.type === "luckyray-popup-get-media") return { pageUrl: PAGE.url, ...mediaResponse };
    return {};
  };
}

async function popupWithTransport(mediaResponse) {
  const { sandbox, elements } = await loadPopupSandbox(popupFixture(mediaResponse));
  const apiCalls = [];
  vm.runInContext("LuckyRayLocalTransport = { fetch: async (p, path, o) => globalThis.__lrApi(p, path, o) };", sandbox);
  sandbox.__lrApi = async (port, path, opts) => {
    apiCalls.push({ port, path, method: opts?.method || "GET", body: opts?.body || null });
    if (path === "/api/notes/capture-target") return {
      ok: true,
      text: async () => JSON.stringify({ ok: true, data: { activation: { vaultId: "test-vault", sourceEpoch: 1 }, revision: "test-revision" } }),
    };
    return {
      ok: true,
      text: async () => JSON.stringify({ ok: true, data: { disposition: "imported", asset: { id: "a1", name: "fresh.png" } } }),
    };
  };
  const state = vm.runInContext("state", sandbox);
  state.port = 37420;
  state.tab = { id: 11, url: PAGE.url };
  return { sandbox, elements, apiCalls, state };
}

test("P1-2: prefill whose URL no longer matches the fresh revalidated identity must zero-write (not commit stale, not retarget)", async () => {
  const { sandbox, apiCalls, state } = await popupWithTransport({ imageUrl: FRESH });
  state.prefillMedia = {
    type: "image",
    url: STALE,
    capturedAt: Date.now() - 1000,
    confidence: "browser-contextmenu",
    tabId: 11,
  };
  await vm.runInContext('doMedia("asset:root")', sandbox);
  assert.equal(apiCalls.filter((call) => call.path === "/api/assets/import-media").length, 0,
    "P1-2: a stale prefill must never be committed AND must not silently retarget to a different fresh URL");
  assert.equal(state.prefillMedia, null, "P1-2: the mismatched prefill must be cleared");
});

test("P1-2: a valid prefill matching the FULL fresh identity commits the fresh URL exactly once", async () => {
  const descriptor = {
    type: "image",
    url: FRESH,
    capturedAt: Date.now() - 200,
    confidence: "browser-contextmenu",
    tabId: 11,
    frameId: 0,
    documentId: "doc-1",
    documentToken: "dtok-1",
    targetToken: "ttok-1",
    scrollX: 0,
    scrollY: 0,
  };
  const { sandbox, apiCalls, state } = await popupWithTransport({ imageUrl: FRESH, descriptor });
  state.prefillMedia = { ...descriptor };
  await vm.runInContext('doMedia("asset:root")', sandbox);
  const posts = apiCalls.filter((call) => call.path === "/api/assets/import-media");
  assert.equal(posts.length, 1, "a fully matching identity still commits exactly once");
  const body = JSON.parse(posts[0].body);
  assert.equal(body.url, FRESH, "the committed URL is the fresh revalidated one (same identity)");
  assert.equal(state.captureTask?.stage, "completed", "acceptance must settle to a completed import");
  assert.equal(state.captureTask?.asset?.id, "a1");
});

test("P1-2 RED: prefill with expired freshness must zero-write and disable Save", async () => {
  const { sandbox, apiCalls } = await popupWithTransport({ imageUrl: FRESH });
  const state = vm.runInContext("state", sandbox);
  state.prefillMedia = {
    type: "image",
    url: STALE,
    capturedAt: Date.now() - LuckyRayExpiredContextTtl() - 1,
    confidence: "browser-contextmenu",
    tabId: 11,
  };
  await vm.runInContext('doMedia("asset:root")', sandbox);
  assert.equal(apiCalls.filter((call) => call.path === "/api/assets/import-media").length, 0,
    "expired prefill must produce zero transport POST");
  assert.equal(state.prefillMedia, null, "expired prefill must be cleared");
});

test("P1-2 RED: fresh descriptor missing (revalidation empty) must zero-write with prefill", async () => {
  const { sandbox, apiCalls } = await popupWithTransport({ imageUrl: "" });
  const state = vm.runInContext("state", sandbox);
  state.prefillMedia = {
    type: "image",
    url: STALE,
    capturedAt: Date.now() - 1000,
    confidence: "browser-contextmenu",
    tabId: 11,
  };
  await vm.runInContext('doMedia("asset:root")', sandbox);
  assert.equal(apiCalls.filter((call) => call.path === "/api/assets/import-media").length, 0,
    "missing fresh descriptor must not resurrect the prefill URL");
});

function LuckyRayExpiredContextTtl() {
  return 10_000;
}

test("P2-1 RED: selectionRequiresPick participates in the visible submit gate", async () => {
  const protocol = await loadProtocol();
  const gate = protocol.quickCollectSubmitGate({
    port: 37420,
    readiness: { ready: true, code: "ready" },
    target: "asset:root",
    selection: {},
    videoSelection: { hasValidSelection: false, requiresPick: true },
  });
  assert.equal(gate.canSubmit, false, "P2-1: a video selection needing re-pick must block the visible gate");
  assert.match(gate.reason, /重新选择|选择/, "P2-1: the gate must carry a visible re-pick reason");
  const valid = protocol.quickCollectSubmitGate({
    port: 37420,
    readiness: { ready: true, code: "ready" },
    target: "asset:root",
    selection: {},
    videoSelection: { hasValidSelection: true, requiresPick: false },
  });
  assert.equal(valid.canSubmit, true, "P2-1: a valid explicit video selection must allow the visible gate");
});

// ---------------------------------------------------------------------------
// [BROWSER-EXT][EXT-R1-REPAIR-2] Contract A — full commit-time image prefill
// identity. RED on parent 3b8689d: doMedia() compares only the URL and ignores
// latest.descriptor; a same-URL different target/token/frame/document/scroll,
// an expired same-URL descriptor and a missing descriptor all authorize a
// write. Contract A requires full current-target identity or fail closed.

const DESC = (over = {}) => ({
  type: "image",
  url: "https://page.test/img.png",
  capturedAt: Date.now() - 200,
  confidence: "browser-contextmenu",
  tabId: 11,
  frameId: 0,
  documentId: "doc-1",
  documentToken: "dtok-1",
  targetToken: "ttok-1",
  scrollX: 0,
  scrollY: 0,
  ...over,
});

async function popupWithMediaDescriptor(descriptor, imageUrl) {
  const { sandbox, elements } = await loadPopupSandbox(async (message) => {
    if (message?.type === "luckyray-popup-get-port") return { port: 37420 };
    if (message?.type === "luckyray-popup-get-page") return { ...PAGE };
    if (message?.type === "luckyray-popup-get-media") {
      const payload = { pageUrl: PAGE.url, imageUrl: imageUrl ?? descriptor.url };
      if (descriptor) payload.descriptor = descriptor;
      return payload;
    }
    return {};
  });
  const apiCalls = [];
  vm.runInContext("LuckyRayLocalTransport = { fetch: async (p, path, o) => globalThis.__lrApi(p, path, o) };", sandbox);
  sandbox.__lrApi = async (port, path, opts) => {
    apiCalls.push({ port, path, method: opts?.method || "GET", body: opts?.body || null });
    return {
      ok: true,
      text: async () => JSON.stringify({ ok: true, data: path === "/api/notes/capture-target"
        ? { activation: { vaultId: "test-vault", sourceEpoch: 1 }, revision: "test-revision" }
        : { disposition: "imported", asset: { id: "a1", name: "x.png" } } }),
    };
  };
  const state = vm.runInContext("state", sandbox);
  state.port = 37420;
  state.tab = { id: 11, url: PAGE.url };
  return { sandbox, elements, apiCalls, state };
}

test("A RED: same URL but changed targetToken must zero-write (identity, not URL)", async () => {
  const expected = DESC();
  const { sandbox, apiCalls, state } = await popupWithMediaDescriptor(DESC({ targetToken: "ttok-2" }));
  state.prefillMedia = expected;
  await vm.runInContext('doMedia("asset:root")', sandbox);
  assert.equal(apiCalls.filter((c) => c.path === "/api/assets/import-media").length, 0,
    "A: same URL with a different current target token must not authorize a write");
  assert.equal(state.prefillMedia, null);
});

test("A RED: same URL but changed documentToken/frame/documentId/scroll must zero-write", async () => {
  for (const over of [
    { documentToken: "dtok-2" },
    { frameId: 1 },
    { documentId: "doc-2" },
    { scrollX: 120 },
    { scrollY: 240 },
  ]) {
    const { sandbox, apiCalls, state } = await popupWithMediaDescriptor(DESC(over));
    state.prefillMedia = DESC();
    await vm.runInContext('doMedia("asset:root")', sandbox);
    assert.equal(apiCalls.filter((c) => c.path === "/api/assets/import-media").length, 0,
      `A: same URL changed ${Object.keys(over)[0]} must fail closed`);
    assert.equal(state.prefillMedia, null);
  }
});

test("A RED: expired same-URL descriptor (TTL) must zero-write", async () => {
  const { sandbox, apiCalls, state } = await popupWithMediaDescriptor(DESC({ capturedAt: Date.now() - LuckyRayExpiredContextTtl() - 1 }));
  state.prefillMedia = DESC({ capturedAt: Date.now() - LuckyRayExpiredContextTtl() - 1 });
  await vm.runInContext('doMedia("asset:root")', sandbox);
  assert.equal(apiCalls.filter((c) => c.path === "/api/assets/import-media").length, 0,
    "A: expired fresh descriptor must fail closed even with the same URL");
});

test("A RED: missing latest.descriptor must zero-write", async () => {
  const { sandbox, apiCalls, state } = await popupWithMediaDescriptor(null);
  state.prefillMedia = DESC();
  await vm.runInContext('doMedia("asset:root")', sandbox);
  assert.equal(apiCalls.filter((c) => c.path === "/api/assets/import-media").length, 0,
    "A: no fresh descriptor means no current-target proof — fail closed");
});

test("A: exact expected/fresh identity match commits the fresh URL exactly once", async () => {
  const descriptor = DESC();
  const { sandbox, apiCalls, state } = await popupWithMediaDescriptor(descriptor);
  state.prefillMedia = { ...descriptor };
  await vm.runInContext('doMedia("asset:root")', sandbox);
  const posts = apiCalls.filter((c) => c.path === "/api/assets/import-media");
  assert.equal(posts.length, 1, "A: a fully matching identity commits exactly once");
  assert.equal(JSON.parse(posts[0].body).url, descriptor.url);
});

test("A RED: unbound browser-contextmenu prefill cannot become a delayed same-URL write", async () => {
  // The prefill was created as an UNBOUND fallback (no target tokens bound);
  // a later fresh target with the same URL must not legitimize it.
  const { sandbox, apiCalls, state } = await popupWithMediaDescriptor(DESC());
  state.prefillMedia = {
    type: "image",
    url: DESC().url,
    capturedAt: Date.now() - 1000,
    confidence: "browser-contextmenu",
    tabId: 11,
    // deliberately missing documentId/documentToken/targetToken/frameId
  };
  await vm.runInContext('doMedia("asset:root")', sandbox);
  assert.equal(apiCalls.filter((c) => c.path === "/api/assets/import-media").length, 0,
    "A: an unbound contextmenu prefill needs a fully matching fresh identity — same URL is not enough");
});

// ---------------------------------------------------------------------------
// [BROWSER-EXT][EXT-R1-REPAIR-4] The visible Save gate must recognize the
// same fully-bound prefill that doMedia() can commit. An empty candidate list
// is normal for a context-menu prefill and must not disable Save. Expiry is
// checked from the descriptor itself, so the gate closes without a click.

const VIDEO_DESC = (over = {}) => ({
  type: "video",
  url: "https://media.test/video.mp4",
  capturedAt: Date.now() - 100,
  confidence: "contextmenu",
  tabId: 11,
  frameId: 0,
  documentId: "video-doc-1",
  documentToken: "video-document-token-1",
  targetToken: "video-target-token-1",
  scrollX: 0,
  scrollY: 0,
  ...over,
});

test("R4-A RED: real popup Save gate accepts a fully-bound video prefill with an empty candidate list", async () => {
  const { sandbox, elements } = await loadPopupSandbox(popupFixture({
    videoUrl: VIDEO_DESC().url,
    descriptor: VIDEO_DESC(),
  }));
  const state = vm.runInContext("state", sandbox);
  state.port = 37420;
  state.tab = { id: 11, url: PAGE.url };
  state.type = "video";
  state.page = { ...PAGE, videoUrl: VIDEO_DESC().url };
  state.videoCandidates = [];
  state.prefillMedia = VIDEO_DESC();
  elements.get("lr-target").value = "asset:root";

  const gate = vm.runInContext("quickCollectGateState()", sandbox);
  assert.equal(gate.canSubmit, true, "the visible gate must accept the bound prefill authority");
  vm.runInContext("renderSubmitState()", sandbox);
  assert.equal(elements.get("lr-submit").disabled, false, "Save must be visibly enabled before the click");
});

test("R4-A: final onSubmit gate commits a bound empty-list prefill exactly once", async () => {
  const descriptor = VIDEO_DESC();
  const { sandbox, elements } = await loadPopupSandbox(popupFixture({
    videoUrl: descriptor.url,
    descriptor,
  }));
  const calls = [];
  sandbox.__lrApi = async (_port, path, options = {}) => {
    calls.push({ path, method: options.method || "GET", body: options.body || null });
    const payload = {
      transferId: "media-abcd-0123456789abcdef",
      state: "completed",
      bytesReceived: 4096,
      totalBytes: 4096,
      assetId: "asset-video-1",
      assetName: "video.mp4",
      assetKind: "video",
      skippedDuplicate: false,
    };
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, data: payload }) };
  };
  vm.runInContext("LuckyRayLocalTransport = { fetch: async (p, path, o) => globalThis.__lrApi(p, path, o) };", sandbox);
  const state = vm.runInContext("state", sandbox);
  state.port = 37420;
  state.tab = { id: 11, url: PAGE.url };
  state.type = "video";
  state.page = { ...PAGE, videoUrl: descriptor.url };
  state.videoCandidates = [];
  state.prefillMedia = descriptor;
  elements.get("lr-target").value = "asset:root";
  vm.runInContext("renderSubmitState()", sandbox);
  await vm.runInContext("onSubmit()", sandbox);
  const posts = calls.filter((call) => call.path === "/api/media/transfers" && call.method === "POST");
  assert.equal(posts.length, 1, "the real final gate must allow exactly one transfer POST");
  assert.equal(JSON.parse(posts[0].body).url, descriptor.url);
  assert.equal(state.captureTask?.stage, "completed", "the popup must observe the completed desktop transfer");
  assert.equal(state.captureTask?.asset?.id, "asset-video-1");
});

test("R4-A RED: an expired or unbound video prefill closes the real popup Save gate", async () => {
  for (const descriptor of [
    VIDEO_DESC({ capturedAt: Date.now() - LuckyRayExpiredContextTtl() - 1 }),
    { type: "video", url: VIDEO_DESC().url, capturedAt: Date.now() - 100 },
  ]) {
    const { sandbox, elements } = await loadPopupSandbox(popupFixture({ videoUrl: descriptor.url, descriptor }));
    const state = vm.runInContext("state", sandbox);
    state.port = 37420;
    state.tab = { id: 11, url: PAGE.url };
    state.type = "video";
    state.page = { ...PAGE, videoUrl: descriptor.url };
    state.videoCandidates = [];
    state.prefillMedia = descriptor;
    elements.get("lr-target").value = "asset:root";
    const gate = vm.runInContext("quickCollectGateState()", sandbox);
    assert.equal(gate.canSubmit, false, "stale/unbound prefill must not keep Save enabled");
  }
});

test("R4-A: a valid prefill automatically disables Save when its bound TTL expires", async () => {
  const descriptor = VIDEO_DESC({ capturedAt: Date.now() - LuckyRayExpiredContextTtl() + 120 });
  const { sandbox, elements } = await loadPopupSandbox(popupFixture({ videoUrl: descriptor.url, descriptor }));
  const state = vm.runInContext("state", sandbox);
  state.port = 37420;
  state.tab = { id: 11, url: PAGE.url };
  state.page = { ...PAGE, videoUrl: descriptor.url };
  sandbox.chrome.storage.session.get = async () => ({
    prefill: { type: "video", mode: "root", tabId: 11, ts: Date.now(), mediaDescriptor: descriptor },
  });
  await vm.runInContext("applyPrefill()", sandbox);
  vm.runInContext("renderSubmitState()", sandbox);
  assert.equal(elements.get("lr-submit").disabled, false, "fresh bound prefill begins enabled");
  await new Promise((resolve) => setTimeout(resolve, 170));
  assert.equal(elements.get("lr-submit").disabled, true, "expiry timer closes Save without requiring a click");
  assert.equal(state.prefillMediaInvalid, true);
});

test("R4-B RED: popup video filename keeps the selected candidate extension as authority", async () => {
  const { sandbox } = await loadPopupSandbox(popupFixture({}));
  const state = vm.runInContext("state", sandbox);
  state.page = { ...PAGE, title: "Authoritative format" };
  const fileName = vm.runInContext(
    'safePopupVideoFileName("https://media.test/misleading.mp4", { extension: "webm", contentType: "video/webm" })',
    sandbox,
  );
  assert.equal(fileName, "Authoritative format.webm", "URL suffix must not override the chosen candidate format");
});

test("R4-E RED: note media commit sends asset identity to the desktop attachment publisher", async () => {
  const descriptor = DESC();
  const { sandbox, elements, apiCalls, state } = await popupWithMediaDescriptor(descriptor);
  state.type = "image";
  state.page = { ...PAGE, imageUrl: descriptor.url };
  state.prefillMedia = { ...descriptor };
  state.noteSelection.recent = "kdoc-vault%3Aexisting.md";
  elements.get("lr-target").value = "note:recent";
  await vm.runInContext('doMedia("note:recent")', sandbox);

  const attach = apiCalls.filter((call) => call.path === "/api/notes/attach-material");
  assert.equal(attach.length, 1, "note media must use the desktop attachment publisher exactly once");
  assert.equal(state.captureTask?.stage, "completed", "note capture is complete only after attachment publishing");
  assert.equal(state.captureTask?.noteResult?.ok, true);
  const body = JSON.parse(attach[0].body);
  const imported = apiCalls.find((call) => call.path === "/api/assets/import-media");
  assert.equal(body.requestId, JSON.parse(imported.body).requestId);
  assert.equal(body.binding.activation.vaultId, "test-vault");
  assert.deepEqual(
    { assetId: body.assetId, target: body.target, noteId: body.noteId },
    { assetId: "a1", target: "existing", noteId: "kdoc-vault%3Aexisting.md" },
    "the extension sends a stable material id and note identity, never a display name as a path",
  );
});

test("note media preserves the clicked note and page source while import is pending", async () => {
  const descriptor = DESC();
  const { sandbox, elements, apiCalls, state } = await popupWithMediaDescriptor(descriptor);
  state.type = "image";
  state.page = { ...PAGE, imageUrl: descriptor.url };
  state.noteSelection.recent = "original-note";
  elements.get("lr-target").value = "note:recent";
  const originalApi = sandbox.__lrApi;
  sandbox.__lrApi = async (...args) => {
    if (args[1] === "/api/assets/import-media") {
      state.noteSelection.recent = "different-note";
      state.page.sourceUrl = "https://different.test/page";
      elements.get("lr-target").value = "note:search";
    }
    return originalApi(...args);
  };
  await vm.runInContext('doMedia("note:recent")', sandbox);
  const attach = apiCalls.find((call) => call.path === "/api/notes/attach-material");
  assert.ok(attach);
  const body = JSON.parse(attach.body);
  assert.equal(body.noteId, "original-note");
  assert.equal(body.sourceUrl, PAGE.sourceUrl);
});

test("new media note preserves its title while import is pending", async () => {
  const descriptor = DESC();
  const { sandbox, elements, apiCalls, state } = await popupWithMediaDescriptor(descriptor);
  state.type = "image";
  state.page = { ...PAGE, imageUrl: descriptor.url };
  elements.get("lr-new-note-title").value = "Clicked title";
  const originalApi = sandbox.__lrApi;
  sandbox.__lrApi = async (...args) => {
    if (args[1] === "/api/assets/import-media") {
      elements.get("lr-new-note-title").value = "Later title";
    }
    return originalApi(...args);
  };
  await vm.runInContext('doMedia("note:new")', sandbox);
  const attach = apiCalls.find((call) => call.path === "/api/notes/attach-material");
  assert.ok(attach);
  assert.equal(JSON.parse(attach.body).title, "Clicked title");
});

test("failed target preparation prevents importing media or writing a note", async () => {
  const { sandbox, elements, apiCalls, state } = await popupWithMediaDescriptor(DESC());
  state.type = "image";
  state.page = { ...PAGE, imageUrl: DESC().url };
  state.noteSelection.recent = "clicked-note";
  elements.get("lr-target").value = "note:recent";
  const originalApi = sandbox.__lrApi;
  sandbox.__lrApi = async (...args) => args[1] === "/api/notes/capture-target"
    ? { ok: false, text: async () => JSON.stringify({ ok: false, error: { code: "knowledge-source-inactive" } }) }
    : originalApi(...args);
  await vm.runInContext('doMedia("note:recent")', sandbox);
  assert.equal(apiCalls.length, 0);
});

test("Save remains disabled during import and ignores a second submit", async () => {
  const descriptor = DESC();
  const { sandbox, elements, apiCalls, state } = await popupWithMediaDescriptor(descriptor);
  state.type = "image";
  state.page = { ...PAGE, imageUrl: descriptor.url };
  elements.get("lr-target").value = "asset:root";
  const originalApi = sandbox.__lrApi;
  sandbox.__lrApi = async (...args) => {
    if (args[1] === "/api/assets/import-media") {
      vm.runInContext("renderSubmitState()", sandbox);
      assert.equal(elements.get("lr-submit").disabled, true);
      await vm.runInContext("onSubmit()", sandbox);
    }
    return originalApi(...args);
  };
  await vm.runInContext("onSubmit()", sandbox);
  assert.equal(apiCalls.filter((call) => call.path === "/api/assets/import-media").length, 1);
  assert.equal(state.submitting, false);
});

test("text capture freezes note selection before the asynchronous page capture", async () => {
  const { sandbox, elements } = await loadPopupSandbox(async (message) => {
    if (message.type === "luckyray-popup-get-page") {
      const current = vm.runInContext("state", sandbox);
      current.noteSelection.recent = "later-note";
      current.type = "image";
      elements.get("lr-target").value = "note:search";
      return { ...PAGE, contentKind: "selection", selection: "Selected text", content: "Selected text" };
    }
    return {};
  });
  const state = vm.runInContext("state", sandbox);
  state.port = 37420;
  state.tab = { id: 11 };
  state.type = "text";
  state.page = { ...PAGE };
  state.noteSelection.recent = "clicked-note";
  elements.get("lr-target").value = "note:recent";
  const calls = [];
  sandbox.__lrApi = async (_port, path, options) => {
    calls.push({ path, body: JSON.parse(options.body) });
    return { ok: true, text: async () => JSON.stringify({ ok: true, data: path === "/api/notes/capture-target"
      ? { activation: { vaultId: "test-vault", sourceEpoch: 1 }, revision: "test-revision" } : {} }) };
  };
  vm.runInContext("LuckyRayLocalTransport = { fetch: async (p, path, o) => globalThis.__lrApi(p, path, o) };", sandbox);
  await vm.runInContext('doNote("note:recent")', sandbox);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].path, "/api/notes/capture");
  assert.equal(calls[1].body.noteId, "clicked-note");
  assert.match(calls[1].body.content, /Selected text/);
  assert.ok(calls[1].body.requestId);
});

test("page navigation during media capture prevents every write", async () => {
  const { sandbox, apiCalls, state } = await popupWithTransport({ pageUrl: "https://different.test/page", imageUrl: DESC().url });
  state.type = "image";
  state.page = { ...PAGE, imageUrl: DESC().url };
  await vm.runInContext('doMedia("asset:root")', sandbox);
  assert.equal(apiCalls.length, 0);
});

test("missing fresh image never revives a previously displayed image", async () => {
  const { sandbox, apiCalls, state } = await popupWithTransport({ pageUrl: PAGE.url });
  state.type = "image";
  state.page = { ...PAGE, imageUrl: DESC().url };
  await vm.runInContext('doMedia("asset:root")', sandbox);
  assert.equal(apiCalls.length, 0);
});

test("material folder selection is frozen before awaiting fresh media", async () => {
  let fixtureState;
  const { sandbox, elements } = await loadPopupSandbox(async (message) => {
    if (message.type === "luckyray-popup-get-media") {
      fixtureState.selectedFolderId = "later-folder";
      return { pageUrl: PAGE.url, imageUrl: DESC().url };
    }
    return {};
  });
  fixtureState = vm.runInContext("state", sandbox);
  Object.assign(fixtureState, { port: 37420, tab: { id: 11 }, type: "image", page: { ...PAGE }, selectedFolderId: "clicked-folder" });
  elements.get("lr-target").value = "asset:pick";
  const requests = [];
  sandbox.__lrApi = async (_port, _path, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, text: async () => JSON.stringify({ ok: true, data: { disposition: "imported", asset: { id: "a1", name: "x.png" } } }) };
  };
  vm.runInContext("LuckyRayLocalTransport = { fetch: async (p, path, o) => globalThis.__lrApi(p, path, o) };", sandbox);
  await vm.runInContext('doMedia("asset:pick")', sandbox);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].targetFolderId, "clicked-folder");
});

test("a lost write response retries the identical receipt-backed request", async () => {
  const { sandbox, state } = await popupWithTransport({});
  const bodies = [];
  sandbox.__lrApi = async (_port, _path, options) => {
    bodies.push(options.body);
    if (bodies.length === 1) return { ok: true, text: async () => { throw new Error("lost response"); } };
    return { ok: true, text: async () => JSON.stringify({ ok: true, data: { noteId: "one-note" } }) };
  };
  const result = await vm.runInContext('callApi("POST", "/api/notes/capture", {requestId:"retry-once", content:"one block"})', sandbox);
  assert.equal(result.ok, true);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(state.unresolvedWrite, false);
});

test("an unresolved write blocks a new Save instead of generating a second action", async () => {
  const { sandbox, elements, state } = await popupWithTransport({});
  sandbox.__lrApi = async () => { throw new Error("disconnected"); };
  state.page = { ...PAGE, imageUrl: DESC().url };
  elements.get("lr-target").value = "asset:root";
  const result = await vm.runInContext('callApi("POST", "/api/notes/capture", {requestId:"uncertain-once", content:"one block"})', sandbox);
  assert.equal(result.errorObject.code, "capture-commit-uncertain");
  vm.runInContext("renderSubmitState()", sandbox);
  assert.equal(elements.get("lr-submit").disabled, true);
  assert.equal(state.unresolvedWrite, true);
});
