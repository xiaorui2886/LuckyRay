// EXT-R1-R1 background service-worker sandbox (P1-1 contract support).
//
// Loads and drives the REAL browser-extension-prototype/background.js inside
// a vm context. This is test-only infrastructure; it must never restate any
// production logic (no copied chooseContextMenuMedia / onClicked routing /
// URL validation). The sandbox provides the minimal chrome.* surface the real
// service worker touches at load time and during context-menu handling:
//
//   importScripts()              -> evaluates the real protocol + auth scripts
//   chrome.contextMenus.onClicked.addListener
//   chrome.runtime.onMessage.addListener / onInstalled / onStartup
//   chrome.tabs.onActivated/onUpdated/onRemoved
//   chrome.action.onClicked
//   chrome.storage.session.get/set/remove (in-memory, per-run)
//   chrome.webRequest.onHeadersReceived.addListener
//
// The transport seam is a test-injected fake LocalTransport factory: every
// LuckyRayLocalTransport.fetch goes through `options.transport` so tests can
// assert zero POSTs against the real background call chain.

import { readFile } from "node:fs/promises";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_URL = new URL("../../browser-extension-prototype/", import.meta.url);
const ROOT = path.dirname(fileURLToPath(EXTENSION_URL));

function makeChromeStub({ transportFetch, sessionStore }) {
  const contextMenuListeners = [];
  const runtimeMessageListeners = [];
  const runtimeInstalledListeners = [];
  const runtimeStartupListeners = [];
  const tabActivatedListeners = [];
  const tabUpdatedListeners = [];
  const tabRemovedListeners = [];
  const actionClickedListeners = [];
  const webRequestHeaderListeners = [];

  const chromeStub = {
    runtime: {
      id: "kjibmbcoioanaejehhfopjhdpnbkodla",
      lastError: null,
      sendMessage: async () => ({}),
      onMessage: {
        addListener: (listener) => runtimeMessageListeners.push(listener),
      },
      onInstalled: { addListener: (l) => runtimeInstalledListeners.push(l) },
      onStartup: { addListener: (l) => runtimeStartupListeners.push(l) },
    },
    contextMenus: {
      removeAll: async () => {},
      create: () => {},
      onClicked: {
        addListener: (listener) => contextMenuListeners.push(listener),
      },
    },
    tabs: {
      get: async () => ({ id: 1, url: "https://page.test/article" }),
      query: async () => [],
      create: async () => ({}),
      sendMessage: async () => ({}),
      onActivated: { addListener: (l) => tabActivatedListeners.push(l) },
      onUpdated: { addListener: (l) => tabUpdatedListeners.push(l) },
      onRemoved: { addListener: (l) => tabRemovedListeners.push(l) },
    },
    action: {
      onClicked: { addListener: (l) => actionClickedListeners.push(l) },
      openPopup: async () => {},
    },
    webRequest: {
      onHeadersReceived: { addListener: (l) => webRequestHeaderListeners.push(l) },
    },
    storage: {
      local: {
        get: async (key) => ({ [key]: sessionStore.get(`local:${key}`) }),
        set: async (obj) => { for (const [key, value] of Object.entries(obj)) sessionStore.set(`local:${key}`, value); },
      },
      session: {
        _store: sessionStore,
        get: async (key) => ({ [key]: sessionStore.get(key) }),
        set: async (obj) => { for (const [k, v] of Object.entries(obj || {})) sessionStore.set(k, v); },
        remove: async (key) => { sessionStore.delete(key); },
        setAccessLevel: async () => {},
      },
    },
    notifications: {
      create: async () => {},
    },
    scripting: {},
    desktopCapture: {},
  };
  return {
    chromeStub,
    listeners: {
      contextMenuListeners,
      runtimeMessageListeners,
      actionClickedListeners,
    },
  };
}

export async function loadBackgroundSandbox(options = {}) {
  const transportCalls = [];
  const sessionStore = new Map();
  const notifications = [];
  const transportFetch = options.transportFetch || (async () => ({ ok: false, status: 0, json: async () => null, text: async () => "" }));

  // Evaluate the production worker's dependencies, including the receipt and
  // input modules already required before the audio integration. Never copy
  // their behavior into the fixture or silently omit an import.
  const scriptSources = {};
  for (const name of ["extension-protocol.js", "video-overlay-preference.js", "audio-collection.js",
    "local-transport-auth.js", "media-import-contract.js", "capture-task.js", "appearance.js",
    "material-library-consumer.js", "capture-controller.js", "capture-surface.js",
    "collection-input.js", "collection-batch.js"]) {
    scriptSources[name] = await readFile(new URL(name, EXTENSION_URL), "utf8");
  }
  const backgroundSource = await readFile(new URL("background.js", EXTENSION_URL), "utf8");

  const { chromeStub, listeners } = makeChromeStub({ transportFetch, sessionStore });

  const sandbox = {
    URL,
    Date,
    Math,
    JSON,
    Promise,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    crypto: { randomUUID: () => "bg-test-uuid" },
    AbortController,
    Headers,
    TextEncoder,
    TextDecoder,
    fetch: transportFetch,
    chrome: {
      ...chromeStub,
      runtime: {
        ...chromeStub.runtime,
        getURL: (path = "") => `chrome-extension://kjibmbcoioanaejehhfopjhdpnbkodla/${path}`,
      },
    },
    // importScripts in a MV3 worker evaluates scripts into the worker scope.
    importScripts: (...names) => {
      for (const name of names) {
        const source = scriptSources[name];
        if (!source) throw new Error(`importScripts: unknown script ${name}`);
        vm.runInContext(source, sandbox, { filename: name });
      }
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);

  vm.runInContext(backgroundSource, sandbox, { filename: "background.js" });

  // Replace the real transport surface with the test fake. The auth module's
  // authorizedFetch/verify chain goes through the injected fetch as well, so
  // every real production path (bootstrap, proof, POST) stays live while the
  // network is bound to the test factory. discover() below is NOT patched:
  // the real one runs against the fake fetch.
  vm.runInContext(`
    globalThis.__realFetchRef = fetch;
    LuckyRayLocalTransport.fetch = async (port, urlPath, fetchOptions, timeoutMs) => {
      return await globalThis.__lrTestTransport(port, urlPath, fetchOptions, timeoutMs);
    };
  `, sandbox);
  // Sandbox-wide crypto: the real auth module needs getRandomValues + subtle
  // HMAC to run its actual proof handshake; the host Node crypto provides both.
  sandbox.crypto = globalThis.crypto;

  const TEST_PORT = 37420;
  const TEST_CREDENTIAL = "a".repeat(64);
  // Sandbox-global fetch answers the REAL bootstrap/proof endpoints with a
  // cryptographically valid proof (HMAC over the same proof message using the
  // same test credential), so the production auth chain completes honestly
  // inside the sandbox. Every request is observable via transportCalls.
  sandbox.fetch = async (url, init = {}) => {
    const urlText = String(url);
    const method = init.method || "GET";
    const body = init.body ? String(init.body) : "";
    transportCalls.push({ port: TEST_PORT, urlPath: urlText.replace(/^https?:\/\/[^/]+/, ""), method, body });
    const jsonResponse = (payload) => ({
      ok: true,
      status: 200,
      clone() { return this; },
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    });
    if (urlText.includes("/api/v1/health")) {
      return jsonResponse({
        ok: true,
        data: { service: "luckyray-local-transport", protocolVersion: 1, extensionBootstrap: true },
      });
    }
    if (urlText.includes("/api/v1/extension/bootstrap")) {
      return jsonResponse({
        ok: true,
        data: { protocolVersion: 1, actualPort: TEST_PORT, baseUrl: `http://127.0.0.1:${TEST_PORT}`, credential: TEST_CREDENTIAL },
      });
    }
    if (urlText.includes("/api/v1/proof")) {
      const request = JSON.parse(body || "{}");
      const clientNonce = String(request.clientNonce || "");
      const serverNonce = "b".repeat(64);
      const message = `luckyray-local-transport-proof-v1\nprotocol:1\norigin:chrome-extension://kjibmbcoioanaejehhfopjhdpnbkodla\nport:${TEST_PORT}\nclientNonce:${clientNonce}\nserverNonce:${serverNonce}`;
      const key = await crypto.subtle.importKey(
        "raw",
        Uint8Array.from(TEST_CREDENTIAL.match(/../g), (pair) => Number.parseInt(pair, 16)),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const signature = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      return jsonResponse({
        ok: true,
        data: { protocolVersion: 1, port: TEST_PORT, clientNonce, serverNonce, proof: signature },
      });
    }
    return jsonResponse({ ok: true, data: { disposition: "imported", asset: { id: "a1", name: "x.png" } } });
  };
  sandbox.__lrTestTransport = async (port, urlPath, fetchOptions, timeoutMs) => {
    transportCalls.push({ port, urlPath, method: fetchOptions?.method || "GET", body: fetchOptions?.body || null });
    return await transportFetch(port, urlPath, fetchOptions, timeoutMs);
  };

  const notify = (message, isError) => { notifications.push({ message: String(message || ""), error: Boolean(isError) }); };
  vm.runInContext(`notify = (m, e) => globalThis.__lrTestNotify(m, e);`, sandbox);
  sandbox.__lrTestNotify = notify;

  // The real contentReceiver bridge drives chrome.tabs.sendMessage; tests can
  // stub per-tab content responses through this hook without copying logic.
  sandbox.__lrTestContentResponse = options.contentResponse || null;

  const contextMenuClick = async (info, tab) => {
    for (const listener of listeners.contextMenuListeners) {
      await listener(info, tab);
    }
  };

  return {
    sandbox,
    protocol: sandbox.LuckyRayExtensionProtocol,
    transportCalls,
    notifications,
    sessionStore,
    contextMenuClick,
    listeners,
  };
}
