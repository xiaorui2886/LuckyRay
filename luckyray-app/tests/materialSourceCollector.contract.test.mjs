import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { loadContentScriptSandbox, loadPopupSandbox, makeDomElement } from "./lib/content-script-sandbox.mjs";
import { loadBackgroundSandbox } from "./lib/background-script-sandbox.mjs";

const pageUrl = "https://feed.test/gallery?tab=favorites#today";
const workA = "https://works.test/item/a?work=42#slide-3";
const workB = "https://works.test/item/b?work=99#slide-1";
const imageA = "https://cdn.test/a.png?size=large";
const imageB = "https://cdn.test/b.png?size=large";

function cardImage(sandbox, imageUrl, workUrl) {
  const anchor = { href: workUrl, getAttribute(name) { return name === "href" ? this.href : null; } };
  const image = new sandbox.HTMLImageElement();
  Object.assign(image, {
    tagName: "IMG", currentSrc: imageUrl, src: imageUrl, srcset: "",
    isConnected: true, parentElement: null,
    getAttribute: () => "", querySelectorAll: () => [],
    closest: (selector) => selector === "a[href]" ? anchor : null,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 300, bottom: 200, width: 300, height: 200 }),
  });
  return { image, anchor };
}

function hover(documentListeners, target) {
  for (const listener of documentListeners.get("mousemove") || []) {
    listener({ clientX: 50, clientY: 50, target });
  }
}

function readHover(runtimeListeners) {
  let response = null;
  for (const listener of runtimeListeners) {
    listener({ type: "luckyray-get-hover-image" }, {}, (value) => { response = value; });
  }
  return response;
}

test("source navigation keeps work parameters but rejects signed media and secret-bearing pages", async () => {
  const { sandbox } = await loadContentScriptSandbox();
  const normalize = sandbox.LuckyRayExtensionProtocol.normalizeSourcePageUrl;
  assert.equal(normalize(workA), workA);
  assert.equal(normalize("https://works.test/item/a?work=42&view=detail#slide-3"),
    "https://works.test/item/a?work=42&view=detail#slide-3");
  assert.equal(normalize("https://works.test/#/work/42?item=7"),
    "https://works.test/#/work/42?item=7");
  for (const unsafe of [
    "javascript:alert(1)", "https://user:pass@works.test/item/a",
    "https://cdn.test/a.png?size=large", "https://works.test/item/a?token=SECRET",
    "https://works.test/item/a#access_token=SECRET",
    "https://works.test/#/work/42?token=SECRET",
    "https://works.test/#/work/42%3Faccess_token%3DSECRET",
  ]) assert.equal(normalize(unsafe), "", unsafe);
  assert.equal(sandbox.LuckyRayExtensionProtocol.normalizeBoundWorkPageUrl("https://works.test/"), "");
  assert.equal(sandbox.LuckyRayExtensionProtocol.normalizeBoundWorkPageUrl("https://works.test/search?q=a"), "");
  assert.equal(sandbox.LuckyRayExtensionProtocol.normalizeBoundWorkPageUrl("https://works.test/profile/alice"), "");
  assert.equal(sandbox.LuckyRayExtensionProtocol.normalizeBoundWorkPageUrl("https://works.test/ads/campaign"), "");
  assert.equal(sandbox.LuckyRayExtensionProtocol.normalizeBoundWorkPageUrl(workA), workA);
});

test("an image linked only to a site homepage does not acquire a fake work URL", async () => {
  const content = await loadContentScriptSandbox();
  content.sandbox.location.href = pageUrl;
  const card = cardImage(content.sandbox, imageA, "https://works.test/");
  content.sandbox.document.elementsFromPoint = () => [card.image];
  vm.runInContext(content.contentSource, content.sandbox, { filename: "content-script.js" });
  hover(content.documentListeners, card.image);
  const captured = readHover(content.runtimeListeners);
  assert.equal(captured.url, imageA);
  assert.equal(captured.linkUrl, null);
});

test("sibling image links bind only within their own explicit card and navigation invalidates capture", async () => {
  const content = await loadContentScriptSandbox();
  content.sandbox.location.href = pageUrl;
  const a = cardImage(content.sandbox, imageA, workA);
  const b = cardImage(content.sandbox, imageB, workB);
  const card = (item) => ({
    tagName: "ARTICLE", parentElement: null,
    getAttribute: () => null,
    querySelectorAll: (selector) => selector === "a[href]" ? [item.anchor]
      : selector === "img,video" ? [item.image] : [],
  });
  a.image.closest = () => null;
  b.image.closest = () => null;
  a.image.parentElement = card(a);
  b.image.parentElement = card(b);
  content.sandbox.document.elementsFromPoint = () => [a.image];
  vm.runInContext(content.contentSource, content.sandbox, { filename: "content-script.js" });
  hover(content.documentListeners, a.image);
  assert.equal(readHover(content.runtimeListeners).linkUrl, workA);
  content.sandbox.document.elementsFromPoint = () => [b.image];
  hover(content.documentListeners, b.image);
  assert.equal(readHover(content.runtimeListeners).linkUrl, workB);
  content.sandbox.location.href = "https://feed.test/next";
  assert.equal(readHover(content.runtimeListeners)?.url, undefined);
});

test("a video without a card link cannot borrow the neighboring card's only work URL", async () => {
  for (const { currentPage, ownLink, noCard, expectedKind, expectedPage, expectedResolver } of [
    { currentPage: "https://www.pinterest.com/feed/", ownLink: false,
      expectedKind: "capture-page", expectedPage: "https://www.pinterest.com/feed/", expectedResolver: "" },
    { currentPage: "https://www.pinterest.com/pin/123456789/?view=detail#comments", ownLink: false,
      expectedKind: "capture-page", expectedPage: "https://www.pinterest.com/pin/123456789/?view=detail#comments", expectedResolver: "" },
    { currentPage: "https://www.pinterest.com/pin/123456789/?view=detail#comments", ownLink: true,
      expectedKind: "work-page", expectedPage: "https://www.pinterest.com/pin/987654321/?view=grid#comments",
      expectedResolver: "https://www.pinterest.com/pin/987654321/" },
    { currentPage: "https://www.youtube.com/watch?v=fixture123&t=35#clip", ownLink: false, noCard: true,
      expectedKind: "capture-page", expectedPage: "https://www.youtube.com/watch?v=fixture123&t=35#clip",
      expectedResolver: "https://www.youtube.com/watch?v=fixture123" },
    { currentPage: "https://www.bilibili.com/video/BV1xx411c7mD/?p=2#reply", ownLink: false, noCard: true,
      expectedKind: "capture-page", expectedPage: "https://www.bilibili.com/video/BV1xx411c7mD/?p=2#reply",
      expectedResolver: "https://www.bilibili.com/video/BV1xx411c7mD/" },
  ]) {
  const content = await loadContentScriptSandbox(async (message) =>
    message.type === "luckyray-video-overlay-open" ? { ok: true, items: [], canRecord: true } : {});
  content.sandbox.location.href = currentPage;
  const nodes = [];
  content.sandbox.document.createElement = (tag) => {
    const node = makeDomElement(tag);
    nodes.push(node);
    return node;
  };
  const video = new content.sandbox.HTMLVideoElement();
  Object.assign(video, {
    tagName: "VIDEO", currentSrc: "https://v1.pinimg.com/videos/a.mp4",
    src: "https://v1.pinimg.com/videos/a.mp4", isConnected: true,
    type: "video/mp4", videoWidth: 600, videoHeight: 400, duration: 12,
    getAttribute: () => "", querySelectorAll: () => [], querySelector: () => null,
    closest: () => null,
    getBoundingClientRect: () => ({ left: 10, top: 10, right: 610, bottom: 410, width: 600, height: 400 }),
  });
  const neighbor = { href: "https://www.pinterest.com/pin/987654321/?view=grid#comments" };
  const grid = { tagName: "DIV", parentElement: null,
    getAttribute: () => null,
    querySelectorAll: (selector) => selector === "a[href]" ? [neighbor] : [video],
  };
  const ownCard = { tagName: "ARTICLE", parentElement: grid,
    getAttribute: () => null,
    querySelectorAll: (selector) => selector === "img,video" ? [video]
      : selector === "a[href]" && ownLink ? [neighbor] : [],
  };
  video.parentElement = noCard ? null : ownCard;
  content.sandbox.document.querySelectorAll = (selector) => selector === "video" ? [video] : [];
  content.sandbox.document.elementsFromPoint = () => [video];
  vm.runInContext(content.contentSource, content.sandbox, { filename: "content-script.js" });
  if (ownLink) {
    content.sandbox.document.addEventListener("__luckyray_pinterest_detail_request_v1__", (event) => {
      content.sandbox.document.dispatchEvent(new content.sandbox.CustomEvent("__luckyray_page_media_probe_v1__", {
        detail: { version: 1, kind: "pinterest-video-catalog", requestId: event.detail.requestId,
          pinId: "987654321", pageUrl: "https://www.pinterest.com/pin/987654321/",
          variants: [{ url: "https://v1.pinimg.com/videos/b_720w.mp4", width: 720, height: 480 }] },
      }));
    });
  }
  for (const listener of content.documentListeners.get("mousemove") || []) {
    listener({ clientX: 100, clientY: 100, target: video });
  }
  let hoveredVideo = null;
  for (const listener of content.runtimeListeners) {
    listener({ type: "luckyray-get-hover-video" }, {}, (value) => { hoveredVideo = value; });
  }
  assert.equal(hoveredVideo?.materialSourcePageUrl || null,
    ownLink ? "https://www.pinterest.com/pin/987654321/?view=grid#comments" : null);
  if (ownLink) {
    assert.equal(content.sandbox.LuckyRayExtensionProtocol.toPopupMediaPayload("video", hoveredVideo)
      .descriptor.materialSourcePageUrl, hoveredVideo.materialSourcePageUrl);
  }
  const chip = nodes.find((node) => node.className === "lr-chip");
  assert.ok(chip);
  chip.dispatch("click", { preventDefault() {}, stopPropagation() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const opened = content.runtimeMessages.find((message) => message.type === "luckyray-video-overlay-open");
  assert.ok(opened);
  assert.equal(opened.sourcePageKind, expectedKind);
  assert.equal(opened.sourcePageUrl, expectedPage);
  assert.equal(opened.resolverPageUrl, expectedResolver);
  }
});

test("background keeps detail A as capture-page when selected video B has no matching work binding", async () => {
  const background = await loadBackgroundSandbox();
  const pageA = "https://www.pinterest.com/pin/123456789/?view=detail#comments";
  const pageB = "https://www.pinterest.com/pin/987654321/?view=grid#comments";
  background.sandbox.__sourceRequest = {
    pageUrl: pageA, sourcePageUrl: pageA, sourcePageKind: "capture-page",
    resolverPageUrl: "https://www.pinterest.com/pin/987654321/", playerContext: true,
  };
  const capture = await vm.runInContext("createVideoMenuSession(1, 0, null, __sourceRequest)", background.sandbox);
  assert.equal(capture.ok, true);
  background.sandbox.__sessionId = capture.sessionId;
  let stored = vm.runInContext("videoMenuSessions.get(__sessionId)", background.sandbox);
  assert.equal(stored.sourcePageUrl, pageA);
  assert.equal(stored.sourcePageKind, "capture-page");
  background.sandbox.__sourceRequest = {
    pageUrl: pageA, sourcePageUrl: pageB, sourcePageKind: "work-page",
    resolverPageUrl: "https://www.pinterest.com/pin/987654321/", playerContext: true,
  };
  const bound = await vm.runInContext("createVideoMenuSession(1, 0, null, __sourceRequest)", background.sandbox);
  assert.equal(bound.ok, true);
  background.sandbox.__sessionId = bound.sessionId;
  stored = vm.runInContext("videoMenuSessions.get(__sessionId)", background.sandbox);
  assert.equal(stored.sourcePageUrl, pageB);
  assert.equal(stored.sourcePageKind, "work-page");
});

test("video context-menu direct save does not borrow stale B work for same-URL card C", async () => {
  const pageA = "https://www.pinterest.com/pin/111111111111/?view=detail#clip-a";
  const pageB = "https://www.pinterest.com/pin/222222222222/?view=card#clip-b";
  const videoB = "https://v1.pinimg.com/videos/card-b.mp4";
  const background = await loadBackgroundSandbox();
  const staleB = {
    type: "video", url: videoB, capturedAt: Date.now(), confidence: "contextmenu",
    tabId: 7, frameId: 0, documentId: "document-a",
    documentToken: "doc-a", targetToken: "video-b", scrollX: 0, scrollY: 0,
    materialSourcePageUrl: pageB,
  };
  background.sandbox.__staleB = staleB;
  vm.runInContext('rememberCapture(7, "video", LuckyRayExtensionProtocol.createCaptureDescriptor(__staleB))', background.sandbox);
  background.sandbox.chrome.tabs.sendMessage = async () => staleB;
  vm.runInContext("supportsMaterialSourcePage = async () => true", background.sandbox);
  await background.contextMenuClick(
    // This browser srcUrl also belongs to card C; only stale B's descriptor
    // was received. Same URL alone must never prove which card was clicked.
    { menuItemId: "luckyray-video-root", srcUrl: videoB },
    { id: 7, url: pageA, title: "Detail A" },
  );
  const transfers = background.transportCalls.filter((call) => call.urlPath === "/api/media/transfers");
  assert.equal(transfers.length, 1);
  const body = JSON.parse(transfers[0].body);
  assert.equal(body.url, videoB);
  assert.equal(body.sourcePageUrl, pageA, "resolver/auth stays on the capture tab");
  assert.equal(body.materialSourcePageUrl, pageA);
  assert.equal(body.sourcePageKind, "capture-page", "the same media URL cannot prove B is the clicked card");
  await background.contextMenuClick(
    { menuItemId: "luckyray-video-root", srcUrl: "https://v1.pinimg.com/videos/other-c.mp4" },
    { id: 7, url: pageA, title: "Detail A" },
  );
  const allTransfers = background.transportCalls.filter((call) => call.urlPath === "/api/media/transfers");
  assert.equal(allTransfers.length, 2, "the immediate browser-media fallback still saves");
  const mismatched = JSON.parse(allTransfers[1].body);
  assert.equal(mismatched.materialSourcePageUrl, pageA);
  assert.equal(mismatched.sourcePageKind, "capture-page", "a different browser target cannot borrow B's work page");
});

test("rapid hover between two cards sharing one video URL updates the selected work binding", async () => {
  const content = await loadContentScriptSandbox();
  content.sandbox.location.href = "https://www.pinterest.com/feed/";
  content.sandbox.document.createElement = (tag) => makeDomElement(tag);
  const sharedVideo = "https://v1.pinimg.com/videos/shared.mp4";
  const makeVideo = (workUrl) => {
    const video = new content.sandbox.HTMLVideoElement();
    const anchor = { href: workUrl };
    const card = { tagName: "ARTICLE", parentElement: null, getAttribute: () => null,
      querySelectorAll: (selector) => selector === "img,video" ? [video]
        : selector === "a[href]" ? [anchor] : [] };
    Object.assign(video, {
      tagName: "VIDEO", currentSrc: sharedVideo, src: sharedVideo, isConnected: true,
      parentElement: card, getAttribute: () => "", querySelectorAll: () => [], querySelector: () => null,
      closest: () => null,
      getBoundingClientRect: () => ({ left: 10, top: 10, right: 600, bottom: 400, width: 590, height: 390 }),
    });
    return video;
  };
  const b = makeVideo("https://www.pinterest.com/pin/222222222222/?v=b#work");
  const c = makeVideo("https://www.pinterest.com/pin/333333333333/?v=c#work");
  let current = b;
  content.sandbox.document.querySelectorAll = (selector) => selector === "video" ? [b, c] : [];
  content.sandbox.document.elementsFromPoint = () => [current];
  vm.runInContext(content.contentSource, content.sandbox, { filename: "content-script.js" });
  const move = () => {
    for (const listener of content.documentListeners.get("mousemove") || []) {
      listener({ clientX: 50, clientY: 50, target: current });
    }
  };
  const read = () => {
    let response = null;
    for (const listener of content.runtimeListeners) {
      listener({ type: "luckyray-get-hover-video" }, {}, (value) => { response = value; });
    }
    return response;
  };
  move();
  const first = read();
  assert.equal(first.materialSourcePageUrl, "https://www.pinterest.com/pin/222222222222/?v=b#work");
  current = c;
  move();
  const second = read();
  assert.equal(second.url, sharedVideo);
  assert.notEqual(second.targetToken, first.targetToken);
  assert.equal(second.materialSourcePageUrl, "https://www.pinterest.com/pin/333333333333/?v=c#work");
});

test("tab recording of related video B never labels detail A as B's work page", async () => {
  const background = await loadBackgroundSandbox();
  const pageA = "https://www.pinterest.com/pin/123456789/?view=detail#comments";
  const pageB = "https://www.pinterest.com/pin/987654321/?view=grid#comments";
  vm.runInContext(`
    recordingState.active = true;
    recordingState.recordingId = "record-b";
    recordingState.tabId = 1;
    recordingState.pageUrl = "https://www.pinterest.com";
    recordingState.sourcePageUrl = ${JSON.stringify(pageA)};
    recordingState.pageTitle = "Detail A with related video B";
    recordingState.startedAt = Date.now();
    lastWorkingPort = 37420;
    sendOffscreenMessage = async () => ({ ok: true, base64: "dGVzdA==" });
    supportsMaterialSourcePage = async () => true;
  `, background.sandbox);
  const result = await vm.runInContext("stopRecordingAndSaveOnce()", background.sandbox);
  assert.equal(result.ok, true);
  const saves = background.transportCalls.filter((call) => call.urlPath === "/api/video/record/save");
  assert.equal(saves.length, 1);
  const body = JSON.parse(saves[0].body);
  assert.equal(body.sourcePageUrl, pageA);
  assert.equal(body.sourcePageKind, "capture-page");
  assert.notEqual(body.sourcePageUrl, pageB);
});

test("selected card A keeps its exact work URL through real content capture, popup commit, and old-desktop negotiation", async () => {
  const content = await loadContentScriptSandbox();
  content.sandbox.location.href = pageUrl;
  const a = cardImage(content.sandbox, imageA, workA);
  const b = cardImage(content.sandbox, imageB, workB);
  content.sandbox.document.elementsFromPoint = () => [a.image];
  vm.runInContext(content.contentSource, content.sandbox, { filename: "content-script.js" });
  hover(content.documentListeners, a.image);
  const captured = readHover(content.runtimeListeners);
  assert.equal(captured.url, imageA);
  assert.equal(captured.linkUrl, workA);
  assert.notEqual(captured.linkUrl, workB);

  // A changed card anchor is not allowed to lend B's URL to A's image.
  a.anchor.href = workB;
  assert.equal(readHover(content.runtimeListeners)?.url, undefined);
  a.anchor.href = workA;
  hover(content.documentListeners, a.image);
  const fresh = readHover(content.runtimeListeners);
  assert.equal(fresh.linkUrl, workA);
  const mediaPayload = {
    ...content.sandbox.LuckyRayExtensionProtocol.toPopupMediaPayload("image", fresh),
    pageUrl,
  };
  assert.equal(mediaPayload.descriptor.linkUrl, workA);
  assert.notEqual(mediaPayload.imageUrl, b.image.currentSrc);

  let supported = true;
  const requests = [];
  const popup = await loadPopupSandbox(async (message) => {
    if (message?.type === "luckyray-popup-get-media") return mediaPayload;
    if (message?.type === "luckyray-source-page-capability") return { supported };
    return {};
  });
  const state = vm.runInContext("state", popup.sandbox);
  state.port = 37420;
  state.tab = { id: 11, url: pageUrl, title: "Gallery" };
  state.type = "image";
  state.page = { title: "Gallery", url: pageUrl, sourceUrl: pageUrl };
  popup.sandbox.__lrFetch = async (_port, route, options) => {
    if (route === "/api/assets/import-media") requests.push(JSON.parse(options.body));
    return {
      ok: true,
      text: async () => JSON.stringify({
        ok: true, disposition: "imported",
        asset: { id: "asset-a", name: "a.png", kind: "image" },
      }),
    };
  };
  vm.runInContext("LuckyRayLocalTransport = { fetch: (...args) => globalThis.__lrFetch(...args) };", popup.sandbox);
  await vm.runInContext('doMedia("asset:root")', popup.sandbox);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, imageA);
  assert.equal(requests[0].sourcePageUrl, workA);
  assert.equal(requests[0].sourcePageKind, "work-page");
  assert.equal(Object.hasOwn(requests[0], "sourcePageTitle"), false, "feed title is not the work title");
  assert.notEqual(requests[0].sourcePageUrl, imageA);

  supported = false;
  await vm.runInContext('doMedia("asset:root")', popup.sandbox);
  assert.equal(requests.length, 2, "unsupported provenance must not retry a write");
  assert.equal(requests[1].url, imageA, "old desktop still receives media");
  assert.equal(Object.hasOwn(requests[1], "sourcePageUrl"), false);
  assert.equal(Object.hasOwn(requests[1], "sourcePageKind"), false);
});
