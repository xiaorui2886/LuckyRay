import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { loadContentScriptSandbox } from "./lib/content-script-sandbox.mjs";

async function loadProtocol() {
  const source = await readFile(new URL("../browser-extension-prototype/extension-protocol.js", import.meta.url), "utf8");
  const sandbox = { URL, setTimeout, clearTimeout };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: "extension-protocol.js" });
  return sandbox.LuckyRayExtensionProtocol;
}

test("canonical import results distinguish imported, duplicate, partial, and malformed success", async () => {
  const protocol = await loadProtocol();
  const asset = { id: "asset-1", name: "hero.png", folderId: null, storageMode: "managed" };

  assert.equal(
    JSON.stringify(protocol.parseMaterialImportResponse({ ok: true, data: { disposition: "imported", asset } })),
    JSON.stringify({ ok: true, disposition: "imported", asset }),
  );
  assert.equal(
    JSON.stringify(protocol.parseMaterialImportResponse({ ok: true, data: { disposition: "duplicate", asset } })),
    JSON.stringify({ ok: true, disposition: "duplicate", asset }),
  );
  assert.equal(protocol.parseMaterialImportResponse({
    ok: true,
    data: { disposition: "partial", asset, failedCount: 1 },
  }).ok, false);
  assert.equal(protocol.parseMaterialImportResponse({ ok: true, data: {} }).code, "canonical-result-missing");
});

test("extension media payload uses the canonical folder and media fields without legacy drift", async () => {
  const protocol = await loadProtocol();
  const request = protocol.buildMaterialImportRequest({
    mediaType: "video",
    url: "https://cdn.test/movie.mp4",
    targetFolderId: "folder-7",
    newFolderName: "ignored only by caller choice",
    parentFolderId: "parent-2",
    requestId: "action-9",
    captureSource: "hover",
    folderId: "legacy-must-not-leak",
    storageMode: "source",
    kind: "document",
    sourceUrl: "https://wrong.test",
  });
  assert.equal(JSON.stringify(request), JSON.stringify({
    mediaType: "video",
    url: "https://cdn.test/movie.mp4",
    targetFolderId: "folder-7",
    newFolderName: "ignored only by caller choice",
    parentFolderId: "parent-2",
    requestId: "action-9",
    captureSource: "hover",
  }));
});

test("material download diagnostics are readable and never expose the raw error envelope", async () => {
  const protocol = await loadProtocol();
  const failure = {
    ok: false,
    error: {
      code: "adapter-request-failed",
      message: "Local operation failed",
      details: {
        reason: "network",
        category: "connect",
        source: "hover",
        fingerprint: "a1b2c3d4e5f6",
        clientRequestId: "action-9",
      },
    },
    requestId: "lr-safe-request-24",
  };

  const formatted = protocol.formatMaterialImportFailure(failure, "image");

  assert.equal(formatted.handled, true);
  assert.match(formatted.message, /图片下载失败（连接阶段）/);
  assert.match(formatted.message, /可打开原图后重试/);
  assert.match(formatted.message, /hover · a1b2c3d4e5f6 · lr-safe-request-24/);
  assert.doesNotMatch(formatted.message, /Local operation failed|\{|\}/);
});

test("unknown material failures remain visible without dumping JSON", async () => {
  const protocol = await loadProtocol();
  const formatted = protocol.formatMaterialImportFailure({
    ok: false,
    error: { code: "unexpected", message: "C:\\private\\raw-path" },
    requestId: "lr-unknown-1",
  }, "video");

  assert.equal(formatted.handled, false);
  assert.equal(formatted.message, "视频保存失败，请稍后重试 · 诊断 lr-unknown-1");
  assert.doesNotMatch(formatted.message, /private|raw-path|\{|\}/);
});

test("video transfer maps media-needs-recording to a fixed actionable message", async () => {
  const protocol = await loadProtocol();
  assert.deepEqual(
    JSON.parse(JSON.stringify(protocol.formatMaterialImportFailure({ code: "media-needs-recording" }, "video"))),
    { handled: true, message: "该视频需要录制后才能入库。" },
  );
});

test("YouTube PO Token failures use a fixed actionable message", async () => {
  const protocol = await loadProtocol();
  assert.deepEqual(
    JSON.parse(JSON.stringify(protocol.formatMaterialImportFailure({ code: "media-youtube-token-required" }, "video"))),
    { handled: true, message: "YouTube 当前要求站点会话与 PO Token；已授权后仍失败的视频暂不可直接入库。" },
  );
});

test("resolver diagnostics expose only fixed site failure guidance", async () => {
  const protocol = await loadProtocol();
  const expected = new Map([
    ["media-authentication-required", "当前视频需要站点登录授权；请确认已登录并允许 LuckyRay 访问该站点。"],
    ["media-site-blocked", "视频网站拒绝了当前解析请求；请刷新页面或稍后重试。"],
    ["media-region-restricted", "该视频受地区限制，当前无法入库。"],
    ["media-drm-protected", "该视频受 DRM 保护，LuckyRay 不会绕过保护。"],
    ["media-no-formats", "站点没有提供可下载的视频格式；该内容可能已下架、受限或需要 PO Token。"],
  ]);
  for (const [code, message] of expected) {
    assert.deepEqual(
      JSON.parse(JSON.stringify(protocol.formatMaterialImportFailure({ code, raw: "PRIVATE" }, "video"))),
      { handled: true, message },
    );
  }
});

test("supported social-video links normalize card-specific routes without preserving feed state", async () => {
  const protocol = await loadProtocol();
  assert.equal(
    protocol.normalizeSupportedVideoPageUrl("https://x.com/example/status/1234567890/video/1?ref_src=PRIVATE"),
    "https://x.com/example/status/1234567890",
  );
  assert.equal(
    protocol.normalizeSupportedVideoPageUrl("https://www.pinterest.com/pin/222222222222/?utm_source=PRIVATE"),
    "https://www.pinterest.com/pin/222222222222/",
  );
  assert.equal(
    protocol.normalizeSupportedVideoPageUrl("https://www.pinterest.com/pin/quiet-lake-video--333333333333/?utm_source=PRIVATE"),
    "https://www.pinterest.com/pin/333333333333/",
  );
  assert.equal(protocol.normalizeSupportedVideoPageUrl("https://x.com/home"), "");
});

test("a player card resolves its own supported page instead of the surrounding feed", async () => {
  const protocol = await loadProtocol();
  assert.equal(
    protocol.chooseBoundVideoPageUrl(
      "https://www.bilibili.com/",
      ["https://www.bilibili.com/video/BV1xx411c7mD?spm_id_from=PRIVATE"],
    ),
    "https://www.bilibili.com/video/BV1xx411c7mD",
  );
  assert.equal(
    protocol.chooseBoundVideoPageUrl(
      "https://www.youtube.com/",
      ["https://www.youtube.com/watch?v=fixture123&list=PRIVATE"],
    ),
    "https://www.youtube.com/watch?v=fixture123",
  );
  assert.equal(
    protocol.chooseBoundVideoPageUrl("https://www.bilibili.com/video/BV1xx411c7mD", []),
    "https://www.bilibili.com/video/BV1xx411c7mD",
  );
  assert.equal(
    protocol.chooseBoundVideoPageUrl("https://www.pinterest.com/pin/111111111111/", []),
    "",
  );
});

test("point targeting uses the exact stacked media and only upgrades within that element", async () => {
  const protocol = await loadProtocol();
  const overlay = { tagName: "DIV", rect: { left: 0, top: 0, right: 200, bottom: 200 } };
  const left = {
    tagName: "IMG",
    currentSrc: "https://cdn.test/left-rendered.jpg",
    src: "https://cdn.test/left-fallback.jpg",
    srcset: "https://cdn.test/left-small.jpg 1x, https://cdn.test/left-large.jpg 2x",
    dataFull: "https://cdn.test/not-the-rendered-image.jpg",
    rect: { left: 0, top: 0, right: 99, bottom: 100 },
  };
  const right = {
    tagName: "IMG",
    currentSrc: "https://cdn.test/right.jpg",
    rect: { left: 101, top: 0, right: 200, bottom: 100 },
  };

  // M1-S3 PRODUCT-DIRECTION: within the same target the best-quality safe
  // candidate wins (allowlisted same-element original attribute beats the
  // displayed tier); the sibling/adjacent element is never consulted.
  assert.equal(protocol.selectPointMedia("image", 50, 50, [overlay, left, right]).url, left.dataFull);
  assert.equal(protocol.selectPointMedia("image", 100, 50, [overlay, left, right]), null);
  assert.equal(protocol.selectPointMedia("image", 150, 50, [overlay, left, right]).url, right.currentSrc);
});

test("the selected image element upgrades to its strongest bounded srcset candidate", async () => {
  const protocol = await loadProtocol();
  const image = {
    tagName: "IMG",
    currentSrc: "https://cdn.test/photo-640.jpg",
    src: "https://cdn.test/photo-320.jpg",
    srcset: [
      "https://cdn.test/photo-640.jpg 640w",
      "https://cdn.test/photo-1280.jpg 1280w",
      "https://cdn.test/photo-2400.jpg 2400w",
    ].join(", "),
    rect: { left: 0, top: 0, right: 300, bottom: 200 },
  };

  // M1-S3 PRODUCT-DIRECTION: same-target srcset w-tier may beat the
  // displayed tier (currentSrc is evidence, not a quality ceiling).
  assert.equal(
    protocol.selectPointMedia("image", 100, 100, [image]).url,
    "https://cdn.test/photo-2400.jpg",
  );
});

test("the selected image element prefers its safe original attribute without accepting unsafe candidates", async () => {
  const protocol = await loadProtocol();
  const attributes = new Map([
    ["data-original", "https://images.test/original.jpg"],
    ["data-full", "javascript:alert(1)"],
    ["data-zoom-image", "https://user:secret@images.test/private.jpg"],
  ]);
  const image = {
    tagName: "IMG",
    currentSrc: "https://images.test/thumb.jpg",
    src: "https://images.test/thumb.jpg",
    srcset: "",
    getAttribute: (name) => attributes.get(name) || "",
    rect: { left: 0, top: 0, right: 200, bottom: 120 },
  };

  // M1-S3 PRODUCT-DIRECTION: a safe allowlisted same-element original may
  // win; unsafe candidates (javascript:, URL credentials) stay rejected.
  assert.equal(
    protocol.selectPointMedia("image", 40, 40, [image]).url,
    "https://images.test/original.jpg",
  );
});

test("the selected image element can use the strongest source from its own picture element", async () => {
  const protocol = await loadProtocol();
  const source = {
    tagName: "SOURCE",
    srcset: "https://cdn.test/picture-1200.webp 1200w, https://cdn.test/picture-3200.webp 3200w",
    getAttribute: (name) => name === "srcset" ? source.srcset : "",
  };
  const inactiveSource = {
    tagName: "SOURCE",
    srcset: "https://cdn.test/unrelated-8000.jpg 8000w",
    getAttribute: (name) => name === "srcset" ? inactiveSource.srcset : "",
  };
  const picture = {
    querySelectorAll: (selector) => selector === "source[srcset]" ? [source, inactiveSource] : [],
  };
  const image = {
    tagName: "IMG",
    currentSrc: "https://cdn.test/picture-1200.webp",
    src: "https://cdn.test/picture-800.jpg",
    srcset: "",
    closest: (selector) => selector === "picture" ? picture : null,
    getAttribute: () => "",
    rect: { left: 0, top: 0, right: 220, bottom: 140 },
  };

  // M1-S3 PRODUCT-DIRECTION: HD only from the img's own picture binding
  // (the source that actually matched the displayed resource).
  assert.equal(
    protocol.selectPointMedia("image", 30, 30, [image]).url,
    "https://cdn.test/picture-3200.webp",
  );
});

test("capture descriptors fail closed across time, tab, frame, document, scroll, and DOM replacement", async () => {
  const protocol = await loadProtocol();
  const descriptor = protocol.createCaptureDescriptor({
    type: "image",
    url: "https://cdn.test/current.jpg",
    capturedAt: 1_000,
    confidence: "contextmenu",
    tabId: 7,
    frameId: 0,
    documentId: "doc-a",
    documentToken: "token-a",
    clientX: 30,
    clientY: 40,
    scrollX: 0,
    scrollY: 100,
    targetToken: "target-a",
  });
  const context = {
    now: 1_900,
    tabId: 7,
    frameId: 0,
    documentId: "doc-a",
    documentToken: "token-a",
    scrollX: 0,
    scrollY: 100,
    targetToken: "target-a",
  };
  assert.equal(protocol.isCaptureDescriptorUsable(descriptor, context), true);
  assert.equal(protocol.isCaptureDescriptorUsable(descriptor, {
    ...context,
    now: descriptor.capturedAt + protocol.CONTEXT_TTL_MS + 1,
  }), false);
  assert.equal(protocol.isCaptureDescriptorUsable(descriptor, { ...context, tabId: 8 }), false);
  assert.equal(protocol.isCaptureDescriptorUsable(descriptor, { ...context, frameId: 2 }), false);
  assert.equal(protocol.isCaptureDescriptorUsable(descriptor, { ...context, documentId: "doc-b" }), false);
  assert.equal(protocol.isCaptureDescriptorUsable(descriptor, { ...context, scrollY: 101 }), false);
  assert.equal(protocol.isCaptureDescriptorUsable(descriptor, { ...context, targetToken: "replacement" }), false);
});

test("dragging a real page image reveals the isolated collector and drops one opaque import request", async () => {
  const { sandbox, contentSource, documentListeners, runtimeMessages } = await loadContentScriptSandbox();
  const nodes = [];
  const createNode = (tagName) => {
    const listeners = new Map();
    const node = {
      tagName: String(tagName || "div").toUpperCase(),
      className: "",
      textContent: "",
      style: {},
      dataset: {},
      children: [],
      parentNode: null,
      isConnected: true,
      setAttribute(name, value) { this[name] = String(value); },
      append(...children) { for (const child of children) this.appendChild(child); },
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
      replaceChildren(...children) { this.children = []; this.append(...children); },
      addEventListener(type, listener) { listeners.set(type, listener); },
      removeEventListener(type) { listeners.delete(type); },
      attachShadow() { this.shadowForTest = createNode("shadow-root"); return this.shadowForTest; },
      remove() { this.isConnected = false; },
      dispatch(type, event = {}) { return listeners.get(type)?.({ preventDefault() {}, stopPropagation() {}, ...event }); },
    };
    nodes.push(node);
    return node;
  };
  const documentElement = createNode("html");
  Object.assign(sandbox.document, {
    documentElement,
    createElement: createNode,
  });
  sandbox.innerWidth = 1_200;
  sandbox.innerHeight = 800;
  const image = new sandbox.HTMLImageElement();
  Object.assign(image, {
    currentSrc: "https://cdn.test/drag-original.jpg?token=PRIVATE",
    src: "https://cdn.test/drag-thumb.jpg",
    srcset: "",
    isConnected: true,
    draggable: true,
    getAttribute: () => "",
    querySelectorAll: () => [],
    closest: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 300, bottom: 200, width: 300, height: 200 }),
  });
  sandbox.document.elementsFromPoint = () => [image];
  vm.runInContext(contentSource, sandbox, { filename: "content-script.js" });

  assert.ok(documentListeners.get("dragstart")?.size, "production dragstart listener must be installed");
  for (const listener of documentListeners.get("dragstart")) {
    listener({ target: image, clientX: 50, clientY: 50, dataTransfer: { effectAllowed: "all" } });
  }
  const dropZone = nodes.find((node) => node.className === "lr-drag-dropzone");
  const folderPanel = nodes.find((node) => node.className === "lr-drag-folders");
  const folderList = nodes.find((node) => node.className === "lr-drag-folder-list");
  const scrollUp = nodes.find((node) => node.className === "lr-drag-scroll-zone lr-drag-scroll-up");
  const scrollDown = nodes.find((node) => node.className === "lr-drag-scroll-zone lr-drag-scroll-down");
  const collectorMain = nodes.find((node) => node.className === "lr-drag-main");
  const collectorHost = nodes.find((node) => Object.hasOwn(node, "data-luckyray-drag-collector"));
  const collectorStyle = nodes.find((node) => node.tagName === "STYLE" && /lr-drag-main/.test(node.textContent));
  assert.ok(dropZone, "the closed-shadow collection drop zone must exist");
  assert.ok(folderPanel, "the drag collector must contain its folder-selection UI");
  assert.equal(scrollUp, undefined, "folder scrolling must not consume space with visible hotspot rows");
  assert.equal(scrollDown, undefined, "folder scrolling must not consume space with visible hotspot rows");
  assert.deepEqual(
    collectorMain?.children.map((node) => node.className),
    ["lr-drag-dropzone", "lr-drag-folders"],
    "the media target and folder picker must be side-by-side in one horizontal collector",
  );
  assert.match(collectorStyle.textContent, /grid-template-columns:240px minmax\(300px,1fr\)/);
  assert.match(collectorStyle.textContent, /scrollbar-width:none/);
  folderPanel.getBoundingClientRect = () => ({ left: 600, top: 100, right: 930, bottom: 350, width: 330, height: 250 });
  folderList.getBoundingClientRect = () => ({ left: 610, top: 135, right: 920, bottom: 315, width: 310, height: 180 });
  folderList.scrollTop = 0;
  await folderPanel.dispatch("dragover", { dataTransfer: { dropEffect: "copy" } });
  await folderPanel.dispatch("dragleave", { relatedTarget: null });
  for (const listener of documentListeners.get("wheel") || []) {
    listener({ deltaY: 120, preventDefault() {}, stopPropagation() {} });
  }
  assert.equal(folderList.scrollTop, 120,
    "a Shadow DOM dragleave with no relatedTarget must not disable folder wheel scrolling");
  folderList.scrollTop = 0;
  for (const listener of documentListeners.get("dragover") || []) {
    listener({ clientX: 800, clientY: 310, preventDefault() {}, dataTransfer: { dropEffect: "copy" } });
  }
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.ok(folderList.scrollTop > 0,
    "native dragover near the lower folder edge must auto-scroll when Chromium suppresses wheel events");
  assert.ok(folderList.scrollTop <= 12, "edge auto-scroll must remain slow enough for precise folder selection");
  assert.equal(collectorHost.style.left, "316px", "collector should open beside the dragged media");
  assert.doesNotMatch(nodes.map((node) => node.textContent).join(" "), /PRIVATE|cdn\.test|token=/);

  await dropZone.dispatch("drop", { dataTransfer: { dropEffect: "copy" } });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const request = runtimeMessages.find((message) => message.type === "luckyray-drag-collect");
  assert.equal(request.mediaType, "image");
  assert.equal(request.url, "https://cdn.test/drag-original.jpg?token=PRIVATE");
  assert.match(request.actionId, /^drag:/);
  assert.equal(runtimeMessages.filter((message) => message.type === "luckyray-drag-collect").length, 1);

  const blankPage = createNode("main");
  for (const listener of documentListeners.get("pointerdown")) {
    listener({
      button: 0,
      target: blankPage,
      clientX: 900,
      clientY: 700,
      composedPath: () => [blankPage, documentElement],
    });
  }
  assert.equal(collectorHost.style.display, "none", "clicking blank page space must dismiss the collector");
});

test("the page drag collector saves into an existing or new material folder without opening the extension popup", async () => {
  const { sandbox, contentSource, documentListeners, runtimeMessages } = await loadContentScriptSandbox(async (message) => {
    if (message.type === "luckyray-drag-folders") return {
      ok: true,
      folders: [{ id: "folder-a", parentId: null, name: "灵感" }],
    };
    if (message.type === "luckyray-drag-collect") return { ok: true };
    return {};
  });
  const nodes = [];
  const createNode = (tagName) => {
    const listeners = new Map();
    const node = {
      tagName: String(tagName || "div").toUpperCase(),
      className: "",
      textContent: "",
      value: "",
      style: {},
      dataset: {},
      children: [],
      parentNode: null,
      isConnected: true,
      setAttribute(name, value) { this[name] = String(value); },
      getAttribute(name) { return this[name] ?? null; },
      append(...children) { for (const child of children) this.appendChild(child); },
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
      replaceChildren(...children) { this.children = []; this.append(...children); },
      addEventListener(type, listener) { listeners.set(type, listener); },
      removeEventListener(type) { listeners.delete(type); },
      attachShadow() { this.shadowForTest = createNode("shadow-root"); return this.shadowForTest; },
      remove() { this.isConnected = false; },
      focus() {},
      dispatch(type, event = {}) { return listeners.get(type)?.({ preventDefault() {}, stopPropagation() {}, ...event }); },
    };
    nodes.push(node);
    return node;
  };
  const documentElement = createNode("html");
  Object.assign(sandbox.document, { documentElement, createElement: createNode });
  sandbox.innerWidth = 1_200;
  sandbox.innerHeight = 800;
  const image = new sandbox.HTMLImageElement();
  Object.assign(image, {
    currentSrc: "https://cdn.test/folder-target.jpg",
    src: "https://cdn.test/folder-target.jpg",
    srcset: "",
    isConnected: true,
    draggable: true,
    getAttribute: () => "",
    querySelectorAll: () => [],
    closest: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 300, bottom: 200, width: 300, height: 200 }),
  });
  sandbox.document.elementsFromPoint = () => [image];
  vm.runInContext(contentSource, sandbox, { filename: "content-script.js" });

  const startDrag = () => {
    for (const listener of documentListeners.get("dragstart")) {
      listener({ target: image, clientX: 50, clientY: 50, dataTransfer: { effectAllowed: "all" } });
    }
  };
  startDrag();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const folderItem = nodes.find((node) => node.className === "lr-drag-folder-item");
  assert.ok(folderItem, "the authenticated folder list must render inside the collector");
  await folderItem.dispatch("drop", { dataTransfer: { dropEffect: "copy" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(runtimeMessages.find((message) => message.type === "luckyray-drag-collect")?.targetFolderId, "folder-a");

  startDrag();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const newFolder = nodes.find((node) => node.className === "lr-drag-new-folder");
  const input = nodes.find((node) => node.className === "lr-drag-folder-input");
  const save = nodes.find((node) => node.className === "lr-drag-folder-save");
  await newFolder.dispatch("drop", { dataTransfer: { dropEffect: "copy" } });
  input.value = "本次采集";
  await save.dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const imports = runtimeMessages.filter((message) => message.type === "luckyray-drag-collect");
  assert.equal(imports.length, 2);
  assert.equal(imports[1].newFolderName, "本次采集");
  assert.equal(runtimeMessages.some((message) => message.type === "luckyray-popup-get-page"), false);
});

test("a video covered by a page overlay becomes a native drag source and opens the video collector", async () => {
  const { sandbox, contentSource, documentListeners, runtimeMessages } = await loadContentScriptSandbox(async (message) => {
    if (message.type === "luckyray-video-overlay-open") {
      return { ok: true, sessionId: "pinterest-session", items: [], canRecord: false };
    }
    if (message.type === "luckyray-drag-collect") return { ok: true };
    return {};
  });
  const nodes = [];
  const createNode = (tagName) => {
    const listeners = new Map();
    const node = {
      tagName: String(tagName || "div").toUpperCase(),
      className: "",
      textContent: "",
      style: {},
      dataset: {},
      children: [],
      parentNode: null,
      isConnected: true,
      setAttribute(name, value) { this[name] = String(value); },
      getAttribute(name) { return this[name] ?? null; },
      hasAttribute(name) { return Object.hasOwn(this, name); },
      removeAttribute(name) { delete this[name]; },
      append(...children) { for (const child of children) this.appendChild(child); },
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
      replaceChildren(...children) { this.children = []; this.append(...children); },
      addEventListener(type, listener) { listeners.set(type, listener); },
      removeEventListener(type) { listeners.delete(type); },
      attachShadow() { this.shadowForTest = createNode("shadow-root"); return this.shadowForTest; },
      remove() { this.isConnected = false; },
      dispatch(type, event = {}) { return listeners.get(type)?.({ preventDefault() {}, stopPropagation() {}, ...event }); },
    };
    nodes.push(node);
    return node;
  };
  const rect = { left: 100, top: 80, right: 500, bottom: 680, width: 400, height: 600 };
  const pinLink = new sandbox.Element();
  Object.assign(pinLink, {
    href: "https://www.pinterest.com/pin/quiet-lake-video--123456789/?utm_source=PRIVATE",
    parentElement: null,
    matches: (selector) => selector === "a[href]",
    querySelectorAll: () => [],
  });
  const video = new sandbox.HTMLVideoElement();
  Object.assign(video, {
    tagName: "VIDEO",
    currentSrc: "https://v1.pinimg.com/videos/pin-a_360w.cmfv?token=PRIVATE-LOW",
    src: "",
    type: "",
    videoWidth: 720,
    videoHeight: 1_080,
    duration: 12,
    draggable: false,
    isConnected: true,
    getAttribute: () => "",
    querySelectorAll: () => [],
    closest: () => video,
    parentElement: pinLink,
    getBoundingClientRect: () => rect,
  });
  const poster = new sandbox.HTMLImageElement();
  Object.assign(poster, {
    tagName: "IMG",
    currentSrc: "https://i.pinimg.test/posters/pin-a.jpg?token=PRIVATE-POSTER",
    src: "https://i.pinimg.test/posters/pin-a.jpg",
    srcset: "",
    isConnected: true,
    getAttribute: () => "",
    querySelectorAll: () => [],
    closest: () => null,
    getBoundingClientRect: () => rect,
  });
  const cover = new sandbox.Element();
  Object.assign(cover, createNode("div"), {
    parentElement: null,
    draggable: false,
    querySelectorAll: (selector) => String(selector).includes("video") ? [video]
      : String(selector).includes("img") ? [poster] : [],
    closest: () => null,
    getBoundingClientRect: () => rect,
  });
  const documentElement = createNode("html");
  Object.assign(sandbox.document, { documentElement, createElement: createNode, elementsFromPoint: () => [cover, poster, video] });
  sandbox.location.href = "https://www.pinterest.com/";
  sandbox.innerWidth = 1_400;
  sandbox.innerHeight = 900;
  vm.runInContext(contentSource, sandbox, { filename: "content-script.js" });

  let detailRequests = 0;
  sandbox.document.addEventListener("__luckyray_pinterest_detail_request_v1__", (event) => {
    detailRequests += 1;
    sandbox.document.dispatchEvent(new sandbox.CustomEvent("__luckyray_page_media_probe_v1__", { detail: {
      version: 1,
      kind: "pinterest-video-catalog",
      requestId: event.detail.requestId,
      pinId: "123456789",
      pageUrl: "https://www.pinterest.com/pin/123456789/",
      variants: [
        { url: "https://v1.pinimg.com/videos/pin-a_960w.cmfv?token=PRIVATE-HIGH", width: 960, height: 1_280 },
        { url: "https://v1.pinimg.com/videos/pin-a_360w.cmfv?token=PRIVATE-LOW", width: 360, height: 640 },
      ],
    } }));
  });
  sandbox.document.dispatchEvent(new sandbox.CustomEvent("__luckyray_page_media_probe_v1__", { detail: {
    version: 1,
    kind: "pinterest-video-catalog",
    pinId: "123456789",
    pageUrl: "https://www.pinterest.com/pin/123456789/",
    variants: [
      { url: "https://v1.pinimg.com/videos/pin-a_360w.cmfv?token=PRIVATE-LOW", width: 360, height: 640 },
    ],
  } }));

  for (const listener of documentListeners.get("mousemove") || []) {
    listener({ target: video, clientX: 220, clientY: 240 });
  }
  const chip = nodes.find((node) => node.className === "lr-chip");
  assert.ok(chip);
  await chip.dispatch("click");
  const overlayRequest = runtimeMessages.find((message) => message.type === "luckyray-video-overlay-open");
  assert.equal(detailRequests, 1, "opening the Pinterest player menu must request exact Pin detail once");
  assert.match(JSON.stringify(overlayRequest.playerCandidates), /pin-a_960w\.cmfv/);

  for (const listener of documentListeners.get("pointerdown")) {
    listener({ button: 0, target: cover, clientX: 220, clientY: 240, composedPath: () => [cover] });
  }
  assert.equal(String(cover.draggable), "true", "the actual pointer target must become draggable when it covers a video");

  for (const listener of documentListeners.get("dragstart")) {
    listener({ target: cover, clientX: 220, clientY: 240, composedPath: () => [cover], dataTransfer: { effectAllowed: "all" } });
  }
  const dropZone = nodes.find((node) => node.className === "lr-drag-dropzone");
  assert.ok(dropZone);
  await dropZone.dispatch("drop", { dataTransfer: { dropEffect: "copy" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const request = runtimeMessages.find((message) => message.type === "luckyray-drag-collect");
  assert.equal(request.mediaType, "video");
  assert.equal(request.resolveVideo, true);
  assert.equal(request.url, undefined);
  assert.equal(detailRequests, 2, "opening and dropping a Pinterest preview each use a fresh explicit detail request");
  assert.equal(request.resolverPageUrl, "https://www.pinterest.com/pin/123456789/");
  assert.match(JSON.stringify(request.playerCandidates), /pin-a_360w\.cmfv/);
  assert.match(JSON.stringify(request.playerCandidates), /pin-a_960w\.cmfv/);
  assert.doesNotMatch(JSON.stringify(request), /PRIVATE-POSTER|i\.pinimg/);
});

test("two players keep independent hover chips and open only their own candidate session", async () => {
  const { sandbox, contentSource, documentListeners, runtimeMessages } = await loadContentScriptSandbox();
  const nodes = [];
  const createNode = (tagName) => {
    const listeners = new Map();
    const node = {
      tagName: String(tagName || "div").toUpperCase(),
      className: "",
      textContent: "",
      style: {},
      dataset: {},
      children: [],
      parentNode: null,
      isConnected: true,
      setAttribute(name, value) { this[name] = String(value); },
      append(...children) { for (const child of children) this.appendChild(child); },
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
      addEventListener(type, listener) { listeners.set(type, listener); },
      removeEventListener(type) { listeners.delete(type); },
      attachShadow() { this.shadowForTest = createNode("shadow-root"); return this.shadowForTest; },
      remove() { this.isConnected = false; },
      dispatch(type, event = {}) { return listeners.get(type)?.({ preventDefault() {}, stopPropagation() {}, ...event }); },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    };
    nodes.push(node);
    return node;
  };
  const documentElement = createNode("html");
  Object.assign(sandbox.document, { documentElement, createElement: createNode });
  sandbox.innerWidth = 1_400;
  sandbox.innerHeight = 900;

  const makeVideo = (name, left) => {
    const video = new sandbox.HTMLVideoElement();
    Object.assign(video, {
      tagName: "VIDEO",
      currentSrc: `https://media.test/${name}_720w.mp4`,
      src: "",
      type: "video/mp4",
      videoWidth: 720,
      videoHeight: 1_280,
      duration: 12,
      isConnected: true,
      getAttribute: () => "",
      querySelectorAll: () => [],
      querySelector: () => null,
      closest: () => video,
      getBoundingClientRect: () => ({ left, top: 80, right: left + 300, bottom: 580, width: 300, height: 500 }),
    });
    return video;
  };
  const first = makeVideo("first", 40);
  const second = makeVideo("second", 420);
  const attachWork = (video, href) => {
    const link = new sandbox.Element();
    Object.assign(link, {
      tagName: "A", href, parentElement: null,
      matches: (selector) => selector === "a[href]",
      querySelectorAll: () => [],
      getAttribute: (name) => name === "href" ? href : null,
    });
    video.parentElement = link;
  };
  attachWork(first, "https://www.pinterest.com/pin/123456789/?view=large#comments");
  attachWork(second, "https://www.pinterest.com/pin/987654321/?view=grid#comments");
  let pointed = first;
  sandbox.document.elementsFromPoint = () => [pointed];
  vm.runInContext(contentSource, sandbox, { filename: "content-script.js" });

  for (const listener of documentListeners.get("mousemove")) {
    listener({ clientX: 100, clientY: 120, target: first });
  }
  pointed = second;
  for (const listener of documentListeners.get("mousemove")) {
    listener({ clientX: 480, clientY: 120, target: second });
  }

  const hosts = nodes.filter((node) => Object.hasOwn(node, "data-luckyray-video-capture"));
  const chips = nodes.filter((node) => node.className === "lr-chip");
  const panels = nodes.filter((node) => node.className === "lr-panel");
  assert.equal(hosts.length, 2, "each player must own one fixed overlay host");
  assert.equal(chips.length, 2, "each player must own one independent action chip");
  assert.equal(hosts[0].style.left, "296px");
  assert.equal(hosts[1].style.left, "676px");
  assert.equal(panels[0].style.left, "0px", "a left-edge player panel must open toward the viewport");
  assert.equal(panels[0].style.right, "auto");
  assert.equal(panels[1].style.right, "0px", "a right-side player panel may open back toward the viewport");

  await chips[0].dispatch("click");
  await chips[1].dispatch("click");
  const opens = runtimeMessages.filter((message) => message.type === "luckyray-video-overlay-open");
  assert.equal(opens.length, 2);
  assert.notEqual(opens[0].descriptor.targetToken, opens[1].descriptor.targetToken);
  assert.match(JSON.stringify(opens[0].playerCandidates), /first_720w\.mp4/);
  assert.doesNotMatch(JSON.stringify(opens[0].playerCandidates), /second_720w\.mp4/);
  assert.match(JSON.stringify(opens[1].playerCandidates), /second_720w\.mp4/);
  assert.doesNotMatch(JSON.stringify(opens[1].playerCandidates), /first_720w\.mp4/);
  assert.equal(opens[0].sourcePageUrl, "https://www.pinterest.com/pin/123456789/?view=large#comments");
  assert.equal(opens[1].sourcePageUrl, "https://www.pinterest.com/pin/987654321/?view=grid#comments");
  assert.equal(opens[0].sourcePageKind, "work-page");
  assert.equal(opens[1].sourcePageKind, "work-page");
});

test("a hidden video panel reopens its active transfer instead of starting a second session", async () => {
  const { sandbox, contentSource, documentListeners, runtimeMessages } = await loadContentScriptSandbox();
  const nodes = [];
  const createNode = (tagName) => {
    const listeners = new Map();
    const node = {
      tagName: String(tagName || "div").toUpperCase(), className: "", textContent: "", style: {}, dataset: {},
      children: [], parentNode: null, isConnected: true, disabled: false,
      setAttribute(name, value) { this[name] = String(value); },
      append(...children) { for (const child of children) this.appendChild(child); },
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
      replaceChildren(...children) { this.children = []; this.append(...children); },
      addEventListener(type, listener) { listeners.set(type, listener); },
      removeEventListener(type) { listeners.delete(type); },
      attachShadow() { this.shadowForTest = createNode("shadow-root"); return this.shadowForTest; },
      remove() { this.isConnected = false; },
      dispatch(type, event = {}) { return listeners.get(type)?.({ preventDefault() {}, stopPropagation() {}, ...event }); },
      querySelector() { return null; }, querySelectorAll() { return []; },
    };
    nodes.push(node);
    return node;
  };
  const documentElement = createNode("html");
  const video = new sandbox.HTMLVideoElement();
  Object.assign(video, {
    tagName: "VIDEO", currentSrc: "https://media.test/active_720w.mp4", src: "", type: "video/mp4",
    videoWidth: 1280, videoHeight: 720, duration: 12, isConnected: true,
    getAttribute: () => "", querySelectorAll: () => [], querySelector: () => null, closest: () => video,
    getBoundingClientRect: () => ({ left: 40, top: 40, right: 440, bottom: 300, width: 400, height: 260 }),
  });
  Object.assign(sandbox.document, { documentElement, createElement: createNode, elementsFromPoint: () => [video] });
  sandbox.innerWidth = 1_200;
  sandbox.innerHeight = 800;
  const realSetTimeout = setTimeout;
  sandbox.setTimeout = (callback, delay, ...args) => realSetTimeout(callback, delay === 750 ? 40 : delay, ...args);
  sandbox.window = sandbox;
  let statusReads = 0;
  sandbox.chrome.runtime.sendMessage = async (message) => {
    runtimeMessages.push(message);
    if (message.type === "luckyray-video-overlay-open") return {
      ok: true,
      sessionId: "session-active-transfer",
      items: [{
        candidateId: "video-active", label: "720p · MP4", host: "media.test",
        kind: "direct-video", canSaveToMaterials: true,
      }],
      canRecord: false,
    };
    if (message.action === "save-materials") return {
      ok: true,
      transfer: {
        transferId: "media-cafe-0123456789abcdef", state: "queued", bytesReceived: 0,
        totalBytes: 4096, fileName: "Active.mp4", mimeType: "video/mp4", skippedDuplicate: false,
      },
    };
    if (message.action === "media-transfer-status") {
      statusReads += 1;
      return {
        ok: true,
        transfer: {
          transferId: "media-cafe-0123456789abcdef", state: "completed", bytesReceived: 4096,
          totalBytes: 4096, fileName: "Active.mp4", mimeType: "video/mp4", skippedDuplicate: false,
          assetId: "asset-active", assetName: "Active.mp4", assetKind: "video",
        },
      };
    }
    return {};
  };
  vm.runInContext(contentSource, sandbox, { filename: "content-script.js" });

  for (const listener of documentListeners.get("mousemove")) listener({ clientX: 100, clientY: 100, target: video });
  const chip = nodes.find((node) => node.className === "lr-chip");
  await chip.dispatch("click");
  const save = nodes.find((node) => node.className === "lr-action");
  save.dispatch("click");
  await new Promise((resolve) => realSetTimeout(resolve, 0));

  const blankPage = createNode("main");
  for (const listener of documentListeners.get("pointerdown")) {
    listener({ button: 0, target: blankPage, clientX: 900, clientY: 700, composedPath: () => [blankPage, documentElement] });
  }
  assert.equal(chip["aria-expanded"], "false");
  await chip.dispatch("click");
  assert.equal(chip["aria-expanded"], "true");
  assert.equal(runtimeMessages.filter((message) => message.type === "luckyray-video-overlay-open").length, 1);

  await new Promise((resolve) => realSetTimeout(resolve, 60));
  assert.equal(statusReads, 1);
});

test("a stalled overlay request leaves the loading state within a bounded timeout", async () => {
  const { sandbox, contentSource, documentListeners, runtimeMessages } = await loadContentScriptSandbox();
  const nodes = [];
  const createNode = (tagName) => {
    const listeners = new Map();
    const node = {
      tagName: String(tagName || "div").toUpperCase(), className: "", textContent: "", style: {}, dataset: {},
      children: [], parentNode: null, isConnected: true,
      setAttribute(name, value) { this[name] = String(value); },
      append(...children) { for (const child of children) this.appendChild(child); },
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
      addEventListener(type, listener) { listeners.set(type, listener); },
      removeEventListener(type) { listeners.delete(type); },
      attachShadow() { this.shadowForTest = createNode("shadow-root"); return this.shadowForTest; },
      remove() { this.isConnected = false; },
      dispatch(type, event = {}) { return listeners.get(type)?.({ preventDefault() {}, stopPropagation() {}, ...event }); },
      querySelector() { return null; }, querySelectorAll() { return []; },
    };
    nodes.push(node);
    return node;
  };
  const video = new sandbox.HTMLVideoElement();
  Object.assign(video, {
    tagName: "VIDEO", currentSrc: "https://media.test/stalled.mp4", src: "", type: "video/mp4",
    videoWidth: 720, videoHeight: 1280, duration: 8, isConnected: true,
    getAttribute: () => "", querySelectorAll: () => [], querySelector: () => null, closest: () => video,
    getBoundingClientRect: () => ({ left: 20, top: 20, right: 320, bottom: 520, width: 300, height: 500 }),
  });
  Object.assign(sandbox.document, {
    documentElement: createNode("html"), createElement: createNode, elementsFromPoint: () => [video],
  });
  sandbox.innerWidth = 1200;
  sandbox.innerHeight = 800;
  sandbox.chrome.runtime.sendMessage = (message) => {
    runtimeMessages.push(message);
    if (message.type === "luckyray-video-overlay-open") return new Promise(() => {});
    return Promise.resolve({});
  };
  const realSetTimeout = setTimeout;
  sandbox.setTimeout = (callback, delay, ...args) => realSetTimeout(callback, delay === 5_000 ? 5 : delay, ...args);
  sandbox.window = sandbox;
  vm.runInContext(contentSource, sandbox, { filename: "content-script.js" });

  for (const listener of documentListeners.get("mousemove")) listener({ clientX: 80, clientY: 80, target: video });
  const chip = nodes.find((node) => node.className === "lr-chip");
  const status = nodes.find((node) => node.className === "lr-status");
  void chip.dispatch("click");
  assert.equal(status.textContent, "正在读取视频候选…");
  await new Promise((resolve) => realSetTimeout(resolve, 20));
  assert.equal(status.textContent, "暂时无法读取视频候选。");
  assert.equal(status["data-error"], "true");
});

test("an MSE hint is bound only to the video element owning that blob URL", async () => {
  const { sandbox, contentSource, documentListeners, runtimeMessages } = await loadContentScriptSandbox();
  const nodes = [];
  const createNode = (tagName) => {
    const listeners = new Map();
    const node = {
      tagName: String(tagName || "div").toUpperCase(), className: "", textContent: "", style: {}, dataset: {},
      children: [], parentNode: null, isConnected: true,
      setAttribute(name, value) { this[name] = String(value); },
      append(...children) { for (const child of children) this.appendChild(child); },
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
      addEventListener(type, listener) { listeners.set(type, listener); },
      removeEventListener(type) { listeners.delete(type); },
      attachShadow() { this.shadowForTest = createNode("shadow-root"); return this.shadowForTest; },
      remove() { this.isConnected = false; },
      dispatch(type, event = {}) { return listeners.get(type)?.({ preventDefault() {}, stopPropagation() {}, ...event }); },
      querySelector() { return null; }, querySelectorAll() { return []; },
    };
    nodes.push(node);
    return node;
  };
  const documentElement = createNode("html");
  Object.assign(sandbox.document, { documentElement, createElement: createNode });
  sandbox.innerWidth = 1_200;
  sandbox.innerHeight = 800;
  const makeVideo = (blob, left) => {
    const video = new sandbox.HTMLVideoElement();
    Object.assign(video, {
      tagName: "VIDEO", currentSrc: blob, src: "", type: "video/mp4", videoWidth: 720, videoHeight: 1_280,
      duration: 8, isConnected: true, getAttribute: () => "", querySelectorAll: () => [], querySelector: () => null,
      closest: () => video,
      getBoundingClientRect: () => ({ left, top: 20, right: left + 280, bottom: 500, width: 280, height: 480 }),
    });
    return video;
  };
  const first = makeVideo("blob:https://page.test/first", 20);
  const second = makeVideo("blob:https://page.test/second", 340);
  let pointed = first;
  sandbox.document.querySelectorAll = (selector) => selector === "video" ? [first, second] : [];
  sandbox.document.elementsFromPoint = () => [pointed];
  vm.runInContext(contentSource, sandbox, { filename: "content-script.js" });

  const probeListeners = documentListeners.get("__luckyray_page_media_probe_v1__");
  assert.ok(probeListeners?.size, "the isolated content receiver must consume MAIN-world correlation hints");
  for (const listener of probeListeners) listener({ detail: {
    version: 1, kind: "mse-candidate", blobUrl: first.currentSrc,
    candidateUrl: "https://media.test/first_1080w.cmfv", contentType: "video/mp4",
  } });
  for (const listener of probeListeners) listener({ detail: {
    version: 1, kind: "mse-candidate", blobUrl: second.currentSrc,
    candidateUrl: "https://media.test/second_720w.cmfv", contentType: "video/mp4",
  } });

  for (const listener of documentListeners.get("mousemove")) listener({ clientX: 80, clientY: 80, target: first });
  pointed = second;
  for (const listener of documentListeners.get("mousemove")) listener({ clientX: 400, clientY: 80, target: second });
  const chips = nodes.filter((node) => node.className === "lr-chip");
  await chips[0].dispatch("click");
  await chips[1].dispatch("click");
  const opens = runtimeMessages.filter((message) => message.type === "luckyray-video-overlay-open");
  assert.match(JSON.stringify(opens[0].playerCandidates), /first_1080w\.cmfv/);
  assert.doesNotMatch(JSON.stringify(opens[0].playerCandidates), /second_720w\.cmfv/);
  assert.match(JSON.stringify(opens[1].playerCandidates), /second_720w\.cmfv/);
  assert.doesNotMatch(JSON.stringify(opens[1].playerCandidates), /first_1080w\.cmfv/);
  assert.equal(opens[0].playerCandidates.find((item) => /first_/.test(item.url)).binding, "mse-probe");
});

test("a site track pair binds only to the primary player on its exact detail page", async () => {
  const { sandbox, contentSource, documentListeners, runtimeMessages } = await loadContentScriptSandbox();
  const nodes = [];
  const createNode = (tagName) => {
    const listeners = new Map();
    const node = {
      tagName: String(tagName || "div").toUpperCase(), className: "", textContent: "", style: {}, dataset: {},
      children: [], parentNode: null, isConnected: true,
      setAttribute(name, value) { this[name] = String(value); },
      append(...children) { for (const child of children) this.appendChild(child); },
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
      addEventListener(type, listener) { listeners.set(type, listener); },
      removeEventListener(type) { listeners.delete(type); },
      attachShadow() { this.shadowForTest = createNode("shadow-root"); return this.shadowForTest; },
      remove() { this.isConnected = false; },
      dispatch(type, event = {}) { return listeners.get(type)?.({ preventDefault() {}, stopPropagation() {}, ...event }); },
      querySelector() { return null; }, querySelectorAll() { return []; },
    };
    nodes.push(node);
    return node;
  };
  const documentElement = createNode("html");
  Object.assign(sandbox.document, { documentElement, createElement: createNode });
  sandbox.location.href = "https://www.bilibili.com/video/BV1xx411c7mD";
  sandbox.innerWidth = 1_400;
  sandbox.innerHeight = 900;
  const makeVideo = (left, width, height) => {
    const video = new sandbox.HTMLVideoElement();
    Object.assign(video, {
      tagName: "VIDEO", currentSrc: `blob:https://www.bilibili.com/${left}`, src: "", type: "video/mp4",
      videoWidth: 1_920, videoHeight: 1_080, duration: 30, isConnected: true,
      getAttribute: () => "", querySelectorAll: () => [], querySelector: () => null, closest: () => video,
      getBoundingClientRect: () => ({ left, top: 20, right: left + width, bottom: 20 + height, width, height }),
    });
    return video;
  };
  const primary = makeVideo(20, 960, 540);
  const related = makeVideo(1_020, 240, 135);
  let pointed = primary;
  sandbox.document.querySelectorAll = (selector) => selector === "video" ? [primary, related] : [];
  sandbox.document.elementsFromPoint = () => [pointed];
  vm.runInContext(contentSource, sandbox, { filename: "content-script.js" });

  for (const listener of documentListeners.get("__luckyray_page_media_probe_v1__")) listener({ detail: {
    version: 1,
    kind: "site-track-pair",
    pageUrl: sandbox.location.href,
    videoUrl: "https://v.example.bilivideo.com/video-high.m4s",
    audioUrl: "https://a.example.bilivideo.com/audio-high.m4s",
    contentType: "video/mp4",
    width: 1920,
    height: 1080,
    bitrate: 3_000_000,
  } });

  for (const listener of documentListeners.get("mousemove")) listener({ clientX: 80, clientY: 80, target: primary });
  pointed = related;
  for (const listener of documentListeners.get("mousemove")) listener({ clientX: 1_050, clientY: 80, target: related });
  const chips = nodes.filter((node) => node.className === "lr-chip");
  await chips[0].dispatch("click");
  await chips[1].dispatch("click");
  const opens = runtimeMessages.filter((message) => message.type === "luckyray-video-overlay-open");
  assert.match(JSON.stringify(opens[0].playerCandidates), /video-high\.m4s/);
  assert.match(JSON.stringify(opens[0].playerCandidates), /audio-high\.m4s/);
  assert.doesNotMatch(JSON.stringify(opens[1].playerCandidates), /video-high\.m4s|audio-high\.m4s/);

});

test("an X status candidate is bound to the visible primary player", async () => {
  const { sandbox, contentSource, documentListeners, runtimeMessages } = await loadContentScriptSandbox();
  const nodes = [];
  const createNode = (tagName) => {
    const listeners = new Map();
    const node = {
      tagName: String(tagName || "div").toUpperCase(), className: "", textContent: "", style: {}, dataset: {},
      children: [], parentNode: null, isConnected: true,
      setAttribute(name, value) { this[name] = String(value); },
      append(...children) { for (const child of children) this.appendChild(child); },
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
      addEventListener(type, listener) { listeners.set(type, listener); },
      removeEventListener(type) { listeners.delete(type); },
      attachShadow() { this.shadowForTest = createNode("shadow-root"); return this.shadowForTest; },
      remove() { this.isConnected = false; },
      dispatch(type, event = {}) { return listeners.get(type)?.({ preventDefault() {}, stopPropagation() {}, ...event }); },
      querySelector() { return null; }, querySelectorAll() { return []; },
    };
    nodes.push(node);
    return node;
  };
  Object.assign(sandbox.document, { documentElement: createNode("html"), createElement: createNode });
  sandbox.location.href = "https://x.com/luckyray/status/1234567890";
  sandbox.innerWidth = 1_400;
  sandbox.innerHeight = 900;
  const primary = new sandbox.HTMLVideoElement();
  Object.assign(primary, {
    tagName: "VIDEO", currentSrc: "blob:https://x.com/primary", src: "", type: "video/mp4",
    videoWidth: 1_280, videoHeight: 720, duration: 30, isConnected: true,
    getAttribute: () => "", querySelectorAll: () => [], querySelector: () => null, closest: () => primary,
    getBoundingClientRect: () => ({ left: 20, top: 20, right: 980, bottom: 560, width: 960, height: 540 }),
  });
  sandbox.document.querySelectorAll = (selector) => selector === "video" ? [primary] : [];
  sandbox.document.elementsFromPoint = () => [primary];
  vm.runInContext(contentSource, sandbox, { filename: "content-script.js" });

  for (const listener of documentListeners.get("__luckyray_page_media_probe_v1__")) listener({ detail: {
    version: 1,
    kind: "site-video-candidate",
    pageUrl: sandbox.location.href,
    videoUrl: "https://video.twimg.com/ext_tw_video/right/pu/vid/1280x720/high.mp4",
    contentType: "video/mp4",
    bitrate: 2_176_000,
  } });
  for (const listener of documentListeners.get("mousemove")) listener({ clientX: 80, clientY: 80, target: primary });
  await nodes.find((node) => node.className === "lr-chip").dispatch("click");
  const opened = runtimeMessages.find((message) => message.type === "luckyray-video-overlay-open");
  assert.match(JSON.stringify(opened.playerCandidates), /video\.twimg\.com.*high\.mp4/);
  assert.equal(opened.playerCandidates.find((item) => /twimg/.test(item.url)).binding, "site-probe");
});

test("a page-captured hover survives popup focus without re-hitting the current pointer", async () => {
  const protocol = await loadProtocol();
  const descriptor = protocol.createCaptureDescriptor({
    type: "image",
    url: "https://cdn.test/captured-before-popup.jpg",
    capturedAt: 1_000,
    confidence: "hover-point",
    tabId: 7,
    frameId: 0,
    documentToken: "document-a",
    scrollX: 0,
    scrollY: 120,
    targetToken: "target-a",
  });

  const resolved = protocol.resolveCapturedDescriptor(descriptor, {
    now: 7_000,
    tabId: 7,
    frameId: 0,
    documentToken: "document-a",
    scrollX: 0,
    scrollY: 120,
    targetToken: "target-a",
    targetConnected: true,
    targetUrl: "https://cdn.test/captured-before-popup.jpg",
  });

  assert.equal(resolved?.url, descriptor.url);
  assert.equal(protocol.resolveCapturedDescriptor(descriptor, {
    now: 7_000,
    tabId: 7,
    frameId: 0,
    documentToken: "document-a",
    scrollX: 0,
    scrollY: 120,
    targetToken: "target-a",
    targetConnected: false,
    targetUrl: descriptor.url,
  }), null);
  assert.equal(protocol.resolveCapturedDescriptor(descriptor, {
    now: 7_000,
    tabId: 8,
    frameId: 0,
    documentToken: "document-a",
    scrollX: 0,
    scrollY: 120,
    targetToken: "target-a",
    targetConnected: true,
    targetUrl: descriptor.url,
  }), null);
});

test("an existing tab without a receiver installs the production scripts and retries once without guessing media", async () => {
  const protocol = await loadProtocol();
  const calls = [];
  let sendAttempts = 0;
  const receiver = protocol.createContentReceiverBridge({
    tabs: {
      async sendMessage(tabId, message, options) {
        calls.push({ kind: "message", tabId, message, options });
        sendAttempts += 1;
        if (sendAttempts === 1) throw new Error("Could not establish connection. Receiving end does not exist.");
        return {};
      },
    },
    scripting: {
      async executeScript(details) {
        calls.push({ kind: "install", details });
        return [];
      },
    },
  });

  const response = await receiver.request(17, { type: "luckyray-get-hover-image" }, { frameId: 0 });

  assert.deepEqual(response, {});
  assert.equal(calls.filter((call) => call.kind === "message").length, 2);
  const installs = calls.filter((call) => call.kind === "install");
  assert.equal(installs.length, 2);
  assert.equal(installs[0].details.world, "MAIN");
  assert.equal(JSON.stringify(installs[0].details.files), JSON.stringify(["page-media-probe.js"]));
  assert.equal(
    JSON.stringify(installs[1].details.files),
    JSON.stringify(["extension-protocol.js", "appearance.js", "article-extractor.js", "page-capture.js", "content-script.js"]),
  );
});

test("a stale page receiver is reinstalled when its capture protocol version is obsolete", async () => {
  let installed = 0;
  let calls = 0;
  const installDetails = [];
  const receiver = (await loadProtocol()).createContentReceiverBridge({
    tabs: {
      async sendMessage() {
        calls += 1;
        return installed
          ? { captureProtocolVersion: 2, title: "Current receiver" }
          : { title: "Stale receiver" };
      },
    },
    scripting: {
      async executeScript(details) {
        installed += 1;
        installDetails.push(details);
      },
    },
  });

  const response = await receiver.request(12, { type: "luckyray-get-page-context" }, {
    frameId: 0,
    requiredProtocolVersion: 2,
  });
  assert.equal(response.title, "Current receiver");
  assert.equal(installed, 2);
  assert.equal(installDetails[0].world, "MAIN");
  assert.equal(JSON.stringify(installDetails[0].files), JSON.stringify(["page-media-probe.js"]));
  assert.equal(JSON.stringify(installDetails[1].files), JSON.stringify(["extension-protocol.js", "appearance.js", "article-extractor.js", "page-capture.js", "content-script.js"]));
  assert.equal(calls, 2);
});

test("extension startup installs the idempotent receiver into every existing matching tab", async () => {
  const protocol = await loadProtocol();
  const installed = [];
  const receiver = protocol.createContentReceiverBridge({
    tabs: {
      async query(filter) {
        assert.equal(JSON.stringify(filter.url), JSON.stringify(["http://*/*", "https://*/*"]));
        return [{ id: 4 }, { id: 8 }, { id: null }];
      },
      sendMessage: async () => ({}),
    },
    scripting: {
      async executeScript(details) {
        installed.push(`${details.target.tabId}:${details.world || "ISOLATED"}`);
        return [];
      },
    },
  });

  await receiver.installOpenTabs();

  assert.equal(JSON.stringify(installed.sort()), JSON.stringify([
    "4:ISOLATED", "4:MAIN", "8:ISOLATED", "8:MAIN",
  ]));
});

test("reinstalling the production content receiver leaves exactly one listener set", async () => {
  const { sandbox, contentSource, documentListeners, runtimeListeners } = await loadContentScriptSandbox();

  vm.runInContext(contentSource, sandbox, { filename: "content-script.js" });
  const firstCounts = {
    mousemove: documentListeners.get("mousemove")?.size,
    contextmenu: documentListeners.get("contextmenu")?.size,
    runtime: runtimeListeners.size,
  };
  vm.runInContext(contentSource, sandbox, { filename: "content-script.js" });

  assert.ok(firstCounts.mousemove > 0);
  assert.ok(firstCounts.contextmenu > 0);
  assert.ok(firstCounts.runtime > 0);
  assert.deepEqual({
    mousemove: documentListeners.get("mousemove")?.size,
    contextmenu: documentListeners.get("contextmenu")?.size,
    runtime: runtimeListeners.size,
  }, firstCounts);
});

test("an invalidated extension receiver retires its video hosts and listeners before handling another player event", async () => {
  const { sandbox, contentSource, documentListeners, runtimeListeners } = await loadContentScriptSandbox();
  sandbox.chrome.runtime.id = "collector-fixture";
  sandbox.innerWidth = 1200;
  sandbox.innerHeight = 800;
  const video = new sandbox.HTMLVideoElement();
  Object.assign(video, {
    isConnected: true,
    getBoundingClientRect: () => ({ left: 100, top: 100, right: 400, bottom: 300, width: 300, height: 200 }),
  });
  vm.runInContext(contentSource, sandbox, { filename: "content-script.js" });
  sandbox.document.dispatchEvent({ type: "play", target: video });
  const host = sandbox.document.documentElement.__lrChildren.find(
    (node) => node.getAttribute?.("data-luckyray-video-capture") !== null,
  );
  assert.ok(host?.isConnected, "the valid receiver first mounts its player button");
  const queuedPlay = [...documentListeners.get("play")][0];

  // Reloading an extension invalidates its runtime while the page retains
  // the old isolated world's DOM event listeners and overlay references.
  delete sandbox.chrome.runtime.id;
  sandbox.document.dispatchEvent({ type: "play", target: video });
  assert.equal(host.isConnected, false, "the old player button must be removed");
  assert.equal([...documentListeners.values()].reduce((sum, listeners) => sum + listeners.size, 0), 0);
  assert.equal(runtimeListeners.size, 0);

  const appendedBefore = sandbox.document.documentElement.__lrChildren.length;
  queuedPlay({ type: "play", target: video });
  assert.equal(sandbox.document.documentElement.__lrChildren.length, appendedBefore,
    "a queued callback cannot reattach the retired player button");
});

test("a fresh receiver removes orphan collector and video-overlay hosts left by an invalidated extension world", async () => {
  const { sandbox, contentSource } = await loadContentScriptSandbox();
  const removed = [];
  const orphanCollector = { remove: () => removed.push("collector") };
  const orphanOverlay = { remove: () => removed.push("overlay") };
  sandbox.document.querySelectorAll = (selector) => selector.includes("data-luckyray-drag-collector")
    ? [orphanCollector, orphanOverlay]
    : [];

  vm.runInContext(contentSource, sandbox, { filename: "content-script.js" });

  assert.deepEqual(removed, ["collector", "overlay"]);
});

test("an embedded frame never creates a second page-level drag collector", async () => {
  const { sandbox, contentSource, documentListeners } = await loadContentScriptSandbox();
  const nodes = [];
  const createNode = (tagName) => {
    const listeners = new Map();
    const node = {
      tagName: String(tagName || "div").toUpperCase(), className: "", style: {}, children: [], isConnected: true,
      setAttribute(name, value) { this[name] = String(value); }, getAttribute: () => "", querySelectorAll: () => [],
      append(...children) { this.children.push(...children); }, appendChild(child) { this.children.push(child); return child; },
      addEventListener(type, listener) { listeners.set(type, listener); }, removeEventListener(type) { listeners.delete(type); },
      attachShadow() { return createNode("shadow-root"); }, remove() {},
    };
    nodes.push(node);
    return node;
  };
  const image = new sandbox.HTMLImageElement();
  Object.assign(image, {
    currentSrc: "https://cdn.test/frame.jpg", src: "https://cdn.test/frame.jpg", srcset: "", draggable: true,
    isConnected: true, getAttribute: () => "", querySelectorAll: () => [], closest: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 200, bottom: 120, width: 200, height: 120 }),
  });
  sandbox.top = {};
  Object.assign(sandbox.document, {
    documentElement: createNode("html"), createElement: createNode,
    querySelectorAll: () => [], elementsFromPoint: () => [image],
  });
  vm.runInContext(contentSource, sandbox, { filename: "content-script.js" });
  for (const listener of documentListeners.get("dragstart")) {
    listener({ target: image, clientX: 40, clientY: 40, dataTransfer: { effectAllowed: "all" } });
  }
  assert.equal(nodes.some((node) => Object.hasOwn(node, "data-luckyray-drag-collector")), false);
});

test("a Pinterest feed drag stays on the resolved video path even before an exact Pin id is known", async () => {
  const { sandbox, contentSource, documentListeners, runtimeMessages } = await loadContentScriptSandbox(async (message) => {
    if (message.type === "luckyray-drag-folders") return { ok: true, folders: [] };
    if (message.type === "luckyray-drag-collect") return { ok: true };
    return {};
  });
  const nodes = [];
  const createNode = (tagName) => {
    const listeners = new Map();
    const node = {
      tagName: String(tagName || "div").toUpperCase(), className: "", textContent: "", style: {}, dataset: {},
      children: [], parentNode: null, isConnected: true, draggable: false,
      setAttribute(name, value) { this[name] = String(value); }, getAttribute(name) { return this[name] ?? null; },
      hasAttribute(name) { return Object.hasOwn(this, name); }, removeAttribute(name) { delete this[name]; },
      append(...children) { for (const child of children) this.appendChild(child); },
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
      replaceChildren(...children) { this.children = []; this.append(...children); },
      addEventListener(type, listener) { listeners.set(type, listener); }, removeEventListener(type) { listeners.delete(type); },
      attachShadow() { this.shadowForTest = createNode("shadow-root"); return this.shadowForTest; },
      remove() { this.isConnected = false; }, querySelector() { return null; }, querySelectorAll() { return []; },
      dispatch(type, event = {}) { return listeners.get(type)?.({ preventDefault() {}, stopPropagation() {}, ...event }); },
    };
    nodes.push(node);
    return node;
  };
  const video = new sandbox.HTMLVideoElement();
  Object.assign(video, {
    tagName: "VIDEO",
    currentSrc: "https://v1.pinimg.com/videos/card_360w.cmfv?token=PRIVATE-LOW",
    src: "https://v1.pinimg.com/videos/card_360w.cmfv?token=PRIVATE-LOW",
    type: "video/mp4",
    videoWidth: 360,
    videoHeight: 416,
    parentElement: null,
    isConnected: true,
    matches: () => false,
    getAttribute: () => "",
    querySelectorAll: () => [],
    closest: () => null,
    getBoundingClientRect: () => ({ left: 40, top: 40, right: 400, bottom: 456, width: 360, height: 416 }),
  });
  const documentElement = createNode("html");
  Object.assign(sandbox.document, {
    documentElement, createElement: createNode,
    querySelectorAll: (selector) => selector === "video" ? [video] : [],
    elementsFromPoint: () => [video],
  });
  sandbox.location.href = "https://www.pinterest.com/";
  sandbox.innerWidth = 1_200;
  sandbox.innerHeight = 800;
  vm.runInContext(contentSource, sandbox, { filename: "content-script.js" });

  for (const listener of documentListeners.get("dragstart")) {
    listener({ target: video, clientX: 100, clientY: 100, composedPath: () => [video], dataTransfer: { effectAllowed: "all" } });
  }
  const dropZone = nodes.find((node) => node.className === "lr-drag-dropzone");
  assert.ok(dropZone);
  await dropZone.dispatch("drop", { dataTransfer: { dropEffect: "copy" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const descriptor = runtimeMessages.find((message) => message.type === "luckyray-drag-collect");
  assert.equal(descriptor?.mediaType, "video");
  assert.equal(descriptor?.resolveVideo, true, "Pinterest drag must not bypass candidate resolution into a low CMFV direct import");
  assert.equal(descriptor?.url, undefined);
  assert.equal(descriptor?.resolverPageUrl, "");
  assert.match(JSON.stringify(descriptor?.playerCandidates), /card_360w\.cmfv/);
});

test("a source-less Pinterest card still gets one player chip and one exact resolver drag descriptor", async () => {
  const { sandbox, contentSource, documentListeners, runtimeMessages } = await loadContentScriptSandbox(async (message) => {
    if (message.type === "luckyray-video-overlay-open") return {
      ok: true,
      sessionId: "pin-source-less",
      items: [{ candidateId: "pin-resolver", label: "解析最佳版本", host: "pinterest.com", kind: "site-resolver", canSaveToMaterials: true }],
      canRecord: true,
    };
    if (message.type === "luckyray-drag-folders") return { ok: true, folders: [] };
    return {};
  });
  const nodes = [];
  const createNode = (tagName) => {
    const listeners = new Map();
    const node = {
      tagName: String(tagName || "div").toUpperCase(), className: "", textContent: "", style: {}, dataset: {},
      children: [], parentNode: null, isConnected: true, draggable: false,
      setAttribute(name, value) { this[name] = String(value); }, getAttribute(name) { return this[name] ?? null; },
      hasAttribute(name) { return Object.hasOwn(this, name); }, removeAttribute(name) { delete this[name]; },
      append(...children) { for (const child of children) this.appendChild(child); },
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
      replaceChildren(...children) { this.children = []; this.append(...children); },
      addEventListener(type, listener) { listeners.set(type, listener); }, removeEventListener(type) { listeners.delete(type); },
      attachShadow() { this.shadowForTest = createNode("shadow-root"); return this.shadowForTest; },
      remove() { this.isConnected = false; }, querySelector() { return null; }, querySelectorAll() { return []; },
      dispatch(type, event = {}) { return listeners.get(type)?.({ preventDefault() {}, stopPropagation() {}, ...event }); },
    };
    nodes.push(node);
    return node;
  };
  const pin = new sandbox.Element();
  Object.assign(pin, {
    parentElement: null, matches: () => false, querySelectorAll: () => [],
    getAttribute: (name) => name === "data-pin-id" ? "987654321" : "",
  });
  const video = new sandbox.HTMLVideoElement();
  Object.assign(video, {
    tagName: "VIDEO", currentSrc: "", src: "", type: "", videoWidth: 360, videoHeight: 640,
    duration: 12, draggable: false, isConnected: true, parentElement: pin,
    getAttribute: () => "", querySelectorAll: () => [], querySelector: () => null, closest: () => video,
    getBoundingClientRect: () => ({ left: 100, top: 80, right: 460, bottom: 720, width: 360, height: 640 }),
  });
  const cover = new sandbox.Element();
  Object.assign(cover, createNode("div"), {
    querySelector: (selector) => selector === "video" ? video : null,
    querySelectorAll: (selector) => selector.includes("video") ? [video] : [],
    getBoundingClientRect: video.getBoundingClientRect,
  });
  const documentElement = createNode("html");
  Object.assign(sandbox.document, {
    documentElement, createElement: createNode,
    querySelectorAll: (selector) => selector === "video" ? [video] : [],
    elementsFromPoint: () => [cover, video],
  });
  sandbox.location.href = "https://www.pinterest.com/";
  sandbox.innerWidth = 1_400;
  sandbox.innerHeight = 900;
  vm.runInContext(contentSource, sandbox, { filename: "content-script.js" });
  sandbox.document.addEventListener("__luckyray_pinterest_detail_request_v1__", (event) => {
    sandbox.document.dispatchEvent(new sandbox.CustomEvent("__luckyray_page_media_probe_v1__", { detail: {
      version: 1,
      kind: "pinterest-video-catalog",
      requestId: event.detail.requestId,
      pinId: "987654321",
      pageUrl: "https://www.pinterest.com/pin/987654321/",
      variants: [{
        url: "https://v1.pinimg.com/videos/source-less_960w.cmfv",
        width: 960,
        height: 1_280,
      }],
    } }));
  });

  for (const listener of documentListeners.get("mousemove")) {
    listener({ clientX: 220, clientY: 240, target: cover });
  }
  const chip = nodes.find((node) => node.className === "lr-chip");
  assert.ok(chip, "a card video must expose its player action before a direct URL is available");
  await chip.dispatch("click");
  const opened = runtimeMessages.find((message) => message.type === "luckyray-video-overlay-open");
  assert.equal(opened.resolverPageUrl, "https://www.pinterest.com/pin/987654321/");
  assert.match(JSON.stringify(opened.playerCandidates), /source-less_960w\.cmfv/);

  for (const listener of documentListeners.get("pointerdown")) {
    listener({ button: 0, target: cover, clientX: 220, clientY: 240, composedPath: () => [cover] });
  }
  assert.equal(String(cover.draggable), "true");
  for (const listener of documentListeners.get("dragstart")) {
    listener({ target: cover, clientX: 220, clientY: 240, composedPath: () => [cover], dataTransfer: { effectAllowed: "all" } });
  }
  const request = runtimeMessages.find((message) => message.type === "luckyray-drag-collect");
  const dropZone = nodes.find((node) => node.className === "lr-drag-dropzone");
  assert.ok(dropZone, "one top-level drag collector must open");
  await dropZone.dispatch("drop", { dataTransfer: { dropEffect: "copy" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const drag = runtimeMessages.find((message) => message.type === "luckyray-drag-collect");
  assert.equal(drag?.resolverPageUrl, "https://www.pinterest.com/pin/987654321/");
  assert.equal(request, undefined, "the import request is emitted only after dropping into the collector");
});

test("the installed production receiver captures a real hover descriptor and answers with descriptor.url", async () => {
  const { sandbox, contentSource, documentListeners, runtimeListeners, runtimeMessages } = await loadContentScriptSandbox();
  const image = new sandbox.HTMLImageElement();
  Object.assign(image, {
    tagName: "IMG",
    currentSrc: "https://cdn.test/hovered.jpg",
    src: "https://cdn.test/fallback.jpg",
    srcset: "",
    parentElement: null,
    isConnected: true,
    closest: () => null,
    getAttribute: () => "",
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 200, bottom: 120, width: 200, height: 120 }),
    querySelectorAll: () => [],
  });
  sandbox.document.elementsFromPoint = () => [image];
  vm.runInContext(contentSource, sandbox, { filename: "content-script.js" });

  for (const listener of documentListeners.get("mousemove")) {
    listener({ clientX: 40, clientY: 30, target: image });
  }
  const announced = runtimeMessages.find((message) => message.type === "luckyray-context-image");
  assert.equal(announced?.descriptor?.url, image.currentSrc);

  let response = null;
  for (const listener of runtimeListeners) {
    listener({ type: "luckyray-get-hover-image" }, {}, (value) => { response = value; });
  }
  assert.equal(response?.url, image.currentSrc);
});

test("the production hover receiver keeps the upgraded image candidate valid through popup retrieval", async () => {
  const { sandbox, contentSource, documentListeners, runtimeListeners, runtimeMessages } = await loadContentScriptSandbox();
  const image = new sandbox.HTMLImageElement();
  Object.assign(image, {
    tagName: "IMG",
    currentSrc: "https://cdn.test/article-640.jpg",
    src: "https://cdn.test/article-320.jpg",
    srcset: "https://cdn.test/article-640.jpg 640w, https://cdn.test/article-2400.jpg 2400w",
    parentElement: null,
    isConnected: true,
    closest: () => null,
    getAttribute(name) {
      return name === "srcset" ? this.srcset : "";
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 260, bottom: 180, width: 260, height: 180 }),
    querySelectorAll: () => [],
  });
  sandbox.document.elementsFromPoint = () => [image];
  vm.runInContext(contentSource, sandbox, { filename: "content-script.js" });

  for (const listener of documentListeners.get("mousemove")) {
    listener({ clientX: 50, clientY: 40, target: image });
  }
  const announced = runtimeMessages.find((message) => message.type === "luckyray-context-image");
  // M1-S3 PRODUCT-DIRECTION: same-target srcset w-tier may beat the
  // displayed tier (the announced candidate is the HD source).
  assert.equal(announced?.descriptor?.url, "https://cdn.test/article-2400.jpg");

  for (const listener of documentListeners.get("contextmenu")) {
    listener({ clientX: 50, clientY: 40, target: image });
  }
  let response = null;
  for (const listener of runtimeListeners) {
    listener({ type: "luckyray-get-hover-image" }, {}, (value) => { response = value; });
  }
  assert.equal(response?.url, "https://cdn.test/article-2400.jpg");
  assert.equal(response?.browserUrl, "https://cdn.test/article-640.jpg");
  assert.equal(response?.confidence, "contextmenu");
});

test("the popup adapter consumes descriptor.url and contains legacy src compatibility at one boundary", async () => {
  const protocol = await loadProtocol();

  // EXT-R1-R1 P1-2: the adapter additionally carries the bounded revalidated
  // descriptor (commit-identity fields only) next to the compatibility URL.
  const imagePayload = protocol.toPopupMediaPayload("image", { type: "image", url: "https://cdn.test/new.jpg", capturedAt: 123, tabId: 5, frameId: 2, documentId: "d", documentToken: "t", targetToken: "k", scrollX: 0, scrollY: 0, confidence: "hover-point" });
  assert.equal(imagePayload.imageUrl, "https://cdn.test/new.jpg");
  assert.equal(imagePayload.descriptor.url, "https://cdn.test/new.jpg");
  assert.equal(imagePayload.descriptor.tabId, 5);
  assert.equal(imagePayload.descriptor.capturedAt, 123);
  assert.ok(!JSON.stringify(imagePayload).includes("content"), "descriptor projection must stay identity-bounded (no page content)");
  const videoPayload = protocol.toPopupMediaPayload("video", { type: "video", src: "https://cdn.test/legacy.mp4" });
  assert.equal(videoPayload.videoUrl, "https://cdn.test/legacy.mp4");
});

test("reload injection, new hover capture, receiver response, and popup adaptation share one production chain", async () => {
  const fixture = await loadContentScriptSandbox();
  const { sandbox, contentSource, documentListeners, runtimeListeners } = fixture;
  const image = new sandbox.HTMLImageElement();
  Object.assign(image, {
    tagName: "IMG",
    currentSrc: "https://cdn.test/reloaded-hover.jpg",
    src: "",
    srcset: "",
    parentElement: null,
    isConnected: true,
    closest: () => null,
    getAttribute: () => "",
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 180, bottom: 100, width: 180, height: 100 }),
    querySelectorAll: () => [],
  });
  sandbox.document.elementsFromPoint = () => [image];
  sandbox.chrome.tabs = {
    query: async () => [],
    async sendMessage(_tabId, message) {
      if (runtimeListeners.size === 0) throw new Error("Receiving end does not exist");
      let response = {};
      for (const listener of runtimeListeners) listener(message, {}, (value) => { response = value; });
      return response;
    },
  };
  sandbox.chrome.scripting = {
    async executeScript(details) {
      if (details.world === "MAIN") {
        assert.equal(JSON.stringify(details.files), JSON.stringify(["page-media-probe.js"]));
      } else {
        assert.equal(JSON.stringify(details.files), JSON.stringify(["extension-protocol.js", "appearance.js", "article-extractor.js", "page-capture.js", "content-script.js"]));
        vm.runInContext(contentSource, sandbox, { filename: "content-script.js" });
      }
      return [];
    },
  };
  const receiver = sandbox.LuckyRayExtensionProtocol.createContentReceiverBridge(sandbox.chrome);

  assert.equal(
    JSON.stringify(await receiver.request(9, { type: "luckyray-get-hover-image" }, { frameId: 0 })),
    JSON.stringify({}),
  );
  for (const listener of documentListeners.get("mousemove")) listener({ clientX: 30, clientY: 20, target: image });
  const descriptor = await receiver.request(9, { type: "luckyray-get-hover-image" }, { frameId: 0 });
  const popupPayload = sandbox.LuckyRayExtensionProtocol.toPopupMediaPayload("image", descriptor);

  assert.equal(descriptor.url, image.currentSrc);
  assert.equal(popupPayload.imageUrl, image.currentSrc);
});

test("context-menu URL wins over cached hover and one in-flight import intent executes once", async () => {
  const protocol = await loadProtocol();
  const descriptor = protocol.createCaptureDescriptor({
    type: "image",
    url: "https://cdn.test/stale.jpg",
    capturedAt: 2_000,
    confidence: "hover-point",
    tabId: 3,
    frameId: 0,
    documentId: "doc",
    documentToken: "token",
    clientX: 1,
    clientY: 1,
    scrollX: 0,
    scrollY: 0,
    targetToken: "old",
  });
  const selected = protocol.chooseContextMenuMedia({
    type: "image",
    infoUrl: "https://cdn.test/right-clicked.jpg",
    descriptor,
  });
  assert.equal(selected.url, "https://cdn.test/right-clicked.jpg");
  assert.equal(selected.confidence, "browser-contextmenu");
  assert.doesNotMatch(selected.actionId, /cdn\.test|right-clicked/);

  const gate = protocol.createActionGate();
  const intent = protocol.createMaterialImportIntent({
    actionId: "action-1",
    mediaType: "image",
    url: selected.url,
    targetFolderId: "folder-a",
    storageMode: "managed",
    mode: "asset:pick",
  });
  let calls = 0;
  const operation = async () => {
    calls += 1;
    return { ok: true };
  };
  const first = gate.run(intent, operation);
  const replay = gate.run(intent, operation);
  assert.equal(first, replay);
  await Promise.all([first, replay]);
  assert.equal(calls, 1);
});

test("a fresh context-menu descriptor upgrades only the exact browser-reported image", async () => {
  const protocol = await loadProtocol();
  const descriptor = protocol.createCaptureDescriptor({
    type: "image",
    url: "https://cdn.test/right-clicked-original.jpg",
    browserUrl: "https://cdn.test/right-clicked-thumb.jpg",
    capturedAt: 2_000,
    confidence: "contextmenu",
    targetToken: "exact-image",
  });

  assert.equal(
    protocol.chooseContextMenuMedia({
      type: "image",
      infoUrl: "https://cdn.test/right-clicked-thumb.jpg",
      descriptor,
    }).url,
    "https://cdn.test/right-clicked-original.jpg",
  );
  assert.equal(
    protocol.chooseContextMenuMedia({
      type: "image",
      infoUrl: "https://cdn.test/other-image.jpg",
      descriptor,
    }).url,
    "https://cdn.test/other-image.jpg",
  );
});

test("folder, new-folder parent, storage mode, and capture URL are distinct import intents", async () => {
  const protocol = await loadProtocol();
  const gate = protocol.createActionGate();
  const base = {
    actionId: "shared-action",
    mediaType: "image",
    url: "https://cdn.test/left.jpg",
    storageMode: "managed",
    mode: "asset:pick",
  };
  const inputs = [
    { ...base, targetFolderId: "folder-a" },
    { ...base, targetFolderId: "folder-b" },
    { ...base, targetFolderId: "folder-a", storageMode: "source" },
    { ...base, mode: "asset:newFolder", newFolderName: "A", parentFolderId: "parent-a" },
    { ...base, mode: "asset:newFolder", newFolderName: "A", parentFolderId: "parent-b" },
    { ...base, url: "https://cdn.test/right.jpg", targetFolderId: "folder-a" },
  ];
  let calls = 0;
  const releases = [];
  const promises = inputs.map((input) => gate.run(protocol.createMaterialImportIntent(input), () => new Promise((resolve) => {
    calls += 1;
    releases.push(resolve);
  })));

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, inputs.length);
  releases.forEach((resolve, index) => resolve({ index }));
  await Promise.all(promises);
});

test("failed, imported, and duplicate results are never cached after the in-flight request settles", async () => {
  const protocol = await loadProtocol();
  const gate = protocol.createActionGate();
  const intent = protocol.createMaterialImportIntent({
    actionId: "retryable-action",
    mediaType: "image",
    url: "https://cdn.test/retry.jpg",
    targetFolderId: "folder-a",
    storageMode: "managed",
    mode: "asset:pick",
  });
  let calls = 0;

  await assert.rejects(gate.run(intent, async () => {
    calls += 1;
    throw new Error("temporary 401");
  }), /temporary 401/);
  const imported = await gate.run(intent, async () => {
    calls += 1;
    return { disposition: "imported" };
  });
  const duplicate = await gate.run(intent, async () => {
    calls += 1;
    return { disposition: "duplicate" };
  });

  assert.equal(calls, 3);
  assert.equal(imported.disposition, "imported");
  assert.equal(duplicate.disposition, "duplicate");
});

test("a stale promise finally cannot delete a newer active request with the same intent key", async () => {
  const protocol = await loadProtocol();
  let now = 0;
  const gate = protocol.createActionGate({ now: () => now, maxInFlightAgeMs: 10 });
  const intent = protocol.createMaterialImportIntent({
    actionId: "same-action",
    mediaType: "image",
    url: "https://cdn.test/same.jpg",
    targetFolderId: "folder-a",
    storageMode: "managed",
    mode: "asset:pick",
  });
  let resolveOld;
  let resolveNew;
  const oldPromise = gate.run(intent, () => new Promise((resolve) => { resolveOld = resolve; }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  now = 11;
  const newPromise = gate.run(intent, () => new Promise((resolve) => { resolveNew = resolve; }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  resolveOld("old");
  await oldPromise;
  let unexpectedCalls = 0;
  const joinedNew = gate.run(intent, async () => {
    unexpectedCalls += 1;
    return "unexpected";
  });
  assert.equal(joinedNew, newPromise);
  assert.equal(unexpectedCalls, 0);

  resolveNew("new");
  assert.equal(await joinedNew, "new");
  assert.equal(unexpectedCalls, 0);
});

test("video point capture accepts an exact normal source and marks blob as non-importable", async () => {
  const protocol = await loadProtocol();
  const normal = {
    tagName: "VIDEO",
    currentSrc: "https://cdn.test/clip.mp4",
    rect: { left: 10, top: 10, right: 310, bottom: 210 },
  };
  const blob = {
    tagName: "VIDEO",
    currentSrc: "blob:https://site.test/123",
    rect: { left: 320, top: 10, right: 620, bottom: 210 },
  };
  assert.equal(
    JSON.stringify(protocol.selectPointMedia("video", 20, 20, [normal])),
    JSON.stringify({ url: normal.currentSrc, importable: true }),
  );
  assert.equal(
    JSON.stringify(protocol.selectPointMedia("video", 400, 20, [blob])),
    JSON.stringify({ url: blob.currentSrc, importable: false }),
  );
});

test("the selected video element prefers its downloadable source over its blob playback URL", async () => {
  const protocol = await loadProtocol();
  const source = {
    tagName: "SOURCE",
    src: "https://media.test/original-video.mp4",
    type: "video/mp4",
    getAttribute(name) {
      return name === "src" ? this.src : name === "type" ? this.type : "";
    },
  };
  const video = {
    tagName: "VIDEO",
    currentSrc: "blob:https://page.test/playback",
    src: "",
    querySelectorAll: (selector) => selector === "source[src]" ? [source] : [],
    getAttribute: () => "",
    rect: { left: 0, top: 0, right: 400, bottom: 240 },
  };

  assert.deepEqual(
    JSON.parse(JSON.stringify(protocol.selectPointMedia("video", 100, 80, [video]))),
    { url: "https://media.test/original-video.mp4", importable: true },
  );
});

test("a player exposes every bounded downloadable source variant without its poster or blob URL", async () => {
  const protocol = await loadProtocol();
  const sources = [360, 720, 1080].map((height) => ({
    tagName: "SOURCE",
    src: `https://media.test/movie-${height}p.mp4?token=fixture`,
    type: "video/mp4",
    media: `(min-width: ${height}px)`,
    getAttribute(name) {
      return this[name] || "";
    },
  }));
  const video = {
    tagName: "VIDEO",
    currentSrc: "blob:https://page.test/current",
    src: "",
    poster: "https://media.test/poster.jpg",
    videoWidth: 1920,
    videoHeight: 1080,
    duration: 12.5,
    querySelectorAll: (selector) => selector === "source[src]" ? sources : [],
    getAttribute(name) {
      return this[name] || "";
    },
  };

  const variants = protocol.collectVideoElementCandidates(video, "https://page.test/watch");
  assert.equal(variants.length, 4);
  assert.equal(variants[0].kind, "blob");
  assert.equal(variants.filter((variant) => variant.kind === "direct-video").length, 3);
  assert.equal(variants.at(-1).height, 1080);
  assert.equal(variants.at(-1).duration, 12.5);
  assert.doesNotMatch(JSON.stringify(variants), /poster\.jpg/);
});

test("the production hover receiver publishes the downloadable source before a blob fallback", async () => {
  const { sandbox, contentSource, documentListeners, runtimeMessages } = await loadContentScriptSandbox();
  const source = new sandbox.HTMLSourceElement();
  Object.assign(source, {
    tagName: "SOURCE",
    src: "https://media.test/production-original.webm",
    type: "video/webm",
    parentElement: null,
    isConnected: true,
    getAttribute(name) {
      return name === "src" ? this.src : name === "type" ? this.type : "";
    },
  });
  const video = new sandbox.HTMLVideoElement();
  Object.assign(video, {
    tagName: "VIDEO",
    currentSrc: "blob:https://page.test/production-playback",
    src: "",
    parentElement: null,
    isConnected: true,
    getAttribute: () => "",
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 480, bottom: 270, width: 480, height: 270 }),
    querySelectorAll: (selector) => selector === "source[src]" ? [source] : [],
    querySelector: () => null,
  });
  source.closest = (selector) => selector === "video" ? video : null;
  sandbox.document.elementsFromPoint = () => [video];
  vm.runInContext(contentSource, sandbox, { filename: "content-script.js" });

  for (const listener of documentListeners.get("mousemove")) {
    listener({ clientX: 100, clientY: 80, target: video });
  }
  const announced = runtimeMessages.find((message) => message.type === "luckyray-context-video");
  assert.equal(announced?.descriptor?.url, "https://media.test/production-original.webm");
  assert.equal(announced?.descriptor?.importable, true);
});

test("an off-point video elsewhere in the same card grid cannot replace the hovered image", async () => {
  const { sandbox, contentSource, documentListeners, runtimeMessages } = await loadContentScriptSandbox();
  const container = new sandbox.Element();
  const image = new sandbox.HTMLImageElement();
  const unrelatedVideo = new sandbox.HTMLVideoElement();
  Object.assign(unrelatedVideo, {
    tagName: "VIDEO",
    currentSrc: "https://media.test/unrelated.mp4",
    src: "",
    parentElement: container,
    getAttribute: () => "",
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 500, top: 500, right: 800, bottom: 700, width: 300, height: 200 }),
  });
  Object.assign(container, {
    tagName: "DIV",
    parentElement: null,
    querySelector: (selector) => selector.includes("video") ? unrelatedVideo : null,
    querySelectorAll: (selector) => selector.includes("video") ? [unrelatedVideo] : [],
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 900, bottom: 900, width: 900, height: 900 }),
  });
  Object.assign(image, {
    tagName: "IMG",
    currentSrc: "https://images.test/current-card.jpg",
    src: "https://images.test/current-card.jpg",
    srcset: "",
    parentElement: container,
    isConnected: true,
    getAttribute: () => "",
    closest: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 320, bottom: 420, width: 320, height: 420 }),
  });
  sandbox.document.elementsFromPoint = () => [image, container];
  vm.runInContext(contentSource, sandbox, { filename: "content-script.js" });

  for (const listener of documentListeners.get("mousemove")) {
    listener({ clientX: 100, clientY: 100, target: image });
  }

  assert.equal(runtimeMessages.some((message) => message.type === "luckyray-context-video"), false);
  assert.equal(runtimeMessages.filter((message) => message.type === "luckyray-context-kind").at(-1)?.contextKind, "image");
});

test("moving directly from a video card to an image card cannot reuse the stale video hit", async () => {
  const { sandbox, contentSource, documentListeners, runtimeMessages } = await loadContentScriptSandbox();
  const video = new sandbox.HTMLVideoElement();
  Object.assign(video, {
    tagName: "VIDEO",
    currentSrc: "https://media.test/first-card.mp4",
    src: "",
    parentElement: null,
    isConnected: true,
    getAttribute: () => "",
    querySelectorAll: () => [],
    querySelector: () => null,
    closest: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 300, bottom: 400, width: 300, height: 400 }),
  });
  const image = new sandbox.HTMLImageElement();
  Object.assign(image, {
    tagName: "IMG",
    currentSrc: "https://images.test/second-card.jpg",
    src: "https://images.test/second-card.jpg",
    srcset: "",
    parentElement: null,
    isConnected: true,
    getAttribute: () => "",
    querySelectorAll: () => [],
    querySelector: () => null,
    closest: () => null,
    getBoundingClientRect: () => ({ left: 320, top: 0, right: 620, bottom: 400, width: 300, height: 400 }),
  });
  let pointed = video;
  sandbox.document.elementsFromPoint = () => [pointed];
  vm.runInContext(contentSource, sandbox, { filename: "content-script.js" });

  for (const listener of documentListeners.get("mousemove")) {
    listener({ clientX: 100, clientY: 100, target: video });
  }
  runtimeMessages.length = 0;
  pointed = image;
  for (const listener of documentListeners.get("mousemove")) {
    listener({ clientX: 400, clientY: 100, target: image });
  }

  assert.equal(runtimeMessages.some((message) => message.type === "luckyray-context-video"), false);
  assert.equal(runtimeMessages.filter((message) => message.type === "luckyray-context-kind").at(-1)?.contextKind, "image");
});

test("video importability follows the actual media path and fails closed for stream formats", async () => {
  const protocol = await loadProtocol();

  assert.equal(protocol.isVideoUrlImportable("https://media.test/video.mp4?next=master.m3u8"), true);
  assert.equal(protocol.isVideoUrlImportable("https://media.test/master.M3U8?token=fixture"), false);
  assert.equal(protocol.isVideoUrlImportable("https://media.test/manifest.mpd"), false);
  assert.equal(protocol.isVideoUrlImportable("https://media.test/segment-001.m4s"), false);
  assert.equal(protocol.isVideoUrlImportable("blob:https://page.test/stream"), false);
  assert.equal(protocol.isVideoUrlImportable("https://user:fixture@media.test/video.mp4"), false);
});

test("video candidates become a bounded quality menu with LuckyRay material actions only", async () => {
  const protocol = await loadProtocol();
  const menu = protocol.buildVideoActionMenu([
    {
      url: "https://video.example.test/clip-1080p.mp4?token=PRIVATE",
      kind: "direct_video",
      direct: true,
      contentType: "video/mp4",
      size: String(12 * 1024 * 1024),
      width: 1920,
      height: 1080,
      bitrate: 2_824_000,
    },
    {
      url: "https://video.example.test/master.m3u8?token=PRIVATE",
      kind: "hls",
      direct: false,
      contentType: "application/vnd.apple.mpegurl",
      width: 1280,
      height: 720,
      bitrate: 1_612_000,
    },
    {
      url: "https://video.example.test/segment-001.ts?token=PRIVATE",
      kind: "segment",
      direct: false,
    },
    {
      url: "https://video.example.test/manifest.mpd?token=PRIVATE",
      kind: "dash",
      direct: false,
      contentType: "application/dash+xml",
      width: 3840,
      height: 2160,
    },
    {
      url: "blob:https://page.test/player",
      kind: "blob",
      direct: false,
    },
  ]);

  assert.equal(menu.items.length, 3);
  assert.equal(menu.items[0].label, "2160p · DASH");
  assert.equal(menu.items[0].canSaveToMaterials, true);
  assert.equal(menu.items[1].label, "1080p · MP4 · 12 MB");
  assert.equal(menu.items[1].canDownload, false);
  assert.equal(menu.items[1].canSaveToMaterials, true);
  assert.equal(menu.items[2].label, "720p · HLS · 1612 kbps");
  assert.equal(menu.items[2].canDownload, false);
  assert.equal(menu.items[2].canSaveToMaterials, true);
  assert.equal(menu.canRecord, true);
  assert.doesNotMatch(JSON.stringify(menu), /PRIVATE/);
});

test("a supported single-video page exposes a resolver-only material action without pretending it is a direct download", async () => {
  const protocol = await loadProtocol();
  const menu = protocol.buildVideoActionMenu([{
    url: "https://www.youtube.com/watch?v=fixture",
    contentType: "application/x-luckyray-video-page",
    source: "site-resolver",
  }]);
  assert.equal(menu.items.length, 1);
  assert.equal(menu.items[0].kind, "site-resolver");
  assert.equal(menu.items[0].canSaveToMaterials, true);
  assert.equal(menu.items[0].canDownload, false);
  assert.match(menu.items[0].label, /解析最佳版本/);
});

test("the video action chip anchors inside only a meaningful visible player", async () => {
  const protocol = await loadProtocol();

  assert.deepEqual(JSON.parse(JSON.stringify(protocol.placeVideoActionChip(
    { left: 100, top: 80, right: 900, bottom: 530, width: 800, height: 450 },
    { width: 1200, height: 800 },
  ))), { visible: true, left: 856, top: 92 });
  assert.equal(protocol.placeVideoActionChip(
    { left: 0, top: 0, right: 120, bottom: 68, width: 120, height: 68 },
    { width: 1200, height: 800 },
  ).visible, false);
  assert.equal(protocol.placeVideoActionChip(
    { left: 100, top: 900, right: 900, bottom: 1350, width: 800, height: 450 },
    { width: 1200, height: 800 },
  ).visible, false);
});

test("network-only video candidates derive conservative quality labels from their media path", async () => {
  const protocol = await loadProtocol();
  const menu = protocol.buildVideoActionMenu([{
    url: "https://cdn.test/variants/1920x1080/movie.mp4?token=fixture",
    contentType: "video/mp4",
    direct: true,
  }]);
  assert.equal(menu.items[0].label, "1080p · MP4");
});

test("Pinterest width variants are ordered by source width and HLS manifest bytes are not shown as video size", async () => {
  const protocol = await loadProtocol();
  const menu = protocol.buildVideoActionMenu([
    {
      url: "https://v1.pinimg.test/videos/pin-a_360w.cmfv?token=fixture",
      contentType: "video/mp4",
      size: 300_000,
    },
    {
      url: "https://v1.pinimg.test/videos/pin-a_720w.cmfv?token=fixture",
      contentType: "video/mp4",
      size: 1_200_000,
    },
    {
      url: "https://v1.pinimg.test/videos/pin-a_1080w.m3u8?token=fixture",
      contentType: "application/vnd.apple.mpegurl",
      size: 96_000,
    },
  ]);

  assert.deepEqual(Array.from(menu.items, (item) => item.label), [
    "1080w · HLS",
    "720w · CMFV · 1.1 MB",
    "360w · CMFV · 0.3 MB",
  ]);
});

test("an adaptive HLS master is labelled as the preferred high-resolution choice", async () => {
  const protocol = await loadProtocol();
  const menu = protocol.buildVideoActionMenu([
    {
      url: "https://v1.pinimg.test/videos/pin-a_416w.cmfv?token=fixture",
      contentType: "video/mp4",
      width: 416,
      height: 0,
    },
    {
      url: "https://v1.pinimg.test/videos/pin-a-master.m3u8?token=fixture",
      contentType: "application/vnd.apple.mpegurl",
    },
  ]);

  assert.equal(menu.items[0].label, "优先高分辨率 · HLS");
  assert.equal(menu.items[1].label, "416w · CMFV");
});

test("recording fallback has auditable byte and duration limits instead of unbounded chunk retention", async () => {
  const protocol = await loadProtocol();
  let now = 1_000;
  const budget = protocol.createRecordingBudget({
    maxBytes: 10,
    maxDurationMs: 100,
    now: () => now,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(budget.addChunk(6))), { ok: true, bytes: 6 });
  assert.deepEqual(JSON.parse(JSON.stringify(budget.addChunk(5))), {
    ok: false,
    code: "recording-size-limit",
    bytes: 6,
  });
  now = 1_101;
  assert.deepEqual(JSON.parse(JSON.stringify(budget.checkTime())), {
    ok: false,
    code: "recording-duration-limit",
    bytes: 6,
  });
});

test("media transfer snapshots expose bounded progress without URL or staging details", async () => {
  const protocol = await loadProtocol();
  const parsed = protocol.parseMediaTransferSnapshot({
    transferId: "media-abcdef-1234567890abcdef",
    state: "running",
    bytesReceived: 2048,
    totalBytes: 4096,
    fileName: "clip.mp4",
    mimeType: "video/mp4",
    url: "https://private.test/video.mp4?token=PRIVATE",
    stagingPath: "C:\\PRIVATE\\clip.part",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), {
    ok: true,
    transferId: "media-abcdef-1234567890abcdef",
    state: "running",
    bytesReceived: 2048,
    totalBytes: 4096,
    percent: 50,
    fileName: "clip.mp4",
    mimeType: "video/mp4",
    assetId: null,
    assetName: null,
    assetKind: null,
    skippedDuplicate: false,
    errorCode: null,
  });
  assert.doesNotMatch(JSON.stringify(parsed), /PRIVATE|https?:|stagingPath/i);
  assert.equal(protocol.parseMediaTransferSnapshot({ transferId: "../escape", state: "running" }).ok, false);
});

test("media transfer progress projects determinate and indeterminate states for the visible progress bar", async () => {
  const protocol = await loadProtocol();
  assert.deepEqual(JSON.parse(JSON.stringify(protocol.buildMediaTransferProgress({
    state: "running",
    percent: 50,
  }))), {
    label: "正在下载 50%",
    percent: 50,
    indeterminate: false,
    terminal: false,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(protocol.buildMediaTransferProgress({
    state: "running",
    percent: null,
  }))), {
    label: "正在解析并下载",
    percent: null,
    indeterminate: true,
    terminal: false,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(protocol.buildMediaTransferProgress({
    state: "failed",
    percent: null,
  }))), {
    label: "入库失败",
    percent: 0,
    indeterminate: false,
    terminal: true,
  });
});

test("video data attributes cannot replace a real video with a poster image", async () => {
  const protocol = await loadProtocol();
  const video = {
    tagName: "VIDEO",
    currentSrc: "https://media.test/movie.mp4",
    src: "",
    querySelectorAll: () => [],
    getAttribute: (name) => name === "data-original" ? "https://media.test/poster.jpg" : "",
  };

  assert.equal(protocol.selectVideoCandidate(video, "https://page.test/article")?.url, "https://media.test/movie.mp4");
});

test("a page snapshot prioritizes selected text and keeps bounded safe metadata", async () => {
  const protocol = await loadProtocol();
  const snapshot = protocol.createPageSnapshot({
    url: "https://example.test/articles/42?view=full#comments",
    canonicalUrl: "/articles/42",
    title: "  A useful article  ",
    description: "A concise\u0000 description",
    author: " Example Author ",
    publishedAt: "2026-07-24T01:00:00Z",
    selection: "  Selected\n\nparagraph  ",
    articleText: "This article body must not replace the explicit selection.",
    ogImage: "https://example.test/cover.jpg",
    rawHtml: "<script>PRIVATE</script>",
  });

  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), {
    title: "A useful article",
    url: "https://example.test/articles/42?view=full",
    canonicalUrl: "https://example.test/articles/42",
    sourceUrl: "https://example.test/articles/42",
    description: "A concise description",
    author: "Example Author",
    publishedAt: "2026-07-24T01:00:00Z",
    content: "Selected\n\nparagraph",
    contentKind: "selection",
    imageUrl: "https://example.test/cover.jpg",
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /rawHtml|<script|PRIVATE/);
});

test("the production content receiver extracts article text and page metadata without page chrome", async () => {
  const { sandbox, contentSource, runtimeListeners } = await loadContentScriptSandbox();
  let chromeRemoved = false;
  const article = {
    cloneNode: () => ({
      querySelectorAll: () => [{ remove: () => { chromeRemoved = true; } }],
      get innerText() {
        return chromeRemoved ? "Article paragraph one.\n\nArticle paragraph two." : "Navigation noise";
      },
      textContent: "",
    }),
  };
  const element = (attributes) => ({
    getAttribute: (name) => attributes[name] || "",
  });
  const nodes = new Map([
    ['link[rel="canonical"]', element({ href: "/guides/safe-capture" })],
    ['meta[name="description"]', element({ content: "A bounded guide." })],
    ['meta[name="author"]', element({ content: "LuckyRay Team" })],
    ['meta[property="article:published_time"]', element({ content: "2026-07-24" })],
    ['meta[property="og:image"]', element({ content: "https://page.test/guide-cover.jpg" })],
    ["article, main, [role=\"main\"]", article],
  ]);
  Object.assign(sandbox.document, {
    title: "Safe capture guide",
    body: article,
    querySelector: (selector) => nodes.get(selector) || null,
  });
  sandbox.getSelection = () => ({ toString: () => "" });
  sandbox.location.href = "https://page.test/guides/safe-capture?from=home#section";
  vm.runInContext(contentSource, sandbox, { filename: "content-script.js" });

  let response = null;
  for (const listener of runtimeListeners) {
    listener({ type: "luckyray-get-page-context" }, {}, (value) => { response = value; });
  }

  assert.equal(chromeRemoved, true);
  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    title: "Safe capture guide",
    url: "https://page.test/guides/safe-capture?from=home",
    canonicalUrl: "https://page.test/guides/safe-capture",
    sourceUrl: "https://page.test/guides/safe-capture",
    description: "A bounded guide.",
    author: "LuckyRay Team",
    publishedAt: "2026-07-24",
    content: "Article paragraph one.\n\nArticle paragraph two.",
    contentKind: "article",
    imageUrl: "https://page.test/guide-cover.jpg",
    captureProtocolVersion: 2,
  });
});

test("page snapshots remain valid across hash changes but not SPA route changes", async () => {
  const protocol = await loadProtocol();
  const snapshot = protocol.createPageSnapshot({
    url: "https://page.test/article/one?mode=full#part-a",
    title: "Article one",
    articleText: "Body one",
  });

  assert.equal(protocol.isPageSnapshotCurrent(snapshot, "https://page.test/article/one?mode=full#part-b"), true);
  assert.equal(protocol.isPageSnapshotCurrent(snapshot, "https://page.test/article/two?mode=full"), false);
  assert.equal(protocol.isPageSnapshotCurrent(snapshot, "https://page.test/article/one?mode=compact"), false);
});

test("page capture text preserves the readable body and safe source metadata", async () => {
  const protocol = await loadProtocol();
  const snapshot = protocol.createPageSnapshot({
    url: "https://page.test/posts/one?token=fixture",
    canonicalUrl: "https://page.test/posts/one",
    title: "Post one",
    description: "Safe summary.",
    author: "Example Author",
    publishedAt: "2026-07-24",
    articleText: "Readable paragraph.",
  });

  assert.equal(protocol.formatPageCaptureText(snapshot), [
    "Readable paragraph.",
    "",
    "摘要：Safe summary.",
    "作者：Example Author",
    "发布：2026-07-24",
    "来源：https://page.test/posts/one",
  ].join("\n"));
});

test("the production page receiver derives bounded article metadata from JSON-LD without returning raw JSON", async () => {
  const { sandbox, contentSource, runtimeListeners } = await loadContentScriptSandbox();
  const emptyRoot = {
    cloneNode: () => ({ querySelectorAll: () => [], innerText: "", textContent: "" }),
  };
  const jsonLd = {
    textContent: JSON.stringify({
      "@type": "NewsArticle",
      headline: "Structured headline",
      description: "Structured description",
      author: { "@type": "Person", name: "Structured Author" },
      datePublished: "2026-07-24T02:00:00Z",
      image: { url: "https://page.test/structured-cover.jpg" },
      articleBody: "Structured article body.",
      privatePayload: "PRIVATE-JSON-LD",
    }),
  };
  Object.assign(sandbox.document, {
    title: "",
    body: emptyRoot,
    querySelector: (selector) => selector === 'article, main, [role="main"]' ? emptyRoot : null,
    querySelectorAll: (selector) => selector === 'script[type="application/ld+json"]' ? [jsonLd] : [],
  });
  sandbox.getSelection = () => ({ toString: () => "" });
  sandbox.location.href = "https://page.test/structured";
  vm.runInContext(contentSource, sandbox, { filename: "content-script.js" });

  let response = null;
  for (const listener of runtimeListeners) {
    listener({ type: "luckyray-get-page-context" }, {}, (value) => { response = value; });
  }

  assert.equal(response?.title, "Structured headline");
  assert.equal(response?.description, "Structured description");
  assert.equal(response?.author, "Structured Author");
  assert.equal(response?.publishedAt, "2026-07-24T02:00:00Z");
  assert.equal(response?.imageUrl, "https://page.test/structured-cover.jpg");
  assert.equal(response?.content, "Structured description", "JSON-LD-only articleBody is not visible user-authorized body content");
  assert.doesNotMatch(JSON.stringify(response), /privatePayload|PRIVATE-JSON-LD|NewsArticle/);
});

test("page preview exposes only compact safe fields for the popup", async () => {
  const protocol = await loadProtocol();
  const snapshot = protocol.createPageSnapshot({
    url: "https://page.test/article?private=fixture",
    title: "Preview title",
    author: "Preview Author",
    publishedAt: "2026-07-24",
    selection: "Selected preview text.",
  });

  assert.deepEqual(JSON.parse(JSON.stringify(protocol.buildPagePreview(snapshot, "text"))), {
    visible: true,
    kindLabel: "已选文字",
    title: "Preview title",
    metadata: "Preview Author · 2026-07-24",
    snippet: "Selected preview text.",
  });
  assert.equal(protocol.buildPagePreview(snapshot, "image").visible, false);
  assert.doesNotMatch(JSON.stringify(protocol.buildPagePreview(snapshot, "text")), /private=fixture/);
});

test("page snapshots bound UTF-8 content and reject cross-origin canonical metadata", async () => {
  const protocol = await loadProtocol();
  const snapshot = protocol.createPageSnapshot({
    url: "https://page.test/article?view=full",
    canonicalUrl: "https://attacker.test/other",
    title: "T".repeat(500),
    articleText: "😀".repeat(20_000),
  });

  assert.equal(snapshot.canonicalUrl, "");
  assert.equal(snapshot.sourceUrl, "https://page.test/article?view=full");
  assert.ok(Buffer.byteLength(snapshot.title, "utf8") <= 300);
  assert.ok(Buffer.byteLength(snapshot.content, "utf8") <= 64 * 1_024);
  assert.doesNotMatch(snapshot.content, /[\ud800-\udbff]$/);
});

test("the page receiver skips an empty shell and selects the populated article container", async () => {
  const { sandbox, contentSource, runtimeListeners } = await loadContentScriptSandbox();
  const root = (text) => ({
    cloneNode: () => ({ querySelectorAll: () => [], innerText: "", textContent: text }),
  });
  const emptyShell = root("");
  const populatedArticle = root("Real article paragraph one.\n\nReal article paragraph two.");
  Object.assign(sandbox.document, {
    title: "Shell page",
    body: emptyShell,
    querySelector: (selector) => selector === 'article, main, [role="main"]' ? emptyShell : null,
    querySelectorAll: (selector) => selector === 'script[type="application/ld+json"]'
      ? []
      : [emptyShell, populatedArticle],
  });
  sandbox.getSelection = () => ({ toString: () => "" });
  sandbox.location.href = "https://page.test/shell-article";
  vm.runInContext(contentSource, sandbox, { filename: "content-script.js" });

  let response = null;
  for (const listener of runtimeListeners) {
    listener({ type: "luckyray-get-page-context" }, {}, (value) => { response = value; });
  }

  assert.equal(response?.contentKind, "article");
  assert.equal(response?.content, "Real article paragraph one.\n\nReal article paragraph two.");
});

test("capture targets follow the selected content type and current note availability", async () => {
  const protocol = await loadProtocol();
  const textWithoutNote = protocol.buildCaptureTargetPolicy("text", {
    hasCurrentNote: false,
    hasRecentNotes: false,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(textWithoutNote)), {
    allowedTargets: ["note:search", "note:new", "collection:queue"],
    defaultTarget: "note:new",
    showRecording: false,
    showCurrentNote: false,
  });

  const textWithNote = protocol.buildCaptureTargetPolicy("text", {
    hasCurrentNote: true,
    hasRecentNotes: true,
  });
  assert.equal(textWithNote.defaultTarget, "note:insertCurrent");
  assert.equal(textWithNote.allowedTargets.includes("note:insertCurrent"), true);
  assert.equal(textWithNote.allowedTargets.includes("asset:root"), false);

  const video = protocol.buildCaptureTargetPolicy("video", {
    hasCurrentNote: false,
    hasRecentNotes: false,
  });
  assert.equal(video.defaultTarget, "asset:root");
  assert.equal(video.showRecording, true);
});

test("browser context menus resolve the exact clicked content instead of the wrapping link", async () => {
  const protocol = await loadProtocol();
  const specification = Array.from(protocol.buildContextMenuSpecification());
  const now = 5_000;
  const linkedImage = protocol.resolveContextMenuKind({ linkUrl: "https://example.test/card" }, {
    image: { confidence: "contextmenu", capturedAt: now - 10, linkUrl: "https://example.test/card" },
  }, now);
  assert.equal(linkedImage, "image");
  assert.equal(protocol.resolveContextMenuKind({ linkUrl: "https://example.test/card" }, {}, now), "link");
  assert.equal(protocol.resolveContextMenuKind({ selectionText: "selected" }, {
    image: { confidence: "contextmenu", capturedAt: now - 10, linkUrl: "https://example.test/card" },
  }, now), "selection");
  assert.deepEqual(
    Array.from(protocol.contextMenuVisibility(specification, linkedImage))
      .filter((item) => item.visible)
      .map((item) => item.id),
    ["luckyray-image-root", "luckyray-image-pick", "luckyray-image-new-folder"],
  );
});

test("popup page transport preserves the sanitized article body and protocol identity", async () => {
  const protocol = await loadProtocol();
  const payload = protocol.buildPopupPagePayload({
    captureProtocolVersion: protocol.CAPTURE_PROTOCOL_VERSION,
    title: "Readable page",
    url: "https://example.test/article",
    sourceUrl: "https://example.test/article",
    content: "Actual extracted article body",
    contentKind: "article",
    description: "Summary",
    author: "Author",
    publishedAt: "2026-07-24",
  }, { imageUrl: "https://example.test/image.jpg", videoUrl: "" });

  assert.equal(payload.captureProtocolVersion, protocol.CAPTURE_PROTOCOL_VERSION);
  assert.equal(payload.content, "Actual extracted article body");
  assert.equal(payload.contentKind, "article");
  assert.equal(payload.author, "Author");
  assert.equal(payload.imageUrl, "https://example.test/image.jpg");
});

test("text capture cannot save a stale empty page projection as a URL-only note", async () => {
  const protocol = await loadProtocol();
  assert.deepEqual(
    JSON.parse(JSON.stringify(protocol.pageCaptureReadiness({
      captureProtocolVersion: 0,
      title: "Page",
      url: "https://example.test/page",
      content: "",
    }, "text"))),
    { ready: false, code: "reload-required" },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(protocol.pageCaptureReadiness({
      captureProtocolVersion: protocol.CAPTURE_PROTOCOL_VERSION,
      title: "Page",
      url: "https://example.test/page",
      content: "Readable body",
    }, "text"))),
    { ready: true, code: "ready" },
  );
});

test("new page notes recover once from a name conflict without exposing the raw backend error", async () => {
  const protocol = await loadProtocol();
  const titles = [];
  const result = await protocol.createNoteWithConflictRecovery(async (title) => {
    titles.push(title);
    return titles.length === 1
      ? {
          ok: false,
          error: '{"code":"knowledge-name-conflict","error":"Local operation failed","requestId":"private-id"}',
          errorObject: { code: "knowledge-name-conflict", error: "Local operation failed", requestId: "private-id" },
        }
      : { ok: true, data: { noteId: "note-2" } };
  }, "Existing page title", Date.UTC(2026, 6, 24, 2, 3, 4));

  assert.equal(result.ok, true);
  assert.equal(titles.length, 2);
  assert.equal(titles[0], "Existing page title");
  assert.match(titles[1], /^Existing page title · 网页收集 \d{8}-\d{6}$/);
  const failure = protocol.formatNoteWriteFailure({
    ok: false,
    error: '{"code":"knowledge-name-conflict","error":"Local operation failed","requestId":"private-id"}',
    errorObject: { code: "knowledge-name-conflict", error: "Local operation failed", requestId: "private-id" },
  });
  assert.equal(failure, "同名笔记已存在，请修改标题后重试");
  assert.doesNotMatch(failure, /Local operation failed|private-id|\{|\}/);
});

test("note errors explain changed targets without exposing backend details", async () => {
  const protocol = await loadProtocol();
  for (const [code, expected] of [
    ["knowledge-current-context-changed", "当前笔记已变化"],
    ["knowledge-source-inactive", "知识库已切换或关闭"],
    ["knowledge-revision-conflict", "笔记内容已变化"],
    ["note-material-not-found", "素材已不存在"],
    ["note-material-source-invalid", "网页来源地址无效"],
  ]) {
    const message = protocol.formatNoteWriteFailure({ errorObject: { code, message: "private-path" } });
    assert.ok(message.startsWith(expected), code);
    assert.doesNotMatch(message, /private-path/);
  }
});

test("popup defaults to the content actually present under the current pointer", async () => {
  const protocol = await loadProtocol();
  assert.equal(protocol.choosePopupCaptureType({ selection: "selected text" }), "text");
  assert.equal(protocol.choosePopupCaptureType({
    url: "https://example.test/card",
    contextImageUrl: "https://cdn.example.test/card.jpg",
  }), "image");
  assert.equal(protocol.choosePopupCaptureType({
    url: "https://example.test/article",
    imageUrl: "https://cdn.example.test/og-cover.jpg",
    content: "article body",
  }), "text");
});

// EXT-PINTEREST-DRAG-R1 (#125): drag-session lifecycle coverage. A wedged
// runtime reply must never lock the page or swallow the next drag session,
// and a late reply must never land on a newer session.
async function makeDragLifecycleSandbox(runtimeFixture) {
  const { sandbox, contentSource, documentListeners, runtimeMessages } = await loadContentScriptSandbox(runtimeFixture);
  const nodes = [];
  const createNode = (tagName) => {
    const listeners = new Map();
    const node = {
      tagName: String(tagName || "div").toUpperCase(),
      className: "",
      textContent: "",
      style: {},
      dataset: {},
      children: [],
      parentNode: null,
      isConnected: true,
      setAttribute(name, value) { this[name] = String(value); },
      getAttribute(name) { return this[name] ?? null; },
      append(...children) { for (const child of children) this.appendChild(child); },
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
      replaceChildren(...children) { this.children = []; this.append(...children); },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener(type, listener) { listeners.set(type, listener); },
      removeEventListener(type) { listeners.delete(type); },
      attachShadow() { this.shadowForTest = createNode("shadow-root"); return this.shadowForTest; },
      remove() { this.isConnected = false; },
      dispatch(type, event = {}) { return listeners.get(type)?.({ preventDefault() {}, stopPropagation() {}, ...event }); },
    };
    nodes.push(node);
    return node;
  };
  const documentElement = createNode("html");
  Object.assign(sandbox.document, { documentElement, createElement: createNode });
  sandbox.innerWidth = 1_200;
  sandbox.innerHeight = 800;
  let pointed = null;
  sandbox.document.elementsFromPoint = () => (pointed ? [pointed] : []);
  const makeImage = (src) => {
    const image = new sandbox.HTMLImageElement();
    Object.assign(image, {
      currentSrc: src,
      src,
      srcset: "",
      isConnected: true,
      draggable: true,
      getAttribute: () => "",
      querySelectorAll: () => [],
      closest: () => null,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 300, bottom: 200, width: 300, height: 200 }),
    });
    return image;
  };
  vm.runInContext(contentSource, sandbox, { filename: "content-script.js" });
  const panel = () => nodes.find((node) => Object.hasOwn(node, "data-luckyray-drag-collector"));
  const dropZone = () => nodes.find((node) => node.className === "lr-drag-dropzone");
  const status = () => nodes.find((node) => node.className === "lr-drag-status");
  const fire = (type, event) => { for (const listener of documentListeners.get(type) || []) listener(event); };
  const dragstart = (image) => {
    pointed = image;
    fire("dragstart", { target: image, clientX: 50, clientY: 50, dataTransfer: { effectAllowed: "all", setDragImage() {} } });
  };
  const dragend = () => fire("dragend", {});
  // Fire-and-forget on purpose: the production drop listener is async, and
  // awaiting its promise would block the test timeline for the whole save
  // (including the bounded reply wait) instead of observing it.
  const drop = () => dropZone().dispatch("drop", { dataTransfer: { dropEffect: "copy" } });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 10));
  return { sandbox, documentListeners, runtimeMessages, nodes, makeImage, panel, dropZone, status, dragstart, dragend, drop, flush };
}

test("drag end after cancel hides the collector panel immediately", async () => {
  const harness = await makeDragLifecycleSandbox();
  harness.dragstart(harness.makeImage("https://cdn.test/cancel.jpg"));
  assert.equal(harness.panel().style.display, "block", "dragstart must show the collector panel");
  harness.dragend();
  assert.equal(harness.panel().style.display, "none", "dragend without a drop must hide the panel without waiting");
});

test("drag end during an in-flight save keeps the panel until the reply, then hides", async () => {
  const replies = [];
  const harness = await makeDragLifecycleSandbox(async (message) => {
    if (message.type === "luckyray-drag-folders") return { ok: true, libraryId: "drag-test-library", folders: [] };
    if (message.type === "luckyray-drag-collect") return new Promise((resolve) => replies.push(resolve));
    return {};
  });
  harness.dragstart(harness.makeImage("https://cdn.test/inflight.jpg"));
  await harness.flush();
  harness.drop();
  await harness.flush();
  assert.equal(harness.status().textContent, "正在发送到 LuckyRay…", "the save must be visibly in flight");
  harness.dragend();
  assert.equal(harness.panel().style.display, "block", "dragend during a save keeps the panel so the result stays visible");
  replies[0]({ ok: true, transfer: { state: "running" } });
  await harness.flush();
  assert.equal(harness.status().textContent, "已提交下载，完成后会显示在素材库；现在可以继续浏览", "a pending transfer must not claim a completed catalog import");
  assert.equal(harness.status()["data-success"], "false");
  assert.equal(harness.status()["data-error"], "false");
  await new Promise((resolve) => setTimeout(resolve, 1_700));
  assert.equal(harness.panel().style.display, "none", "the success status must auto-dismiss the panel");
});

test("a wedged save cannot lock the next drag session and a late reply stays silent", async () => {
  const replies = [];
  const harness = await makeDragLifecycleSandbox(async (message) => {
    if (message.type === "luckyray-drag-folders") return { ok: true, libraryId: "drag-test-library", folders: [] };
    if (message.type === "luckyray-drag-collect") return new Promise((resolve) => replies.push(resolve));
    return {};
  });
  harness.dragstart(harness.makeImage("https://cdn.test/wedged.jpg"));
  await harness.flush();
  harness.drop();
  await harness.flush();
  harness.dragend();
  assert.equal(harness.panel().style.display, "block", "the wedged save keeps its panel for now");
  harness.dragstart(harness.makeImage("https://cdn.test/next.jpg"));
  assert.equal(harness.panel().style.display, "block", "the new session must take over the panel");
  assert.equal(harness.status().textContent, "拖到框内后松开", "the new session must reset the panel copy");
  replies[0]({ ok: false, message: "LATE-FAILURE" });
  await harness.flush();
  assert.equal(harness.status().textContent, "拖到框内后松开", "a late reply from the older session must not touch the live panel");
  assert.doesNotMatch(harness.status().textContent, /LATE-FAILURE/);
  harness.drop();
  await harness.flush();
  assert.equal(harness.runtimeMessages.filter((message) => message.type === "luckyray-drag-collect").length, 2,
    "the new session must be able to submit its own save");
  replies[1]({ ok: true });
  await harness.flush();
  assert.equal(harness.status().textContent, "已保存到素材库", "the new session's own reply must report normally");
});

test("a runtime reply that never arrives reports unknown, never failure or success, and frees the page", async () => {
  const harness = await makeDragLifecycleSandbox(async (message) => {
    if (message.type === "luckyray-drag-folders") return { ok: true, libraryId: "drag-test-library", folders: [] };
    if (message.type === "luckyray-drag-collect") return new Promise(() => {});
    return {};
  });
  const nativeSetTimeout = harness.sandbox.setTimeout;
  harness.sandbox.setTimeout = (callback, ms) => nativeSetTimeout(callback, ms === 120_000 ? 40 : ms);
  harness.dragstart(harness.makeImage("https://cdn.test/blackhole.jpg"));
  await harness.flush();
  harness.drop();
  await harness.flush();
  harness.dragend();
  assert.equal(harness.panel().style.display, "block", "the panel stays while the bounded wait is running");
  await new Promise((resolve) => setTimeout(resolve, 140));
  assert.match(harness.status().textContent, /结果暂时无法确认.*不要重复保存/, "an unacknowledged write must keep its outcome unknown");
  assert.equal(harness.status()["data-error"], "false", "lost acknowledgment does not prove failure");
  assert.equal(harness.status()["data-success"], "false", "lost acknowledgment does not prove catalog completion");
  assert.equal(harness.panel().style.display, "block", "unknown result must remain inspectable until dismissal or a new session");
  harness.dragstart(harness.makeImage("https://cdn.test/recovered.jpg"));
  assert.equal(harness.status().textContent, "拖到框内后松开", "after the timeout a fresh drag session must take over immediately");
});

test("a lost drag runtime port reports unknown without replay, false failure, or false catalog success", async () => {
  const harness = await makeDragLifecycleSandbox(async (message) => {
    if (message.type === "luckyray-drag-folders") return { ok: true, libraryId: "drag-test-library", folders: [] };
    if (message.type === "luckyray-drag-collect") throw new Error("fixture port closed after dispatch");
    return {};
  });
  harness.dragstart(harness.makeImage("https://cdn.test/lost-port.jpg"));
  await harness.flush();
  harness.drop();
  await harness.flush();
  assert.match(harness.status().textContent, /结果暂时无法确认.*不要重复保存/);
  assert.equal(harness.status()["data-error"], "false");
  assert.equal(harness.status()["data-success"], "false");
  assert.equal(harness.runtimeMessages.filter(message => message.type === "luckyray-drag-collect").length, 1);
  assert.equal(harness.panel().style.display, "block");
  harness.dragend();
  // Explicit dismissal must still work; unknown is not an input lock.
  for (const listener of harness.documentListeners.get("keydown") || []) listener({ key: "Escape" });
  assert.equal(harness.panel().style.display, "none");
});

test("a definite drag rejection stays an error and never creates a success state", async () => {
  const harness = await makeDragLifecycleSandbox(async (message) => {
    if (message.type === "luckyray-drag-folders") return { ok: true, libraryId: "drag-test-library", folders: [] };
    if (message.type === "luckyray-drag-collect") return { ok: false, code: "consumer-folder-denied", message: "分类不属于此素材库" };
    return {};
  });
  harness.dragstart(harness.makeImage("https://cdn.test/denied.jpg"));
  await harness.flush();
  harness.drop();
  await harness.flush();
  assert.equal(harness.status().textContent, "分类不属于此素材库");
  assert.equal(harness.status()["data-error"], "true");
  assert.equal(harness.status()["data-success"], "false");
  assert.equal(harness.runtimeMessages.filter(message => message.type === "luckyray-drag-collect").length, 1);
});

test("a lost video icon save acknowledgment stays unknown and does not invite a duplicate import", async () => {
  const harness = await makeDragLifecycleSandbox(async (message) => {
    if (message.type === "luckyray-video-overlay-open") return {
      ok: true, sessionId: "video-lost-port-session", canRecord: false,
      items: [{ candidateId: "video-lost-port", kind: "direct-video", canSaveToMaterials: true, label: "MP4", host: "cdn.test" }],
    };
    if (message.type === "luckyray-video-overlay-action" && message.action === "save-materials") {
      throw new Error("fixture save dispatched but acknowledgment port closed");
    }
    return {};
  });
  const video = new harness.sandbox.HTMLVideoElement();
  Object.assign(video, {
    tagName: "VIDEO", currentSrc: "https://cdn.test/lost-port.mp4", src: "https://cdn.test/lost-port.mp4",
    type: "video/mp4", isConnected: true, parentElement: null, videoWidth: 640, videoHeight: 360,
    getAttribute: () => "", querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360 }),
  });
  harness.sandbox.document.elementsFromPoint = () => [video];
  for (const listener of harness.documentListeners.get("mousemove") || []) {
    listener({ target: video, clientX: 50, clientY: 50 });
  }
  const overlay = {
    chip: harness.nodes.find(node => node.className === "lr-chip"),
    status: harness.nodes.find(node => node.className === "lr-status"),
  };
  assert.ok(overlay.chip && overlay.status, "the actual pointer handler must create the video overlay");
  await overlay.chip.dispatch("click");
  harness.nodes.find(node => node.className === "lr-action").dispatch("click");
  await harness.flush();
  assert.match(overlay.status.textContent, /结果暂时无法确认.*不要重复保存/);
  assert.equal(overlay.status["data-error"], "false");
  assert.equal(harness.runtimeMessages.filter(message => message.action === "save-materials").length, 1);
  assert.doesNotMatch(overlay.status.textContent, /入库失败|重试|已入库|已保存/);
});

test("a completed drop releases the page wheel immediately while the save is in flight", async () => {
  const replies = [];
  const harness = await makeDragLifecycleSandbox(async (message) => {
    if (message.type === "luckyray-drag-folders") return { ok: true, libraryId: "drag-test-library", folders: [] };
    if (message.type === "luckyray-drag-collect") return new Promise((resolve) => replies.push(resolve));
    return {};
  });
  const wheel = () => {
    let prevented = false;
    for (const listener of harness.documentListeners.get("wheel") || []) {
      listener({ deltaY: 120, preventDefault() { prevented = true; }, stopPropagation() {} });
    }
    return prevented;
  };
  harness.dragstart(harness.makeImage("https://cdn.test/wheellock.jpg"));
  await harness.flush();
  const folderPanel = harness.nodes.find((node) => node.className === "lr-drag-folders");
  const folderList = harness.nodes.find((node) => node.className === "lr-drag-folder-list");
  assert.ok(folderPanel && folderList, "the folder panel and list must exist");
  folderList.scrollTop = 0;
  await folderPanel.dispatch("dragover", { dataTransfer: { dropEffect: "copy" } });
  assert.equal(wheel(), true, "while a drag hovers the panel the wheel is proxied into the folder list");
  assert.equal(folderList.scrollTop, 120, "the proxied wheel must scroll the folder list");
  folderList.scrollTop = 0;
  harness.drop();
  await harness.flush();
  assert.equal(wheel(), false, "after the drop the page wheel must be released at once, even while the save reply is pending");
  assert.equal(folderList.scrollTop, 0, "no folder scrolling may hijack the page after the drag session ended");
  const dragendFired = [];
  for (const listener of harness.documentListeners.get("dragend") || []) { listener({}); dragendFired.push(true); }
  assert.ok(dragendFired.length, "dragend listeners are installed");
  assert.equal(wheel(), false, "after dragend the wheel stays released");
  replies[0]({ ok: true });
  await harness.flush();
  for (const listener of harness.documentListeners.get("keydown") || []) listener({ key: "Escape" });
});

test("an older save reply cannot unlock a newer in-flight drop", async () => {
  const replies = [];
  const h = await makeDragLifecycleSandbox(async (message) => {
    if (message.type === "luckyray-drag-folders") return { ok: true, libraryId: "drag-test-library", folders: [] };
    if (message.type === "luckyray-drag-collect") return new Promise(resolve => replies.push(resolve));
    return {};
  });
  h.dragstart(h.makeImage("https://cdn.test/older.jpg"));
  await h.flush();
  h.drop();
  await h.flush();
  h.dragstart(h.makeImage("https://cdn.test/newer.jpg"));
  await h.flush();
  h.drop();
  await h.flush();
  replies[0]({ ok: true });
  await h.flush();
  h.drop();
  await h.flush();
  replies.slice(1).forEach(resolve => resolve({ok:true}));
  assert.equal(h.runtimeMessages.filter(m => m.type === "luckyray-drag-collect").length, 2,
    "late acknowledgement must not clear the current session's busy guard and duplicate its save");
});

test("dismissing an in-flight save keeps its late status out of the next page interaction", async () => {
  let finish;
  const h = await makeDragLifecycleSandbox(async (message) => {
    if (message.type === "luckyray-drag-folders") return { ok: true, libraryId: "drag-test-library", folders: [] };
    if (message.type === "luckyray-drag-collect") return new Promise(resolve => { finish = resolve; });
    return {};
  });
  h.dragstart(h.makeImage("https://cdn.test/dismissed.jpg"));
  await h.flush();
  h.drop();
  await h.flush();
  for (const listener of h.documentListeners.get("keydown") || []) listener({key:"Escape"});
  finish({ok:false,message:"LATE DISMISSED FAILURE"});
  await h.flush();
  assert.equal(h.panel().style.display, "none");
  assert.equal(h.status().textContent, "", "dismissal invalidates pending UI responses");
});

test("production collector leaves page titles and diagnostic globals alone", async () => {
  const h = await makeDragLifecycleSandbox();
  assert.equal(h.sandbox.__lrBox, undefined);
  assert.equal(h.sandbox.__lrNote, undefined);
  assert.equal(h.sandbox.__lrBoxTimer, undefined);
  h.dragstart(h.makeImage("https://cdn.test/title.jpg"));
  h.dragend();
  assert.equal(h.sandbox.document.title, "Fixture page");
});
