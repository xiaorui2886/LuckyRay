// Test-only Node VM driver for the real controller/SDK/background/auth and
// a Rust-owned temporary HTTP host. Browser bitmap APIs are synthetic; HTTP,
// HMAC proof, PNG decode, Catalog and durable receipt are production code.
// Input is synthetic PNG + target/port only. Never access an ordinary browser
// profile, discover Main's ports, or print credentials/request bodies.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { loadBackgroundSandbox } from "./background-script-sandbox.mjs";

const watchdog = setTimeout(() => process.exit(2), 110_000);
watchdog.unref();
const calls = [], failures = [];
try {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  const input = JSON.parse(text);
  assert(Number.isInteger(input.port) && input.port > 0 && input.port <= 65535);
  assert(/^chrome-extension:\/\/[a-p]{32}$/.test(input.origin));
  const png = Buffer.from(input.pngBase64, "base64");
  const fixture = await loadBackgroundSandbox();
  const { sandbox } = fixture;
  sandbox.process = { versions: { node: process.versions.node } };
  sandbox.__LUCKYRAY_TEST_PORTS__ = [input.port];
  sandbox.btoa = btoa;
  sandbox.Uint8Array = Uint8Array;
  sandbox.chrome.runtime.getURL = path => `${input.origin}/${path || ""}`;
  const metrics = { ok: true, documentToken: "synthetic-native-document",
    url: "https://page.test/capture", x: 0, y: 0, width: 3828, height: 1911,
    dpr: 1, visualScale: 1, pageWidth: 3828, pageHeight: 1911 };
  sandbox.chrome.tabs.get = async () => ({ id: 11, windowId: 4, active: true,
    url: metrics.url, title: "Synthetic native screenshot" });
  sandbox.chrome.tabs.captureVisibleTab = async () => "data:image/png;base64,SYNTHETIC";
  sandbox.chrome.windows = { update: async () => {} };
  sandbox.createImageBitmap = async () => ({ width: 3828, height: 1911, close() {} });
  sandbox.OffscreenCanvas = class {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() { return { drawImage() {} }; }
    async convertToBlob() {
      return { size: png.length, arrayBuffer: async () =>
        png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) };
    }
  };
  let controlUnavailable = false;
  let writePreflightArmed = false;
  sandbox.fetch = async (url, init = {}) => {
    if (String(url).startsWith("data:image/")) return { blob: async () => ({}) };
    const parsed = new URL(url);
    assert.equal(parsed.origin, `http://127.0.0.1:${input.port}`,
      "The harness may only use the Rust-owned temporary port");
    const headers = new Headers(init.headers);
    headers.set("Origin", input.origin);
    calls.push({ path: parsed.pathname, method: init.method || "GET" });
    if (controlUnavailable && /^\/api\/v1\/(?:proof|health|extension\/bootstrap)$/.test(parsed.pathname)) {
      throw new TypeError("Synthetic pre-dispatch control connection failure");
    }
    const response = await fetch(url, { ...init, headers });
    // Keep the readonly library recheck intact; this scenario must lose
    // proof before the PNG write, not before an earlier prerequisite read.
    if (writePreflightArmed && parsed.pathname === "/api/material-libraries") controlUnavailable = true;
    if (input.scenario === "lost-response" && parsed.pathname === "/api/material-libraries/import-bytes") {
      // The real host has decoded/persisted the PNG and durable receipt. Lose
      // only its response at the JS boundary; no replacement business request.
      assert.equal(response.status, 200);
      await response.arrayBuffer();
      throw new TypeError("Synthetic loss after real native commit");
    }
    return response;
  };
  // Restore the production transport after the general sandbox's fake seam.
  vm.runInContext(await readFile(new URL("../../browser-extension-prototype/local-transport-auth.js", import.meta.url), "utf8"), sandbox);
  const controller = sandbox.LuckyRayPageCaptureController.create({
    chromeApi: sandbox.chrome, page: async () => ({ ...metrics }),
    request: async (...args) => {
      const result = await sandbox.requestCaptureApi(...args);
      if (!result.ok) failures.push({ path: args[1], status: result.status || null,
        code: result.errorObject?.error?.code || result.errorObject?.code || null });
      return result;
    }, delay: async () => {} });
  const began = Date.now();
  const started = await controller.start({ mode: "visible", tabId: 11, libraryId: input.libraryId });
  assert.equal(started.ok, true, `Start failed: ${started.code}`);
  for (let i = 0; controller.status(started.draft.id).draft.stage === "capturing" && i < 200; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(controller.status(started.draft.id).draft.stage, "preview");
  writePreflightArmed = input.scenario === "preflight-failure";
  const result = await controller.save(started.draft.id, { title: "Synthetic native screenshot" });
  const pending = await controller.pendingStatus();
  process.stdout.write(JSON.stringify({ outcome: "SYNTHETIC_REAL_JS_NATIVE_CAPTURE",
    stage: result.draft?.stage, code: result.code || null,
    businessWrites: calls.filter(c => c.path === "/api/material-libraries/import-bytes").length,
    receiptReads: calls.filter(c => c.path === "/api/material-libraries/capture-receipt").length,
    notCommitted: result.draft?.notCommitted === true,
    pendingCount: pending.pending.length, milliseconds: Date.now() - began,
    pngBytes: png.length, width: result.draft?.width, height: result.draft?.height, calls, failures }));
  // Rust owns expected verdicts for success and fault-injection scenarios.
} catch (error) {
  process.stdout.write(JSON.stringify({ outcome: "SYNTHETIC_REAL_JS_NATIVE_CAPTURE",
    failed: true, code: error.code || error.name, message: error.message, calls, failures }));
  process.exitCode = 1;
}
