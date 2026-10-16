// [BROWSER-EXT][EXT-R1-R1][P1-1] Context-menu image URL strict boundary — RED
// contract driven through the REAL background.js production call chain.
//
// Reviewer finding P1-1 (PR #105, exact head 941640d): a URL rejected by the
// strict image resolver can be revived by the looser normalizeUrl() inside
// chooseContextMenuMedia()/buildMaterialImportRequest() when the user clicks
// the browser context menu (info.srcUrl), reaching either the real import
// POST (/api/assets/import-media) or the popup prefill (chrome.storage.session).
//
// Contract (repair card §5-A):
//   1. Every image URL entering a context-menu candidate, popup payload or
//      material import request passes the same strict image sanitizer
//      (HTTP(S) only, no credentials, no blob/data/javascript, bounded
//      length, no control characters / backslash).
//   2. A rejected info.srcUrl must never be reconstructed by a looser
//      normalizer: context-menu root/pick/new-folder all fail closed with
//      ZERO transport POST and ZERO prefill write.
//   3. A valid separately revalidated bound descriptor still works.
//   4. Video URL semantics are unchanged (video menu paths keep their own
//      importability rules; this suite does not tighten them).

import assert from "node:assert/strict";
import test from "node:test";
import { loadBackgroundSandbox } from "./lib/background-script-sandbox.mjs";

const TAB = { id: 7, url: "https://page.test/article" };

const REJECTED_IMAGE_URLS = {
  blob: "blob:https://page.test/9f2c1d64-1",
  "credential-https": "https://user:secret@page.test/secret-image.png",
  "credential-http": "http://user:pass@page.test/image.jpg",
  overlong: `https://page.test/${"a".repeat(5000)}.png`,
  "control-char": "https://page.test/im\u0001age.png",
  backslash: "https://page.test\\..\\evil.png",
};

async function loadSandbox() {
  return await loadBackgroundSandbox({
    transportFetch: async () => ({
      ok: true,
      json: async () => ({ ok: true, data: { disposition: "imported", asset: { id: "a1", name: "x.png" } } }),
      text: async () => "",
    }),
  });
}

test("context-menu image root: rejected info.srcUrl produces zero transport POST (RED)", async () => {
  for (const [label, srcUrl] of Object.entries(REJECTED_IMAGE_URLS)) {
    const bg = await loadSandbox();
    await bg.contextMenuClick({ menuItemId: "luckyray-image-root", srcUrl }, TAB);
    const posts = bg.transportCalls.filter((call) => call.urlPath === "/api/assets/import-media");
    assert.equal(posts.length, 0, `P1-1 [${label}]: rejected srcUrl must never reach import-media via root menu`);
  }
});

test("context-menu image pick/new-folder: rejected info.srcUrl produces zero prefill write (RED)", async () => {
  for (const [label, srcUrl] of Object.entries(REJECTED_IMAGE_URLS)) {
    for (const menuId of ["luckyray-image-pick", "luckyray-image-new-folder"]) {
      const bg = await loadSandbox();
      await bg.contextMenuClick({ menuItemId: menuId, srcUrl }, TAB);
      assert.equal(bg.sessionStore.get("prefill"), undefined, `P1-1 [${label} via ${menuId}]: rejected srcUrl must never create a popup prefill`);
    }
  }
});

test("context-menu image pick/new-folder: rejected srcUrl still revives through the loose normalizer today (RED proof)", async () => {
  // Same production path as the tests above, but asserted positively: on the
  // parent head the loose normalizer DOES construct a browser-contextmenu
  // candidate from a credential-bearing URL. This test documents the revival
  // seam; it must flip to the fail-closed behavior after the fix, so it is
  // written as the inverse of the zero-prefill contract.
  const bg = await loadSandbox();
  await bg.contextMenuClick({ menuItemId: "luckyray-image-pick", srcUrl: REJECTED_IMAGE_URLS["credential-https"] }, TAB);
  const prefill = bg.sessionStore.get("prefill");
  assert.ok(!prefill, "P1-1: credential-bearing srcUrl must not create a prefill (GREEN: fail closed)");
});

test("context-menu image root: a valid strict URL still reaches the import path (RED keeps working path)", async () => {
  const bg = await loadSandbox();
  await bg.contextMenuClick({ menuItemId: "luckyray-image-root", srcUrl: "https://page.test/ok.png" }, TAB);
  const posts = bg.transportCalls.filter((call) => call.urlPath === "/api/assets/import-media");
  assert.equal(posts.length, 1, "valid context-menu image must still produce exactly one import request");
  const body = JSON.parse(posts[0].body || "{}");
  assert.equal(body.url, "https://page.test/ok.png");
  assert.equal(body.mediaType, "image");
});

test("buildMaterialImportRequest applies the strict image boundary to mediaType=image (RED)", async () => {
  const bg = await loadSandbox();
  const protocol = bg.protocol;
  for (const [label, url] of Object.entries(REJECTED_IMAGE_URLS)) {
    const request = protocol.buildMaterialImportRequest({ mediaType: "image", url, captureSource: "popup" });
    assert.equal(request, null, `P1-1 [${label}]: image import request must fail closed for rejected URLs`);
  }
  const videoBlob = protocol.buildMaterialImportRequest({ mediaType: "video", url: "blob:https://page.test/x", captureSource: "popup" });
  assert.ok(videoBlob, "video URL semantics are unchanged: blob video URLs keep their existing path");
});

test("chooseContextMenuMedia(image) uses the strict image sanitizer, never the loose one (RED)", async () => {
  const bg = await loadSandbox();
  const protocol = bg.protocol;
  for (const [label, url] of Object.entries(REJECTED_IMAGE_URLS)) {
    const candidate = protocol.chooseContextMenuMedia({ type: "image", infoUrl: url, descriptor: null });
    assert.equal(candidate, null, `P1-1 [${label}]: context-menu image candidate must fail closed`);
  }
  const valid = protocol.chooseContextMenuMedia({ type: "image", infoUrl: "https://page.test/ok.png", descriptor: null });
  assert.ok(valid && valid.url === "https://page.test/ok.png", "valid srcUrl must still produce a candidate");
});

// ---------------------------------------------------------------------------
// [BROWSER-EXT][EXT-R1-REPAIR-2] Contract E — toPopupMediaPayload("image", …)
// must reapply the strict image sanitizer before emitting any URL.

test("E: toPopupMediaPayload(image) rejects blob/credential/overlong descriptor URLs", async () => {
  const bg = await loadSandbox();
  const protocol = bg.protocol;
  for (const [label, url] of Object.entries(REJECTED_IMAGE_URLS)) {
    const payload = protocol.toPopupMediaPayload("image", { type: "image", url, capturedAt: Date.now(), tabId: 11 });
    assert.equal(payload.imageUrl, "", `E [${label}]: the popup payload must not emit a rejected image URL`);
    assert.equal(payload.descriptor, undefined, `E [${label}]: no descriptor may be exposed for a rejected URL`);
  }
  const ok = protocol.toPopupMediaPayload("image", { type: "image", url: "https://page.test/ok.png", capturedAt: Date.now(), tabId: 11 });
  assert.equal(ok.imageUrl, "https://page.test/ok.png");
  assert.ok(ok.descriptor && ok.descriptor.url === "https://page.test/ok.png", "E: a valid descriptor stays bounded and exposed");
});

// ---------------------------------------------------------------------------
// [BROWSER-EXT][EXT-R1-REPAIR-3] Contract C — real background video
// pick/new-folder must obtain the CURRENT content-side bound descriptor even
// when info.srcUrl exists; srcUrl may only cross-check; no bound descriptor =>
// zero prefill. The immediate video-root path stays unchanged.

function videoPopupSandboxStub(contentVideoResponse) {
  return async (message) => {
    if (message?.type === "luckyray-get-hover-video") return contentVideoResponse;
    return {};
  };
}

function boundVideoDescriptor(overrides = {}) {
  return {
    url: "https://media.test/video.mp4",
    type: "video",
    capturedAt: Date.now(),
    confidence: "contextmenu",
    tabId: 7,
    frameId: 0,
    documentId: "video-document-1",
    documentToken: "video-document-token-1",
    targetToken: "video-target-token-1",
    scrollX: 0,
    scrollY: 0,
    ...overrides,
  };
}

test("R3-C RED: video pick with info.srcUrl + matching bound descriptor creates ONE bound prefill", async () => {
  const bg = await loadBackgroundSandbox({
    contentResponse: videoPopupSandboxStub(boundVideoDescriptor()),
  });
  // contentReceiver.request goes through chrome.tabs.sendMessage; stub it on
  // the sandbox chrome so the real getBestContextVideo path runs:
  bg.sandbox.chrome.tabs.sendMessage = async () => boundVideoDescriptor();
  await bg.contextMenuClick(
    { menuItemId: "luckyray-video-pick", srcUrl: "https://media.test/video.mp4" },
    { id: 7, url: "https://media.test/watch" },
  );
  const prefill = bg.sessionStore.get("prefill");
  assert.ok(prefill, "R3-C: a matching bound descriptor must create a prefill");
  assert.equal(prefill.mediaDescriptor?.confidence, "contextmenu",
    "R3-C: the stored prefill is the BOUND descriptor, not an unbound browser-contextmenu candidate");
});

test("R3-C RED: video pick with info.srcUrl and NO bound descriptor must zero-prefill", async () => {
  const bg = await loadBackgroundSandbox({
    contentResponse: videoPopupSandboxStub({}),
  });
  bg.sandbox.chrome.tabs.sendMessage = async () => ({});
  await bg.contextMenuClick(
    { menuItemId: "luckyray-video-pick", srcUrl: "https://media.test/video.mp4" },
    { id: 7, url: "https://media.test/watch" },
  );
  assert.equal(bg.sessionStore.get("prefill"), undefined,
    "R3-C: no bound descriptor means no delayed prefill even with a browser srcUrl");
});

test("R3-C RED: video pick with srcUrl MISMATCHING the bound descriptor must zero-prefill", async () => {
  const bg = await loadBackgroundSandbox({
    contentResponse: videoPopupSandboxStub(boundVideoDescriptor({ url: "https://media.test/other.mp4" })),
  });
  bg.sandbox.chrome.tabs.sendMessage = async () => boundVideoDescriptor({ url: "https://media.test/other.mp4" });
  await bg.contextMenuClick(
    { menuItemId: "luckyray-video-new-folder", srcUrl: "https://media.test/video.mp4" },
    { id: 7, url: "https://media.test/watch" },
  );
  assert.equal(bg.sessionStore.get("prefill"), undefined,
    "R3-C: srcUrl must cross-check against the bound descriptor; mismatch fails closed");
});

test("R3-C: the immediate video-root path keeps its existing behavior", async () => {
  const bg = await loadBackgroundSandbox({
    contentResponse: videoPopupSandboxStub({}),
  });
  await bg.contextMenuClick(
    { menuItemId: "luckyray-video-root", srcUrl: "https://media.test/video.mp4" },
    { id: 7, url: "https://media.test/watch" },
  );
  const posts = bg.transportCalls.filter((call) => call.urlPath === "/api/media/transfers");
  assert.equal(posts.length, 1, "the immediate root action must start exactly one real transfer request");
  assert.equal(JSON.parse(posts[0].body).url, "https://media.test/video.mp4");
  assert.equal(bg.sessionStore.get("prefill"), undefined, "root never creates a prefill");
});

test("R4-C RED: video descriptor/popup boundaries reject credentials, controls and oversized URLs", async () => {
  const bg = await loadSandbox();
  const protocol = bg.protocol;
  for (const [label, url] of Object.entries({
    credentials: "https://user:secret@media.test/video.mp4",
    control: "https://media.test/vid\u0001eo.mp4",
    backslash: "https://media.test\\..\\video.mp4",
    oversized: `https://media.test/${"v".repeat(5000)}.mp4`,
  })) {
    assert.equal(protocol.createCaptureDescriptor({ type: "video", url }), null, `${label}: capture descriptor`);
    const payload = protocol.toPopupMediaPayload("video", { type: "video", url });
    assert.equal(payload.videoUrl, "", `${label}: popup URL`);
    assert.equal(payload.descriptor, undefined, `${label}: popup descriptor`);
  }
});

test("R4-D RED: two unbound descriptors can never compare as the same commit target", async () => {
  const bg = await loadSandbox();
  const protocol = bg.protocol;
  const capturedAt = Date.now() - 50;
  const unbound = { type: "video", url: "https://media.test/video.mp4", capturedAt };
  assert.equal(protocol.mediaPrefillIdentity(unbound, "video"), null, "unbound identity must not exist");
  assert.equal(protocol.sameMediaPrefillIdentity(unbound, { ...unbound }, "video"), false,
    "matching null binding fields must never authorize a commit");
});

test("concurrent video root clicks share one transfer request", async () => {
  const bg = await loadBackgroundSandbox({ contentResponse: videoPopupSandboxStub({}) });
  const info = { menuItemId: "luckyray-video-root", srcUrl: "https://media.test/video.mp4" };
  const tab = { id: 7, url: "https://media.test/watch" };
  await Promise.all([bg.contextMenuClick(info, tab), bg.contextMenuClick(info, tab)]);
  assert.equal(bg.transportCalls.filter((call) => call.urlPath === "/api/media/transfers").length, 1);
});
