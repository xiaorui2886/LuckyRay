// Shared content-script sandbox loader used by the extension media and hover
// contract suites. Loads extension-protocol.js and content-script.js into a
// vm context with a minimal DOM/runtime stub so production capture logic can
// be driven deterministically (hover dispatch, dragstart, runtime messages).
//
// Test-only infrastructure (Issue #21 / PR #22 scope).

import { readFile } from "node:fs/promises";
import vm from "node:vm";

const PROTOCOL_URL = new URL("../../browser-extension-prototype/extension-protocol.js", import.meta.url);
const CONTENT_URL = new URL("../../browser-extension-prototype/content-script.js", import.meta.url);

export async function loadContentScriptSandbox(runtimeFixture = null) {
  const protocolSource = await readFile(PROTOCOL_URL, "utf8");
  const contentSource = await readFile(CONTENT_URL, "utf8");
  const documentListeners = new Map();
  const runtimeListeners = new Set();
  const runtimeMessages = [];
  class Element {}
  class HTMLImageElement extends Element {}
  class HTMLSourceElement extends Element {}
  class HTMLVideoElement extends Element {}
  class HTMLAnchorElement extends Element {}
  class CustomEvent {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
  }
  // EXT-R1-REPAIR-2: a generic DOM element factory so the REAL content-script
  // overlay lifecycle (closed shadow host, chip/panel/buttons, listeners) can
  // execute inside the sandbox without restating any production logic.
  const documentElement = makeDomElement("html");
  const document = {
    addEventListener(type, listener) {
      const listeners = documentListeners.get(type) || new Set();
      listeners.add(listener);
      documentListeners.set(type, listeners);
    },
    removeEventListener(type, listener) {
      documentListeners.get(type)?.delete(listener);
    },
    dispatchEvent(event) {
      for (const listener of documentListeners.get(event.type) || []) listener(event);
      return true;
    },
    elementsFromPoint: () => [],
    createElement: (tag) => makeDomElement(String(tag || "div").toLowerCase()),
    createTextNode: (text) => ({ text }),
    documentElement,
    body: makeDomElement("body"),
    title: "Fixture page",
  };
  const sandbox = {
    URL,
    Date,
    Math,
    setTimeout,
    clearTimeout,
    crypto: { randomUUID: () => "document-token" },
    location: { href: "https://page.test/article" },
    scrollX: 0,
    scrollY: 0,
    getComputedStyle: () => ({ backgroundImage: "none" }),
    document,
    Element,
    HTMLImageElement,
    HTMLSourceElement,
    HTMLVideoElement,
    HTMLAnchorElement,
    CustomEvent,
    HTMLElement: class HTMLElement {},
    getComputedStyle: () => ({ backgroundImage: "none" }),
    requestAnimationFrame: (fn) => setTimeout(fn, 16),
    location: { href: "https://page.test/watch" },
    chrome: {
      runtime: {
        sendMessage: async (message) => {
          runtimeMessages.push(message);
          return typeof runtimeFixture === "function" ? await runtimeFixture(message) : {};
        },
        onMessage: {
          addListener: (listener) => runtimeListeners.add(listener),
          removeListener: (listener) => runtimeListeners.delete(listener),
        },
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.__lrDocumentListeners = documentListeners;
  vm.createContext(sandbox);
  vm.runInContext(protocolSource, sandbox, { filename: "extension-protocol.js" });
  return { sandbox, contentSource, documentListeners, runtimeListeners, runtimeMessages };
}

// Generic bounded DOM element for the overlay lifecycle (test-only).
export function makeDomElement(tag) {
  const listeners = new Map();
  const shadowListeners = [];
  const children = [];
  const shadowChildren = [];
  const element = {
    tagName: String(tag || "div").toUpperCase(),
    textContent: "",
    innerHTML: "",
    className: "",
    title: "",
    hidden: false,
    disabled: false,
    type: "",
    style: {},
    dataset: {},
    isConnected: true,
    parentElement: null,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { listeners.delete(type); },
    dispatch(type, event) { const l = listeners.get(type); if (l) l(event); },
    setAttribute(name, value) { (this.attributes ||= {})[name] = String(value); },
    getAttribute(name) { return (this.attributes || {})[name] ?? null; },
    appendChild(child) { child.parentElement = this; children.push(child); shadowChildren.push(child); return child; },
    append(...nodes) { for (const n of nodes) this.appendChild(n); },
    replaceChildren(...nodes) { children.length = 0; shadowChildren.length = 0; for (const n of nodes) this.appendChild(n); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    remove() { this.isConnected = false; },
    focus() {},
    blur() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 300, bottom: 170, width: 300, height: 170 }),
    attachShadow() {
      const shadow = {
        appendChild: (child) => { child.parentElement = element; children.push(child); return child; },
        append: (...nodes) => { for (const n of nodes) shadow.appendChild(n); },
        replaceChildren: (...nodes) => { children.length = 0; for (const n of nodes) shadow.appendChild(n); },
        querySelector: () => null,
        querySelectorAll: () => [],
      };
      return shadow;
    },
    __lrChildren: children,
    __lrShadowChildren: shadowChildren,
    __lrShadowListeners: shadowListeners,
    classList: {
      add() {}, remove() {}, toggle() {}, contains() { return false; },
    },
  };
  return element;
}

// ---------------------------------------------------------------------------
// EXT-R1-R1 (repair round 1) popup sandbox: executes the REAL popup.js in a vm
// against a minimal DOM/chrome surface. Test-only infrastructure; production
// logic is never restated. Used to drive applyPrefill/doMedia/submit-gate
// paths end-to-end (P1-2 / P1-3 / P2-1 contracts).
const POPUP_URL = new URL("../../browser-extension-prototype/popup.js", import.meta.url);
const POPUP_ELEMENT_IDS = [
  "lr-action-summary", "lr-advanced", "lr-current-note", "lr-folder-list",
  "lr-folder-new", "lr-folder-pick", "lr-more-options", "lr-new-folder-name",
  "lr-new-note-title", "lr-note-insert", "lr-note-list", "lr-note-q",
  "lr-note-recent", "lr-note-search", "lr-page-preview", "lr-prefill-hint",
  "lr-preview-kind", "lr-preview-meta", "lr-preview-snippet", "lr-preview-title",
  "lr-qc-type", "lr-recent-list", "lr-record", "lr-record-hint",
  "lr-record-start", "lr-record-status", "lr-record-stop",
  "lr-reload-extension", "lr-source", "lr-submit", "lr-target", "lr-toast",
  "lr-transfer-progress", "lr-transfer-progress-fill",
  "lr-transfer-progress-label", "lr-video-candidates", "lr-video-refresh",
  "lr-video-section", "lr-video-state",
];

function makePopupElement(id) {
  const listeners = new Map();
  const element = {
    id,
    value: "",
    textContent: "",
    hidden: false,
    disabled: false,
    style: {},
    dataset: {},
    innerHTML: "",
    className: "",
    title: "",
    children: [],
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
    dispatch(type, event) { const l = listeners.get(type); if (l) l(event); },
    appendChild(child) { this.children.push(child); },
    replaceChildren(...nodes) { this.children = nodes; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    setAttribute() {},
    getAttribute() { return null; },
    classList: {
      add() {}, remove() {}, toggle() {}, contains() { return false; },
    },
  };
  return element;
}

export async function loadPopupSandbox(runtimeFixture = null) {
  const protocolSource = await readFile(new URL("../../browser-extension-prototype/extension-protocol.js", import.meta.url), "utf8");
  const popupSource = await readFile(POPUP_URL, "utf8");
  const captureTaskSource = await readFile(new URL("../../browser-extension-prototype/capture-task.js", import.meta.url), "utf8");
  let captureTask;
  let storedCaptureTask = null;
  const captureMessage = (message) => {
    if (message?.type !== "luckyray-capture-task") return runtimeFixture ? runtimeFixture(message) : {};
    if (message.action === "start") return captureTask.start(message.input);
    if (message.action === "status") return captureTask.status();
    if (message.action === "resume") return captureTask.resume(message.id);
    if (message.action === "acknowledge") return captureTask.acknowledge(message.id);
    return { ok: false, code: "capture-task-invalid" };
  };
  const elements = new Map(POPUP_ELEMENT_IDS.map((id) => [id, makePopupElement(id)]));
  const apiCalls = [];
  const typeButtons = ["image", "video", "text", "link"].map((type) => ({
    dataset: { type },
    addEventListener() {},
    classList: { toggle() {} },
  }));
  const document = {
    getElementById: (id) => elements.get(id) || makePopupElement(id),
    createElement: () => makePopupElement("dyn"),
    createTextNode: (text) => ({ text }),
    addEventListener() {},
    querySelectorAll: (selector) => (String(selector).includes("lr-type") ? typeButtons : []),
  };
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
    AbortController,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    crypto: globalThis.crypto,
    document,
    escapeHtml: undefined,
    chrome: {
      runtime: {
        lastError: null,
        sendMessage: (message, callback) => {
          Promise.resolve(captureMessage(message))
            .then((response) => { if (typeof callback === "function") callback(response); })
            .catch(() => { if (typeof callback === "function") callback({}); });
        },
        reload() {},
      },
      tabs: {
        query: async () => [{ id: 11, url: "https://page.test/article", title: "Fixture" }],
      },
      storage: {
        session: {
          get: async () => ({}),
          remove: async () => {},
        },
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(protocolSource, sandbox, { filename: "extension-protocol.js" });
  vm.runInContext(popupSource, sandbox, { filename: "popup.js" });
  vm.runInContext(captureTaskSource, sandbox, { filename: "capture-task.js" });
  // Drive the production coordinator through popup messages. The existing
  // transport fixture still observes the final HTTP method/path/body, so a
  // task acceptance alone cannot satisfy a material or note write assertion.
  captureTask = sandbox.LuckyRayCaptureTask.create({
    protocol: sandbox.LuckyRayExtensionProtocol,
    read: async () => structuredClone(storedCaptureTask),
    write: async (value) => { storedCaptureTask = structuredClone(value); },
    request: (method, route, body) => sandbox.callApi(method, route, body),
  });
  return { sandbox, elements, apiCalls, captureTask };
}
