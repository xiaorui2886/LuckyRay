import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Test-only source selection enables an identical fixture/command to compare
// the byte-preserved installed baseline with the integrated worker.
const extensionRoot = process.env.LUCKYRAY_TEST_EXTENSION_ROOT
  ? pathToFileURL(path.resolve(process.env.LUCKYRAY_TEST_EXTENSION_ROOT) + path.sep)
  : new URL("../browser-extension-prototype/", import.meta.url);
const readExtension = name => readFile(new URL(name, extensionRoot), "utf8");

async function loadBackground(sessionStore = {}, transportFixture = null, recordingFixture = null, clock = null, tabFixture = null, siteAuthFixture = null, storageFixture = null) {
  const protocolSource = await readExtension("extension-protocol.js");
  const taskSource = await readExtension("capture-task.js");
  const appearanceSource = await readExtension("appearance.js");
  const backgroundSource = await readExtension("background.js");
  const dependencies = {};
  const importedNames = [...backgroundSource.matchAll(/importScripts\(([^)]*)\)/g)]
    .flatMap(match => [...match[1].matchAll(/["']([^"']+\.js)["']/g)].map(value => value[1]));
  for (const name of new Set(importedNames)) {
    if (["extension-protocol.js", "capture-task.js", "appearance.js", "local-transport-auth.js"].includes(name)) continue;
    dependencies[name] = await readExtension(name);
  }
  const runtimeListeners = [];
  const webRequestListeners = [];
  const tabUpdatedListeners = [];
  const tabRemovedListeners = [];
  const contextMenuListeners = [];
  const downloads = [];
  const timerDurations = [];
  const localWrites = [];
  const localStore = storageFixture?.localStore || {};
  const fixtureTabs = new Map();
  const copy = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const event = (listeners = []) => ({ addListener: (listener) => listeners.push(listener) });
  const sandbox = {
    URL,
    Date: clock ? class extends Date { static now() { return clock.now; } } : Date,
    Math,
    Map,
    Set,
    Promise,
    setTimeout(callback, timeout) {
      timerDurations.push(timeout);
      const bounded = Number.isFinite(storageFixture?.maxTimerMs)
        ? Math.min(timeout, storageFixture.maxTimerMs)
        : timeout;
      return setTimeout(callback, bounded);
    },
    clearTimeout,
    navigator: { userAgent: "Mozilla/5.0 Edg/126" },
    crypto: { randomUUID: (() => { let id = 0; return () => `opaque-${++id}`; })() },
    console: { warn() {} },
  };
  sandbox.globalThis = sandbox;
  sandbox.chrome = {
    runtime: {
      id: "fixture-extension",
      getURL: (path) => `chrome-extension://fixture-extension/${path}`,
      lastError: null,
      onInstalled: event(),
      onStartup: event(),
      onMessage: event(runtimeListeners),
      sendMessage(message, callback) {
        const response = typeof recordingFixture === "function" ? recordingFixture(message) : { ok: true };
        if (typeof callback === "function") {
          Promise.resolve(response).then(callback);
          return undefined;
        }
        return Promise.resolve(response);
      },
    },
    webRequest: { onHeadersReceived: event(webRequestListeners) },
    tabs: {
      query: async () => [],
      get: async (id) => ({ id, title: "Fixture video", ...(tabFixture || fixtureTabs.get(id) || { url: "https://page.test/watch" }) }),
      sendMessage: async () => ({}),
      onActivated: event(),
      onUpdated: event(tabUpdatedListeners),
      onRemoved: event(tabRemovedListeners),
    },
    contextMenus: {
      removeAll: (callback) => callback?.(),
      create() {},
      update(_id, _value, callback) { callback?.(); },
      onClicked: event(contextMenuListeners),
    },
    action: { onClicked: event(), openPopup: async () => {} },
    notifications: { create() {} },
    storage: {
      local: {
        async get(key) { return { [key]: copy(localStore[key]) }; },
        async set(value) {
          localWrites.push(copy(value));
          Object.assign(localStore, copy(value));
        },
      },
      session: {
        async get(key) {
          if (storageFixture?.get) return await storageFixture.get(key);
          return { [key]: sessionStore[key] };
        },
        async set(value) { Object.assign(sessionStore, value); },
        async remove(key) { delete sessionStore[key]; },
        async setAccessLevel() {},
      },
    },
    scripting: { executeScript: async () => [] },
    downloads: {
      async download(options) {
        downloads.push(options);
        return 71;
      },
    },
    offscreen: {
      hasDocument: async () => recordingFixture?.hasDocument
        ? await recordingFixture.hasDocument()
        : Boolean(recordingFixture),
      createDocument: async () => {},
      closeDocument: async () => {},
    },
    permissions: {
      async contains(details) { return siteAuthFixture?.contains ? siteAuthFixture.contains(details) : false; },
      async request(details) { return siteAuthFixture?.request ? siteAuthFixture.request(details) : true; },
    },
    cookies: {
      async getAll(details) { return siteAuthFixture?.getAll ? siteAuthFixture.getAll(details) : []; },
    },
    tabCapture: { getMediaStreamId(_options, callback) { callback?.("fixture-stream-id"); } },
  };
  const context = vm.createContext(sandbox);
  sandbox.importScripts = (...names) => {
    for (const name of names) {
      if (name === "extension-protocol.js") vm.runInContext(protocolSource, context, { filename: name });
      if (name === "capture-task.js") vm.runInContext(taskSource, context, { filename: name });
      if (name === "appearance.js") vm.runInContext(appearanceSource, context, { filename: name });
      if (dependencies[name]) vm.runInContext(dependencies[name], context, { filename: name });
      if (name === "local-transport-auth.js") {
        sandbox.LuckyRayLocalTransport = {
          discover: async () => 38471,
          // This remains a fake business-transport fixture. Real proof,
          // identity, restart and stale-selection paths have their separate
          // hard-gated tests in extensionTransportBinding.contract.test.mjs.
          discoverCandidates: async () => [{ version: 1, port: 38471, fingerprint: "a".repeat(64), serverNonce: "b".repeat(64) }],
          openBinding: async port => ({ version: 1, port, fingerprint: "a".repeat(64), serverNonce: "b".repeat(64) }),
          confirmBinding: async () => ({ ok: true, serverNonce: "b".repeat(64) }),
          runtimeOrigin: () => "chrome-extension://fixture-extension",
          fetch: async (port, path, options, timeoutMs) => transportFixture
            ? await transportFixture({ port: typeof port === "object" ? port.port : port, path, options: options || {}, timeoutMs })
            : ({ ok: false, status: 503, text: async () => "", json: async () => ({}) }),
        };
      }
    }
  };
  vm.runInContext(backgroundSource, context, { filename: "background.js" });

  async function send(message, sender) {
    // A real runtime sender and tabs.get describe the same live tab. Explicit
    // caller-supplied sender/tab fixtures still control navigation and all
    // wrong-source cases; only unspecified fixture metadata is completed.
    sender ||= { tab: { id: 7, ...(tabFixture || fixtureTabs.get(7) || { url: message.pageUrl || "https://page.test/watch" }) } };
    sender = { id: sandbox.chrome.runtime.id, ...sender };
    if (!tabFixture && sender.tab) fixtureTabs.set(sender.tab.id, { ...sender.tab });
    for (const listener of runtimeListeners) {
      const response = await new Promise((resolve, reject) => {
        let settled = false;
        const sendResponse = (value) => {
          settled = true;
          resolve(value);
        };
        try {
          const keepAlive = listener(message, sender, sendResponse);
          if (keepAlive !== true && !settled) resolve(undefined);
        } catch (error) {
          reject(error);
        }
      });
      if (response !== undefined) return response;
    }
    return undefined;
  }

  return {
    send,
    downloads,
    timerDurations,
    localWrites,
    localStore,
    contextMenuListeners,
    webRequestListeners,
    tabUpdatedListeners,
    tabRemovedListeners,
  };
}

function jsonResponse(status, payload) {
  const text = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return text; },
    async json() { return payload; },
  };
}

async function loadPopup(transportFixture = null, runtimeFixture = null, popupSessionStore = {}, options = {}) {
  const protocolSource = await readExtension("extension-protocol.js");
  const popupSource = await readExtension("popup.js");
  const elements = new Map();
  const runtimeCalls = [];
  const permissionRequests = [];
  const timerDurations = [];
  const background = options.background || await loadBackground({}, transportFixture, null, null, null, null, {
    localStore: options.localStore || {},
    maxTimerMs: 20,
  });
  const popupSender = {
    id: "fixture-extension",
    url: "chrome-extension://fixture-extension/popup.html",
  };
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: "",
      textContent: "",
      disabled: false,
      style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {},
      querySelectorAll() { return []; },
      querySelector(selector) { return element(`${id}:${selector}`); },
    });
    return elements.get(id);
  };
  const sandbox = {
    URL,
    Date,
    Math,
    Promise,
    Map,
    Set,
    crypto: { randomUUID: () => "popup-action-opaque" },
    document: {
      getElementById: element,
      addEventListener() {},
      querySelectorAll() { return []; },
    },
    setTimeout(callback, timeout) {
      timerDurations.push(timeout);
      if (options.runTimers && timeout === 750) return setTimeout(callback, 0);
      return timerDurations.length;
    },
    clearTimeout,
    setInterval() { return 1; },
    clearInterval() {},
    console: { warn() {}, error() {} },
  };
  sandbox.globalThis = sandbox;
  sandbox.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        runtimeCalls.push(message);
        const result = message?.type === "luckyray-capture-task"
          ? background.send(message, popupSender)
          : runtimeFixture ? runtimeFixture(message) : (
            message?.type === "luckyray-site-auth-request" ? { ok: true, siteAuth: null } : {}
          );
        Promise.resolve(result).then((response) => callback?.(response));
      },
      reload() {},
    },
    tabs: { query(_options, callback) { callback([]); } },
    permissions: {
      async request(details) {
        permissionRequests.push(details);
        return typeof options.sitePermissionGranted === "function"
          ? await options.sitePermissionGranted(details)
          : options.sitePermissionGranted !== false;
      },
    },
    storage: {
      local: { async get() { return {}; }, async remove() {} },
      session: {
        async get(key) { return { [key]: popupSessionStore[key] }; },
        async remove(key) { delete popupSessionStore[key]; },
      },
    },
  };
  sandbox.LuckyRayLocalTransport = {
    async fetch(port, path, options, timeoutMs) {
      return transportFixture
        ? await transportFixture({ port, path, options: options || {}, timeoutMs })
        : jsonResponse(503, {});
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(protocolSource, context, { filename: "extension-protocol.js" });
  vm.runInContext(`${popupSource}\n;globalThis.__popupTest = { state, callApi, importMedia, buildVideoTransferRequest, observeCaptureTask, onRecordStop, applyPrefill, candidateLabel, resolvePopupFormats, selectedVideoCandidate };`, context, { filename: "popup.js" });
  async function taskAction(action, id) {
    return background.send({ type: "luckyray-capture-task", action, id }, popupSender);
  }
  async function waitForTask(expectedStage = null) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const result = await taskAction("status");
      assert.equal(result.ok, true, JSON.stringify(result));
      const task = result.task;
      if (task && (expectedStage ? task.stage === expectedStage : !["starting", "transferring", "attaching"].includes(task.stage))) {
        return task;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(`capture task did not reach ${expectedStage || "an observable terminal state"}`);
  }
  return { api: sandbox.__popupTest, element, runtimeCalls, permissionRequests, timerDurations, background, taskAction, waitForTask };
}

async function loadOffscreenRecorder() {
  const protocolSource = await readExtension("extension-protocol.js");
  const offscreenSource = await readExtension("offscreen.js");
  const listeners = [];
  const outbound = [];
  const stored = {};
  let durationCallback = null;
  const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  class FixtureRecorder {
    static last = null;
    static isTypeSupported() { return true; }
    constructor() {
      this.state = "inactive";
      this.mimeType = "video/webm";
      FixtureRecorder.last = this;
    }
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      this.onstop?.({});
    }
    emit(size) { this.ondataavailable?.({ data: { size } }); }
  }
  const sandbox = {
    URL,
    Date,
    Math,
    Promise,
    Object,
    Number,
    MediaRecorder: FixtureRecorder,
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => tracks }) } },
    setTimeout(callback) { durationCallback = callback; return 9; },
    clearTimeout() { durationCallback = null; },
    Blob: class { constructor(chunks, options) { this.size = chunks.reduce((sum, chunk) => sum + chunk.size, 0); this.type = options.type; } },
    FileReader: class {},
  };
  sandbox.globalThis = sandbox;
  sandbox.chrome = {
    runtime: {
      onMessage: { addListener(listener) { listeners.push(listener); } },
      sendMessage(message) { outbound.push(message); },
    },
    storage: { session: { async set(value) { Object.assign(stored, value); } } },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(protocolSource, context, { filename: "extension-protocol.js" });
  vm.runInContext(offscreenSource, context, { filename: "offscreen.js" });
  async function send(message) {
    for (const listener of listeners) {
      const response = await new Promise((resolve, reject) => {
        let settled = false;
        const sendResponse = (value) => { settled = true; resolve(value); };
        try {
          const keepAlive = listener(message, {}, sendResponse);
          if (keepAlive !== true && !settled) resolve(undefined);
        } catch (error) { reject(error); }
      });
      if (response !== undefined) return response;
    }
    return undefined;
  }
  return { send, FixtureRecorder, outbound, tracks, stored, fireDuration: () => durationCallback?.() };
}

test("an extensionless player URL is offered only for LuckyRay material import", async () => {
  const harness = await loadBackground();
  assert.equal(harness.webRequestListeners.length, 1);
  harness.webRequestListeners[0]({
    tabId: 7,
    url: "https://cdn.test/signed-stream?token=PRIVATE",
    responseHeaders: [
      { name: "Content-Type", value: "video/mp4" },
      { name: "Content-Length", value: String(8 * 1024 * 1024) },
    ],
  });

  const opened = await harness.send({
    type: "luckyray-video-overlay-open",
    pageTitle: "Demo / clip",
    pageUrl: "https://page.test/watch?PRIVATE",
    descriptor: {
      url: "https://cdn.test/signed-stream?token=PRIVATE",
      importable: false,
    },
    width: 1920,
    height: 1080,
  });

  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(opened.items.length, 1);
  assert.equal(opened.items[0].canDownload, false);
  assert.equal(opened.items[0].canSaveToMaterials, true);
  assert.doesNotMatch(JSON.stringify(opened), /PRIVATE|signed-stream/);

  const result = await harness.send({
    type: "luckyray-video-overlay-action",
    sessionId: opened.sessionId,
    candidateId: opened.items[0].candidateId,
    action: "download-computer",
  });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.code, "video-action-invalid");
  assert.equal(harness.downloads.length, 0);
});

test("a supported player resolves safe qualities and binds one opaque format to LuckyRay material import", async () => {
  const calls = [];
  const harness = await loadBackground({}, async ({ path, options }) => {
    calls.push({ path, body: options.body ? JSON.parse(options.body) : null });
    if (path === "/api/media/probes") return jsonResponse(200, {
      probeId: "probe-0123456789abcdef0123456789abcdef",
      formats: [{
        formatId: "format-fedcba9876543210fedcba9876543210",
        label: "1080p · MP4 · 合并音频",
        width: 1920,
        height: 1080,
        fps: 30,
        extension: "mp4",
        videoCodec: "avc1",
        audioCodec: "merge",
        estimatedBytes: 42000000,
        bitrate: 4000000,
      }],
    });
    if (path === "/api/media/transfers") return jsonResponse(202, {
      transferId: "media-feed-0123456789abcdef",
      state: "queued",
      bytesReceived: 0,
      totalBytes: null,
      fileName: "Fixture.mp4",
      mimeType: "video/mp4",
      skippedDuplicate: false,
    });
    return jsonResponse(404, { code: "missing" });
  }, null, null, {
    id: 7,
    url: "https://www.youtube.com/watch?v=safe-fixture",
    title: "Fixture",
  });
  const sender = {
    tab: { id: 7, url: "https://www.youtube.com/watch?v=safe-fixture" },
    frameId: 0,
    documentId: "document-7",
  };
  const opened = await harness.send({
    type: "luckyray-video-overlay-open",
    pageUrl: sender.tab.url,
    resolverPageUrl: sender.tab.url,
    playerContext: true,
    playerCandidates: [{ url: "blob:https://www.youtube.com/player" }],
  }, sender);
  const resolver = opened.items.find((item) => item.kind === "site-resolver");
  assert.ok(resolver);
  const catalog = await harness.send({
    type: "luckyray-video-overlay-action",
    sessionId: opened.sessionId,
    candidateId: resolver.candidateId,
    action: "probe-formats",
  }, sender);
  assert.equal(catalog.ok, true, JSON.stringify(catalog));
  assert.equal(catalog.items.length, 1);
  assert.equal(catalog.items[0].label, "1080p · MP4 · 合并音频");
  assert.equal(catalog.items[0].canDownload, false);
  const saved = await harness.send({
    type: "luckyray-video-overlay-action",
    sessionId: opened.sessionId,
    candidateId: catalog.items[0].candidateId,
    action: "save-materials",
  }, sender);
  assert.equal(saved.ok, true);
  const transfer = calls.find((call) => call.path === "/api/media/transfers");
  assert.equal(transfer.body.probeId, "probe-0123456789abcdef0123456789abcdef");
  assert.equal(transfer.body.formatId, "format-fedcba9876543210fedcba9876543210");
  assert.doesNotMatch(JSON.stringify(calls), /bestaudio|PRIVATE/);
  assert.equal(harness.downloads.length, 0);
});

test("a player overlay exposes only the clicked video's network quality family", async () => {
  const harness = await loadBackground();
  const emit = (url, size) => harness.webRequestListeners[0]({
    tabId: 7,
    frameId: 0,
    documentId: "document-pin-grid",
    url,
    responseHeaders: [
      { name: "Content-Type", value: "video/mp4" },
      { name: "Content-Length", value: String(size) },
    ],
  });
  emit("https://v1.pinimg.test/videos/pin-a_360w.cmfv?token=PRIVATE-A", 300_000);
  emit("https://v1.pinimg.test/videos/pin-a_720w.cmfv?token=PRIVATE-A", 1_200_000);
  emit("https://v1.pinimg.test/videos/pin-b_1080w.cmfv?token=PRIVATE-B", 2_400_000);

  const opened = await harness.send({
    type: "luckyray-video-overlay-open",
    descriptor: { url: "https://v1.pinimg.test/videos/pin-a_360w.cmfv?token=PRIVATE-A" },
    playerCandidates: [{
      url: "https://v1.pinimg.test/videos/pin-a_360w.cmfv?token=PRIVATE-A",
      contentType: "video/mp4",
    }],
  }, {
    tab: { id: 7, url: "https://page.test/pin-grid" },
    frameId: 0,
    documentId: "document-pin-grid",
  });

  assert.equal(opened.ok, true);
  assert.equal(opened.items.length, 2);
  assert.doesNotMatch(JSON.stringify(opened), /pin-b|1080w|PRIVATE/);
});

test("an unbound blob player refuses to guess from unrelated recent network traffic", async () => {
  const clock = { now: 1_000 };
  const harness = await loadBackground({}, null, null, clock);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const emit = (url) => harness.webRequestListeners[0]({
    tabId: 7,
    frameId: 0,
    documentId: "document-blob-grid",
    url,
    responseHeaders: [{ name: "Content-Type", value: "video/mp4" }],
  });
  emit("https://v1.pinimg.test/videos/pin-old_1080w.cmfv?token=PRIVATE-OLD");
  clock.now += 1_000;
  emit("https://v1.pinimg.test/videos/pin-current_360w.cmfv?token=PRIVATE-CURRENT");
  clock.now += 100;
  emit("https://v1.pinimg.test/videos/pin-current_720w.cmfv?token=PRIVATE-CURRENT");

  const opened = await harness.send({
    type: "luckyray-video-overlay-open",
    descriptor: { url: "blob:https://page.test/current-player" },
    playerCandidates: [{ url: "blob:https://page.test/current-player" }],
  }, {
    tab: { id: 7, url: "https://page.test/pin-grid" },
    frameId: 0,
    documentId: "document-blob-grid",
  });

  assert.equal(opened.ok, true);
  assert.equal(opened.items.length, 0);
  assert.equal(opened.canRecord, true);
  assert.doesNotMatch(JSON.stringify(opened), /pin-old|1080w|PRIVATE/);
});

test("an MSE player hint is accepted only after the same URL was observed by webRequest", async () => {
  const harness = await loadBackground();
  const message = {
    type: "luckyray-video-overlay-open",
    descriptor: { url: "blob:https://page.test/player-a" },
    playerCandidates: [{
      url: "https://media.test/player-a_1080w.cmfv?token=PRIVATE",
      contentType: "video/mp4",
      binding: "mse-probe",
    }],
  };
  const sender = {
    tab: { id: 7, url: "https://page.test/grid" },
    frameId: 0,
    documentId: "document-mse-grid",
  };

  const spoofed = await harness.send(message, sender);
  assert.equal(spoofed.ok, true);
  assert.equal(spoofed.items.length, 0, "page-controlled events cannot authorize a media URL");

  harness.webRequestListeners[0]({
    tabId: 7,
    frameId: 0,
    documentId: "document-mse-grid",
    url: "https://media.test/player-a_1080w.cmfv?token=PRIVATE",
    responseHeaders: [{ name: "Content-Type", value: "video/mp4" }],
  });
  const verified = await harness.send(message, sender);
  assert.equal(verified.items.length, 1);
  assert.equal(verified.items[0].label, "1080w · CMFV");
  assert.doesNotMatch(JSON.stringify(verified), /PRIVATE|token=/);
});

test("a bound Bilibili track pair reaches one backend transfer without losing its audio track", async () => {
  const calls = [];
  const harness = await loadBackground({}, async ({ path, options }) => {
    calls.push({ path, body: options.body ? JSON.parse(options.body) : null });
    return jsonResponse(202, {
      transferId: "media-cafe-1234567890abcdef",
      state: "queued",
      bytesReceived: 0,
      totalBytes: null,
      fileName: "Bilibili pair.mp4",
      mimeType: "video/mp4",
      skippedDuplicate: false,
    });
  });
  const pageUrl = "https://www.bilibili.com/video/BV1xx411c7mD";
  const sender = { tab: { id: 7, url: pageUrl, title: "Bilibili pair" }, frameId: 0 };
  const opened = await harness.send({
    type: "luckyray-video-overlay-open",
    pageUrl,
    resolverPageUrl: pageUrl,
    playerContext: true,
    playerCandidates: [{
      url: "https://v.example.bilivideo.com/video-high.m4s",
      audioUrl: "https://a.example.bilivideo.com/audio-high.m4s",
      contentType: "video/mp4",
      width: 1920,
      height: 1080,
      bitrate: 3_000_000,
      binding: "site-track-pair",
    }],
  }, sender);
  const pair = opened.items.find((item) => item.kind === "track-pair");
  assert.ok(pair, JSON.stringify(opened));
  assert.equal(pair.canSaveToMaterials, true);

  const started = await harness.send({
    type: "luckyray-video-overlay-action",
    sessionId: opened.sessionId,
    candidateId: pair.candidateId,
    action: "save-materials",
  }, sender);
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.url, "https://v.example.bilivideo.com/video-high.m4s");
  assert.equal(calls[0].body.audioUrl, "https://a.example.bilivideo.com/audio-high.m4s");
});

test("the production background listener answers recording status without entering transport error handling", async () => {
  const harness = await loadBackground();
  const status = await harness.send({ type: "luckyray-record-status" });
  assert.deepEqual(JSON.parse(JSON.stringify(status)), {
    ok: true,
    active: false,
    tabId: null,
    elapsedSec: 0,
  });
});

test("a stale offscreen recorder cannot leave the player video menu loading forever", async () => {
  const harness = await loadBackground({}, null, () => new Promise(() => {}));
  const result = await Promise.race([
    harness.send({
      type: "luckyray-video-overlay-open",
      descriptor: { url: "https://cdn.test/bounded-menu.mp4" },
      pageUrl: "https://page.test/watch",
    }, { tab: { id: 7, url: "https://page.test/watch" }, frameId: 0 }),
    new Promise((resolve) => setTimeout(() => resolve({ code: "fixture-menu-timeout" }), 900)),
  ]);
  assert.equal(result.ok, true);
  assert.notEqual(result.code, "fixture-menu-timeout");
});

test("popup video candidates show the actual source quality instead of a generic direct label", async () => {
  const popup = await loadPopup();
  assert.equal(popup.api.candidateLabel({
    url: "https://v1.pinimg.test/videos/pin-a_720w.cmfv?token=PRIVATE",
    contentType: "video/mp4",
    size: 1_200_000,
    kind: "direct_video",
    direct: true,
  }), "720w · CMFV · 1.1 MB");
});

test("popup candidate discovery defaults to the highest known direct quality rather than the last response", async () => {
  const harness = await loadBackground();
  const emit = (url, size) => harness.webRequestListeners[0]({
    tabId: 7,
    frameId: 0,
    documentId: "document-popup-quality",
    url,
    responseHeaders: [
      { name: "Content-Type", value: "video/mp4" },
      { name: "Content-Length", value: String(size) },
    ],
  });
  emit("https://v1.pinimg.test/videos/pin-a_720w.cmfv", 1_200_000);
  emit("https://v1.pinimg.test/videos/pin-a_360w.cmfv", 300_000);

  const response = await harness.send({ type: "luckyray-popup-get-video-candidates", tabId: 7 });
  assert.match(response.candidates[0].url, /_720w\.cmfv$/);
  assert.match(response.candidates[1].url, /_360w\.cmfv$/);
});

test("popup candidate discovery exposes the same supported-site resolver as the player overlay", async () => {
  const harness = await loadBackground({}, null, null, null, {
    id: 7,
    url: "https://www.youtube.com/watch?v=fixture",
    title: "Fixture YouTube video",
  });
  const response = await harness.send({ type: "luckyray-popup-get-video-candidates", tabId: 7 });
  const resolver = response.candidates.find((candidate) => candidate.kind === "site_page");
  assert.equal(resolver.url, "https://www.youtube.com/watch?v=fixture");
  assert.equal(resolver.contentType, "application/x-luckyray-video-page");
});

test("the popup resolves a safe quality catalog and imports only the selected opaque format", async () => {
  const calls = [];
  const popup = await loadPopup(async ({ path, options }) => {
    calls.push({ path, body: options.body ? JSON.parse(options.body) : null });
    if (path === "/api/media/probes") return jsonResponse(200, {
      probeId: "probe-0123456789abcdef0123456789abcdef",
      formats: [{
        formatId: "format-fedcba9876543210fedcba9876543210",
        label: "720p · MP4 · 含音频",
        width: 1280,
        height: 720,
        fps: 30,
        extension: "mp4",
        videoCodec: "avc1",
        audioCodec: "mp4a",
        estimatedBytes: 21000000,
        bitrate: 2200000,
      }],
    });
    if (path === "/api/media/transfers") return jsonResponse(200, {
      transferId: "media-feed-0123456789abcdef",
      state: "completed",
      bytesReceived: 1024,
      totalBytes: 1024,
      fileName: "Fixture.mp4",
      mimeType: "video/mp4",
      assetId: "asset-opaque",
      assetName: "Fixture.mp4",
      assetKind: "video",
      skippedDuplicate: false,
    });
    return jsonResponse(404, { code: "missing" });
  }, (message) => message?.type === "luckyray-site-auth-request"
    ? { ok: true, siteAuth: { cookies: [], userAgent: "Fixture", referer: message.url } }
    : {});
  popup.api.state.port = 38471;
  popup.api.state.page = {
    title: "Fixture",
    url: "https://www.youtube.com/watch?v=fixture",
    sourceUrl: "https://www.youtube.com/watch?v=fixture",
  };
  const pageCandidate = {
    kind: "site_page",
    url: "https://www.youtube.com/watch?v=fixture",
    direct: false,
  };
  popup.api.state.videoCandidates = [pageCandidate];
  await popup.api.resolvePopupFormats(pageCandidate);
  assert.equal(popup.api.state.videoCandidates.length, 1);
  assert.equal(popup.api.selectedVideoCandidate().label, "720p · MP4 · 含音频");
  const imported = await popup.api.importMedia(
    "video",
    "asset:root",
    "https://www.youtube.com/watch?v=fixture",
    popup.api.selectedVideoCandidate(),
  );
  assert.equal(imported.ok, true);
  const completed = await popup.waitForTask();
  assert.equal(completed.stage, "completed", JSON.stringify(completed));
  assert.equal(completed.asset.id, "asset-opaque");
  const transfer = calls.find((call) => call.path === "/api/media/transfers");
  assert.equal(transfer.body.probeId, "probe-0123456789abcdef0123456789abcdef");
  assert.equal(transfer.body.formatId, "format-fedcba9876543210fedcba9876543210");
  assert.equal(calls.filter((call) => call.path === "/api/media/transfers").length, 1);
  assert.equal(calls.filter((call) => call.path.startsWith("/api/media/transfers/")).length, 0,
    "an already completed create response must not depend on another status read");
  assert.doesNotMatch(JSON.stringify(calls), /bestaudio|PRIVATE/);
});

test("YouTube network video and audio responses become one mergeable candidate", async () => {
  const tab = {
    id: 7,
    url: "https://www.youtube.com/watch?v=fixture123",
    title: "Fixture YouTube video",
  };
  const harness = await loadBackground({}, null, null, null, tab);
  const emit = (url, contentType, size) => harness.webRequestListeners[0]({
    tabId: 7,
    frameId: 0,
    documentId: "youtube-document",
    url,
    responseHeaders: [
      { name: "Content-Type", value: contentType },
      { name: "Content-Length", value: String(size) },
    ],
  });

  emit("https://rr1.example.googlevideo.com/videoplayback?itag=399&mime=video%2Fmp4&clen=9000000&range=0-999&rn=3&rbuf=1", "video/mp4", 1_000);
  emit("https://rr1.example.googlevideo.com/videoplayback?itag=140&mime=audio%2Fmp4&clen=2000000&range=0-499&rn=4&rbuf=1", "audio/mp4", 500);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const response = await harness.send({ type: "luckyray-popup-get-video-candidates", tabId: 7 });
  const pair = response.candidates.find((candidate) => candidate.binding === "site-track-pair");
  assert.ok(pair, JSON.stringify(response));
  assert.match(pair.url, /itag=399/);
  assert.match(pair.audioUrl, /itag=140/);
  assert.match(pair.url, /range=0-8999999/);
  assert.match(pair.audioUrl, /range=0-1999999/);
  assert.doesNotMatch(`${pair.url}${pair.audioUrl}`, /[?&](?:rn|rbuf)=/);
  assert.equal(pair.kind, "track_pair");

  const overlay = await harness.send({
    type: "luckyray-video-overlay-open",
    descriptor: { url: "blob:https://www.youtube.com/player" },
    playerCandidates: [{ url: "blob:https://www.youtube.com/player" }],
    pageUrl: tab.url,
    resolverPageUrl: tab.url,
    playerContext: true,
    width: 1_280,
    height: 720,
  }, { tab, frameId: 0, documentId: "youtube-document" });
  assert.equal(overlay.items.some((item) => item.kind === "track-pair" && item.canSaveToMaterials), true);
});

test("an X feed player binds its resolver to the exact status permalink instead of the feed page", async () => {
  const calls = [];
  const harness = await loadBackground({}, async ({ path, options }) => {
    calls.push({ path, body: options.body ? JSON.parse(options.body) : null });
    return jsonResponse(202, {
      transferId: "media-cafe-fedcba9876543210",
      state: "queued",
      bytesReceived: 0,
      totalBytes: null,
      fileName: "X clip.mp4",
      mimeType: "video/mp4",
      skippedDuplicate: false,
    });
  });
  const sender = { tab: { id: 7, url: "https://x.com/home" }, frameId: 0, documentId: "x-feed-doc" };
  const opened = await harness.send({
    type: "luckyray-video-overlay-open",
    descriptor: { url: "blob:https://x.com/player" },
    playerCandidates: [{ url: "blob:https://x.com/player" }],
    pageUrl: "https://x.com/home",
    resolverPageUrl: "https://x.com/example/status/1234567890",
    pageTitle: "X clip",
    playerContext: true,
  }, sender);
  const resolver = opened.items.find((item) => ["site-resolver", "site_page"].includes(item.kind));
  assert.ok(resolver);
  const started = await harness.send({
    type: "luckyray-video-overlay-action",
    sessionId: opened.sessionId,
    candidateId: resolver.candidateId,
    action: "save-materials",
  }, sender);
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(calls[0].body.url, "https://x.com/example/status/1234567890");
  assert.equal(calls[0].body.sourcePageUrl, "https://x.com/example/status/1234567890");
});

test("an X status player accepts its exact page candidate only with matching network evidence", async () => {
  const harness = await loadBackground();
  const mediaUrl = "https://video.twimg.com/ext_tw_video/right/pu/vid/1280x720/high.mp4";
  const sender = {
    tab: { id: 7, url: "https://x.com/luckyray/status/1234567890", title: "X clip" },
    frameId: 0,
    documentId: "x-status-document",
  };
  const message = {
    type: "luckyray-video-overlay-open",
    descriptor: { url: "blob:https://x.com/primary" },
    playerCandidates: [{
      url: mediaUrl,
      contentType: "video/mp4",
      bitrate: 2_176_000,
      binding: "site-probe",
    }],
    pageUrl: sender.tab.url,
    resolverPageUrl: sender.tab.url,
    playerContext: true,
  };

  const spoofed = await harness.send(message, sender);
  assert.equal(spoofed.items.some((item) => item.host === "video.twimg.com"), false);

  harness.webRequestListeners[0]({
    tabId: 7,
    frameId: 0,
    documentId: "x-status-document",
    url: mediaUrl,
    responseHeaders: [{ name: "Content-Type", value: "video/mp4" }],
  });
  const verified = await harness.send(message, sender);
  assert.equal(verified.items.some((item) => item.host === "video.twimg.com" && item.canSaveToMaterials), true);
});

test("a Pinterest detail page never substitutes the current pin for an unbound related-card player", async () => {
  const harness = await loadBackground();
  const sender = {
    tab: { id: 7, url: "https://www.pinterest.com/pin/111111111111/", title: "Current pin" },
    frameId: 0,
    documentId: "pinterest-detail",
  };
  const unbound = await harness.send({
    type: "luckyray-video-overlay-open",
    descriptor: { url: "blob:https://www.pinterest.com/related-card" },
    playerCandidates: [{ url: "blob:https://www.pinterest.com/related-card" }],
    pageUrl: sender.tab.url,
    resolverPageUrl: "",
    pageTitle: "Related card",
    playerContext: true,
  }, sender);
  assert.equal(unbound.ok, true);
  assert.equal(unbound.items.some((item) => item.kind === "site-resolver"), false);

  const bound = await harness.send({
    type: "luckyray-video-overlay-open",
    descriptor: { url: "blob:https://www.pinterest.com/related-card-2" },
    playerCandidates: [{ url: "blob:https://www.pinterest.com/related-card-2" }],
    pageUrl: sender.tab.url,
    resolverPageUrl: "https://www.pinterest.com/pin/222222222222/",
    pageTitle: "Bound related card",
    playerContext: true,
  }, sender);
  assert.equal(bound.ok, true);
  assert.equal(bound.items.some((item) => item.kind === "site-resolver"), true);
});

test("a Bilibili resolver reuses an already granted site session without prompting", async () => {
  const calls = [];
  const permissionRequests = [];
  const sessionStore = {};
  const harness = await loadBackground(sessionStore, async ({ path, options }) => {
    calls.push({ path, body: options.body ? JSON.parse(options.body) : null });
    return jsonResponse(202, {
      transferId: "media-babe-fedcba9876543210",
      state: "queued",
      bytesReceived: 0,
      totalBytes: null,
      fileName: "Bilibili clip.mp4",
      mimeType: "video/mp4",
      skippedDuplicate: false,
    });
  }, null, null, null, {
    contains: async () => true,
    request: async (details) => { permissionRequests.push(details); return true; },
    getAll: async ({ domain }) => domain === "bilibili.com" ? [{
      name: "SESSDATA",
      value: "PRIVATE-BILI-COOKIE",
      domain: ".bilibili.com",
      path: "/",
      expirationDate: 2_000_000_000,
      secure: true,
      httpOnly: true,
    }] : [],
  });
  const sender = {
    tab: { id: 7, url: "https://www.bilibili.com/video/BV1xx411c7mD" },
    frameId: 0,
    documentId: "bili-video-doc",
  };
  const opened = await harness.send({
    type: "luckyray-video-overlay-open",
    descriptor: { url: "blob:https://www.bilibili.com/player" },
    playerCandidates: [{ url: "blob:https://www.bilibili.com/player" }],
    pageUrl: sender.tab.url,
    resolverPageUrl: sender.tab.url,
    pageTitle: "Bilibili clip",
    playerContext: true,
  }, sender);
  const resolver = opened.items.find((item) => item.kind === "site-resolver");
  assert.ok(resolver);
  const started = await harness.send({
    type: "luckyray-video-overlay-action",
    sessionId: opened.sessionId,
    candidateId: resolver.candidateId,
    action: "save-materials",
  }, sender);
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.deepEqual(JSON.parse(JSON.stringify(permissionRequests)), []);
  assert.equal(calls[0].body.siteAuth.cookies[0].value, "PRIVATE-BILI-COOKIE");
  assert.equal(calls[0].body.siteAuth.userAgent, "Mozilla/5.0 Edg/126");
  assert.equal(calls[0].body.siteAuth.referer, sender.tab.url);
  assert.doesNotMatch(JSON.stringify(sessionStore), /PRIVATE-BILI-COOKIE|SESSDATA/);
});

test("missing cookie permission still attempts the public resolver without cookies", async () => {
  let requestCount = 0;
  const harness = await loadBackground({}, async () => {
    requestCount += 1;
    return jsonResponse(500, { code: "media-resolver-failed" });
  }, null, null, null, {
    async contains() { return false; },
    async request() { throw new Error("public resolver must not prompt"); },
    async getAll() { throw new Error("cookies must not be read without permission"); },
  });
  const pageUrl = "https://www.bilibili.com/video/BV1xx411c7mD";
  const sender = { tab: { id: 7, url: pageUrl }, frameId: 0 };
  const opened = await harness.send({
    type: "luckyray-video-overlay-open",
    descriptor: { url: `blob:${pageUrl}` },
    playerCandidates: [{ url: `blob:${pageUrl}` }],
    resolverPageUrl: pageUrl,
    pageUrl,
    playerContext: true,
  }, sender);
  const resolver = opened.items.find((item) => item.kind === "site-resolver");
  const result = await harness.send({
    type: "luckyray-video-overlay-action",
    sessionId: opened.sessionId,
    candidateId: resolver.candidateId,
    action: "save-materials",
  }, sender);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: false,
    code: "media-resolver-failed",
    message: "没有解析到可下载的公开媒体；登录、地区限制或 DRM 内容可能不可用。",
  });
  assert.equal(requestCount, 1);
});

test("a granted site permission without cookies still binds browser headers to a public resolver", async () => {
  const calls = [];
  const harness = await loadBackground({}, async ({ options }) => {
    calls.push(JSON.parse(options.body));
    return jsonResponse(202, {
      transferId: "media-babe-0123456789abcdef",
      state: "queued",
      bytesReceived: 0,
      totalBytes: null,
      fileName: "Public Bilibili.mp4",
      mimeType: "video/mp4",
      skippedDuplicate: false,
    });
  }, null, null, null, {
    async contains() { return true; },
    async request() { return true; },
    async getAll() { return []; },
  });
  const pageUrl = "https://www.bilibili.com/video/BV1xx411c7mD";
  const sender = { tab: { id: 7, url: pageUrl }, frameId: 0 };
  const opened = await harness.send({
    type: "luckyray-video-overlay-open",
    descriptor: { url: `blob:${pageUrl}` },
    playerCandidates: [{ url: `blob:${pageUrl}` }],
    resolverPageUrl: pageUrl,
    pageUrl,
    playerContext: true,
  }, sender);
  const resolver = opened.items.find((item) => item.kind === "site-resolver");
  const result = await harness.send({
    type: "luckyray-video-overlay-action",
    sessionId: opened.sessionId,
    candidateId: resolver.candidateId,
    action: "save-materials",
  }, sender);
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0].siteAuth.cookies, []);
  assert.equal(calls[0].siteAuth.userAgent, "Mozilla/5.0 Edg/126");
  assert.equal(calls[0].siteAuth.referer, pageUrl);
});

test("video menu creation does not wait forever for the optional session cache", async () => {
  const harness = await loadBackground(
    {}, null, null, null, null, null,
    { get: async () => await new Promise(() => {}), maxTimerMs: 5 },
  );
  const result = await Promise.race([
    harness.send({ type: "luckyray-video-overlay-open", pageTitle: "Pinterest fixture" }, {
      tab: { id: 7, url: "https://www.pinterest.com/pin/123" }, frameId: 0, documentId: "pin-doc",
    }),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, code: "fixture-timeout" }), 50)),
  ]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.canRecord, true);
});

test("video menu creation does not wait forever for stale offscreen document state", async () => {
  const harness = await loadBackground(
    {}, null, { hasDocument: async () => await new Promise(() => {}) }, null, null, null,
    { maxTimerMs: 5 },
  );
  const result = await Promise.race([
    harness.send({ type: "luckyray-video-overlay-open", pageTitle: "X fixture" }, {
      tab: { id: 7, url: "https://x.com/example/status/1234567890" }, frameId: 0, documentId: "x-doc",
    }),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, code: "fixture-timeout" }), 50)),
  ]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.recording, false);
});

test("a direct site CDN candidate carries the authenticated page snapshot into resolver fallback", async () => {
  const calls = [];
  const harness = await loadBackground({}, async ({ path, options }) => {
    calls.push({ path, body: options.body ? JSON.parse(options.body) : null });
    return jsonResponse(202, {
      transferId: "media-cafe-fedcba9876543210", state: "queued", bytesReceived: 0,
      totalBytes: null, fileName: "X direct clip.mp4", mimeType: "video/mp4", skippedDuplicate: false,
    });
  }, null, null, null, {
    contains: async () => true,
    request: async () => true,
    getAll: async ({ domain }) => domain === "x.com" ? [{
      name: "auth_token", value: "PRIVATE-X-COOKIE", domain: ".x.com", path: "/",
      expirationDate: 2_000_000_000, secure: true, httpOnly: true,
    }] : [],
  });
  harness.webRequestListeners[0]({
    tabId: 7, frameId: 0, documentId: "x-direct-doc",
    url: "https://video.twimg.com/ext_tw_video/123/pu/vid/avc1/720x1280/clip.mp4",
    responseHeaders: [{ name: "Content-Type", value: "video/mp4" }],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const sender = {
    tab: { id: 7, url: "https://x.com/example/status/1234567890", title: "X direct clip" },
    frameId: 0, documentId: "x-direct-doc",
  };
  const opened = await harness.send({ type: "luckyray-video-overlay-open", pageUrl: sender.tab.url }, sender);
  const direct = opened.items.find((item) => item.kind === "direct-video" && item.host === "video.twimg.com");
  assert.ok(direct, JSON.stringify(opened));
  const started = await harness.send({
    type: "luckyray-video-overlay-action", sessionId: opened.sessionId,
    candidateId: direct.candidateId, action: "save-materials",
  }, sender);
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(calls[0].body.sourcePageUrl, sender.tab.url);
  assert.equal(calls[0].body.siteAuth.cookies[0].value, "PRIVATE-X-COOKIE");
});

test("record stop gives base64 assembly and its dedicated upload a bounded long timeout", async () => {
  const calls = [];
  const harness = await loadBackground({}, async ({ path, timeoutMs }) => {
    calls.push({ path, timeoutMs });
    if (path === "/api/video/record/save") return jsonResponse(200, {
      ok: true,
      data: {
        disposition: "imported",
        asset: { id: "asset-recorded", name: "Recorded.webm", kind: "video", sizeBytes: 1024 },
      },
    });
    return jsonResponse(404, {});
  }, (message) => {
    if (message.type === "luckyray-offscreen-record-status") return { ok: true, active: false };
    if (message.type === "luckyray-offscreen-record-start") return { ok: true };
    if (message.type === "luckyray-offscreen-record-stop") return { ok: true, base64: "Zml4dHVyZQ==" };
    return { ok: true };
  });

  assert.equal((await harness.send({
    type: "luckyray-record-start",
    tabId: 7,
    pageUrl: "https://page.test/watch",
    pageTitle: "Fixture video",
  })).ok, true);
  assert.equal((await harness.send({ type: "luckyray-record-stop" })).ok, true);
  assert.equal(calls.find((call) => call.path === "/api/video/record/save")?.timeoutMs, 120_000);
  assert.ok(harness.timerDurations.includes(120_000));
});

test("popup video new-folder transfer sends the requested folder name and fails closed without it", async () => {
  const calls = [];
  const harness = await loadPopup(async ({ path, options }) => {
    calls.push({ path, body: options.body ? JSON.parse(options.body) : null });
    return jsonResponse(202, {
      transferId: "media-cafe-0123456789abcdef",
      state: "completed",
      bytesReceived: 1024,
      totalBytes: 1024,
      fileName: "Folder clip.mp4",
      mimeType: "video/mp4",
      assetId: "asset-folder-video",
      assetName: "Folder clip.mp4",
      assetKind: "video",
      skippedDuplicate: false,
    });
  });
  harness.api.state.port = 38471;
  harness.api.state.page = { title: "Folder clip", url: "https://page.test/watch", sourceUrl: "https://page.test/watch" };
  harness.api.state.videoCandidates = [{ url: "https://cdn.test/folder.mp4", contentType: "video/mp4", direct: true }];
  harness.element("lr-new-folder-name").value = "New video folder";
  assert.equal((await harness.api.importMedia("video", "asset:newFolder", "https://cdn.test/folder.mp4")).ok, true);
  const completed = await harness.waitForTask();
  assert.equal(completed.stage, "completed", JSON.stringify(completed));
  assert.equal(completed.asset.id, "asset-folder-video");
  assert.equal(calls[0].body.newFolderName, "New video folder");

  const before = calls.length;
  const rejected = await harness.api.buildVideoTransferRequest("asset:newFolder", "https://cdn.test/folder.mp4", "");
  assert.equal(rejected.ok, false);
  assert.equal(rejected.errorObject.code, "media-input-invalid");
  assert.equal(calls.length, before);
});

test("the popup reuses the authenticated site snapshot without reading cookies itself", async () => {
  const calls = [];
  const harness = await loadPopup(async ({ path, options }) => {
    calls.push({ path, body: options.body ? JSON.parse(options.body) : null });
    return jsonResponse(202, {
      transferId: "media-cafe-abcdef0123456789",
      state: "completed",
      bytesReceived: 1024,
      totalBytes: 1024,
      fileName: "Bilibili popup.mp4",
      mimeType: "video/mp4",
      assetId: "asset-bilibili-popup",
      assetName: "Bilibili popup.mp4",
      assetKind: "video",
      skippedDuplicate: false,
    });
  }, (message) => message.type === "luckyray-site-auth-request" ? {
    ok: true,
    siteAuth: { cookies: [{
      name: "SESSDATA",
      value: "PRIVATE-POPUP-COOKIE",
      domain: ".bilibili.com",
      path: "/",
      expires: 2_000_000_000,
      secure: true,
      httpOnly: true,
    }] },
  } : {});
  harness.api.state.port = 38471;
  harness.api.state.page = {
    title: "Bilibili popup",
    url: "https://www.bilibili.com/video/BV1xx411c7mD",
    sourceUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
  };
  assert.equal((await harness.api.importMedia(
    "video",
    "asset:root",
    "https://www.bilibili.com/video/BV1xx411c7mD",
    null,
  )).ok, true);
  assert.equal((await harness.waitForTask()).stage, "completed");
  assert.equal(calls[0].body.siteAuth.cookies[0].value, "PRIVATE-POPUP-COOKIE");
  assert.doesNotMatch(JSON.stringify(harness.background.localStore), /PRIVATE-POPUP-COOKIE|SESSDATA/);
});

test("the popup starts a public site transfer without requesting cookie permission", async () => {
  const order = [];
  const harness = await loadPopup(async ({ path }) => {
    order.push(`api:${path}`);
    return jsonResponse(202, {
      transferId: "media-cafe-abcdef0123456789",
      state: "completed",
      bytesReceived: 1024,
      totalBytes: 1024,
      fileName: "Bilibili permission.mp4",
      mimeType: "video/mp4",
      assetId: "asset-bilibili-permission",
      assetName: "Bilibili permission.mp4",
      assetKind: "video",
      skippedDuplicate: false,
    });
  }, (message) => {
    order.push(`runtime:${message.type}`);
    return message.type === "luckyray-site-auth-request"
      ? { ok: true, siteAuth: { cookies: [] } }
      : {};
  });
  harness.api.state.port = 38471;
  harness.api.state.page = {
    title: "Bilibili popup",
    url: "https://www.bilibili.com/video/BV1xx411c7mD",
    sourceUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
  };

  const result = await harness.api.importMedia(
    "video",
    "asset:root",
    "https://www.bilibili.com/video/BV1xx411c7mD",
    null,
  );
  assert.equal(result.ok, true);
  assert.equal((await harness.waitForTask()).stage, "completed");
  assert.ok(order.indexOf("runtime:luckyray-site-auth-request") < order.indexOf("api:/api/media/transfers"));
  assert.equal(order.filter((entry) => entry === "api:/api/media/transfers").length, 1);
  assert.equal(harness.permissionRequests.length, 0);
});

test("the popup preserves a discovered track pair in the backend transfer request", async () => {
  const calls = [];
  const harness = await loadPopup(async ({ path, options }) => {
    calls.push({ path, body: options.body ? JSON.parse(options.body) : null });
    return jsonResponse(202, {
      transferId: "media-cafe-abcdefabcdef1234",
      state: "completed",
      bytesReceived: 4096,
      totalBytes: 4096,
      fileName: "YouTube pair.mp4",
      mimeType: "video/mp4",
      assetId: "asset-youtube-pair",
      assetName: "YouTube pair.mp4",
      assetKind: "video",
      skippedDuplicate: false,
    });
  }, (message) => message.type === "luckyray-site-auth-request"
    ? { ok: true, siteAuth: { cookies: [] } }
    : {});
  harness.api.state.port = 38471;
  harness.api.state.page = {
    title: "YouTube pair",
    url: "https://www.youtube.com/watch?v=fixture123",
    sourceUrl: "https://www.youtube.com/watch?v=fixture123",
  };
  harness.api.state.videoCandidates = [{
    url: "https://v.example.googlevideo.com/videoplayback?id=video",
    audioUrl: "https://a.example.googlevideo.com/videoplayback?id=audio",
    binding: "site-track-pair",
    contentType: "video/mp4",
  }];

  const result = await harness.api.importMedia(
    "video",
    "asset:root",
    harness.api.state.videoCandidates[0].url,
    harness.api.state.videoCandidates[0],
  );
  assert.equal(result.ok, true);
  assert.equal((await harness.waitForTask()).stage, "completed");
  assert.equal(calls[0].body.audioUrl, harness.api.state.videoCandidates[0].audioUrl);
  assert.equal(calls[0].body.mimeType, "video/mp4");
  assert.equal(calls.filter((call) => call.path === "/api/media/transfers").length, 1);
});

test("the background reads an already granted session but never blocks a public transfer on permission", async () => {
  let permissionRequests = 0;
  const harness = await loadBackground({}, null, null, null, null, {
    async contains() { return false; },
    async request() { permissionRequests += 1; return false; },
  });
  const response = await harness.send({
    type: "luckyray-site-auth-request",
    url: "https://www.youtube.com/watch?v=fixture123",
  });
  assert.equal(response.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(response.siteAuth.cookies)), []);
  assert.equal(response.siteAuth.userAgent, "Mozilla/5.0 Edg/126");
  assert.equal(response.siteAuth.referer, "https://www.youtube.com/watch?v=fixture123");
  assert.equal(permissionRequests, 0);
});

test("the popup site authorization snapshot includes the exact browser session headers", async () => {
  const harness = await loadBackground({}, null, null, null, null, {
    async contains() { return true; },
    async request() { return true; },
    async getAll() {
      return [{
        name: "SESSDATA",
        value: "PRIVATE-BILI-COOKIE",
        domain: ".bilibili.com",
        path: "/",
        expirationDate: 2_000_000_000,
        secure: true,
        httpOnly: true,
      }];
    },
  });
  const exactPage = "https://www.bilibili.com/video/BV1xx411c7mD";
  const response = await harness.send({ type: "luckyray-site-auth-request", url: exactPage });
  assert.equal(response.ok, true);
  assert.equal(response.siteAuth.cookies[0].value, "PRIVATE-BILI-COOKIE");
  assert.equal(response.siteAuth.userAgent, "Mozilla/5.0 Edg/126");
  assert.equal(response.siteAuth.referer, exactPage);
});

test("the popup preserves a stable backend resolver error and classifies YouTube precisely", async () => {
  const harness = await loadPopup(async () => jsonResponse(500, {
    code: "media-resolver-failed",
    message: "PRIVATE raw provider body",
  }), (message) => message.type === "luckyray-site-auth-request" ? { ok: true, siteAuth: null } : {});
  harness.api.state.port = 38471;
  harness.api.state.page = {
    title: "YouTube fixture",
    url: "https://www.youtube.com/watch?v=fixture123",
    sourceUrl: "https://www.youtube.com/watch?v=fixture123",
  };
  const result = await harness.api.importMedia(
    "video",
    "asset:root",
    "https://www.youtube.com/watch?v=fixture123",
  );
  assert.equal(result.ok, true, "accepting a background task does not claim the transfer completed");
  const failed = await harness.waitForTask();
  assert.equal(failed.stage, "failed");
  assert.equal(failed.errorCode, "media-resolver-failed");
  await harness.api.observeCaptureTask();
  assert.match(harness.element("lr-capture-task-label").textContent, /PO Token/);
  assert.doesNotMatch(JSON.stringify([failed, harness.background.localStore]), /PRIVATE|provider body/);
});

test("context-menu video prefill without a bound descriptor never writes (durable storage banned)", async () => {
  const sessionStore = {};
  const harness = await loadBackground(sessionStore);
  assert.equal(harness.contextMenuListeners.length, 1);
  // EXT-R1-REPAIR-3 contract C: a bare browser srcUrl with no current
  // content-side bound descriptor must fail closed — zero prefill anywhere.
  await harness.contextMenuListeners[0]({
    menuItemId: "luckyray-video-new-folder",
    srcUrl: "https://cdn.test/private-video.mp4?token=PRIVATE-PREFILL",
  }, { id: 7, url: "https://page.test/watch", title: "Fixture video" });
  assert.equal(harness.localWrites.length, 0);
  assert.equal(sessionStore.prefill, undefined,
    "an unbound video srcUrl must never become a delayed prefill");
});

test("popup record stop keeps its message channel alive for the dedicated long save timeout", async () => {
  const harness = await loadPopup(null, (message) => message.type === "luckyray-record-stop"
    ? { ok: true, disposition: "imported", assetName: "Recorded.webm" }
    : {});
  await harness.api.onRecordStop();
  assert.deepEqual(JSON.parse(JSON.stringify(harness.runtimeCalls)), [{ type: "luckyray-record-stop" }]);
  assert.ok(harness.timerDurations.includes(120_000));
  assert.equal(harness.api.state.recording.status, "success");
});

test("popup deletes an expired session prefill before rejecting it", async () => {
  const popupSessionStore = {
    prefill: {
      type: "video",
      ts: Date.now() - 60_001,
      mediaDescriptor: { type: "video", url: "https://cdn.test/expired.mp4?token=PRIVATE-EXPIRED" },
    },
  };
  const harness = await loadPopup(null, null, popupSessionStore);
  assert.equal(await harness.api.applyPrefill(), false);
  assert.equal("prefill" in popupSessionStore, false);
});

test("video overlay starts one backend transfer and observes running through completed without leaking raw inputs", async () => {
  const calls = [];
  const transferId = "media-abc-0123456789abcdef";
  let statusRead = 0;
  const harness = await loadBackground({}, async ({ path, options }) => {
    calls.push({ path, method: options.method || "GET", body: options.body || "" });
    if (path === "/api/media/transfers" && options.method === "POST") {
      return jsonResponse(202, { ok: true, data: {
        transferId,
        state: "queued",
        bytesReceived: 0,
        totalBytes: 4096,
        fileName: "Demo clip.mp4",
        mimeType: "video/mp4",
        skippedDuplicate: false,
      } });
    }
    if (path === `/api/media/transfers/${transferId}` && options.method === "GET") {
      statusRead += 1;
      return jsonResponse(200, { ok: true, data: statusRead === 1 ? {
        transferId,
        state: "running",
        bytesReceived: 2048,
        totalBytes: 4096,
        fileName: "Demo clip.mp4",
        mimeType: "video/mp4",
        skippedDuplicate: false,
      } : {
        transferId,
        state: "completed",
        bytesReceived: 4096,
        totalBytes: 4096,
        fileName: "Demo clip.mp4",
        mimeType: "video/mp4",
        assetId: "asset-safe-1",
        assetName: "Demo clip.mp4",
        assetKind: "video",
        skippedDuplicate: false,
      } });
    }
    return jsonResponse(404, { code: "not-found" });
  });
  harness.webRequestListeners[0]({
    tabId: 7,
    frameId: 0,
    documentId: "document-transfer",
    url: "https://cdn.test/private-video.mp4?token=PRIVATE",
    responseHeaders: [{ name: "Content-Type", value: "video/mp4" }],
  });
  const opened = await harness.send({
    type: "luckyray-video-overlay-open",
    pageTitle: "Demo / clip",
    pageUrl: "https://page.test/watch?token=PRIVATE-PAGE",
  }, { tab: { id: 7, url: "https://page.test/watch" }, frameId: 0, documentId: "document-transfer" });
  const candidateId = opened.items[0].candidateId;
  const started = await harness.send({
    type: "luckyray-video-overlay-action",
    sessionId: opened.sessionId,
    candidateId,
    action: "save-materials",
  }, { tab: { id: 7, url: "https://page.test/watch" }, frameId: 0, documentId: "document-transfer" });
  assert.equal(started.ok, true);
  assert.equal(started.transfer.state, "queued");
  assert.doesNotMatch(JSON.stringify(started), /PRIVATE|private-video|page\.test/);
  const request = JSON.parse(calls[0].body);
  assert.match(request.requestId, /^video:/);
  assert.deepEqual(request, {
    requestId: request.requestId,
    url: "https://cdn.test/private-video.mp4?token=PRIVATE",
    fileName: "Demo clip.mp4",
    mimeType: "video/mp4",
    sourcePageUrl: "https://page.test/watch?token=PRIVATE-PAGE",
  });

  const running = await harness.send({
    type: "luckyray-video-overlay-action",
    sessionId: opened.sessionId,
    candidateId,
    action: "media-transfer-status",
  }, { tab: { id: 7, url: "https://page.test/watch" }, frameId: 0, documentId: "document-transfer" });
  assert.equal(running.transfer.state, "running");
  assert.equal(running.transfer.percent, 50);

  const completed = await harness.send({
    type: "luckyray-video-overlay-action",
    sessionId: opened.sessionId,
    candidateId,
    action: "media-transfer-status",
  }, { tab: { id: 7, url: "https://page.test/watch" }, frameId: 0, documentId: "document-transfer" });
  assert.equal(completed.transfer.state, "completed");
  assert.equal(completed.transfer.assetId, "asset-safe-1");
  assert.doesNotMatch(JSON.stringify(completed), /PRIVATE|private-video|page\.test/);
});

test("a transient local-service disconnect while polling does not turn a completed import into a false failure", async () => {
  const transferId = "media-babe-0123456789abcdef";
  let statusAttempts = 0;
  const harness = await loadBackground({}, async ({ path, options }) => {
    if (path === "/api/media/transfers" && options.method === "POST") {
      return jsonResponse(202, {
        transferId,
        state: "queued",
        bytesReceived: 0,
        totalBytes: null,
        fileName: "Reconnect clip.mp4",
        mimeType: "video/mp4",
        skippedDuplicate: false,
      });
    }
    if (path === `/api/media/transfers/${transferId}` && options.method === "GET") {
      statusAttempts += 1;
      if (statusAttempts === 1) throw new Error("fixture connection rotated");
      return jsonResponse(200, {
        transferId,
        state: "completed",
        bytesReceived: 2_457,
        totalBytes: 2_457,
        fileName: "Reconnect clip.mp4",
        mimeType: "video/mp4",
        assetId: "asset-reconnect-1",
        assetName: "Reconnect clip.mp4",
        assetKind: "video",
        skippedDuplicate: false,
      });
    }
    return jsonResponse(404, { code: "media-transfer-not-found" });
  });
  harness.webRequestListeners[0]({
    tabId: 7,
    frameId: 0,
    documentId: "document-reconnect",
    url: "https://cdn.test/reconnect.mp4",
    responseHeaders: [{ name: "Content-Type", value: "video/mp4" }],
  });
  const sender = {
    tab: { id: 7, url: "https://page.test/watch" },
    frameId: 0,
    documentId: "document-reconnect",
  };
  const opened = await harness.send({ type: "luckyray-video-overlay-open" }, sender);
  const candidateId = opened.items[0].candidateId;
  const started = await harness.send({
    type: "luckyray-video-overlay-action",
    sessionId: opened.sessionId,
    candidateId,
    action: "save-materials",
  }, sender);
  assert.equal(started.ok, true);

  const completed = await harness.send({
    type: "luckyray-video-overlay-action",
    sessionId: opened.sessionId,
    candidateId,
    action: "media-transfer-status",
  }, sender);

  assert.equal(completed.ok, true);
  assert.equal(completed.transfer.state, "completed");
  assert.equal(completed.transfer.assetId, "asset-reconnect-1");
  assert.equal(statusAttempts, 2);
});

test("a page media drag reuses the production image and video import paths exactly once", async () => {
  const calls = [];
  const sessionStore = {};
  const harness = await loadBackground(sessionStore, async ({ path, options }) => {
    calls.push({ path, method: options.method, body: options.body ? JSON.parse(options.body) : null });
    if (path === "/api/assets/import-media") {
      return jsonResponse(200, {
        disposition: "imported",
        asset: { id: "asset-drag-image", name: "drag.jpg", kind: "image" },
      });
    }
    if (path === "/api/media/transfers") {
      return jsonResponse(202, {
        transferId: "media-dada-0123456789abcdef",
        state: "queued",
        bytesReceived: 0,
        totalBytes: null,
        fileName: "Drag video.mp4",
        mimeType: "video/mp4",
        skippedDuplicate: false,
      });
    }
    return jsonResponse(404, { code: "media-transfer-not-found" });
  });
  const sender = {
    tab: { id: 7, url: "https://page.test/gallery", title: "Drag gallery" },
    frameId: 0,
    documentId: "document-drag",
  };

  const image = await harness.send({
    type: "luckyray-drag-collect",
    mediaType: "image",
    actionId: "drag-image-1",
    url: "https://cdn.test/drag.jpg?token=PRIVATE",
  }, sender);
  const video = await harness.send({
    type: "luckyray-drag-collect",
    mediaType: "video",
    actionId: "drag-video-1",
    url: "https://cdn.test/drag.mp4?token=PRIVATE",
    contentType: "video/mp4",
  }, sender);

  assert.equal(image.ok, true);
  assert.equal(video.ok, true);
  assert.equal(calls.filter((call) => call.path === "/api/assets/import-media").length, 1);
  assert.equal(calls.filter((call) => call.path === "/api/media/transfers").length, 1);
  assert.equal(calls[0].body.captureSource, "drag");
  assert.equal(calls[1].body.url, "https://cdn.test/drag.mp4?token=PRIVATE");
  assert.doesNotMatch(JSON.stringify(image), /PRIVATE|cdn\.test/);
  assert.doesNotMatch(JSON.stringify(video), /PRIVATE|cdn\.test/);

  const pickFolder = await harness.send({
    type: "luckyray-drag-collect",
    mediaType: "image",
    target: "pick-folder",
    actionId: "drag-image-folder-1",
    url: "https://cdn.test/drag-folder.jpg?token=PRIVATE",
  }, sender);
  assert.equal(pickFolder.ok, false);
  assert.equal(pickFolder.code, "media-input-invalid");
  assert.equal(sessionStore.prefill, undefined, "drag collection must never redirect into the popup folder picker");
  assert.equal(calls.filter((call) => call.path === "/api/assets/import-media").length, 1);
  assert.doesNotMatch(JSON.stringify(pickFolder), /PRIVATE|cdn\.test/);
});

test("the drag collector lists safe material folders and imports directly without opening the popup", async () => {
  const calls = [];
  const harness = await loadBackground({}, async ({ path, options }) => {
    calls.push({ path, method: options.method, body: options.body ? JSON.parse(options.body) : null });
    if (path === "/api/folders") return jsonResponse(200, {
      ok: true,
      data: {
        folders: [
          { id: "folder-a", parentId: null, name: "灵感", sortOrder: 1, private: "PRIVATE" },
          { id: "folder-b", parentId: "folder-a", name: "视频", sortOrder: 2 },
        ],
      },
    });
    if (path === "/api/assets/import-media") return jsonResponse(200, {
      disposition: "imported",
      asset: { id: "asset-folder", name: "drag.jpg", kind: "image" },
    });
    if (path === "/api/media/transfers") return jsonResponse(202, {
      transferId: "media-dada-0123456789abcdef",
      state: "queued",
      bytesReceived: 0,
      totalBytes: null,
      fileName: "drag.mp4",
      mimeType: "video/mp4",
      skippedDuplicate: false,
    });
    return jsonResponse(404, { code: "missing" });
  });
  const sender = { tab: { id: 7, url: "https://page.test/gallery", title: "Gallery" }, frameId: 0 };

  const listed = await harness.send({ type: "luckyray-drag-folders" }, sender);
  assert.deepEqual(JSON.parse(JSON.stringify(listed)), {
    ok: true,
    folders: [
      { id: "folder-a", parentId: null, name: "灵感" },
      { id: "folder-b", parentId: "folder-a", name: "视频" },
    ],
  });
  assert.doesNotMatch(JSON.stringify(listed), /PRIVATE|sortOrder/);

  const imported = await harness.send({
    type: "luckyray-drag-collect",
    mediaType: "image",
    targetFolderId: "folder-b",
    actionId: "drag-image-folder-direct",
    url: "https://cdn.test/drag-folder.jpg",
  }, sender);
  assert.equal(imported.ok, true, JSON.stringify(imported));
  const importCall = calls.find((call) => call.path === "/api/assets/import-media");
  assert.equal(importCall.body.targetFolderId, "folder-b");

  const created = await harness.send({
    type: "luckyray-drag-collect",
    mediaType: "video",
    newFolderName: "本次视频",
    actionId: "drag-video-folder-new",
    url: "https://cdn.test/drag-folder.mp4",
    contentType: "video/mp4",
  }, sender);
  assert.equal(created.ok, true, JSON.stringify(created));
  const transferCall = calls.find((call) => call.path === "/api/media/transfers");
  assert.equal(transferCall.body.newFolderName, "本次视频");
});

test("a Pinterest CMFV player with an empty MIME still opens a saveable overlay candidate", async () => {
  const harness = await loadBackground();
  const opened = await harness.send({
    type: "luckyray-video-overlay-open",
    pageUrl: "https://www.pinterest.com/pin/123456789/",
    resolverPageUrl: "https://www.pinterest.com/pin/123456789/",
    playerCandidates: [{
      url: "https://v1.pinimg.com/videos/pin-a_360w.cmfv?token=PRIVATE",
      contentType: "",
      width: 360,
      height: 640,
    }],
    playerContext: true,
  }, {
    tab: { id: 7, url: "https://www.pinterest.com/pin/123456789/", title: "Pinterest" },
    frameId: 0,
    documentId: "document-pin-overlay",
  });

  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.ok(opened.items.some((item) => item.canSaveToMaterials && item.kind === "direct-video"), JSON.stringify(opened));
  assert.doesNotMatch(JSON.stringify(opened), /PRIVATE|pin-a/);
});

test("a Pinterest preview drag upgrades to the highest detail-page format when resolution succeeds", async () => {
  const calls = [];
  const harness = await loadBackground({}, async ({ path, options }) => {
    calls.push({ path, body: options.body ? JSON.parse(options.body) : null });
    if (path === "/api/media/probes") return jsonResponse(200, {
      probeId: "probe-0123456789abcdef0123456789abcdef",
      formats: [{
        formatId: "format-fedcba9876543210fedcba9876543210",
        label: "1080p · MP4 · 含音频",
        width: 1920,
        height: 1080,
        fps: 30,
        extension: "mp4",
        videoCodec: "avc1",
        audioCodec: "mp4a",
        estimatedBytes: 42_000_000,
        bitrate: 4_000_000,
      }],
    });
    if (path === "/api/media/transfers") return jsonResponse(202, {
      transferId: "media-cafe-0123456789abcdef",
      state: "queued",
      bytesReceived: 0,
      totalBytes: null,
      fileName: "Pinterest.mp4",
      mimeType: "video/mp4",
      skippedDuplicate: false,
    });
    return jsonResponse(404, { code: "missing" });
  });
  const pinUrl = "https://www.pinterest.com/pin/123456789/";
  const result = await harness.send({
    type: "luckyray-drag-collect",
    mediaType: "video",
    resolveVideo: true,
    resolverPageUrl: pinUrl,
    playerCandidates: [{
      url: "https://v1.pinimg.com/videos/pin-a_360w.cmfv?token=PRIVATE-LOW",
      contentType: "",
      width: 360,
      height: 640,
    }],
    width: 360,
    height: 640,
    actionId: "drag-pinterest-preview",
    target: "root",
  }, {
    tab: { id: 7, url: "https://www.pinterest.com/", title: "Pinterest" },
    frameId: 0,
    documentId: "document-pin-preview",
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls.filter((call) => call.path === "/api/media/probes").length, 1);
  const transfer = calls.find((call) => call.path === "/api/media/transfers");
  assert.equal(transfer.body.url, pinUrl);
  assert.equal(transfer.body.probeId, "probe-0123456789abcdef0123456789abcdef");
  assert.equal(transfer.body.formatId, "format-fedcba9876543210fedcba9876543210");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|pinimg/);
});

test("a Pinterest feed drag without an exact Pin URL prefers its adaptive HLS master over a fixed low CMFV", async () => {
  const calls = [];
  const harness = await loadBackground({}, async ({ path, options }) => {
    calls.push({ path, body: options.body ? JSON.parse(options.body) : null });
    if (path === "/api/media/probes") return jsonResponse(422, { code: "media-no-formats" });
    if (path === "/api/media/transfers") return jsonResponse(202, {
      transferId: "media-acde-0123456789abcdef",
      state: "queued",
      bytesReceived: 0,
      totalBytes: null,
      fileName: "Pinterest adaptive.mp4",
      mimeType: "video/mp4",
      skippedDuplicate: false,
    });
    return jsonResponse(404, { code: "missing" });
  });
  const result = await harness.send({
    type: "luckyray-drag-collect",
    mediaType: "video",
    resolveVideo: true,
    resolverPageUrl: "",
    playerCandidates: [
      {
        url: "https://v1.pinimg.com/videos/pin-a_360w.cmfv?token=PRIVATE-LOW",
        contentType: "video/mp4",
        width: 360,
        height: 416,
      },
      {
        url: "https://v1.pinimg.com/videos/pin-a_360w.m3u8?token=PRIVATE-FIXED",
        contentType: "application/vnd.apple.mpegurl",
        width: 360,
        height: 0,
      },
      {
        url: "https://v1.pinimg.com/videos/pin-a-master.m3u8?token=PRIVATE-MASTER",
        contentType: "application/vnd.apple.mpegurl",
        width: 0,
        height: 0,
      },
    ],
    width: 360,
    height: 416,
    actionId: "drag-pinterest-adaptive-master",
    target: "root",
  }, {
    tab: { id: 7, url: "https://www.pinterest.com/", title: "Pinterest" },
    frameId: 0,
    documentId: "document-pin-adaptive",
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  const transfer = calls.find((call) => call.path === "/api/media/transfers");
  assert.equal(transfer.body.url, "https://v1.pinimg.com/videos/pin-a-master.m3u8?token=PRIVATE-MASTER");
  assert.equal(transfer.body.mimeType, "application/vnd.apple.mpegurl");
});

test("a Pinterest preview drag keeps its CMFV player fallback when the detail resolver has no catalog", async () => {
  const calls = [];
  const harness = await loadBackground({}, async ({ path, options }) => {
    calls.push({ path, body: options.body ? JSON.parse(options.body) : null });
    if (path === "/api/media/probes") return jsonResponse(422, { code: "media-no-formats" });
    if (path === "/api/media/transfers") return jsonResponse(202, {
      transferId: "media-cafe-fedcba9876543210",
      state: "queued",
      bytesReceived: 0,
      totalBytes: null,
      fileName: "Pinterest preview.mp4",
      mimeType: "video/mp4",
      skippedDuplicate: false,
    });
    return jsonResponse(404, { code: "missing" });
  });
  const result = await harness.send({
    type: "luckyray-drag-collect",
    mediaType: "video",
    resolveVideo: true,
    resolverPageUrl: "https://www.pinterest.com/pin/123456789/",
    playerCandidates: [{
      url: "https://v1.pinimg.com/videos/pin-a_360w.cmfv?token=PRIVATE-LOW",
      contentType: "",
      width: 360,
      height: 640,
    }],
    width: 360,
    height: 640,
    actionId: "drag-pinterest-preview-fallback",
    target: "root",
  }, {
    tab: { id: 7, url: "https://www.pinterest.com/", title: "Pinterest" },
    frameId: 0,
    documentId: "document-pin-preview-fallback",
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  const transfer = calls.find((call) => call.path === "/api/media/transfers");
  assert.equal(transfer.body.url, "https://v1.pinimg.com/videos/pin-a_360w.cmfv?token=PRIVATE-LOW");
  assert.equal(transfer.body.mimeType, "video/mp4");
  assert.equal("probeId" in transfer.body, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|pinimg/);
});

test("a blob-player drag without verified player evidence never starts an arbitrary recent transfer", async () => {
  const clock = { now: 10_000 };
  const calls = [];
  const harness = await loadBackground({}, async ({ path, options }) => {
    calls.push({ path, method: options.method, body: options.body ? JSON.parse(options.body) : null });
    if (path === "/api/media/transfers") return jsonResponse(202, {
      transferId: "media-dada-0123456789abcdef",
      state: "queued",
      bytesReceived: 0,
      totalBytes: null,
      fileName: "Drag gallery.mp4",
      mimeType: "video/mp4",
      skippedDuplicate: false,
    });
    return jsonResponse(404, { code: "media-transfer-not-found" });
  }, null, clock);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const emit = (url) => harness.webRequestListeners[0]({
    tabId: 7,
    frameId: 0,
    documentId: "document-blob-drag",
    url,
    responseHeaders: [{ name: "Content-Type", value: "video/mp4" }],
  });
  emit("https://v1.pinimg.test/videos/old-pin_1080w.cmfv?token=PRIVATE-OLD");
  clock.now += 1_000;
  emit("https://v1.pinimg.test/videos/current-pin_360w.cmfv?token=PRIVATE-CURRENT");
  clock.now += 100;
  emit("https://v1.pinimg.test/videos/current-pin_720w.cmfv?token=PRIVATE-CURRENT");

  const result = await harness.send({
    type: "luckyray-drag-collect",
    mediaType: "video",
    resolveVideo: true,
    playerCandidates: [],
    width: 720,
    height: 1_080,
    actionId: "drag-blob-player-1",
    target: "root",
  }, {
    tab: { id: 7, url: "https://page.test/gallery", title: "Drag gallery" },
    frameId: 0,
    documentId: "document-blob-drag",
  });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.code, "media-format-unsupported");
  assert.equal(calls.filter((call) => call.path === "/api/media/transfers").length, 0);
  assert.doesNotMatch(JSON.stringify(result), /pinimg|PRIVATE|current-pin/);
});

test("a popup task resumes observation after a typed transport interruption without restarting its transfer", async () => {
  const transferId = "media-face-0123456789abcdef";
  let postCount = 0;
  let statusCount = 0;
  const ports = [];
  const harness = await loadPopup(async ({ port, path, options }) => {
    ports.push(port);
    if (path === "/api/media/transfers" && options.method === "POST") {
      postCount += 1;
      return jsonResponse(202, {
        transferId,
        state: "queued",
        bytesReceived: 0,
        totalBytes: null,
        fileName: "Popup reconnect.mp4",
        mimeType: "video/mp4",
        skippedDuplicate: false,
      });
    }
    if (path === `/api/media/transfers/${transferId}` && options.method === "GET") {
      statusCount += 1;
      if (statusCount === 1) {
        const error = new Error("fixture transport reset");
        error.code = "app-unavailable";
        throw error;
      }
      return jsonResponse(200, {
        transferId,
        state: "completed",
        bytesReceived: 2_457,
        totalBytes: 2_457,
        fileName: "Popup reconnect.mp4",
        mimeType: "video/mp4",
        assetId: "asset-popup-reconnect",
        assetName: "Popup reconnect.mp4",
        assetKind: "video",
        skippedDuplicate: false,
      });
    }
    return jsonResponse(404, { code: "media-transfer-not-found" });
  }, (message) => message.type === "luckyray-popup-get-port"
    ? { port: 38_472, code: null }
    : message.type === "luckyray-site-auth-request"
      ? { ok: true, siteAuth: null }
      : {}, {}, { runTimers: true });
  harness.api.state.port = 38_471;
  harness.api.state.page = {
    title: "Popup reconnect",
    url: "https://page.test/watch",
    sourceUrl: "https://page.test/watch",
  };
  harness.api.state.videoCandidates = [{
    url: "https://cdn.test/popup-reconnect.mp4",
    kind: "direct_video",
    direct: true,
    contentType: "video/mp4",
  }];

  const result = await harness.api.importMedia(
    "video",
    "asset:root",
    "https://cdn.test/popup-reconnect.mp4",
  );

  assert.equal(result.ok, true);
  const paused = await harness.waitForTask();
  assert.equal(paused.stage, "paused");
  assert.equal(paused.transferId, transferId);
  assert.equal(paused.errorCode, "app-unavailable");
  assert.equal(postCount, 1);
  assert.equal((await harness.taskAction("resume", paused.id)).ok, true);
  const completed = await harness.waitForTask();
  assert.equal(completed.stage, "completed", JSON.stringify(completed));
  assert.equal(completed.transferId, transferId);
  assert.equal(completed.asset.id, "asset-popup-reconnect");
  await harness.api.observeCaptureTask();
  assert.equal(postCount, 1);
  assert.equal(statusCount, 2);
  assert.deepEqual(ports, [null, null, null], "the background delegates endpoint recovery to the shared transport");
  assert.equal(harness.element("lr-transfer-progress-label").textContent, "已入库");
  assert.equal(harness.element("lr-transfer-progress-fill").style.width, "100%");
  assert.equal(harness.element("lr-transfer-progress").style.display, "grid");
});

test("capture task messages accept only the exact extension popup identity with or without a tab", async () => {
  const calls = [];
  const harness = await loadBackground({}, async ({ path, options }) => {
    calls.push({ path, method: options.method });
    return jsonResponse(500, { code: "unexpected-request" });
  });
  const popupUrl = "chrome-extension://fixture-extension/popup.html";
  const validSenders = [
    { id: "fixture-extension", url: popupUrl },
    { id: "fixture-extension", url: popupUrl, tab: { id: 71, url: popupUrl } },
  ];
  for (const sender of validSenders) {
    const status = await harness.send({ type: "luckyray-capture-task", action: "status" }, sender);
    assert.equal(status.ok, true, JSON.stringify({ sender, status }));
    assert.equal(status.task, null);
  }
  const rejectedSenders = [
    { id: "fixture-extension", url: "https://page.test/watch", tab: { id: 7, url: "https://page.test/watch" } },
    { id: "external-extension", url: popupUrl },
    { id: "fixture-extension", url: "chrome-extension://fixture-extension/offscreen.html" },
  ];
  const input = {
    kind: "video", sourceUrl: "https://page.test/watch",
    request: { requestId: "popup:identity-denied", url: "https://cdn.test/video.mp4", fileName: "Fixture.mp4" },
  };
  for (const sender of rejectedSenders) {
    for (const action of ["status", "start"]) {
      const denied = await harness.send({ type: "luckyray-capture-task", action, input }, sender);
      assert.equal(denied.ok, false, JSON.stringify({ sender, denied }));
      assert.equal(denied.code, "capture-task-forbidden");
    }
  }
  assert.equal(calls.length, 0, "rejected identities must never reach a protected API request");
  assert.equal(harness.localWrites.length, 0, "rejected starts must not create a persisted task");
});

test("reopening the popup observes the existing duplicate video task and attaches once to its frozen note", async () => {
  const transferId = "media-deed-0123456789abcdef";
  const calls = [];
  let releaseTransfer;
  const statusReady = new Promise((resolve) => { releaseTransfer = resolve; });
  const first = await loadPopup(async ({ path, options }) => {
    calls.push({ path, method: options.method, body: options.body ? JSON.parse(options.body) : null });
    if (path === "/api/media/transfers" && options.method === "POST") return jsonResponse(202, {
      transferId, state: "queued", bytesReceived: 0, totalBytes: 4096,
      fileName: "Frozen video.mp4", mimeType: "video/mp4", skippedDuplicate: false,
    });
    if (path === `/api/media/transfers/${transferId}` && options.method === "GET") return statusReady;
    if (path === "/api/notes/attach-material" && options.method === "POST") return jsonResponse(200, {
      ok: true, data: { noteId: "original-note", indexStale: false },
    });
    return jsonResponse(404, { code: "missing" });
  });
  first.api.state.port = 38471;
  const submission = {
    requestId: "popup:frozen-video", type: "video", target: "note:recent",
    noteId: "original-note", sourceUrl: "https://page.test/original",
    pageTitle: "Frozen video", newFolderName: "", folderId: "",
  };
  const binding = { activation: { vaultId: "original-vault", sourceEpoch: 17 } };
  assert.equal((await first.api.importMedia(
    "video", "asset:root", "https://cdn.test/frozen.mp4", { contentType: "video/mp4" }, submission, binding,
  )).ok, true);
  const running = await first.waitForTask("transferring");
  assert.equal(running.transferId, transferId);

  // Discard the first popup's presentation state. Only the actual production
  // background controller and its persisted task survive in the second view.
  const reopened = await loadPopup(null, null, {}, { background: first.background });
  reopened.api.state.port = 38471;
  reopened.api.state.currentNote = { noteId: "different-note" };
  const pending = await reopened.taskAction("status");
  assert.equal(pending.task.id, submission.requestId);
  assert.equal(pending.task.transferId, transferId);
  assert.equal((await reopened.api.importMedia("video", "asset:root", "https://cdn.test/other.mp4")).code, "capture-task-pending");
  releaseTransfer(jsonResponse(200, {
    transferId, state: "completed", bytesReceived: 4096, totalBytes: 4096,
    fileName: "Frozen video.mp4", mimeType: "video/mp4", skippedDuplicate: true,
    assetId: "asset-existing-video", assetName: "Frozen video.mp4", assetKind: "video",
  }));
  const completed = await reopened.waitForTask();
  assert.equal(completed.stage, "completed", JSON.stringify(completed));
  assert.equal(completed.disposition, "duplicate");
  assert.equal(completed.noteRequest.noteId, "original-note");
  assert.equal(completed.noteRequest.binding.activation.vaultId, "original-vault");
  assert.equal(calls.filter((call) => call.path === "/api/media/transfers").length, 1);
  const attachments = calls.filter((call) => call.path === "/api/notes/attach-material");
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].body.requestId, submission.requestId);
  assert.equal(attachments[0].body.assetId, "asset-existing-video");
  assert.equal(attachments[0].body.noteId, "original-note");
  await reopened.api.observeCaptureTask();
  assert.equal(reopened.element("lr-capture-task-label").textContent, "素材已存在，并已写入笔记");
  assert.equal(reopened.element("lr-transfer-progress-fill").style.width, "100%");
  assert.equal(calls.filter((call) => call.path === "/api/notes/attach-material").length, 1);
  assert.equal(first.background.localStore.luckyrayCaptureTaskV1.stage, "completed");
});

test("video overlay cancels only its bound backend transfer", async () => {
  const calls = [];
  const transferId = "media-def-abcdef0123456789";
  const harness = await loadBackground({}, async ({ path, options }) => {
    calls.push({ path, method: options.method || "GET" });
    if (path === "/api/media/transfers") return jsonResponse(202, {
      transferId,
      state: "running",
      bytesReceived: 512,
      totalBytes: 4096,
      fileName: "Cancel clip.mp4",
      mimeType: "video/mp4",
      skippedDuplicate: false,
    });
    if (path === `/api/media/transfers/${transferId}/cancel`) return jsonResponse(200, {
      transferId,
      state: "cancelling",
      bytesReceived: 512,
      totalBytes: 4096,
      fileName: "Cancel clip.mp4",
      mimeType: "video/mp4",
      skippedDuplicate: false,
    });
    return jsonResponse(404, { code: "media-transfer-not-found" });
  });
  harness.webRequestListeners[0]({
    tabId: 7,
    frameId: 0,
    url: "https://cdn.test/cancel.mp4?token=PRIVATE-CANCEL",
    responseHeaders: [{ name: "Content-Type", value: "video/mp4" }],
  });
  const sender = { tab: { id: 7, url: "https://page.test/watch" }, frameId: 0 };
  const opened = await harness.send({ type: "luckyray-video-overlay-open", pageTitle: "Cancel clip" }, sender);
  const candidateId = opened.items[0].candidateId;
  assert.equal((await harness.send({
    type: "luckyray-video-overlay-action",
    sessionId: opened.sessionId,
    candidateId,
    action: "save-materials",
  }, sender)).ok, true);
  const cancelled = await harness.send({
    type: "luckyray-video-overlay-action",
    sessionId: opened.sessionId,
    candidateId,
    action: "media-transfer-cancel",
  }, sender);
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.transfer.state, "cancelling");
  assert.equal(calls.at(-1).path, `/api/media/transfers/${transferId}/cancel`);
  assert.doesNotMatch(JSON.stringify(cancelled), /PRIVATE|cancel\.mp4|cdn\.test/);
});

test("media transfer failures expose only a fixed safe code and never the local response body", async () => {
  let requestCount = 0;
  const harness = await loadBackground({}, async () => {
    requestCount += 1;
    return jsonResponse(500, {
      code: "media-download-failed",
      message: "PRIVATE-BODY https://internal.test/path?token=SECRET C:\\Users\\Private",
    });
  });
  harness.webRequestListeners[0]({
    tabId: 7,
    frameId: 0,
    url: "https://cdn.test/master.m3u8?token=PRIVATE-HLS",
    responseHeaders: [{ name: "Content-Type", value: "application/vnd.apple.mpegurl" }],
  });
  const sender = { tab: { id: 7, url: "https://page.test/watch" }, frameId: 0 };
  const opened = await harness.send({ type: "luckyray-video-overlay-open", pageTitle: "HLS video" }, sender);
  assert.equal(opened.items[0].kind, "hls");
  const result = await harness.send({
    type: "luckyray-video-overlay-action",
    sessionId: opened.sessionId,
    candidateId: opened.items[0].candidateId,
    action: "save-materials",
  }, sender);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: false,
    code: "media-download-failed",
    message: "视频下载失败，请稍后重试。",
  });
  assert.equal(requestCount, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|SECRET|internal\.test|Users|master\.m3u8/);
});

test("a stable backend media failure remains visible instead of collapsing to a generic retry", async () => {
  const harness = await loadBackground({}, async () => jsonResponse(500, {
    code: "media-http-unavailable",
    message: "PRIVATE upstream body and signed URL",
  }));
  harness.webRequestListeners[0]({
    tabId: 7, frameId: 0, url: "https://cdn.test/rejected.mp4",
    responseHeaders: [{ name: "Content-Type", value: "video/mp4" }],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const sender = { tab: { id: 7, url: "https://www.bilibili.com/video/BV1xx411c7mD" }, frameId: 0 };
  const opened = await harness.send({ type: "luckyray-video-overlay-open", pageUrl: sender.tab.url }, sender);
  const result = await harness.send({
    type: "luckyray-video-overlay-action", sessionId: opened.sessionId,
    candidateId: opened.items[0].candidateId, action: "save-materials",
  }, sender);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: false,
    code: "media-http-unavailable",
    message: "视频源拒绝当前下载请求；请刷新站点登录状态后重试。",
  });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|signed URL/);
});

test("a YouTube resolver failure reports the current PO Token boundary precisely", async () => {
  const harness = await loadBackground({}, async () => jsonResponse(500, {
    code: "media-resolver-failed",
    message: "PRIVATE YouTube response",
  }));
  const pageUrl = "https://www.youtube.com/watch?v=fixture123";
  const sender = { tab: { id: 7, url: pageUrl }, frameId: 0 };
  const opened = await harness.send({
    type: "luckyray-video-overlay-open",
    descriptor: { url: `blob:${pageUrl}` },
    playerCandidates: [{ url: `blob:${pageUrl}` }],
    pageUrl,
    resolverPageUrl: pageUrl,
    playerContext: true,
  }, sender);
  const resolver = opened.items.find((item) => item.kind === "site-resolver");
  assert.ok(resolver);
  const result = await harness.send({
    type: "luckyray-video-overlay-action",
    sessionId: opened.sessionId,
    candidateId: resolver.candidateId,
    action: "save-materials",
  }, sender);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: false,
    code: "media-youtube-token-required",
    message: "YouTube 当前要求站点会话与 PO Token；已授权后仍失败的视频暂不可直接入库。",
  });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|response/);
});

test("video candidates and action sessions stay bound to their exact frame", async () => {
  const harness = await loadBackground();
  harness.webRequestListeners[0]({
    tabId: 7,
    frameId: 3,
    documentId: "document-3",
    url: "https://cdn.test/frame-three.mp4",
    responseHeaders: [{ name: "Content-Type", value: "video/mp4" }],
  });

  const wrongFrame = await harness.send({ type: "luckyray-video-overlay-open" }, {
    tab: { id: 7, url: "https://page.test/watch" },
    frameId: 0,
    documentId: "document-0",
  });
  assert.equal(wrongFrame.items.length, 0);

  const rightFrame = await harness.send({ type: "luckyray-video-overlay-open" }, {
    tab: { id: 7, url: "https://page.test/watch" },
    frameId: 3,
    documentId: "document-3",
  });
  assert.equal(rightFrame.items.length, 1);

  const forged = await harness.send({
    type: "luckyray-video-overlay-action",
    sessionId: rightFrame.sessionId,
    candidateId: rightFrame.items[0].candidateId,
    action: "download-computer",
  }, {
    tab: { id: 7, url: "https://page.test/watch" },
    frameId: 0,
    documentId: "document-0",
  });
  assert.equal(forged.ok, false);
  assert.equal(harness.downloads.length, 0);
});

test("the production extension runs the player chip in embedded frames without browser download authority", async () => {
  const manifest = JSON.parse(await readFile(
    new URL("../browser-extension-prototype/manifest.json", import.meta.url),
    "utf8",
  ));
  assert.equal(manifest.permissions.includes("downloads"), false);
  assert.equal(manifest.content_scripts[0].all_frames, true);
  assert.equal(manifest.content_scripts[0].match_about_blank, true);
  assert.equal(manifest.content_scripts[0].world, "MAIN");
  assert.deepEqual(manifest.content_scripts[0].js, ["page-media-probe.js"]);
  assert.equal(manifest.content_scripts[1].all_frames, true);
});

test("a Manifest V3 worker restart restores only the bounded current-tab video candidates", async () => {
  const sessionStore = {};
  const first = await loadBackground(sessionStore);
  first.webRequestListeners[0]({
    tabId: 7,
    frameId: 0,
    documentId: "document-7",
    url: "https://cdn.test/restart-safe-720p.mp4?token=PRIVATE",
    responseHeaders: [{ name: "Content-Type", value: "video/mp4" }],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const restarted = await loadBackground(sessionStore);
  const opened = await restarted.send({ type: "luckyray-video-overlay-open" }, {
    tab: { id: 7, url: "https://page.test/watch" },
    frameId: 0,
    documentId: "document-7",
  });
  assert.equal(opened.items.length, 1);
  assert.match(opened.items[0].label, /720p/);
  assert.doesNotMatch(JSON.stringify(opened), /PRIVATE|restart-safe/);
});

test("a worker restart restores an opaque transfer binding for status cancel and duplicate-safe save", async () => {
  const sessionStore = {};
  const transferId = "media-feed-0123456789abcdef";
  const calls = [];
  const transport = async ({ path, options }) => {
    calls.push({ path, method: options.method || "GET" });
    if (path === "/api/media/transfers" && options.method === "POST") return jsonResponse(202, {
      transferId,
      state: "running",
      bytesReceived: 256,
      totalBytes: 4096,
      fileName: "Restart.mp4",
      mimeType: "video/mp4",
      skippedDuplicate: false,
    });
    if (path === `/api/media/transfers/${transferId}`) return jsonResponse(200, {
      transferId,
      state: "running",
      bytesReceived: 512,
      totalBytes: 4096,
      fileName: "Restart.mp4",
      mimeType: "video/mp4",
      skippedDuplicate: false,
    });
    if (path === `/api/media/transfers/${transferId}/cancel`) return jsonResponse(200, {
      transferId,
      state: "cancelling",
      bytesReceived: 512,
      totalBytes: 4096,
      fileName: "Restart.mp4",
      mimeType: "video/mp4",
      skippedDuplicate: false,
    });
    return jsonResponse(404, { code: "media-transfer-not-found" });
  };
  const sender = {
    tab: { id: 7, url: "https://page.test/watch" },
    frameId: 2,
    documentId: "document-restart-binding",
  };
  const first = await loadBackground(sessionStore, transport);
  first.webRequestListeners[0]({
    tabId: 7,
    frameId: 2,
    documentId: "document-restart-binding",
    url: "https://cdn.test/restart-binding.mp4?token=PRIVATE-QUERY",
    responseHeaders: [{ name: "Content-Type", value: "video/mp4" }],
  });
  const opened = await first.send({ type: "luckyray-video-overlay-open", pageTitle: "Restart binding" }, sender);
  const candidateId = opened.items[0].candidateId;
  assert.equal((await first.send({
    type: "luckyray-video-overlay-action",
    sessionId: opened.sessionId,
    candidateId,
    action: "save-materials",
  }, sender)).ok, true);

  const storedBindings = sessionStore.luckyrayMediaTransferBindingsV1;
  assert.ok(Array.isArray(storedBindings));
  assert.doesNotMatch(JSON.stringify(storedBindings), /PRIVATE-QUERY|cdn\.test|restart-binding\.mp4|[?&]token=/i);

  const restarted = await loadBackground(sessionStore, transport);
  const action = (name) => restarted.send({
    type: "luckyray-video-overlay-action",
    sessionId: opened.sessionId,
    candidateId,
    action: name,
  }, sender);
  assert.equal((await action("media-transfer-status")).transfer.state, "running");
  assert.equal((await action("save-materials")).transfer.state, "running");
  assert.equal(calls.filter((call) => call.path === "/api/media/transfers" && call.method === "POST").length, 1);
  assert.equal((await action("media-transfer-cancel")).transfer.state, "cancelling");
  assert.equal(calls.at(-1).path, `/api/media/transfers/${transferId}/cancel`);
});

test("an active media transfer keeps its overlay session alive past the short menu TTL", async () => {
  const clock = { now: Date.now() };
  const transferId = "media-fade-abcdef0123456789";
  const harness = await loadBackground({}, async ({ path, options }) => {
    if (path === "/api/media/transfers" && options.method === "POST") return jsonResponse(202, {
      transferId,
      state: "running",
      bytesReceived: 64,
      totalBytes: 4096,
      fileName: "Long-running.mp4",
      mimeType: "video/mp4",
      skippedDuplicate: false,
    });
    if (path === `/api/media/transfers/${transferId}`) return jsonResponse(200, {
      transferId,
      state: "running",
      bytesReceived: 128,
      totalBytes: 4096,
      fileName: "Long-running.mp4",
      mimeType: "video/mp4",
      skippedDuplicate: false,
    });
    return jsonResponse(404, { code: "media-transfer-not-found" });
  }, null, clock);
  const sender = { tab: { id: 7, url: "https://page.test/watch" }, frameId: 0, documentId: "document-active-ttl" };
  harness.webRequestListeners[0]({
    tabId: 7,
    frameId: 0,
    documentId: "document-active-ttl",
    url: "https://cdn.test/active-ttl.mp4",
    responseHeaders: [{ name: "Content-Type", value: "video/mp4" }],
  });
  const opened = await harness.send({ type: "luckyray-video-overlay-open", pageTitle: "Active TTL" }, sender);
  const candidateId = opened.items[0].candidateId;
  assert.equal((await harness.send({
    type: "luckyray-video-overlay-action",
    sessionId: opened.sessionId,
    candidateId,
    action: "save-materials",
  }, sender)).ok, true);
  clock.now += 2 * 60_000 + 1;
  const status = await harness.send({
    type: "luckyray-video-overlay-action",
    sessionId: opened.sessionId,
    candidateId,
    action: "media-transfer-status",
  }, sender);
  assert.equal(status.ok, true);
  assert.equal(status.transfer.state, "running");
});

test("segment traffic cannot evict the actionable HLS manifest from the tab catalog", async () => {
  const harness = await loadBackground();
  harness.webRequestListeners[0]({
    tabId: 7,
    frameId: 0,
    url: "https://cdn.test/master.m3u8?token=fixture",
    responseHeaders: [{ name: "Content-Type", value: "application/vnd.apple.mpegurl" }],
  });
  for (let index = 0; index < 60; index += 1) {
    harness.webRequestListeners[0]({
      tabId: 7,
      frameId: 0,
      url: `https://cdn.test/segment-${index}.m4s`,
      responseHeaders: [{ name: "Content-Type", value: "video/iso.segment" }],
    });
  }
  const opened = await harness.send({ type: "luckyray-video-overlay-open" }, {
    tab: { id: 7, url: "https://page.test/watch" },
    frameId: 0,
  });
  assert.equal(opened.items.length, 1);
  assert.equal(opened.items[0].kind, "hls");
});

test("video action sessions remain bounded and evict the oldest inactive menu", async () => {
  const harness = await loadBackground();
  harness.webRequestListeners[0]({
    tabId: 7,
    frameId: 0,
    url: "https://cdn.test/bounded.mp4",
    responseHeaders: [{ name: "Content-Type", value: "video/mp4" }],
  });
  const opened = [];
  for (let index = 0; index < 70; index += 1) {
    opened.push(await harness.send({ type: "luckyray-video-overlay-open" }, {
      tab: { id: 7, url: "https://page.test/watch" },
      frameId: 0,
    }));
  }
  const stale = await harness.send({
    type: "luckyray-video-overlay-action",
    sessionId: opened[0].sessionId,
    candidateId: opened[0].items[0].candidateId,
    action: "download-computer",
  }, { tab: { id: 7, url: "https://page.test/watch" }, frameId: 0 });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "video-session-expired");

  const recent = opened.at(-1);
  const live = await harness.send({
    type: "luckyray-video-overlay-action",
    sessionId: recent.sessionId,
    candidateId: recent.items[0].candidateId,
    action: "download-computer",
  }, { tab: { id: 7, url: "https://page.test/watch" }, frameId: 0 });
  assert.equal(live.ok, false);
  assert.equal(live.code, "video-action-invalid");
  assert.equal(harness.downloads.length, 0);
});

test("the production offscreen recorder stops and discards data at its bounded memory limit", async () => {
  const harness = await loadOffscreenRecorder();
  const started = await harness.send({
    type: "luckyray-offscreen-record-start",
    streamId: "fixture-stream",
    recordingId: "fixture-recording-1",
    tabId: 7,
  });
  assert.equal(started.ok, true);
  harness.FixtureRecorder.last.emit(64 * 1024 * 1024 + 1);
  const status = await harness.send({ type: "luckyray-offscreen-record-status" });
  assert.deepEqual(JSON.parse(JSON.stringify(status)), {
    ok: true,
    active: false,
    code: "recording-size-limit",
    recordingId: "fixture-recording-1",
    tabId: 7,
    bytes: 0,
    maxBytes: 64 * 1024 * 1024,
    maxDurationMs: 20 * 60_000,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(harness.outbound)), [
    { type: "luckyray-record-fail", code: "recording-size-limit", recordingId: "fixture-recording-1" },
  ]);
  assert.equal(harness.tracks[0].stopped, true);
  assert.doesNotMatch(JSON.stringify(harness.stored), /fixture-stream|PRIVATE|https?:/);
});
