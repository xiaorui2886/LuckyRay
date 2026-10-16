// [BROWSER-EXT][M1-S4] Unified Video Capture State & Save Flow — RED contract
// (Issue #25).
//
// RED evidence: popup and player overlay currently use ad-hoc, divergent
// status text (popup "可入库/解析/直链/需兜底" vs overlay "未找到直链，可录制…"
// vs "暂未发现可用视频。") with no unified user-level video state projection.
// These assertions target the pure `buildVideoCaptureView` the GREEN slice
// must add to extension-protocol.js, projected ONLY from the existing
// authorities (buildVideoActionMenu / buildMediaTransferProgress).
//
// The projection is pure: hover/refresh/quality-selection/open-close never
// write (asserted in the runtime QA); the only truth for "can this be saved"
// stays the existing candidate classification and transfer authority.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const PROTOCOL_URL = new URL("../browser-extension-prototype/extension-protocol.js", import.meta.url);
import { loadContentScriptSandbox, loadPopupSandbox } from "./lib/content-script-sandbox.mjs";

async function loadProtocol() {
  const source = await readFile(PROTOCOL_URL, "utf8");
  const sandbox = { URL, setTimeout, clearTimeout };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: "extension-protocol.js" });
  return sandbox.LuckyRayExtensionProtocol;
}

const direct = (url, extra = {}) => ({ url, ...extra });
const transfer = (state, extra = {}) => ({ state, ...extra });

test("a single direct candidate projects to ready-direct (M1-S4 §5A)", async () => {
  const protocol = await loadProtocol();
  assert.equal(typeof protocol.buildVideoCaptureView, "function", "buildVideoCaptureView must exist (RED)");
  const view = protocol.buildVideoCaptureView({
    candidates: [direct("https://cdn.test/movie.mp4")],
  });
  assert.equal(view.state, "ready-direct");
  assert.equal(view.label, "可直接保存");
  assert.equal(view.primaryAction, "save");
  assert.equal(view.primaryDisabled, false);
  assert.equal(view.options.length, 1);
  assert.equal(view.options[0].kind, "direct-video");
});

test("multiple quality versions project to choose-quality with the existing ranking (M1-S4 §5B)", async () => {
  const protocol = await loadProtocol();
  const view = protocol.buildVideoCaptureView({
    candidates: [
      direct("https://cdn.test/movie-480.mp4", { height: 480 }),
      direct("https://cdn.test/movie-1080.mp4", { height: 1080 }),
      direct("https://cdn.test/movie-720.mp4", { height: 720 }),
    ],
  });
  assert.equal(view.state, "choose-quality");
  assert.equal(view.label, "选择清晰度");
  assert.equal(view.primaryAction, "save");
  assert.equal(view.options.length, 3);
  // Ranking follows the existing buildVideoActionMenu sort (height desc).
  // JSON comparison avoids vm-sandbox realm primitive identity quirks.
  assert.equal(
    JSON.stringify(view.options.map((option) => option.height)),
    JSON.stringify([1080, 720, 480]),
    "quality options must keep the existing ranking order",
  );
  assert.ok(view.options[0].label.includes("1080p"), "labels carry reliable height data");
  assert.ok(view.options.every((option) => /^video-\d+$/.test(option.candidateId)), "options carry stable candidate ids");
});

test("a site-resolver candidate projects to needs-resolve (M1-S4 §5C)", async () => {
  const protocol = await loadProtocol();
  const view = protocol.buildVideoCaptureView({
    candidates: [direct("https://site.test/watch/12345", { contentType: "application/x-luckyray-video-page" })],
  });
  assert.equal(view.state, "needs-resolve");
  assert.equal(view.label, "需要解析");
  assert.equal(view.primaryAction, "resolve");
  assert.equal(view.primaryDisabled, false);
});

test("blob-only and empty candidates project per existing policy (M1-S4 §5D/§5E)", async () => {
  const protocol = await loadProtocol();
  const blobOnly = protocol.buildVideoCaptureView({
    candidates: [direct("blob:https://site.test/uuid")],
  });
  assert.equal(blobOnly.state, "record-fallback");
  assert.equal(blobOnly.label, "需要录制");
  assert.equal(blobOnly.canRecord, true);
  assert.equal(blobOnly.primaryAction, "record");

  const empty = protocol.buildVideoCaptureView({ candidates: [] });
  assert.equal(empty.state, "needs-play");
  assert.equal(empty.label, "先播放几秒，再刷新");
  assert.equal(empty.primaryAction, "refresh");
});

test("unsupported / no safe fallback projects to blocked, never claiming a workaround (M1-S4 §5F)", async () => {
  const protocol = await loadProtocol();
  // A segment (ts/m4s) yields no savable item and no recording fallback.
  const view = protocol.buildVideoCaptureView({
    candidates: [direct("https://cdn.test/segment.ts")],
  });
  assert.equal(view.state, "blocked");
  assert.equal(view.label, "当前内容不支持直接保存");
  assert.equal(view.primaryAction, null);
  assert.equal(view.primaryDisabled, true);
  assert.equal(view.canRecord, false);
});

test("quality selection binds candidate identity (candidateId/sourceIndex), not just URL (M1-S4 §5B/§8)", async () => {
  const protocol = await loadProtocol();
  const view = protocol.buildVideoCaptureView({
    candidates: [
      direct("https://cdn.test/movie-720.mp4", { height: 720 }),
      direct("https://cdn.test/movie-1080.mp4", { height: 1080 }),
    ],
  });
  const ids = new Set(view.options.map((option) => option.candidateId));
  assert.equal(ids.size, 2, "each quality option must carry a distinct candidate id");
  assert.ok(view.options.every((option) => Number.isInteger(option.sourceIndex)), "options carry their source index");
});

test("transfer states project to the unified user-level states (M1-S4 §6)", async () => {
  const protocol = await loadProtocol();
  const expectations = [
    ["queued", "queued", "等待入库"],
    ["running", "running", "正在下载"],
    ["importing", "importing", "正在写入素材库"],
    ["completed", "completed", "已入库"],
    ["cancelling", "cancelling", "正在取消"],
    ["cancelled", "cancelled", "已取消"],
    ["failed", "failed", "入库失败"],
  ];
  for (const [state, expectedState, labelPart] of expectations) {
    const view = protocol.buildVideoCaptureView({
      candidates: [direct("https://cdn.test/movie.mp4")],
      transfer: transfer(state, { percent: state === "running" ? 50 : state === "completed" || state === "importing" ? 100 : 0 }),
    });
    assert.equal(view.state, expectedState, `state for ${state}`);
    assert.ok(view.label.includes(labelPart), `label for ${state} (got "${view.label}")`);
    assert.equal(view.primaryDisabled, !["cancelled", "failed"].includes(state), `submit gate for ${state}`);
  }
});

test("a skipped-duplicate transfer projects to duplicate / already-exists (M1-S4 §6)", async () => {
  const protocol = await loadProtocol();
  const view = protocol.buildVideoCaptureView({
    candidates: [direct("https://cdn.test/movie.mp4")],
    transfer: transfer("completed", { skippedDuplicate: true, bytesReceived: 100, totalBytes: 100 }),
  });
  assert.equal(view.state, "duplicate");
  assert.equal(view.label, "已存在，无需重复保存");
});

test("popup and player overlay derive the same user-level state from the same authority (M1-S4 §5/§12)", async () => {
  const protocol = await loadProtocol();
  const candidates = [
    direct("https://cdn.test/movie-720.mp4", { height: 720 }),
    direct("https://cdn.test/movie-1080.mp4", { height: 1080 }),
  ];
  // Popup feeds raw candidates; the overlay feeds pre-classified menu items
  // plus canRecord (the background's response shape).
  const menu = protocol.buildVideoActionMenu(candidates, {});
  const fromCandidates = protocol.buildVideoCaptureView({ candidates });
  const fromItems = protocol.buildVideoCaptureView({ items: menu.items, canRecord: menu.canRecord });
  assert.equal(fromCandidates.state, fromItems.state, "state must not depend on the caller's input shape");
  assert.equal(fromCandidates.label, fromItems.label, "label must not depend on the caller's input shape");
  assert.deepEqual(
    fromCandidates.options.map((option) => option.label),
    fromItems.options.map((option) => option.label),
    "quality option labels must agree between popup and overlay",
  );
});

test("video capture view functions are pure (no chrome/storage/document access) (M1-S4 §7)", async () => {
  const protocol = await loadProtocol();
  // The vm sandbox exposes no chrome/storage/document — any impurity throws.
  const view = protocol.buildVideoCaptureView({
    candidates: [direct("https://cdn.test/movie.mp4")],
    transfer: transfer("queued", { bytesReceived: 0, totalBytes: 1024 }),
  });
  assert.equal(view.state, "queued");
  assert.equal(protocol.buildVideoCaptureView({ candidates: [] }).state, "needs-play");
});

// [BROWSER-EXT][M1-S4][FIX-1][P1-1] PRESERVE-FIRST regression: an empty
// overlay whose caller positively knows recording is available must project
// record-fallback (the existing 录制当前标签页 affordance is immediately
// usable) — never the contradictory "先播放几秒，再刷新". needs-play stays for
// "no candidate AND recording availability not established".
test("empty items + known canRecord projects record-fallback, not needs-play (FIX-1 P1-1)", async () => {
  const protocol = await loadProtocol();
  const withRecord = protocol.buildVideoCaptureView({ items: [], canRecord: true });
  assert.equal(withRecord.state, "record-fallback", "canRecord=true must win over needs-play");
  assert.equal(withRecord.label, "需要录制");
  assert.equal(withRecord.primaryAction, "record");
  assert.equal(withRecord.primaryDisabled, false);
  assert.ok(withRecord.guidance.includes("录制"), "guidance must keep the recording affordance explicit");

  const withoutRecord = protocol.buildVideoCaptureView({ items: [], canRecord: false });
  assert.equal(withoutRecord.state, "needs-play", "unestablished recording availability keeps needs-play");
  assert.equal(withoutRecord.label, "先播放几秒，再刷新");
  assert.equal(withoutRecord.primaryAction, "refresh");

  // The popup's no-candidate shape (canRecord not passed at all) is unchanged.
  const popupEmpty = protocol.buildVideoCaptureView({ candidates: [] });
  assert.equal(popupEmpty.state, "needs-play");
});

// [BROWSER-EXT][M1-S4][FIX-1][P1-2] The player overlay feeds the unified view
// pre-classified menu items + canRecord (the background's response shape). The
// four overlay states must project from that items shape exactly like the
// popup's candidates shape (DOM-level overlay coverage lives in the runtime
// fixture QA; these are the pure projections it drives).
test("overlay item shapes project the four unified states (FIX-1 P1-2)", async () => {
  const protocol = await loadProtocol();
  const menuOf = (candidates, options = {}) => protocol.buildVideoActionMenu(candidates, options).items;

  const directView = protocol.buildVideoCaptureView({
    items: menuOf([direct("https://cdn.test/movie.mp4")]),
    canRecord: false,
  });
  assert.equal(directView.state, "ready-direct", "one direct item -> ready-direct");
  assert.equal(directView.label, "可直接保存");
  assert.equal(directView.options.length, 1);

  const qualityView = protocol.buildVideoCaptureView({
    items: menuOf([
      direct("https://cdn.test/movie-480.mp4", { height: 480 }),
      direct("https://cdn.test/movie-1080.mp4", { height: 1080 }),
    ]),
    canRecord: true,
  });
  assert.equal(qualityView.state, "choose-quality", "multiple saveable formats -> choose-quality");
  assert.equal(qualityView.label, "选择清晰度");
  assert.equal(qualityView.options.length, 2);

  const resolveView = protocol.buildVideoCaptureView({
    items: menuOf([direct("https://site.test/watch/12345", { contentType: "application/x-luckyray-video-page" })]),
    canRecord: false,
  });
  assert.equal(resolveView.state, "needs-resolve", "one site-resolver item -> needs-resolve");
  assert.equal(resolveView.label, "需要解析");
  assert.equal(resolveView.primaryAction, "resolve");

  const emptyRecord = protocol.buildVideoCaptureView({ items: [], canRecord: true });
  assert.equal(emptyRecord.state, "record-fallback", "empty + canRecord -> record-fallback");
  assert.equal(emptyRecord.label, "需要录制");
});

// ---------------------------------------------------------------------------
// [BROWSER-EXT][EXT-R1-R1] P1-3 / P2-2 repair contracts:
//   P1-3: one immutable, non-secret video candidate identity used by render,
//   explicit selection, refresh comparison, selected lookup and transfer
//   construction. Same URL + changed transfer identity (audioUrl, binding,
//   frameId, documentId, sourcePage) must invalidate an explicit selection
//   and require a re-pick. URL must not remain a selection authority.
//   P2-2: duplicate-aware terminal projection for overlay completion.

test("P1-3 RED: buildVideoCandidateIdentity must exist and bind every transfer-affecting field", async () => {
  const protocol = await loadProtocol();
  assert.equal(typeof protocol.buildVideoCandidateIdentity, "function",
    "P1-3: one canonical identity builder is required");
  const base = {
    url: "https://media.test/video.mp4",
    kind: "direct",
    binding: "site-track-pair",
    audioUrl: "https://media.test/audio.m4a",
    frameId: 3,
    documentId: "doc-1",
    sourcePageUrl: "https://page.test/watch",
    probeId: "probe-9",
    formatId: "1080",
  };
  const identity = protocol.buildVideoCandidateIdentity(base);
  assert.ok(identity, "identity must build for a full candidate");
  // Any single transfer-affecting change must produce a different identity:
  for (const [field, value] of [
    ["audioUrl", "https://media.test/other-audio.m4a"],
    ["binding", "single"],
    ["frameId", 4],
    ["documentId", "doc-2"],
    ["sourcePageUrl", "https://page.test/watch2"],
    ["probeId", "probe-10"],
    ["formatId", "720"],
    ["url", "https://media.test/video2.mp4"],
  ]) {
    const changed = protocol.buildVideoCandidateIdentity({ ...base, [field]: value });
    assert.notEqual(changed, identity, `P1-3: changing ${field} must change the identity under the same URL`);
  }
  assert.equal(protocol.buildVideoCandidateIdentity(base), identity, "identity must be deterministic");
});

test("P1-3 RED: popup selected lookup must not fall back to URL alone", async () => {
  const { sandbox } = await loadPopupSandbox(async (message) => {
    if (message?.type === "luckyray-popup-get-video-candidates") {
      // The real background cache updates a same-URL candidate in place with
      // a changed audio track — this fixture reproduces exactly that shape.
      return {
        candidates: [
          {
            url: "https://media.test/video.mp4",
            kind: "direct",
            binding: "site-track-pair",
            audioUrl: "https://media.test/audio-B.m4a",
            frameId: 3,
            documentId: "doc-1",
          },
        ],
      };
    }
    return {};
  });
  const state = vm.runInContext("state", sandbox);
  state.videoCandidates = [
    {
      url: "https://media.test/video.mp4",
      kind: "direct",
      binding: "site-track-pair",
      audioUrl: "https://media.test/audio-a.m4a",
      frameId: 3,
      documentId: "doc-1",
    },
  ];
  // The user explicitly picked the track-pair candidate:
  state.selectedVideoUrl = "https://media.test/video.mp4";
  state.selectedVideoKey = vm.runInContext("candidateKey(state.videoCandidates[0])", sandbox);
  state.selectedVideoExplicit = true;
  state.selectionRequiresPick = false;
  // Refresh arrives through the REAL refreshVideoCandidates() seam: SAME URL
  // but the audio track changed in place. On the parent head the URL key
  // matches, the selection silently survives, and the transfer would use the
  // new audioUrl without a new explicit pick.
  await vm.runInContext("refreshVideoCandidates()", sandbox);
  assert.equal(state.selectionRequiresPick, true,
    "P1-3: same URL with changed audio track must invalidate the explicit selection");
  assert.equal(state.selectedVideoKey, "", "P1-3: invalidated selection must clear the key");
});

test("P1-3 RED: unchanged identity under the same URL keeps an explicit selection", async () => {
  const { sandbox } = await loadPopupSandbox(async (message) => {
    if (message?.type === "luckyray-popup-get-video-candidates") {
      return {
        candidates: [
          {
            url: "https://media.test/video.mp4",
            kind: "direct",
            binding: "site-track-pair",
            audioUrl: "https://media.test/audio-a.m4a",
            frameId: 3,
            documentId: "doc-1",
          },
        ],
      };
    }
    return {};
  });
  const state = vm.runInContext("state", sandbox);
  state.videoCandidates = [
    {
      url: "https://media.test/video.mp4",
      kind: "direct",
      binding: "site-track-pair",
      audioUrl: "https://media.test/audio-a.m4a",
      frameId: 3,
      documentId: "doc-1",
    },
  ];
  state.selectedVideoUrl = "https://media.test/video.mp4";
  state.selectedVideoKey = vm.runInContext("candidateKey(state.videoCandidates[0])", sandbox);
  state.selectedVideoExplicit = true;
  state.selectionRequiresPick = false;
  await vm.runInContext("refreshVideoCandidates()", sandbox);
  assert.equal(state.selectionRequiresPick, false,
    "P1-3: an unchanged full identity must keep the explicit selection");
  assert.equal(state.selectedVideoKey, vm.runInContext("candidateKey(state.videoCandidates[0])", sandbox),
    "P1-3: unchanged identity keeps the selection key");
});

test("P2-2 RED: overlay duplicate completion projects already-exists, not a new save", async () => {
  const { sandbox } = await loadContentScriptSandbox();
  // Drive the real content-script message path for a completed duplicate
  // transfer through buildMediaTransferProgress + the shared result policy:
  const protocol = sandbox.LuckyRayExtensionProtocol;
  assert.equal(typeof protocol.formatTransferTerminalStatus, "function",
    "P2-2: one duplicate-aware terminal result projection is required");
  const duplicate = protocol.formatTransferTerminalStatus({
    state: "completed",
    skippedDuplicate: true,
  });
  assert.match(duplicate, /已存在|未重复/, "P2-2: duplicate completion must read as already-exists");
  assert.doesNotMatch(duplicate, /已保存到/, "P2-2: duplicate completion must not claim a fresh save");
  const fresh = protocol.formatTransferTerminalStatus({ state: "completed" });
  assert.match(fresh, /已保存/, "fresh completion keeps the saved message");
});

// ---------------------------------------------------------------------------
// [BROWSER-EXT][EXT-R1-REPAIR-2] Contracts B / C — driven through the REAL
// popup.js doMedia() path until the actual /api/media/transfers request body.

const POPUP_PAGE = {
  title: "Fixture page",
  url: "https://page.test/watch",
  sourceUrl: "https://page.test/watch",
  captureProtocolVersion: 2,
  contentKind: "summary",
};

function candidateA(over = {}) {
  return {
    url: "https://media.test/video-a.mp4",
    kind: "direct",
    binding: "site-track-pair",
    audioUrl: "https://media.test/audio-a.m4a",
    frameId: 3,
    documentId: "doc-a",
    sourcePageUrl: "https://page.test/watch",
    ...over,
  };
}

async function videoPopupSandbox({ candidates, mediaPayload, transferBodyCapture, onMediaRequest, sourcePageSupported = false }) {
  const { sandbox, elements } = await loadPopupSandbox(async (message) => {
    if (message?.type === "luckyray-popup-get-port") return { port: 37420 };
    if (message?.type === "luckyray-popup-get-page") return { ...POPUP_PAGE };
    if (message?.type === "luckyray-popup-get-video-candidates") return { candidates };
    if (message?.type === "luckyray-source-page-capability") return { supported: sourcePageSupported };
    if (message?.type === "luckyray-popup-get-media") {
      onMediaRequest?.();
      return { pageUrl: POPUP_PAGE.url, ...(mediaPayload || {}) };
    }
    return {};
  });
  const apiCalls = [];
  vm.runInContext("LuckyRayLocalTransport = { fetch: async (p, path, o) => globalThis.__lrApi(p, path, o) };", sandbox);
  sandbox.__lrApi = async (port, path, opts) => {
    const call = { port, path, method: opts?.method || "GET", body: opts?.body || null };
    apiCalls.push(call);
    if (path === "/api/media/transfers") transferBodyCapture(JSON.parse(call.body || "{}"));
    return {
      ok: true,
      text: async () => JSON.stringify({
        ok: true,
        data: {
          transferId: "media-abcd-0123456789abcdef", state: "completed",
          bytesReceived: 4096, totalBytes: 4096,
          assetId: "a1", assetName: "video-a.mp4", assetKind: "video", skippedDuplicate: false,
        },
      }),
    };
  };
  const state = vm.runInContext("state", sandbox);
  state.port = 37420;
  state.tab = { id: 11, url: POPUP_PAGE.url };
  state.type = "video";
  return { sandbox, elements, apiCalls, state };
}

test("video selection changes during fresh capture cannot replace the clicked candidate", async () => {
  let fixtureState;
  let transferred;
  const first = candidateA();
  const second = candidateA({ url: "https://media.test/second.mp4", audioUrl: "https://media.test/second.m4a" });
  const { sandbox, state } = await videoPopupSandbox({
    candidates: [first, second], mediaPayload: { videoUrl: first.url },
    transferBodyCapture: (body) => { transferred = body; },
    onMediaRequest: () => { fixtureState.selectedVideoUrl = second.url; fixtureState.selectedVideoKey = ""; },
  });
  fixtureState = state;
  state.page = { ...POPUP_PAGE };
  state.videoCandidates = [first, second];
  state.selectedVideoUrl = first.url;
  state.selectedVideoKey = vm.runInContext("candidateKey(state.videoCandidates[0])", sandbox);
  await vm.runInContext('doMedia("asset:root")', sandbox);
  assert.ok(transferred);
  assert.equal(transferred.url, first.url);
  assert.equal(transferred.audioUrl, first.audioUrl);
});

test("B RED: selected candidate A commits A's URL AND A's metadata as one unit even when hover returns URL B", async () => {
  const capture = { body: null };
  const { sandbox, apiCalls } = await videoPopupSandbox({
    candidates: [candidateA()],
    // content-side hover answers a DIFFERENT url B (e.g. a blob player URL):
    mediaPayload: { videoUrl: "https://media.test/hover-B.mp4" },
    transferBodyCapture: (body) => { capture.body = body; },
  });
  const state = vm.runInContext("state", sandbox);
  // user explicitly selected candidate A:
  state.videoCandidates = [candidateA()];
  state.selectedVideoUrl = "https://media.test/video-a.mp4";
  state.selectedVideoKey = vm.runInContext("candidateKey(state.videoCandidates[0])", sandbox);
  state.selectedVideoExplicit = true;
  state.selectionRequiresPick = false;
  await vm.runInContext('doMedia("asset:root")', sandbox);
  const transfers = apiCalls.filter((c) => c.path === "/api/media/transfers");
  assert.equal(transfers.length, 1, "B: the selected candidate must still transfer");
  const body = capture.body || {};
  assert.equal(body.url, "https://media.test/video-a.mp4",
    "B: the transfer URL is the selected candidate's URL, never the hover URL B");
  assert.equal(body.audioUrl, "https://media.test/audio-a.m4a",
    "B: track-pair metadata comes from the SAME selected candidate");
});

test("B RED: empty content-side hover must not block a validly selected candidate", async () => {
  const capture = { body: null };
  const { sandbox, apiCalls } = await videoPopupSandbox({
    candidates: [candidateA()],
    mediaPayload: {},
    transferBodyCapture: (body) => { capture.body = body; },
  });
  const state = vm.runInContext("state", sandbox);
  state.videoCandidates = [candidateA()];
  state.selectedVideoUrl = "https://media.test/video-a.mp4";
  state.selectedVideoKey = vm.runInContext("candidateKey(state.videoCandidates[0])", sandbox);
  state.selectedVideoExplicit = true;
  state.selectionRequiresPick = false;
  await vm.runInContext('doMedia("asset:root")', sandbox);
  const transfers = apiCalls.filter((c) => c.path === "/api/media/transfers");
  assert.equal(transfers.length, 1, "B: hover being empty must not block the selected candidate");
  assert.equal((capture.body || {}).url, "https://media.test/video-a.mp4");
});

test("B: unchanged selected identity transfers exactly once with matching fields", async () => {
  const capture = { body: null };
  const { sandbox, apiCalls } = await videoPopupSandbox({
    candidates: [candidateA()],
    mediaPayload: { videoUrl: "https://media.test/video-a.mp4" },
    transferBodyCapture: (body) => { capture.body = body; },
  });
  const state = vm.runInContext("state", sandbox);
  state.videoCandidates = [candidateA()];
  state.selectedVideoUrl = "https://media.test/video-a.mp4";
  state.selectedVideoKey = vm.runInContext("candidateKey(state.videoCandidates[0])", sandbox);
  state.selectedVideoExplicit = true;
  state.selectionRequiresPick = false;
  await vm.runInContext('doMedia("asset:root")', sandbox);
  const transfers = apiCalls.filter((c) => c.path === "/api/media/transfers");
  assert.equal(transfers.length, 1);
  const body = capture.body || {};
  assert.equal(body.url, "https://media.test/video-a.mp4");
  assert.equal(body.audioUrl, "https://media.test/audio-a.m4a");
  assert.equal(body.sourcePageUrl, "https://page.test/watch");
  assert.equal(state.captureTask?.stage, "completed", "the real task must settle beyond its accepted state");
  assert.equal(state.captureTask?.asset?.id, "a1");
});

test("C RED: invalidated video selection disables Save for every allowed destination", async () => {
  const { sandbox } = await loadPopupSandbox(async (message) => {
    if (message?.type === "luckyray-popup-get-port") return { port: 37420 };
    if (message?.type === "luckyray-popup-get-page") return { ...POPUP_PAGE };
    return {};
  });
  const protocol = sandbox.LuckyRayExtensionProtocol;
  const ready = { port: 37420, readiness: { ready: true, code: "ready" }, selection: {}, videoSelection: { hasValidSelection: false, requiresPick: true } };
  for (const target of ["asset:root", "asset:pick", "asset:newFolder", "note:insertCurrent", "note:recent", "note:search", "note:new"]) {
    const gate = protocol.quickCollectSubmitGate({ ...ready, target, selection: target.startsWith("note:") ? { selectedNoteId: "n1" } : {} });
    assert.equal(gate.canSubmit, false, `C: invalidated selection must block ${target}`);
    assert.match(gate.reason, /重新选择|选择/, `C: ${target} must carry the re-pick reason`);
  }
  const valid = protocol.quickCollectSubmitGate({
    ...ready, target: "note:insertCurrent", selection: { selectedNoteId: "n1" },
    videoSelection: { hasValidSelection: true, requiresPick: false },
  });
  assert.equal(valid.canSubmit, true, "C: a valid selection re-enables a complete destination");
});

// ---------------------------------------------------------------------------
// [BROWSER-EXT][EXT-R1-REPAIR-2] Contract D — REAL overlay duplicate consumer
// proof. Instantiates the actual content-script overlay (closed shadow DOM),
// drives the real save -> pollTransfer() completion branch with
// completed+skippedDuplicate=true and asserts the rendered status text.

import { readFile as rf } from "node:fs/promises";

test("D RED: real overlay renders already-exists terminal status for skippedDuplicate=true", async () => {
  const fixture = await loadContentScriptSandbox(async (message) => {
    // Background seam for the REAL overlay lifecycle: the open request gets a
    // real protocol-shaped menu; the save-materials action returns a completed
    // duplicate transfer snapshot that the real pollTransfer() must render.
    if (message?.type === "luckyray-video-overlay-open") {
      return {
        ok: true,
        sessionId: "s1",
        recording: false,
        canRecord: false,
        items: [{
          candidateId: "video-0",
          kind: "direct",
          label: "MP4 直链",
          url: "https://media.test/dup.mp4",
          canSaveToMaterials: true,
          canProbe: false,
          canRecord: false,
        }],
      };
    }
    if (message?.type === "luckyray-video-overlay-action" && message.action === "save-materials") {
      return {
        ok: true,
        transfer: {
          transferId: "t1", state: "completed", percent: 100,
          skippedDuplicate: true, assetId: "a1", assetName: "dup.mp4", assetKind: "video",
        },
      };
    }
    return {};
  });
  const { sandbox, contentSource } = fixture;
  // Execute the REAL content script (same seam the hover tests use):
  vm.runInContext(contentSource, sandbox, { filename: "content-script.js" });
  // A real video element owns the overlay:
  const video = vm.runInContext("new HTMLVideoElement()", sandbox);
  Object.assign(video, {
    currentSrc: "https://media.test/dup.mp4",
    src: "https://media.test/dup.mp4",
    isConnected: true,
  });
  sandbox.document.querySelectorAll = (selector) => (String(selector).includes("video") ? [video] : []);
  // Drive the REAL overlay lifecycle through real page events (the internals
  // are IIFE-scoped, exactly as in production): a "play" event on the video
  // element is the production trigger for lrCollectorTrackVideoOverlay.
  vm.runInContext(`
    (function () {
      const video = document.querySelectorAll("video")[0];
      const event = { target: video };
      for (const listener of __lrDocumentListeners.get("play") || []) listener(event);
    })();
  `, sandbox);
  await new Promise((resolve) => setTimeout(resolve, 60));
  // Open the panel through the REAL chip click listener (real message round-trip):
  vm.runInContext(`
    (function () {
      const overlay = (() => {
        // The overlay registry is IIFE-internal; reach the panel through the
        // sandbox-recorded shadow tree: the chip is the only lr-chip element.
        return null;
      })();
    })();
  `, sandbox);
  const chip = vm.runInContext(`
    (function () {
      const video = document.querySelectorAll("video")[0];
      const host = document.documentElement.__lrChildren || [];
      const stack = [...host];
      while (stack.length) {
        const node = stack.shift();
        if (node?.className === "lr-chip") return node;
        for (const child of node?.__lrChildren || []) stack.push(child);
      }
      return null;
    })()
  `, sandbox);
  assert.ok(chip, "D: the overlay chip must exist in the sandbox shadow tree after the play event");
  chip.dispatch("click", { preventDefault() {}, stopPropagation() {} });
  await new Promise((resolve) => setTimeout(resolve, 120));
  // Find the row save button through the same real tree:
  const saveButton = vm.runInContext(`
    (function () {
      const video = document.querySelectorAll("video")[0];
      const stack = [...(document.documentElement.__lrChildren || [])];
      while (stack.length) {
        const node = stack.shift();
        if (node?.className === "lr-action" && node.dataset?.primary === "true") return node;
        for (const child of node?.__lrChildren || []) stack.push(child);
      }
      return null;
    })()
  `, sandbox);
  assert.ok(saveButton, "D: the overlay row save button must exist in the real DOM tree");
  saveButton.dispatch("click", { preventDefault() {}, stopPropagation() {} });
  // The real pollTransfer loop ticks at 750ms; give it one tick to complete:
  await new Promise((resolve) => setTimeout(resolve, 1600));
  const status = vm.runInContext(`
    (function () {
      const video = document.querySelectorAll("video")[0];
      let best = "";
      const stack = [...(document.documentElement.__lrChildren || [])];
      while (stack.length) {
        const node = stack.shift();
        // The overlay status line is the element whose text was last set by
        // setStatus — identified by its class in the real overlay DOM.
        if (typeof node?.className === "string" && node.className.includes("lr-status")) best = node.textContent;
        for (const child of node?.__lrChildren || []) stack.push(child);
      }
      return best;
    })()
  `, sandbox);
  assert.match(status, /已存在|未重复/, `D: overlay status must read as already-exists (got: ${status})`);
  assert.doesNotMatch(status, /已保存到/, "D: overlay must not claim a fresh save for a duplicate");
});

// ---------------------------------------------------------------------------
// [BROWSER-EXT][EXT-R1-REPAIR-3] Contracts A/B — the video commit candidate is
// ONE immutable unit on every real Save path, driven through the real popup.js
// doMedia() until the actual /api/media/transfers request body.
//   A: a default/auto-selected row is a selected candidate for transfer
//      purposes (selectedVideoExplicit must NOT gate atomicity); the chosen
//      object flows doMedia -> importMedia -> importVideoWithTransfer and
//      downstream helpers must not re-select from mutable state by URL.
//   B: video prefill is a type-aware separate authority; the commit candidate
//      built from a verified prefill never borrows list-row metadata.

function candidateA3(over = {}) {
  return {
    url: "https://media.test/video-a.mp4",
    kind: "direct",
    binding: "site-track-pair",
    audioUrl: "https://media.test/audio-a.m4a",
    frameId: 3,
    documentId: "doc-a",
    sourcePageUrl: "https://page.test/watch",
    contentType: "video/mp4",
    extension: "mp4",
    ...over,
  };
}

test("R3-A RED: default-selected candidate A + hover URL B must transfer A's full unit (no B/A mixing)", async () => {
  const capture = { body: null };
  const { sandbox, apiCalls } = await videoPopupSandbox({
    candidates: [candidateA3()],
    mediaPayload: { videoUrl: "https://media.test/hover-B.mp4" },
    transferBodyCapture: (body) => { capture.body = body; },
  });
  const state = vm.runInContext("state", sandbox);
  // A is selected as the deterministic/default row (NOT an explicit pick):
  state.videoCandidates = [candidateA3()];
  state.selectedVideoUrl = "https://media.test/video-a.mp4";
  state.selectedVideoKey = vm.runInContext("candidateKey(state.videoCandidates[0])", sandbox);
  state.selectedVideoExplicit = false;
  state.selectionRequiresPick = false;
  await vm.runInContext('doMedia("asset:root")', sandbox);
  const transfers = apiCalls.filter((c) => c.path === "/api/media/transfers");
  assert.equal(transfers.length, 1, "R3-A: the default-selected candidate must still transfer");
  const body = capture.body || {};
  assert.equal(body.url, "https://media.test/video-a.mp4",
    "R3-A: the transfer URL is the selected candidate's URL, never the hover URL B");
  assert.equal(body.audioUrl, "https://media.test/audio-a.m4a",
    "R3-A: audio metadata must come from the SAME selected candidate");
});

test("R3-A RED: default-selected A + empty hover commits A atomically exactly once", async () => {
  const capture = { body: null };
  const { sandbox, apiCalls } = await videoPopupSandbox({
    candidates: [candidateA3()],
    mediaPayload: {},
    transferBodyCapture: (body) => { capture.body = body; },
  });
  const state = vm.runInContext("state", sandbox);
  state.videoCandidates = [candidateA3()];
  state.selectedVideoUrl = "https://media.test/video-a.mp4";
  state.selectedVideoKey = vm.runInContext("candidateKey(state.videoCandidates[0])", sandbox);
  state.selectedVideoExplicit = false;
  state.selectionRequiresPick = false;
  await vm.runInContext('doMedia("asset:root")', sandbox);
  const transfers = apiCalls.filter((c) => c.path === "/api/media/transfers");
  assert.equal(transfers.length, 1, "R3-A: an enabled default selection must not fail at final Save");
  assert.equal((capture.body || {}).url, "https://media.test/video-a.mp4");
});

test("R3-A RED: two same-URL candidates with different audio/MIME — the selected key decides the WHOLE request", async () => {
  const candidateTop = candidateA3({
    audioUrl: "https://media.test/audio-commentary.m4a",
    contentType: "video/mp4",
    extension: "mp4",
    documentId: "doc-top",
  });
  const candidateBottom = candidateA3({
    audioUrl: "https://media.test/audio-original.m4a",
    contentType: "video/webm",
    extension: "webm",
    documentId: "doc-bottom",
  });
  const capture = { body: null };
  const { sandbox, apiCalls } = await videoPopupSandbox({
    candidates: [candidateTop, candidateBottom],
    mediaPayload: {},
    transferBodyCapture: (body) => { capture.body = body; },
  });
  const state = vm.runInContext("state", sandbox);
  state.videoCandidates = [candidateTop, candidateBottom];
  // Explicitly select the SECOND (same URL, different identity):
  state.selectedVideoUrl = candidateBottom.url;
  state.selectedVideoKey = vm.runInContext("candidateKey(state.videoCandidates[1])", sandbox);
  state.selectedVideoExplicit = true;
  state.selectionRequiresPick = false;
  await vm.runInContext('doMedia("asset:root")', sandbox);
  const transfers = apiCalls.filter((c) => c.path === "/api/media/transfers");
  assert.equal(transfers.length, 1);
  const body = capture.body || {};
  assert.equal(body.audioUrl, "https://media.test/audio-original.m4a",
    "R3-A: the selected key decides audio metadata among same-URL candidates");
  assert.notEqual(body.audioUrl, "https://media.test/audio-commentary.m4a",
    "R3-A: the other same-URL candidate's track must not leak into the request");
});

test("R3-B RED: a verified video prefill B commits B only — never list candidate A's metadata", async () => {
  const capture = { body: null };
  const freshDescriptor = {
    type: "video",
    url: "https://media.test/prefill-B.mp4",
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
  const { sandbox, apiCalls } = await videoPopupSandbox({
    candidates: [candidateA3()],
    mediaPayload: { videoUrl: "https://media.test/prefill-B.mp4", descriptor: freshDescriptor },
    transferBodyCapture: (body) => { capture.body = body; },
  });
  const state = vm.runInContext("state", sandbox);
  state.videoCandidates = [candidateA3()];
  state.selectedVideoUrl = "https://media.test/video-a.mp4";
  state.selectedVideoKey = vm.runInContext("candidateKey(state.videoCandidates[0])", sandbox);
  state.selectedVideoExplicit = false;
  state.selectionRequiresPick = false;
  state.prefillMedia = { ...freshDescriptor, type: "video" };
  await vm.runInContext('doMedia("asset:root")', sandbox);
  const transfers = apiCalls.filter((c) => c.path === "/api/media/transfers");
  assert.equal(transfers.length, 1, "R3-B: a verified bound video prefill commits");
  const body = capture.body || {};
  assert.equal(body.url, "https://media.test/prefill-B.mp4", "R3-B: the prefill URL commits");
  assert.equal(body.audioUrl, undefined,
    "R3-B: an unrelated list candidate's audio track must never attach to the prefill transfer");
});

test("a verified popup video prefill B keeps its bound work page, not detail A's resolver page", async () => {
  const pageA = "https://www.pinterest.com/pin/111111111111/?view=detail#clip-a";
  const workB = "https://www.pinterest.com/pin/222222222222/?view=video#clip-b";
  const fresh = {
    type: "video", url: "https://media.test/card-b.mp4", capturedAt: Date.now() - 200,
    confidence: "browser-contextmenu", tabId: 11, frameId: 0,
    documentId: "doc-1", documentToken: "dtok-1", targetToken: "card-b",
    scrollX: 0, scrollY: 0, materialSourcePageUrl: workB,
  };
  let body;
  const { sandbox, state } = await videoPopupSandbox({
    candidates: [candidateA3({ sourcePageUrl: pageA })],
    mediaPayload: { pageUrl: pageA, videoUrl: fresh.url, descriptor: fresh },
    sourcePageSupported: true, transferBodyCapture: (value) => { body = value; },
  });
  state.page = { title: "Detail A", url: pageA, sourceUrl: pageA };
  state.tab.url = pageA;
  state.prefillMedia = { ...fresh };
  await vm.runInContext('doMedia("asset:root")', sandbox);
  assert.equal(body.url, fresh.url);
  assert.equal(body.sourcePageUrl, pageA, "legacy resolver/auth context remains A");
  assert.equal(body.materialSourcePageUrl, workB, "provenance follows the revalidated B card");
  assert.equal(body.sourcePageKind, "work-page");
});

test("a video card link changed after prefill cannot silently retarget the saved work", async () => {
  const oldWork = "https://www.pinterest.com/pin/222222222222/";
  const changedWork = "https://www.pinterest.com/pin/333333333333/";
  const fresh = {
    type: "video", url: "https://media.test/card-b.mp4", capturedAt: Date.now() - 200,
    confidence: "browser-contextmenu", tabId: 11, frameId: 0,
    documentId: "doc-1", documentToken: "dtok-1", targetToken: "card-b",
    scrollX: 0, scrollY: 0, materialSourcePageUrl: changedWork,
  };
  let body;
  const { sandbox, state, apiCalls } = await videoPopupSandbox({
    candidates: [], mediaPayload: { videoUrl: fresh.url, descriptor: fresh },
    sourcePageSupported: true, transferBodyCapture: (value) => { body = value; },
  });
  state.page = { ...POPUP_PAGE };
  state.prefillMedia = { ...fresh, materialSourcePageUrl: oldWork };
  await vm.runInContext('doMedia("asset:root")', sandbox);
  assert.equal(body, undefined);
  assert.equal(apiCalls.filter((call) => call.path === "/api/media/transfers").length, 0);
});

test("popup video resolver pages never become work provenance without target binding", async () => {
  const pageA = "https://www.pinterest.com/pin/111111111111/?view=detail#clip-a";
  const fresh = {
    type: "video", url: "https://media.test/card-b.mp4", capturedAt: Date.now() - 200,
    confidence: "browser-contextmenu", tabId: 11, frameId: 0,
    documentId: "doc-1", documentToken: "dtok-1", targetToken: "card-b",
    scrollX: 0, scrollY: 0,
  };
  let prefillBody;
  const prefill = await videoPopupSandbox({
    candidates: [], mediaPayload: { pageUrl: pageA, videoUrl: fresh.url, descriptor: fresh },
    sourcePageSupported: true, transferBodyCapture: (value) => { prefillBody = value; },
  });
  prefill.state.page = { title: "Detail A", url: pageA, sourceUrl: pageA };
  prefill.state.tab.url = pageA;
  prefill.state.prefillMedia = { ...fresh };
  await vm.runInContext('doMedia("asset:root")', prefill.sandbox);
  assert.equal(prefillBody.sourcePageUrl, pageA);
  assert.equal(prefillBody.materialSourcePageUrl, pageA);
  assert.equal(prefillBody.sourcePageKind, "capture-page");

  let resolvedBody;
  const selected = await videoPopupSandbox({
    candidates: [candidateA3({ kind: "resolved_format", sourcePageUrl: pageA,
      probeId: "probe-1", formatId: "format-1", audioUrl: "" })],
    mediaPayload: { pageUrl: pageA }, sourcePageSupported: true,
    transferBodyCapture: (value) => { resolvedBody = value; },
  });
  selected.state.page = { title: "Detail A", url: pageA, sourceUrl: pageA };
  selected.state.tab.url = pageA;
  selected.state.videoCandidates = [candidateA3({ kind: "resolved_format", sourcePageUrl: pageA,
    probeId: "probe-1", formatId: "format-1", audioUrl: "" })];
  selected.state.selectedVideoUrl = selected.state.videoCandidates[0].url;
  selected.state.selectedVideoKey = vm.runInContext("candidateKey(state.videoCandidates[0])", selected.sandbox);
  selected.state.selectionRequiresPick = false;
  await vm.runInContext('doMedia("asset:root")', selected.sandbox);
  assert.equal(resolvedBody.sourcePageUrl, pageA);
  assert.equal(resolvedBody.materialSourcePageUrl, pageA);
  assert.equal(resolvedBody.sourcePageKind, "capture-page");
});

test("R3-B RED: a valid bound video prefill with an EMPTY candidate list must pass gate and commit once", async () => {
  const capture = { body: null };
  const freshDescriptor = {
    type: "video",
    url: "https://media.test/prefill-solo.mp4",
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
  const { sandbox, apiCalls } = await videoPopupSandbox({
    candidates: [],
    mediaPayload: { videoUrl: "https://media.test/prefill-solo.mp4", descriptor: freshDescriptor },
    transferBodyCapture: (body) => { capture.body = body; },
  });
  const state = vm.runInContext("state", sandbox);
  state.videoCandidates = [];
  state.selectedVideoUrl = "";
  state.selectedVideoKey = "";
  state.selectedVideoExplicit = false;
  state.selectionRequiresPick = false;
  state.prefillMedia = { ...freshDescriptor, type: "video" };
  await vm.runInContext('doMedia("asset:root")', sandbox);
  assert.equal(state.prefillMedia, null, "R3-B: a consumed prefill is cleared");
  const transfers = apiCalls.filter((c) => c.path === "/api/media/transfers");
  assert.equal(transfers.length, 1, "R3-B: gate and final Save agree for a bound prefill without list rows");
  assert.equal((capture.body || {}).url, "https://media.test/prefill-solo.mp4");
});

test("R3-B RED: video prefill with a descriptor of the WRONG type must zero-transfer", async () => {
  const capture = { body: null };
  const { sandbox, apiCalls, state } = await videoPopupSandbox({
    candidates: [],
    mediaPayload: {
      videoUrl: "https://media.test/prefill-x.mp4",
      descriptor: { type: "image", url: "https://media.test/prefill-x.mp4", capturedAt: Date.now() - 200, tabId: 11, frameId: 0, documentId: "doc-1", documentToken: "dtok-1", targetToken: "ttok-1", scrollX: 0, scrollY: 0 },
    },
    transferBodyCapture: (body) => { capture.body = body; },
  });
  state.prefillMedia = {
    type: "video",
    url: "https://media.test/prefill-x.mp4",
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
  await vm.runInContext('doMedia("asset:root")', sandbox);
  assert.equal(apiCalls.filter((c) => c.path === "/api/media/transfers").length, 0,
    "R3-B: a type-mismatched fresh descriptor must fail closed");
  assert.equal(state.prefillMedia, null);
});

// ---------------------------------------------------------------------------
// [BROWSER-EXT][EXT-R1-REPAIR-3] Contract D — visible gate and final write gate
// agree: no list candidate AND no valid prefill means Save disabled everywhere
// and final Save zero-write.

test("R3-D RED: no candidates and no prefill disables Save for asset and note destinations", async () => {
  const protocol = await loadProtocol();
  const ready = {
    port: 37420,
    readiness: { ready: true, code: "ready" },
    selection: {},
    videoSelection: { hasValidSelection: false, requiresPick: false },
  };
  for (const target of ["asset:root", "asset:pick", "asset:newFolder", "note:insertCurrent", "note:recent", "note:search", "note:new"]) {
    const gate = protocol.quickCollectSubmitGate({
      ...ready, target,
      selection: target.startsWith("note:") ? { selectedNoteId: "n1" } : {},
    });
    assert.equal(gate.canSubmit, false, `R3-D: no selection + no prefill must disable ${target}`);
    assert.match(gate.reason, /选择/, `R3-D: ${target} must carry a selection reason`);
  }
  // A provisionally valid bound video prefill re-enables the same destinations:
  const valid = protocol.quickCollectSubmitGate({
    ...ready, target: "note:insertCurrent", selection: { selectedNoteId: "n1" },
    videoSelection: { hasValidSelection: true, requiresPick: false, fromPrefill: true },
  });
  assert.equal(valid.canSubmit, true, "R3-D: a valid prefill selection re-enables a complete destination");
});

test("R3-D: final Save with no selection and no prefill produces zero writes", async () => {
  const capture = { body: null };
  const { sandbox, apiCalls } = await videoPopupSandbox({
    candidates: [],
    mediaPayload: {},
    transferBodyCapture: (body) => { capture.body = body; },
  });
  const state = vm.runInContext("state", sandbox);
  state.videoCandidates = [];
  state.selectedVideoUrl = "";
  state.selectedVideoKey = "";
  state.selectedVideoExplicit = false;
  state.selectionRequiresPick = false;
  state.prefillMedia = null;
  await vm.runInContext('doMedia("asset:root")', sandbox);
  assert.equal(apiCalls.filter((c) => c.path === "/api/media/transfers").length, 0,
    "R3-D: nothing selected means nothing transferred");
});
