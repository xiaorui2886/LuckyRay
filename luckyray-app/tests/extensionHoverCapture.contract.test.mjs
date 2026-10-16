// [BROWSER-EXT][M1-S3] Hover Target Precision — RED contract (Issue #21).
//
// RED evidence: the current resolver prefers srcset text / lazy data-*
// attributes over the browser-displayed currentSrc, exposes no image-like
// candidate for <video> poster or SVG <image>, and capture descriptors carry
// no source/target-kind info for re-validation. These assertions target the
// M1-S3 Target Resolution Contract (§4) and fail against the current code.
//
// Hover/pointer observation stays candidate-only: none of these functions
// touch transport, storage or any write authority (asserted in the runtime
// QA suite). Drag capture keeps its own descriptor path (currentSrc direct)
// and is untouched by this resolver.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { loadContentScriptSandbox } from "./lib/content-script-sandbox.mjs";

const PROTOCOL_URL = new URL("../browser-extension-prototype/extension-protocol.js", import.meta.url);

async function loadProtocol() {
  const source = await readFile(PROTOCOL_URL, "utf8");
  const sandbox = {
    URL,
    setTimeout,
    clearTimeout,
    getComputedStyle: () => ({ backgroundImage: "none" }),
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: "extension-protocol.js" });
  return { protocol: sandbox.LuckyRayExtensionProtocol, sandbox };
}

function imgElement(overrides = {}) {
  return {
    tagName: "IMG",
    currentSrc: "",
    src: "",
    srcset: "",
    getAttribute: () => "",
    closest: () => null,
    querySelectorAll: () => [],
    ...overrides,
  };
}

test("img: within the same target the best-quality safe candidate wins (M1-S3 §4.1/4.2 + PRODUCT-DIRECTION)", async () => {
  const { protocol } = await loadProtocol();
  const image = imgElement({
    currentSrc: "https://cdn.test/rendered-640.jpg",
    src: "https://cdn.test/fallback.jpg",
    srcset: "https://cdn.test/raw-320.jpg 320w, https://cdn.test/raw-2400.jpg 2400w",
    rect: { left: 0, top: 0, right: 200, bottom: 150 },
  });
  assert.equal(
    protocol.selectPointMedia("image", 50, 50, [image]).url,
    "https://cdn.test/raw-2400.jpg",
    "same-target srcset w-tier candidates may beat the displayed tier; currentSrc is not a quality ceiling",
  );
});

test("picture: HD candidates come only from the img's explicitly bound source (M1-S3 §4.2 + PRODUCT-DIRECTION)", async () => {
  const { protocol } = await loadProtocol();
  const source = {
    tagName: "SOURCE",
    srcset: "https://cdn.test/pic-1200.webp 1200w, https://cdn.test/pic-3200.webp 3200w",
    getAttribute: (name) => name === "srcset" ? source.srcset : "",
  };
  const picture = { querySelectorAll: (selector) => selector === "source[srcset]" ? [source] : [] };
  const image = imgElement({
    currentSrc: "https://cdn.test/pic-1200.webp",
    src: "https://cdn.test/pic-fallback.jpg",
    closest: (selector) => selector === "picture" ? picture : null,
    rect: { left: 0, top: 0, right: 220, bottom: 140 },
  });
  assert.equal(
    protocol.selectPointMedia("image", 30, 30, [image]).url,
    "https://cdn.test/pic-3200.webp",
    "the strongest candidate from the img's own picture binding may win",
  );
});

test("same-element allowlisted original attributes may beat the displayed tier (M1-S3 §4.3 + PRODUCT-DIRECTION)", async () => {
  const { protocol } = await loadProtocol();
  const attributes = new Map([
    ["data-original", "https://images.test/original.jpg"],
    ["data-full", "https://images.test/full.jpg"],
  ]);
  const image = imgElement({
    currentSrc: "https://images.test/rendered.jpg",
    src: "https://images.test/rendered.jpg",
    getAttribute: (name) => attributes.get(name) || "",
    rect: { left: 0, top: 0, right: 200, bottom: 120 },
  });
  assert.equal(
    protocol.selectPointMedia("image", 40, 40, [image]).url,
    "https://images.test/original.jpg",
    "a safe allowlisted same-element original attribute may win over the displayed tier",
  );
});

test("cross-target safety: resolution never jumps to a sibling's bigger image (M1-S3 §4.4 + PRODUCT-DIRECTION)", async () => {
  const { protocol } = await loadProtocol();
  const pointed = imgElement({
    currentSrc: "https://cdn.test/pointed-small.jpg",
    rect: { left: 0, top: 0, right: 100, bottom: 100 },
  });
  const sibling = imgElement({
    currentSrc: "https://cdn.test/sibling-small.jpg",
    srcset: "https://cdn.test/sibling-4000.jpg 4000w",
    rect: { left: 0, top: 0, right: 100, bottom: 100 },
  });
  assert.equal(
    protocol.selectPointMedia("image", 20, 20, [pointed, sibling]).url,
    "https://cdn.test/pointed-small.jpg",
    "the pointed element's own candidate wins; a sibling's larger image must never be picked",
  );
});

test("lazy fallback works when no standard resource exists, with strict URL validation (M1-S3 §4.3)", async () => {
  const { protocol } = await loadProtocol();
  const attributes = new Map([
    ["data-src", "https://images.test/lazy.jpg"],
    ["data-original", "javascript:alert(1)"],
  ]);
  const image = imgElement({
    getAttribute: (name) => attributes.get(name) || "",
    rect: { left: 0, top: 0, right: 200, bottom: 120 },
  });
  assert.equal(
    protocol.selectPointMedia("image", 40, 40, [image]).url,
    "https://images.test/lazy.jpg",
    "a valid lazy fallback may be used when no standard resource exists",
  );
  const unsafe = imgElement({
    getAttribute: () => "javascript:alert(1)",
    rect: { left: 0, top: 0, right: 200, bottom: 120 },
  });
  assert.equal(
    protocol.selectPointMedia("image", 40, 40, [unsafe]),
    null,
    "javascript: URLs must never become image candidates",
  );
});

test("video poster is an image-like candidate, never a video file (M1-S3 §4.6)", async () => {
  const { protocol } = await loadProtocol();
  const video = {
    tagName: "VIDEO",
    currentSrc: "https://cdn.test/movie.mp4",
    src: "https://cdn.test/movie.mp4",
    getAttribute: (name) => name === "poster" ? "https://cdn.test/poster.jpg" : "",
    rect: { left: 0, top: 0, right: 320, bottom: 180 },
  };
  assert.equal(
    protocol.selectPointMedia("image", 100, 90, [video]).url,
    "https://cdn.test/poster.jpg",
    "the video poster must resolve as an image-like visual candidate",
  );
  const videoHit = protocol.selectPointMedia("video", 100, 90, [video]);
  assert.equal(videoHit.url, "https://cdn.test/movie.mp4", "the video-file path must stay authoritative");
  assert.notEqual(videoHit.url, "https://cdn.test/poster.jpg", "poster must never enter the video-file path");
});

test("poster / SVG / background candidates use the image-candidate URL safety policy (M1-S3 §4.9)", async () => {
  const { protocol } = await loadProtocol();
  // Credential-bearing and overlong poster/SVG URLs must be rejected exactly
  // like ordinary image candidates.
  const credentialPoster = {
    tagName: "VIDEO",
    getAttribute: (name) => name === "poster" ? "https://user:secret@cdn.test/poster.jpg" : "",
    rect: { left: 0, top: 0, right: 320, bottom: 180 },
  };
  assert.equal(
    protocol.selectPointMedia("image", 100, 90, [credentialPoster]),
    null,
    "credential-bearing poster URLs must be rejected",
  );
  const overlongPoster = {
    tagName: "VIDEO",
    getAttribute: () => `https://cdn.test/${"a".repeat(4_200)}.jpg`,
    rect: { left: 0, top: 0, right: 320, bottom: 180 },
  };
  assert.equal(
    protocol.selectPointMedia("image", 100, 90, [overlongPoster]),
    null,
    "overlong poster URLs must be rejected",
  );
  const credentialSvg = {
    tagName: "IMAGE",
    getAttribute: (name) => name === "href" ? "https://user:secret@cdn.test/svg.png" : "",
    rect: { left: 0, top: 0, right: 100, bottom: 100 },
  };
  assert.equal(
    protocol.selectPointMedia("image", 20, 20, [credentialSvg]),
    null,
    "credential-bearing SVG hrefs must be rejected",
  );
});

test("SVG <image> href / xlink:href resolve as image candidates (M1-S3 §4.7)", async () => {
  const { protocol } = await loadProtocol();
  const svgImage = {
    tagName: "IMAGE",
    getAttribute: (name) => name === "href" ? "https://cdn.test/svg-target.png" : "",
    rect: { left: 0, top: 0, right: 100, bottom: 100 },
  };
  assert.equal(
    protocol.selectPointMedia("image", 20, 20, [svgImage]).url,
    "https://cdn.test/svg-target.png",
    "SVG <image href> must resolve",
  );
  const xlink = {
    tagName: "IMAGE",
    getAttribute: (name) => name === "xlink:href" ? "https://cdn.test/xlink-target.png" : "",
    rect: { left: 0, top: 0, right: 100, bottom: 100 },
  };
  assert.equal(
    protocol.selectPointMedia("image", 20, 20, [xlink]).url,
    "https://cdn.test/xlink-target.png",
    "SVG <image xlink:href> must resolve",
  );
});

test("CSS background-image on the pointed element resolves as an image candidate (M1-S3 §4.4)", async () => {
  const { protocol, sandbox } = await loadProtocol();
  sandbox.getComputedStyle = () => ({ backgroundImage: "url(\"https://cdn.test/card-bg.png\")" });
  const card = {
    tagName: "DIV",
    rect: { left: 0, top: 0, right: 300, bottom: 200 },
  };
  assert.equal(
    protocol.selectPointMedia("image", 150, 100, [card]).url,
    "https://cdn.test/card-bg.png",
    "a safe background-image URL must resolve",
  );
});

test("nested overlay does not hide the underlying image (M1-S3 §4.5)", async () => {
  const { protocol } = await loadProtocol();
  const overlay = { tagName: "DIV", rect: { left: 0, top: 0, right: 200, bottom: 200 } };
  const image = imgElement({
    currentSrc: "https://cdn.test/under-overlay.jpg",
    rect: { left: 0, top: 0, right: 200, bottom: 200 },
  });
  assert.equal(
    protocol.selectPointMedia("image", 100, 100, [overlay, image]).url,
    "https://cdn.test/under-overlay.jpg",
    "the nearest visual media target below an overlay must resolve",
  );
});

test("malformed / javascript / overlong URLs are rejected (M1-S3 §4.3/§4.9)", async () => {
  const { protocol } = await loadProtocol();
  const overlong = `https://cdn.test/${"a".repeat(4_200)}.jpg`;
  const image = imgElement({
    currentSrc: overlong,
    src: "javascript:alert(1)",
    srcset: "data:image/png;base64,AAAA 1x",
    rect: { left: 0, top: 0, right: 200, bottom: 120 },
  });
  assert.equal(protocol.selectPointMedia("image", 40, 40, [image]), null, "overlong/js/data candidates must be rejected");
});

test("capture descriptors carry source and target-kind info for re-validation (M1-S3 §4.9)", async () => {
  const { protocol } = await loadProtocol();
  const descriptor = protocol.createCaptureDescriptor({
    type: "image",
    url: "https://cdn.test/rendered.jpg",
    source: "currentSrc",
    targetKind: "img",
    capturedAt: 1_000,
  });
  assert.equal(descriptor.source, "currentSrc", "descriptor must keep the resolver source");
  assert.equal(descriptor.targetKind, "img", "descriptor must keep the visual target kind");
  assert.equal(descriptor.type, "image", "poster/background descriptors stay image-typed");
});

// ---- M1-S3 FIX-2: real luckyray-get-hover-image consumer path ----

function consumeHoverImage(runtimeListeners) {
  let response = null;
  for (const listener of runtimeListeners) {
    listener({ type: "luckyray-get-hover-image" }, {}, (value) => { response = value; });
  }
  return response;
}

function dispatchHover(sandbox, documentListeners, target, x = 30, y = 30) {
  sandbox.document.elementsFromPoint = () => [target];
  for (const listener of documentListeners.get("mousemove")) {
    listener({ clientX: x, clientY: y, target });
  }
}

test("video poster survives the real luckyray-get-hover-image consumer path (M1-S3 FIX-2)", async () => {
  const { sandbox, contentSource, documentListeners, runtimeListeners } = await loadContentScriptSandbox();
  const video = new sandbox.HTMLVideoElement();
  Object.assign(video, {
    tagName: "VIDEO",
    currentSrc: "https://cdn.test/movie.mp4",
    getAttribute: (name) => name === "poster" ? "https://cdn.test/poster.jpg" : "",
    isConnected: true,
    parentElement: null,
    closest: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 320, bottom: 180, width: 320, height: 180 }),
  });
  vm.runInContext(contentSource, sandbox, { filename: "content-script.js" });
  dispatchHover(sandbox, documentListeners, video, 100, 90);
  const response = consumeHoverImage(runtimeListeners);
  assert.equal(
    response?.url,
    "https://cdn.test/poster.jpg",
    "the real hover-image consumer must re-resolve the video poster (RED: falls into background on the pre-fix code)",
  );
  assert.equal(response?.targetKind, "video-poster");
});

test("SVG <image> href survives the real luckyray-get-hover-image consumer path (M1-S3 FIX-2)", async () => {
  const { sandbox, contentSource, documentListeners, runtimeListeners } = await loadContentScriptSandbox();
  const svgImage = new sandbox.Element();
  Object.assign(svgImage, {
    tagName: "IMAGE",
    getAttribute: (name) => name === "href" ? "https://cdn.test/svg-target.png" : "",
    isConnected: true,
    parentElement: null,
    closest: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }),
  });
  vm.runInContext(contentSource, sandbox, { filename: "content-script.js" });
  dispatchHover(sandbox, documentListeners, svgImage, 20, 20);
  const response = consumeHoverImage(runtimeListeners);
  assert.equal(
    response?.url,
    "https://cdn.test/svg-target.png",
    "the real hover-image consumer must re-resolve the SVG href (RED: falls into background on the pre-fix code)",
  );
  assert.equal(response?.targetKind, "svg-image");
});

test("credential-bearing CSS background is never resurrected by content-side fallback (M1-S3 FIX-2)", async () => {
  const { sandbox, contentSource, documentListeners, runtimeMessages } = await loadContentScriptSandbox();
  const card = new sandbox.Element();
  Object.assign(card, {
    tagName: "DIV",
    isConnected: true,
    parentElement: null,
    closest: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 200, bottom: 120, width: 200, height: 120 }),
  });
  // The strict protocol sanitizer rejects credential-bearing URLs; the
  // content-side fallback must not resurrect them into a capture descriptor.
  sandbox.getComputedStyle = () => ({
    backgroundImage: "url(\"https://user:secret@cdn.test/private.png\")",
  });
  vm.runInContext(contentSource, sandbox, { filename: "content-script.js" });
  dispatchHover(sandbox, documentListeners, card, 40, 40);
  const announced = runtimeMessages.find((message) => message.type === "luckyray-context-image");
  assert.equal(
    announced,
    undefined,
    "a credential-bearing background URL must never reach a capture descriptor (RED: loose fallback resurrects it)",
  );
});

test("a safe CSS background resolves through the real consumer path (M1-S3 FIX-2)", async () => {
  const { sandbox, contentSource, documentListeners, runtimeListeners } = await loadContentScriptSandbox();
  const card = new sandbox.Element();
  Object.assign(card, {
    tagName: "DIV",
    isConnected: true,
    parentElement: null,
    closest: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 200, bottom: 120, width: 200, height: 120 }),
  });
  sandbox.getComputedStyle = () => ({
    backgroundImage: "url(\"https://cdn.test/card-bg.png\")",
  });
  vm.runInContext(contentSource, sandbox, { filename: "content-script.js" });
  dispatchHover(sandbox, documentListeners, card, 40, 40);
  const response = consumeHoverImage(runtimeListeners);
  assert.equal(
    response?.url,
    "https://cdn.test/card-bg.png",
    "a safe background must resolve through the real consumer path",
  );
  assert.equal(response?.targetKind, "background");
});
